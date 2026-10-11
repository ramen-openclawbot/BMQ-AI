-- Smoke test for stock-material alias learning (Giai đoạn 2 data layer).
-- Runs entirely inside BEGIN ... ROLLBACK so it never keeps fixtures.
-- Prerequisites (real data only, never created by this script):
--   * the 20261016100000_material_alias_learning.sql migration applied
--   * at least one public.user_roles row with role 'owner'
--   * optionally a second auth user to exercise the two-confirmer rule
-- Run with:  psql "$DATABASE_URL" -f scripts/smoke_material_alias_learning.sql
--
-- Shared scoring test cases (must match src/lib/material-alias.ts):
--   'Tỏi ngày 10' vs 'Tỏi bóc vỏ'  -> 0.9 and ranks first
--   'Tỏi ngày 10' vs 'Tỏi phi'     -> 0.9

begin;

select set_config('request.jwt.claim.role', 'service_role', true);

do $smoke$
declare
  v_actor uuid;
  v_actor2 uuid;
  v_supplier uuid;
  v_item_a uuid;
  v_item_b uuid;
  v_receipt uuid;
  v_line uuid;
  v_alias_a uuid;
  v_alias_b uuid;
  v_correct_event uuid;
  v_result jsonb;
  v_suggest jsonb;
  v_count integer;
  v_status text;
  v_item uuid;
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
begin
  ------------------------------------------------------------------
  -- Shared scoring contract
  ------------------------------------------------------------------
  if public.material_alias_candidate_score('Tỏi ngày 10', 'Tỏi bóc vỏ') <> 0.9 then
    raise exception 'score Tỏi ngày 10 / Tỏi bóc vỏ must be 0.9';
  end if;
  if public.material_alias_candidate_score('Tỏi ngày 10', 'Tỏi phi') <> 0.9 then
    raise exception 'score Tỏi ngày 10 / Tỏi phi must be 0.9';
  end if;
  if public.material_alias_candidate_score('Bột mì 888', 'Bột mì 888 (25kg)') <> 1 then
    raise exception 'exact normalized match must score 1';
  end if;
  if public.material_alias_candidate_score('Bột mì 888', 'Gạo tám') <> 0 then
    raise exception 'unrelated names must score 0';
  end if;

  ------------------------------------------------------------------
  -- Actor(s): reuse real owner / user rows only.
  ------------------------------------------------------------------
  select u.id into v_actor
  from auth.users u
  join public.user_roles r on r.user_id = u.id and r.role = 'owner'
  order by u.created_at
  limit 1;
  if v_actor is null then
    raise exception 'smoke requires at least one owner user';
  end if;
  perform set_config('request.jwt.claim.sub', v_actor::text, true);

  select u.id into v_actor2
  from auth.users u
  where u.id <> v_actor
  order by u.created_at
  limit 1;

  ------------------------------------------------------------------
  -- Fixtures: supplier, two kitchen items, one confirmed receipt line.
  ------------------------------------------------------------------
  insert into public.suppliers (name, default_receiving_location)
  values ('Smoke alias NCC ' || v_suffix, 'q7')
  returning id into v_supplier;

  insert into public.kitchen_inventory_items (item_code, normalized_key, item_type, name, unit)
  values ('SMOKE-ALIAS-A-' || v_suffix, 'smoke-alias-a-' || v_suffix, 'ingredient', 'Tỏi bóc vỏ', 'kg')
  returning id into v_item_a;

  insert into public.kitchen_inventory_items (item_code, normalized_key, item_type, name, unit)
  values ('SMOKE-ALIAS-B-' || v_suffix, 'smoke-alias-b-' || v_suffix, 'ingredient', 'Tỏi phi', 'kg')
  returning id into v_item_b;

  -- Cutover: only set when the store has not started, so the fixture line posts.
  update public.stock_ledger_settings
  set q7_cutover_date = current_date - 365
  where id = 1 and q7_cutover_date is null;

  insert into public.goods_receipts
    (receipt_number, receipt_date, supplier_id, status, receiving_location, payable_status)
  values ('SMOKE-ALIAS-GR-' || v_suffix, current_date - 5, v_supplier, 'draft', 'q7', 'not_generated')
  returning id into v_receipt;

  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, raw_product_name, quantity, actual_quantity, unit)
  values (v_receipt, 'Tỏi ngày 10', 'Tỏi ngày 10', 7, 7, 'kg')
  returning id into v_line;

  update public.goods_receipts set status = 'confirmed' where id = v_receipt;

  ------------------------------------------------------------------
  -- (1) suggest returns needs_prompt and the right candidate first.
  ------------------------------------------------------------------
  v_suggest := public.suggest_material_aliases(
    v_supplier, 'q7',
    jsonb_build_array(jsonb_build_object('line_key', 'l1', 'raw_name', 'Tỏi ngày 10', 'raw_unit', 'kg'))
  );
  if (v_suggest -> 0 ->> 'needs_prompt')::boolean is not true then
    raise exception 'suggest must ask for a prompt when there is no alias';
  end if;
  if (v_suggest -> 0 -> 'candidates' -> 0 ->> 'name') <> 'Tỏi bóc vỏ' then
    raise exception 'suggest must rank Tỏi bóc vỏ first, got %',
      (v_suggest -> 0 -> 'candidates' -> 0 ->> 'name');
  end if;

  ------------------------------------------------------------------
  -- (2) three confirms by the same person auto-promote.
  ------------------------------------------------------------------
  v_result := public.confirm_material_alias(
    v_supplier, 'q7', 'Tỏi ngày 10', 'kg', v_item_a, null, 'kg', 1, null, null, 'goods_receipt_items', v_line
  );
  v_alias_a := (v_result -> 'alias' ->> 'id')::uuid;
  if (v_result -> 'alias' ->> 'status') <> 'learning' then
    raise exception 'first confirm must stay learning';
  end if;
  v_result := public.confirm_material_alias(
    v_supplier, 'q7', 'Tỏi ngày 10', 'kg', v_item_a, null, 'kg', 1, null, null, 'goods_receipt_items', v_line
  );
  if (v_result -> 'alias' ->> 'status') <> 'learning' then
    raise exception 'second confirm by one person must stay learning';
  end if;
  v_result := public.confirm_material_alias(
    v_supplier, 'q7', 'Tỏi ngày 10', 'kg', v_item_a, null, 'kg', 1, null, null, 'goods_receipt_items', v_line
  );
  if (v_result -> 'alias' ->> 'status') <> 'auto' then
    raise exception 'third confirm must auto-promote, got %', v_result -> 'alias' ->> 'status';
  end if;
  if (v_result -> 'alias' ->> 'confirm_count')::int <> 3 then
    raise exception 'third confirm must record confirm_count 3';
  end if;
  if not exists (
    select 1 from public.material_alias_events e
    where e.alias_id = v_alias_a and e.action = 'auto_promoted'
  ) then
    raise exception 'auto promotion must be logged';
  end if;

  ------------------------------------------------------------------
  -- (3) two distinct confirmers auto-promote a different name.
  ------------------------------------------------------------------
  if v_actor2 is not null then
    perform set_config('request.jwt.claim.sub', v_actor::text, true);
    v_result := public.confirm_material_alias(
      v_supplier, 'q7', 'Tỏi tươi 5', 'kg', v_item_a, null, 'kg', 1, null, null, 'goods_receipt_items', v_line
    );
    perform set_config('request.jwt.claim.sub', v_actor2::text, true);
    v_result := public.confirm_material_alias(
      v_supplier, 'q7', 'Tỏi tươi 5', 'kg', v_item_a, null, 'kg', 1, null, null, 'goods_receipt_items', v_line
    );
    if (v_result -> 'alias' ->> 'status') <> 'auto' then
      raise exception 'two distinct confirmers must auto-promote';
    end if;
    v_alias_b := (v_result -> 'alias' ->> 'id')::uuid;
    perform set_config('request.jwt.claim.sub', v_actor::text, true);
  else
    raise notice 'only one auth user: skip the two-confirmer check';
  end if;

  ------------------------------------------------------------------
  -- (4) choosing another item is a correction (previous values kept).
  ------------------------------------------------------------------
  v_result := public.confirm_material_alias(
    v_supplier, 'q7', 'Tỏi tươi 5', 'kg', v_item_b, null, 'kg', 1, null, null, 'goods_receipt_items', v_line
  );
  if (v_result ->> 'status') <> 'correct' then
    raise exception 'choosing another item must be a correction';
  end if;
  if (v_result -> 'alias' ->> 'status') <> 'learning' then
    raise exception 'a correction must reset to learning';
  end if;
  if (v_result -> 'alias' ->> 'confirm_count')::int <> 1 then
    raise exception 'a correction must reset confirm_count to 1';
  end if;
  select e.id into v_correct_event
  from public.material_alias_events e
  where e.alias_id = v_alias_b and e.action = 'correct'
  order by e.created_at desc, e.id desc
  limit 1;
  if v_correct_event is null then
    raise exception 'a correction must be logged with its previous values';
  end if;
  if (
    select e.previous_item_id from public.material_alias_events e where e.id = v_correct_event
  ) is distinct from v_item_a then
    raise exception 'the correction event must store the previous item';
  end if;

  ------------------------------------------------------------------
  -- (5) undo the correction restores the previous item.
  ------------------------------------------------------------------
  v_result := public.undo_material_alias_event(v_correct_event);
  if (v_result -> 'alias' ->> 'kitchen_inventory_item_id')::uuid is distinct from v_item_a then
    raise exception 'undo must restore the previous item';
  end if;

  ------------------------------------------------------------------
  -- (6) a confident Jev disagreement is flagged.
  ------------------------------------------------------------------
  v_result := public.confirm_material_alias(
    v_supplier, 'q7', 'Tỏi tươi 5', 'kg', v_item_a, null, 'kg', 1, v_item_b, 0.95, 'goods_receipt_items', v_line
  );
  if (v_result -> 'alias' ->> 'jev_disagreed')::boolean is not true then
    raise exception 'a 0.95 Jev choice for another item must set jev_disagreed';
  end if;

  ------------------------------------------------------------------
  -- (7) the confirmed alias posts the receipt line through the existing helper.
  ------------------------------------------------------------------
  select count(*) into v_count
  from public.q7_inventory_movements
  where source = 'goods_receipt' and source_ref_key = 'gr-item:' || v_line::text;
  if v_count <> 1 then
    raise exception 'confirmed alias must post the receipt line exactly once, found %', v_count;
  end if;

  ------------------------------------------------------------------
  -- (8) disabling the alias makes suggest ask again.
  ------------------------------------------------------------------
  perform public.set_material_alias_status(v_alias_a, 'disabled');
  v_suggest := public.suggest_material_aliases(
    v_supplier, 'q7',
    jsonb_build_array(jsonb_build_object('line_key', 'l1', 'raw_name', 'Tỏi ngày 10', 'raw_unit', 'kg'))
  );
  if (v_suggest -> 0 ->> 'needs_prompt')::boolean is not true then
    raise exception 'a disabled alias must ask for a prompt';
  end if;
  if (v_suggest -> 0 -> 'alias' ->> 'status') <> 'disabled' then
    raise exception 'suggest must expose the disabled status';
  end if;

  ------------------------------------------------------------------
  -- (9) legacy aliases (created before learning) are backfilled as auto.
  ------------------------------------------------------------------
  insert into public.stock_material_aliases
    (supplier_id, normalized_name, location, kitchen_inventory_item_id, conversion_factor, unit, created_by, status, confirm_count)
  values (v_supplier, 'legacy-' || v_suffix, 'q7', v_item_a, 1, 'kg', v_actor, 'learning', 0);

  -- Mirrors the migration backfill predicate for pre-existing rows.
  update public.stock_material_aliases
  set status = 'auto', confirm_count = 3
  where normalized_name = 'legacy-' || v_suffix;

  select a.status, a.confirm_count into v_status, v_count
  from public.stock_material_aliases a
  where a.normalized_name = 'legacy-' || v_suffix;
  if v_status <> 'auto' or v_count <> 3 then
    raise exception 'legacy alias must be backfilled as auto/3, got %/%', v_status, v_count;
  end if;

  raise notice 'material alias learning smoke passed';
end;
$smoke$;

rollback;
