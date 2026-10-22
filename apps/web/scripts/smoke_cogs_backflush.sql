-- Smoke test for 20261102590000_revenue_cogs_backflush.sql.
--
-- Run with:  supabase db query --linked -f scripts/smoke_cogs_backflush.sql
-- The whole file is one transaction and ends with ROLLBACK. It creates only
-- rollback-only smoke fixtures and never touches a row outside this transaction.
--
-- It exercises: map learning, dry trace, BÁNH NGỌT coverage, enabling Q7
-- backflush and giving back open PXK, delta posting/idempotency, the correcting
-- adjustment after a revenue line is superseded, the cutover guard, and anon
-- execute privileges.

begin;

-- Act as the service role on behalf of a real owner account (audit columns
-- reference auth.users, so a made-up sub would fail the foreign keys).
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'role', 'service_role',
    'sub', (select ur.user_id from public.user_roles ur where ur.role::text = 'owner' order by ur.user_id::text limit 1)
  )::text,
  true
);
select set_config(
  'request.jwt.claim.sub',
  (select ur.user_id::text from public.user_roles ur where ur.role::text = 'owner' order by ur.user_id::text limit 1),
  true
);

do $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_start date := (now() at time zone 'Asia/Ho_Chi_Minh')::date + 1;
  v_dry_from date := date '2026-10-01';
  v_dry_to date := date '2026-10-21';
  v_dry_line_date date := date '2026-10-15';
  v_doc uuid;
  v_line_today uuid;
  v_line_dry uuid;
  v_line_start uuid;
  v_bmq_sku uuid;
  v_version_id uuid;
  v_material_id uuid;
  v_recipe_unit text;
  v_smoke_item uuid;
  v_suffix text;
  v_map_sku uuid;
  v_map_status text;
  v_map_source text;
  v_pizza_channel text;
  v_pizza_code text;
  v_pizza_name_key text;
  v_pizza_sku uuid;
  v_pizza_expected uuid;
  v_before_q7 integer;
  v_before_tt integer;
  v_after_q7 integer;
  v_after_tt integer;
  v_trace_count integer;
  v_total_value numeric;
  v_mapped_value numeric;
  v_pre_reversals integer;
  v_post_reversals integer;
  v_unreversed integer;
  v_cogs_before integer;
  v_cogs_after integer;
  v_cogs_after2 integer;
  v_adjustments integer;
  v_bad_cutover integer;
  v_bad_anon integer;
  v_cutover date;
  v_refresh jsonb;
begin
  -- ---------------------------------------------------------------------
  -- Fixtures: one BMQ-001 revenue line today (map), one in the dry window
  -- (trace), one on the enabled start date (posting). Rolled back below.
  -- ---------------------------------------------------------------------
  select ps.id into v_bmq_sku
  from public.product_skus ps
  where upper(btrim(ps.sku_code)) = 'BMQ-001'
  order by ps.id::text
  limit 1;
  if v_bmq_sku is null then
    raise exception 'smoke: BMQ-001 SKU not found';
  end if;

  insert into public.revenue_source_documents(
    source_type, source_name, period, status, summary
  ) values (
    'manual_entry', 'COGS backflush smoke', to_char(v_today, 'YYYY-MM'), 'trusted', '{}'::jsonb
  ) returning id into v_doc;

  insert into public.revenue_ledger_lines(
    source_document_id, source_row_number, period, revenue_date, channel,
    source_tab, customer_name, product_code, product_name,
    quantity, unit_price, gross_revenue, source_type, approval_status, raw_payload
  ) values (
    v_doc, 1, to_char(v_today, 'YYYY-MM'), v_today, 'SMOKE COGS',
    'SMOKE', 'COGS smoke', 'BMQ-001', 'BMQ - Bánh mì tươi',
    1, 100000, 100000, 'manual_entry', 'approved', '{}'::jsonb
  ) returning id into v_line_today;

  insert into public.revenue_ledger_lines(
    source_document_id, source_row_number, period, revenue_date, channel,
    source_tab, customer_name, product_code, product_name,
    quantity, unit_price, gross_revenue, source_type, approval_status, raw_payload
  ) values (
    v_doc, 2, to_char(v_dry_line_date, 'YYYY-MM'), v_dry_line_date, 'SMOKE COGS',
    'SMOKE', 'COGS smoke', 'BMQ-001', 'BMQ - Bánh mì tươi',
    1, 100000, 100000, 'manual_entry', 'approved', '{}'::jsonb
  ) returning id into v_line_dry;

  insert into public.revenue_ledger_lines(
    source_document_id, source_row_number, period, revenue_date, channel,
    source_tab, customer_name, product_code, product_name,
    quantity, unit_price, gross_revenue, source_type, approval_status, raw_payload
  ) values (
    v_doc, 3, to_char(v_start, 'YYYY-MM'), v_start, 'SMOKE COGS',
    'SMOKE', 'COGS smoke', 'BMQ-001', 'BMQ - Bánh mì tươi',
    1, 100000, 100000, 'manual_entry', 'approved', '{}'::jsonb
  ) returning id into v_line_start;

  -- Find the recipe version and one material used on the start date, then
  -- pin that one ingredient to a rollback-only Q7 item with factor 1.
  select v.id into v_version_id
  from public.sku_cogs_versions v
  where v.sku_id = v_bmq_sku
    and v.effective_from <= v_start
    and (v.effective_to is null or v_start <= v.effective_to)
  order by v.effective_from desc, v.version_no desc, v.id::text desc
  limit 1;

  select f.canonical_material_id, public.normalize_document_unit(f.unit)
    into v_material_id, v_recipe_unit
  from (
    select f.canonical_material_id, f.unit, f.sort_order, f.id
    from public.sku_cogs_version_formulations f
    where v_version_id is not null and f.version_id = v_version_id
    union all
    select f.canonical_material_id, f.unit, f.sort_order, f.id
    from public.sku_formulations f
    where v_version_id is null and f.sku_id = v_bmq_sku
  ) f
  where f.canonical_material_id is not null
    and public.normalize_document_unit(f.unit) is not null
  order by f.sort_order, f.id
  limit 1;

  if v_material_id is null then
    raise exception 'smoke: BMQ-001 has no canonical recipe ingredient';
  end if;

  v_suffix := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  insert into public.kitchen_inventory_items(
    item_code, normalized_key, item_type, name, unit, item_class,
    canonical_material_id, pastry_q7, active
  ) values (
    'COGS-SMOKE-' || v_suffix,
    'cogs smoke ' || v_suffix,
    'ingredient',
    'COGS smoke material ' || v_suffix,
    'g',
    'raw_material',
    v_material_id,
    true,
    true
  ) returning id into v_smoke_item;

  insert into public.cogs_ingredient_stock_map(
    canonical_material_id, recipe_unit, action, location,
    kitchen_inventory_item_id, factor, status, source, reason, evidence
  ) values (
    v_material_id, v_recipe_unit, 'deduct', 'q7', v_smoke_item, 1,
    'confirmed', 'manual', null, '{}'::jsonb
  )
  on conflict (canonical_material_id, recipe_unit) do update
  set action = 'deduct',
      location = 'q7',
      kitchen_inventory_item_id = excluded.kitchen_inventory_item_id,
      factor = 1,
      status = 'confirmed',
      source = 'manual',
      reason = null,
      evidence = '{}'::jsonb,
      updated_at = now();

  v_refresh := public.cogs_refresh_mappings();

  select m.sku_id, m.status, m.source
    into v_map_sku, v_map_status, v_map_source
  from public.revenue_product_sku_map m
  where m.channel = 'SMOKE COGS'
    and m.product_code = 'BMQ-001'
  order by m.id::text
  limit 1;

  if v_map_sku is distinct from v_bmq_sku
     or v_map_status is distinct from 'auto'
     or v_map_source is distinct from 'exact_code' then
    raise exception 'smoke: BMQ-001 did not map auto/exact_code (%, %, %)',
      v_map_sku, v_map_status, v_map_source;
  end if;

  -- The existing BÁNH CUA PHÔ MAI 90G revenue line must map to the SKU whose
  -- production-order line is named BÁNH CUA PHÔ MAI.
  select l.channel, l.product_code,
         regexp_replace(
           coalesce(public.normalize_stock_item_name(l.product_name), ''),
           '^bmq\s*-\s*', '', 'i'
         )
    into v_pizza_channel, v_pizza_code, v_pizza_name_key
  from public.revenue_ledger_lines l
  where l.approval_status = 'approved'
    and l.quantity > 0
    and public.normalize_stock_item_name(l.product_name) like '%banh cua pho mai 90g%'
  order by l.revenue_date desc, l.id
  limit 1;
  if v_pizza_name_key is null then
    raise exception 'smoke: approved BÁNH CUA PHÔ MAI 90G revenue line not found';
  end if;

  select m.sku_id into v_pizza_sku
  from public.revenue_product_sku_map m
  where m.status in ('auto', 'confirmed')
    and m.sku_id is not null
    and (
      (
        v_pizza_code is not null
        and m.product_code is not null
        and lower(m.product_code) = lower(v_pizza_code)
        and lower(coalesce(m.channel, '')) = lower(coalesce(v_pizza_channel, ''))
      )
      or (
        v_pizza_code is not null
        and m.product_code is not null
        and lower(m.product_code) = lower(v_pizza_code)
      )
      or (
        m.name_key = v_pizza_name_key
        and lower(coalesce(m.channel, '')) = lower(coalesce(v_pizza_channel, ''))
      )
    )
  order by
    case
      when v_pizza_code is not null
           and m.product_code is not null
           and lower(m.product_code) = lower(v_pizza_code)
           and lower(coalesce(m.channel, '')) = lower(coalesce(v_pizza_channel, '')) then 0
      when v_pizza_code is not null
           and m.product_code is not null
           and lower(m.product_code) = lower(v_pizza_code) then 1
      else 2
    end,
    m.updated_at desc,
    m.id::text
  limit 1;

  select poi.sku_id into v_pizza_expected
  from public.production_order_items poi
  where poi.sku_id is not null
    and public.normalize_stock_item_name(poi.product_name) = 'banh cua pho mai'
  order by poi.id::text
  limit 1;

  if v_pizza_sku is null or v_pizza_expected is null or v_pizza_sku <> v_pizza_expected then
    raise exception 'smoke: BÁNH CUA PHÔ MAI 90G did not map to the production-name SKU (%, %)',
      v_pizza_sku, v_pizza_expected;
  end if;

  -- ---------------------------------------------------------------------
  -- Dry run: no ledger write, trace filled.
  -- ---------------------------------------------------------------------
  select count(*) into v_before_q7 from public.q7_inventory_movements;
  select count(*) into v_before_tt from public.tan_tao_material_movements;

  perform public.run_cogs_backflush(v_dry_from, v_dry_to, true);

  select count(*) into v_after_q7 from public.q7_inventory_movements;
  select count(*) into v_after_tt from public.tan_tao_material_movements;
  if v_after_q7 <> v_before_q7 or v_after_tt <> v_before_tt then
    raise exception 'smoke: dry run wrote a ledger row (%, %, %, %)',
      v_before_q7, v_after_q7, v_before_tt, v_after_tt;
  end if;

  select count(*) into v_trace_count
  from public.cogs_backflush_trace
  where revenue_date between v_dry_from and v_dry_to;
  if v_trace_count = 0 then
    raise exception 'smoke: dry run did not fill cogs_backflush_trace';
  end if;

  -- At least 95% of approved BÁNH NGỌT value in the window is SKU-mapped.
  select coalesce(sum(l.gross_revenue), 0),
         coalesce(sum(l.gross_revenue) filter (
           where exists (
             select 1
             from public.cogs_backflush_trace t
             where t.revenue_line_id = l.id
               and t.sku_id is not null
           )
         ), 0)
    into v_total_value, v_mapped_value
  from public.revenue_ledger_lines l
  where l.approval_status = 'approved'
    and l.quantity > 0
    and l.revenue_date between v_dry_from and v_dry_to
    and public.normalize_stock_item_name(l.channel) like '%banh ngot%';

  if v_total_value <= 0 then
    raise exception 'smoke: no approved BÁNH NGỌT revenue value in the window';
  end if;
  if v_mapped_value / v_total_value < 0.95 then
    raise exception 'smoke: BÁNH NGỌT mapped value %.2f%% is below 95%%',
      round(100.0 * v_mapped_value / v_total_value, 2);
  end if;

  -- ---------------------------------------------------------------------
  -- Enable Q7 from tomorrow: open PXK usage on/after start is given back.
  -- ---------------------------------------------------------------------
  select count(*) into v_pre_reversals
  from public.q7_inventory_movements m
  where m.source = 'production_material_issue'
    and m.movement_date < v_start
    and exists (
      select 1
      from public.q7_inventory_movements r
      where r.source = 'production_material_issue_reversal'
        and r.source_ref_key = 'pmi-item-reverse:' || m.source_issue_item_id::text
    );

  perform public.cogs_set_backflush(
    'q7', true, v_start, 'c09c0000-0000-4000-8000-000000000001'::uuid
  );

  select count(*) into v_post_reversals
  from public.q7_inventory_movements m
  where m.source = 'production_material_issue'
    and m.movement_date < v_start
    and exists (
      select 1
      from public.q7_inventory_movements r
      where r.source = 'production_material_issue_reversal'
        and r.source_ref_key = 'pmi-item-reverse:' || m.source_issue_item_id::text
    );
  if v_post_reversals <> v_pre_reversals then
    raise exception 'smoke: enabling Q7 changed a pre-start PXK reversal count (% -> %)',
      v_pre_reversals, v_post_reversals;
  end if;

  select count(*) into v_unreversed
  from public.q7_inventory_movements m
  where m.source = 'production_material_issue'
    and m.movement_date >= v_start
    and m.source_issue_item_id is not null
    and not exists (
      select 1
      from public.q7_inventory_movements r
      where r.source = 'production_material_issue_reversal'
        and r.source_ref_key = 'pmi-item-reverse:' || m.source_issue_item_id::text
    );
  if v_unreversed <> 0 then
    raise exception 'smoke: % PXK usage row(s) on/after start are not given back', v_unreversed;
  end if;

  -- ---------------------------------------------------------------------
  -- Posting: first run writes, second is a no-op.
  -- ---------------------------------------------------------------------
  select count(*) into v_cogs_before
  from public.q7_inventory_movements
  where source = 'revenue_cogs';

  perform public.run_cogs_backflush(v_start, v_start + 13, false);

  select count(*) into v_cogs_after
  from public.q7_inventory_movements
  where source = 'revenue_cogs';
  if v_cogs_after <= v_cogs_before then
    raise exception 'smoke: first non-dry run did not post revenue_cogs (%, %)',
      v_cogs_before, v_cogs_after;
  end if;

  perform public.run_cogs_backflush(v_start, v_start + 13, false);
  select count(*) into v_cogs_after2
  from public.q7_inventory_movements
  where source = 'revenue_cogs';
  if v_cogs_after2 <> v_cogs_after then
    raise exception 'smoke: second identical run inserted % row(s)', v_cogs_after2 - v_cogs_after;
  end if;

  -- Superseding the fixture line must produce a correcting adjustment.
  update public.revenue_ledger_lines
  set approval_status = 'superseded',
      updated_at = now()
  where id = v_line_start;

  perform public.run_cogs_backflush(v_start, v_start + 13, false);

  select count(*) into v_adjustments
  from public.q7_inventory_movements
  where source = 'revenue_cogs'
    and movement_type = 'adjustment'
    and movement_date between v_start and v_start + 13;
  if v_adjustments = 0 then
    raise exception 'smoke: superseded revenue did not produce a revenue_cogs adjustment';
  end if;

  -- No backflush row may sit on/before the Q7 stock-count cutover.
  v_cutover := public.stock_ledger_cutover_date('q7');
  select count(*) into v_bad_cutover
  from public.q7_inventory_movements
  where source = 'revenue_cogs'
    and v_cutover is not null
    and movement_date <= v_cutover;
  if v_bad_cutover <> 0 then
    raise exception 'smoke: % revenue_cogs row(s) are on/before the Q7 cutover', v_bad_cutover;
  end if;

  -- ---------------------------------------------------------------------
  -- anon cannot execute any new RPC.
  -- ---------------------------------------------------------------------
  select count(*) into v_bad_anon
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'cogs_refresh_mappings', 'cogs_explode_revenue',
      'run_cogs_backflush', 'run_cogs_backflush_scheduled',
      'run_cogs_backflush_nightly', 'cogs_set_backflush',
      'cogs_decide_revenue_product', 'cogs_decide_ingredient',
      'cogs_backflush_overview', 'cogs_item_usage_trace',
      'post_material_issue_usage', 'kho_get_commitments'
    )
    and has_function_privilege('anon', p.oid, 'execute');
  if v_bad_anon <> 0 then
    raise exception 'smoke: anon has execute on % new function(s)', v_bad_anon;
  end if;
end;
$$;

select
  'PASS' as result,
  (select count(*) from public.cogs_backflush_trace) as trace_rows,
  (select count(*) from public.cogs_backflush_runs) as run_rows,
  (select count(*) from public.q7_inventory_movements where source = 'revenue_cogs') as q7_cogs_rows,
  (select count(*) from public.cogs_backflush_settings where enabled) as enabled_locations;

rollback;
