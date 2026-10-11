-- Smoke test for the Q7 stock catalog merge / revert flow (append-only ledger).
-- Runs entirely inside BEGIN ... ROLLBACK so it never keeps fixtures.
-- Prerequisites (real data only, never created by this script):
--   * migration 20261015100000_stock_catalog_cleanup.sql applied
--   * at least one public.user_roles row with role 'owner' (for decide permission)
-- Run with:  psql "$DATABASE_URL" -f scripts/smoke_stock_catalog_merge.sql
--
-- Design under test: the Q7 ledger is append-only, so apply_stock_item_merge
-- never rewrites q7_inventory_movements / q7_inventory_openings. It retires the
-- source and moves its on-hand stock with signed adjustment rows
-- (source -balance / target balance*factor), and an AFTER INSERT trigger mirrors
-- any later movement of a retired source to the final target.
--
-- Shared unit-factor test cases (must match src/lib/stock-catalog.ts):
--   kg -> g = 1000, g -> kg = 0.001, l -> ml = 1000, ml -> l = 0.001,
--   lít -> ml = 1000, Kilogram -> g = 1000, gr -> kg = 0.001,
--   Quả -> g = null, chai -> chai = 1, kg -> KG = 1

begin;

select set_config('request.jwt.claim.role', 'service_role', true);

do $smoke$
declare
  v_actor uuid;
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_material uuid;
  v_source uuid;
  v_target uuid;
  v_link_item uuid;
  v_ambiguous_item uuid;
  v_production_order uuid;
  v_order_item uuid;
  v_issue uuid;
  v_issue_item uuid;
  v_mapping uuid;
  v_merge_id uuid;
  v_suggestion uuid;
  v_total_before numeric;
  v_total_after numeric;
  v_target_before_e numeric;
  v_target_snapshot numeric;
  v_source_snapshot numeric;
  v_source_raw numeric;
  v_expected numeric;
  v_count integer;
  v_factor numeric;
  v_rev_qty numeric;
  v_new_movement uuid;
  v_error text;
  v_movement_before jsonb;
  v_usage_before jsonb;
  v_opening_before jsonb;
  v_issue_item_before jsonb;
  v_alias_before jsonb;
  v_mapping_before jsonb;
  v_setting_before jsonb;
  v_row jsonb;
begin
  select u.id into v_actor
  from auth.users u
  join public.user_roles r on r.user_id = u.id and r.role = 'owner'
  order by u.created_at
  limit 1;
  if v_actor is null then
    raise exception 'smoke requires at least one owner user';
  end if;
  perform set_config('request.jwt.claim.sub', v_actor::text, true);

  ------------------------------------------------------------------
  -- 0. stock_unit_factor test table (checked first, no fixtures needed)
  ------------------------------------------------------------------
  if public.stock_unit_factor('kg', 'g') <> 1000 then raise exception 'kg->g'; end if;
  if public.stock_unit_factor('g', 'kg') <> 0.001 then raise exception 'g->kg'; end if;
  if public.stock_unit_factor('l', 'ml') <> 1000 then raise exception 'l->ml'; end if;
  if public.stock_unit_factor('ml', 'l') <> 0.001 then raise exception 'ml->l'; end if;
  if public.stock_unit_factor('lít', 'ml') <> 1000 then raise exception 'lít->ml'; end if;
  if public.stock_unit_factor('Kilogram', 'g') <> 1000 then raise exception 'Kilogram->g'; end if;
  if public.stock_unit_factor('gr', 'kg') <> 0.001 then raise exception 'gr->kg'; end if;
  if public.stock_unit_factor('Quả', 'g') is not null then raise exception 'Quả->g must be null'; end if;
  if public.stock_unit_factor('chai', 'chai') <> 1 then raise exception 'chai->chai'; end if;
  if public.stock_unit_factor('kg', 'KG') <> 1 then raise exception 'kg->KG'; end if;

  ------------------------------------------------------------------
  -- Fixtures: canonical material, source kg / target g, references
  ------------------------------------------------------------------
  -- Let the production issue post usage inside this rolled-back transaction.
  insert into public.stock_ledger_settings (id, q7_cutover_date)
  values (1, v_today - 365)
  on conflict (id) do nothing;
  update public.stock_ledger_settings
    set q7_cutover_date = least(coalesce(q7_cutover_date, v_today - 365), v_today - 365),
        updated_at = now()
    where id = 1;

  insert into public.sku_cogs_materials (material_code, canonical_name, normalized_name, default_unit)
  values ('SMOKE-CAT-' || v_suffix, 'Smoke Bột X', 'smoke-bot-x-' || v_suffix, 'g')
  returning id into v_material;

  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit)
  values ('SMOKE-SRC-' || v_suffix, 'smoke-src-' || v_suffix, 'ingredient', 'Smoke Bột X', 'kg')
  returning id into v_source;

  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit)
  values ('SMOKE-TGT-' || v_suffix, 'smoke-tgt-' || v_suffix, 'ingredient', 'Smoke Bột X (g)', 'g')
  returning id into v_target;

  insert into public.q7_material_issue_material_mappings
    (canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit, conversion_factor, approval_status, approved_by, approved_at)
  values (v_material, 'kg', v_source, 'kg', 1, 'approved', v_actor, now())
  returning id into v_mapping;

  insert into public.q7_inventory_movements
    (kitchen_inventory_item_id, movement_date, movement_type, quantity, unit, source, created_by)
  values (v_source, v_today - 10, 'receipt', 3, 'kg', 'manual_receipt', v_actor);

  insert into public.stock_material_aliases
    (supplier_id, normalized_name, location, kitchen_inventory_item_id, conversion_factor, unit, created_by)
  values (null, 'smoke-bot-x-alias-' || v_suffix, 'q7', v_source, 1, 'kg', v_actor);

  insert into public.q7_inventory_openings
    (kitchen_inventory_item_id, effective_date, opening_qty, unit, created_by)
  values (v_source, v_today - 30, 4, 'kg', v_actor);

  insert into public.q7_purchase_item_settings
    (kitchen_inventory_item_id, mode, order_cycle_days)
  values (v_source, 'suggest', 7);

  insert into public.production_orders (production_number)
  values ('SMOKE-SX-' || v_suffix)
  returning id into v_production_order;

  insert into public.production_order_items (production_order_id, product_name, unit)
  values (v_production_order, 'Smoke bánh mì', 'cái')
  returning id into v_order_item;

  insert into public.production_material_issues
    (issue_number, production_order_id, issue_date, status, location_code, revision, source_hash, is_current)
  values ('SMOKE-PXK-' || v_suffix, v_production_order, v_today - 5, 'pdf_ready', 'q7', 1, repeat('a', 64), true)
  returning id into v_issue;

  insert into public.production_material_issue_items
    (material_issue_id, production_order_item_id, kitchen_inventory_item_id, ingredient_name,
     required_qty, unit, source_ref_key, conversion_factor, q7_mapping_id, canonical_material_id)
  values (v_issue, v_order_item, v_source, 'Smoke Bột X', 2, 'kg', 'smoke-' || v_suffix, 1, v_mapping, v_material)
  returning id into v_issue_item;

  -- Post the usage before the merge so a later reversal exercises the trigger.
  perform public.post_material_issue_usage(v_issue);
  if not exists (
    select 1 from public.q7_inventory_movements m
    where m.source = 'production_material_issue'
      and m.source_issue_id = v_issue
      and m.kitchen_inventory_item_id = v_source
  ) then
    raise exception 'smoke could not post production usage';
  end if;

  ------------------------------------------------------------------
  -- Snapshots before the merge
  ------------------------------------------------------------------
  select to_jsonb(m) into v_movement_before
  from public.q7_inventory_movements m
  where m.kitchen_inventory_item_id = v_source and m.source = 'manual_receipt';

  select to_jsonb(m) into v_usage_before
  from public.q7_inventory_movements m
  where m.kitchen_inventory_item_id = v_source and m.source = 'production_material_issue';

  select to_jsonb(o) into v_opening_before
  from public.q7_inventory_openings o
  where o.kitchen_inventory_item_id = v_source;

  select to_jsonb(i) into v_issue_item_before
  from public.production_material_issue_items i
  where i.kitchen_inventory_item_id = v_source;

  select to_jsonb(a) into v_alias_before
  from public.stock_material_aliases a
  where a.kitchen_inventory_item_id = v_source;

  select to_jsonb(mp) into v_mapping_before
  from public.q7_material_issue_material_mappings mp
  where mp.kitchen_inventory_item_id = v_source;

  select to_jsonb(s) into v_setting_before
  from public.q7_purchase_item_settings s
  where s.kitchen_inventory_item_id = v_source;

  -- 1. Total on-hand converted to g before the merge (get_q7_inventory_snapshot).
  select coalesce(sum(s.balance_qty * public.stock_unit_factor(s.unit, 'g')), 0) into v_total_before
  from public.get_q7_inventory_snapshot(v_today) s
  where s.kitchen_inventory_item_id in (v_source, v_target);
  if v_total_before <> 5000 then
    raise exception 'expected 5000 g before merge (4 opening + 3 receipt - 2 usage), got %', v_total_before;
  end if;

  ------------------------------------------------------------------
  -- 2. Apply the merge (source kg -> target g, factor 1000)
  ------------------------------------------------------------------
  select (public.apply_stock_item_merge(v_source, v_target, 1000))->>'merge_id' into v_error;
  v_merge_id := v_error::uuid;
  if v_merge_id is null then
    raise exception 'apply_stock_item_merge did not return a merge id';
  end if;

  -- (a) Total converted back to g is unchanged and the retired source is at 0.
  select coalesce(sum(s.balance_qty * public.stock_unit_factor(s.unit, 'g')), 0) into v_total_after
  from public.get_q7_inventory_snapshot(v_today) s
  where s.kitchen_inventory_item_id in (v_source, v_target);
  if v_total_after <> v_total_before then
    raise exception 'total on-hand changed after merge: % -> %', v_total_before, v_total_after;
  end if;

  select coalesce(sum(s.balance_qty * public.stock_unit_factor(s.unit, 'g')), 0) into v_source_snapshot
  from public.get_q7_inventory_snapshot(v_today) s
  where s.kitchen_inventory_item_id = v_source;
  if v_source_snapshot <> 0 then
    raise exception 'retired source must read 0 from the snapshot, got %', v_source_snapshot;
  end if;

  -- The source ledger itself nets to zero because of the transfer adjustment.
  select coalesce((
      select sum(case m.movement_type when 'production_usage' then -m.quantity else m.quantity end)
      from public.q7_inventory_movements m
      where m.kitchen_inventory_item_id = v_source
    ), 0) + coalesce((
      select sum(coalesce(o.opening_qty, 0))
      from public.q7_inventory_openings o
      where o.kitchen_inventory_item_id = v_source
    ), 0)
    into v_source_raw;
  if v_source_raw <> 0 then
    raise exception 'retired source ledger must net to 0, got %', v_source_raw;
  end if;

  -- (b) Original movement and opening rows of the source are byte-for-byte intact.
  select to_jsonb(m) into v_row from public.q7_inventory_movements m
  where m.kitchen_inventory_item_id = v_source and m.source = 'manual_receipt';
  if v_row is distinct from v_movement_before then
    raise exception 'q7_inventory_movements receipt row was rewritten';
  end if;

  select to_jsonb(m) into v_row from public.q7_inventory_movements m
  where m.kitchen_inventory_item_id = v_source and m.source = 'production_material_issue';
  if v_row is distinct from v_usage_before then
    raise exception 'q7_inventory_movements usage row was rewritten';
  end if;

  select to_jsonb(o) into v_row from public.q7_inventory_openings o
  where o.kitchen_inventory_item_id = v_source;
  if v_row is distinct from v_opening_before then
    raise exception 'q7_inventory_openings row was rewritten';
  end if;

  -- No stale reference row is left pointing at the retired source.
  for v_count in
    select 1 from public.production_material_issue_items where kitchen_inventory_item_id = v_source
    union all select 1 from public.q7_material_issue_material_mappings where kitchen_inventory_item_id = v_source
    union all select 1 from public.stock_material_aliases where kitchen_inventory_item_id = v_source
    union all select 1 from public.q7_purchase_item_settings where kitchen_inventory_item_id = v_source
  loop
    raise exception 'a movable reference row still points at the merged source';
  end loop;

  -- (c) The movable references were moved and converted.
  select required_qty into v_factor
  from public.production_material_issue_items
  where kitchen_inventory_item_id = v_target and id = v_issue_item;
  if v_factor <> 2000 then
    raise exception 'issue required_qty expected 2000 g, got %', v_factor;
  end if;
  select unit into v_error from public.production_material_issue_items where id = v_issue_item;
  if v_error <> 'g' then raise exception 'issue unit expected g, got %', v_error; end if;

  select conversion_factor into v_factor
  from public.q7_material_issue_material_mappings
  where kitchen_inventory_item_id = v_target;
  if v_factor <> 1000 then
    raise exception 'mapping conversion_factor expected 1000, got %', v_factor;
  end if;
  select kitchen_unit into v_error
  from public.q7_material_issue_material_mappings
  where kitchen_inventory_item_id = v_target;
  if v_error <> 'g' then raise exception 'mapping kitchen_unit expected g, got %', v_error; end if;

  select conversion_factor into v_factor
  from public.stock_material_aliases
  where kitchen_inventory_item_id = v_target;
  if v_factor <> 1000 then
    raise exception 'alias conversion_factor expected 1000, got %', v_factor;
  end if;
  select unit into v_error
  from public.stock_material_aliases
  where kitchen_inventory_item_id = v_target;
  if v_error <> 'g' then raise exception 'alias unit expected g, got %', v_error; end if;

  if not exists (
    select 1 from public.q7_purchase_item_settings where kitchen_inventory_item_id = v_target
  ) then
    raise exception 'purchase setting was not moved to the target';
  end if;

  if (select active from public.kitchen_inventory_items where id = v_source) <> false then
    raise exception 'source must be inactive after the merge';
  end if;
  if (select merged_into_id from public.kitchen_inventory_items where id = v_source) <> v_target then
    raise exception 'source merged_into_id must point at the target';
  end if;

  -- (f) A second merge of the same source must fail with a clear message.
  begin
    perform public.apply_stock_item_merge(v_source, v_target, 1000);
    raise exception 'second merge of an inactive source should have failed';
  exception when others then
    v_error := sqlerrm;
    if v_error not like 'merge_source_inactive%' and v_error not like 'merge_source_was_target%' then
      raise;
    end if;
  end;

  ------------------------------------------------------------------
  -- (d) A new movement written for the retired source is forwarded
  ------------------------------------------------------------------
  insert into public.q7_inventory_movements
    (kitchen_inventory_item_id, movement_date, movement_type, quantity, unit, source, source_ref_key, created_by)
  values (v_source, v_today, 'receipt', 1, 'kg', 'manual_receipt', 'smoke-fwd-' || v_suffix, v_actor)
  returning id into v_new_movement;

  if not exists (
    select 1 from public.q7_inventory_movements m
    where m.source = 'item_merge'
      and m.source_ref_key = 'item-merge:' || v_merge_id::text || ':fwd:' || v_new_movement::text || ':out'
  ) then
    raise exception 'forward trigger did not write the source offset row';
  end if;
  if not exists (
    select 1 from public.q7_inventory_movements m
    where m.source = 'item_merge'
      and m.source_ref_key = 'item-merge:' || v_merge_id::text || ':fwd:' || v_new_movement::text || ':in'
  ) then
    raise exception 'forward trigger did not write the target mirror row';
  end if;

  select coalesce(sum(s.balance_qty * public.stock_unit_factor(s.unit, 'g')), 0) into v_target_snapshot
  from public.get_q7_inventory_snapshot(v_today) s
  where s.kitchen_inventory_item_id = v_target;
  if v_target_snapshot <> 6000 then
    raise exception 'target expected 6000 g after forwarded receipt, got %', v_target_snapshot;
  end if;

  select coalesce((
      select sum(case m.movement_type when 'production_usage' then -m.quantity else m.quantity end)
      from public.q7_inventory_movements m
      where m.kitchen_inventory_item_id = v_source
    ), 0) + coalesce((
      select sum(coalesce(o.opening_qty, 0))
      from public.q7_inventory_openings o
      where o.kitchen_inventory_item_id = v_source
    ), 0)
    into v_source_raw;
  if v_source_raw <> 0 then
    raise exception 'source ledger must stay at 0 after forwarded receipt, got %', v_source_raw;
  end if;

  ------------------------------------------------------------------
  -- (e) Reversing a pre-merge posted usage is forwarded too
  ------------------------------------------------------------------
  select coalesce(sum(s.balance_qty * public.stock_unit_factor(s.unit, 'g')), 0) into v_target_before_e
  from public.get_q7_inventory_snapshot(v_today) s
  where s.kitchen_inventory_item_id = v_target;

  perform public.reverse_material_issue_usage(v_issue);

  select m.quantity into v_rev_qty
  from public.q7_inventory_movements m
  where m.source = 'production_material_issue_reversal'
    and m.source_issue_id = v_issue
    and m.kitchen_inventory_item_id = v_source;
  if v_rev_qty is null then
    raise exception 'reverse_material_issue_usage did not write the reversal row';
  end if;

  -- Adjustments add their signed quantity, so the target absorbs the reversal
  -- converted by the merge factor.
  v_expected := v_target_before_e + v_rev_qty * 1000;

  select coalesce(sum(s.balance_qty * public.stock_unit_factor(s.unit, 'g')), 0) into v_target_snapshot
  from public.get_q7_inventory_snapshot(v_today) s
  where s.kitchen_inventory_item_id = v_target;
  if v_target_snapshot <> v_expected then
    raise exception 'target after usage reversal expected %, got %', v_expected, v_target_snapshot;
  end if;

  select coalesce((
      select sum(case m.movement_type when 'production_usage' then -m.quantity else m.quantity end)
      from public.q7_inventory_movements m
      where m.kitchen_inventory_item_id = v_source
    ), 0) + coalesce((
      select sum(coalesce(o.opening_qty, 0))
      from public.q7_inventory_openings o
      where o.kitchen_inventory_item_id = v_source
    ), 0)
    into v_source_raw;
  if v_source_raw <> 0 then
    raise exception 'source ledger must stay at 0 after usage reversal, got %', v_source_raw;
  end if;

  ------------------------------------------------------------------
  -- (g) Revert restores the four tables and re-activates the source
  ------------------------------------------------------------------
  perform public.revert_stock_item_merge(v_merge_id);

  -- Pre-merge source 4 + 3 - 2 = 5 kg, plus the forwarded +1 kg receipt and the
  -- reversed -2 kg usage that now belong to the source again.
  if (select active from public.kitchen_inventory_items where id = v_source) <> true then
    raise exception 'source must be active again after revert';
  end if;
  if (select merged_into_id from public.kitchen_inventory_items where id = v_source) is not null then
    raise exception 'source merged_into_id must be cleared after revert';
  end if;

  select coalesce(sum(s.balance_qty * public.stock_unit_factor(s.unit, 'g')), 0) into v_source_snapshot
  from public.get_q7_inventory_snapshot(v_today) s
  where s.kitchen_inventory_item_id = v_source;
  if v_source_snapshot <> 4000 then
    raise exception 'source after revert expected 4000 g, got %', v_source_snapshot;
  end if;

  select coalesce(sum(s.balance_qty * public.stock_unit_factor(s.unit, 'g')), 0) into v_target_snapshot
  from public.get_q7_inventory_snapshot(v_today) s
  where s.kitchen_inventory_item_id = v_target;
  if v_target_snapshot <> 0 then
    raise exception 'target after revert expected 0 g, got %', v_target_snapshot;
  end if;

  select to_jsonb(i) into v_row from public.production_material_issue_items i
  where i.kitchen_inventory_item_id = v_source;
  if v_row is distinct from v_issue_item_before then
    raise exception 'production_material_issue_items row was not restored';
  end if;

  select to_jsonb(a) into v_row from public.stock_material_aliases a
  where a.kitchen_inventory_item_id = v_source;
  if v_row is distinct from v_alias_before then
    raise exception 'stock_material_aliases row was not restored';
  end if;

  select to_jsonb(mp) into v_row from public.q7_material_issue_material_mappings mp
  where mp.kitchen_inventory_item_id = v_source;
  if v_row is distinct from v_mapping_before then
    raise exception 'q7_material_issue_material_mappings row was not restored';
  end if;

  select to_jsonb(s) into v_row from public.q7_purchase_item_settings s
  where s.kitchen_inventory_item_id = v_source;
  if v_row is distinct from v_setting_before then
    raise exception 'q7_purchase_item_settings row was not restored';
  end if;

  ------------------------------------------------------------------
  -- Approving a classify suggestion writes the item class
  ------------------------------------------------------------------
  insert into public.stock_catalog_suggestions
    (kind, item_id, proposed_class, probability, prompt_version, factor_source)
  values ('classify', v_target, 'raw_material', 0.82, 'smoke-' || v_suffix, null)
  returning id into v_suggestion;
  perform public.decide_stock_catalog_suggestion(v_suggestion, 'approve');
  if (select item_class from public.kitchen_inventory_items where id = v_target) <> 'raw_material' then
    raise exception 'classify approve did not write item_class';
  end if;
  if (select item_class_source from public.kitchen_inventory_items where id = v_target) <> 'jev' then
    raise exception 'classify approve should record item_class_source jev';
  end if;

  ------------------------------------------------------------------
  -- Linking kitchen items needs exactly one approved mapping
  ------------------------------------------------------------------
  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit)
  values ('SMOKE-LINK-' || v_suffix, 'smoke-link-' || v_suffix, 'ingredient', 'Smoke Link', 'kg')
  returning id into v_link_item;

  insert into public.q7_material_issue_material_mappings
    (canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit, conversion_factor, approval_status, approved_by, approved_at)
  values (v_material, 'kg-link', v_link_item, 'kg', 1, 'approved', v_actor, now());

  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit)
  values ('SMOKE-AMB-' || v_suffix, 'smoke-amb-' || v_suffix, 'ingredient', 'Smoke Ambiguous', 'kg')
  returning id into v_ambiguous_item;

  insert into public.sku_cogs_materials (material_code, canonical_name, normalized_name, default_unit)
  values ('SMOKE-CAT2-' || v_suffix, 'Smoke Bột Y', 'smoke-bot-y-' || v_suffix, 'kg');

  insert into public.q7_material_issue_material_mappings
    (canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit, conversion_factor, approval_status, approved_by, approved_at)
  select id, 'kg-amb', v_ambiguous_item, 'kg', 1, 'approved', v_actor, now()
  from public.sku_cogs_materials
  where material_code = 'SMOKE-CAT2-' || v_suffix;

  insert into public.q7_material_issue_material_mappings
    (canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit, conversion_factor, approval_status, approved_by, approved_at)
  select id, 'kg-amb2', v_ambiguous_item, 'kg', 1, 'approved', v_actor, now()
  from public.sku_cogs_materials
  where material_code = 'SMOKE-CAT-' || v_suffix;

  v_row := public.link_kitchen_items_to_canonical_materials();

  -- Report only (the guarded Material Master linker owns the write).
  if (v_row ->> 'writes')::boolean is distinct from false then
    raise exception 'link report must not write';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_row -> 'linkable_items') e
    where (e ->> 'item_id')::uuid = v_link_item and (e ->> 'material_id')::uuid = v_material
  ) then
    raise exception 'link report must list the single approved canonical material';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_row -> 'linkable_items') e
    where (e ->> 'item_id')::uuid = v_ambiguous_item
  ) then
    raise exception 'an item with several approved materials must not be reported as linkable';
  end if;
  if (select canonical_material_id from public.kitchen_inventory_items where id = v_link_item) is not null then
    raise exception 'link report must leave canonical_material_id untouched';
  end if;
  if (public.get_stock_catalog_review()->'item_class_counts') is null then
    raise exception 'get_stock_catalog_review must return item_class_counts';
  end if;

  raise notice 'stock catalog merge smoke passed';
end;
$smoke$;

rollback;
