-- Smoke test for the Q7 automatic purchasing flow.
-- Runs entirely inside BEGIN ... ROLLBACK so it never keeps fixtures.
-- Prerequisites (real data only, never created by this script):
--   * at least one public.user_roles row with role 'owner'
-- Run with:  psql "$DATABASE_URL" -f scripts/smoke_q7_auto_purchase.sql

begin;

select set_config('request.jwt.claim.role', 'service_role', true);

do $smoke$
declare
  v_actor uuid;
  v_supplier_a uuid;
  v_supplier_b uuid;
  v_material_a uuid;
  v_material_b uuid;
  v_material_c uuid;
  v_item_a uuid;
  v_item_b uuid;
  v_item_c uuid;
  v_mapping_a uuid;
  v_mapping_b uuid;
  v_mapping_c uuid;
  v_po_src uuid;
  v_poi_src uuid;
  v_day integer;
  v_issue uuid;
  v_result jsonb;
  v_run jsonb;
  v_count integer;
  v_sent integer;
  v_draft integer;
  v_qty numeric;
  v_pack numeric;
  v_note date;
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
begin
  ------------------------------------------------------------------
  -- Actor: the first owner (the system actor must be an owner).
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

  ------------------------------------------------------------------
  -- Fixtures: two suppliers, three items and their aliases/mappings.
  ------------------------------------------------------------------
  insert into public.suppliers (name, default_receiving_location)
  values ('Smoke NCC A ' || v_suffix, 'q7') returning id into v_supplier_a;
  insert into public.suppliers (name, default_receiving_location)
  values ('Smoke NCC B ' || v_suffix, 'q7') returning id into v_supplier_b;

  insert into public.sku_cogs_materials (material_code, canonical_name, normalized_name, default_unit)
  values ('SMOKE-Q7A-' || v_suffix, 'Smoke NVL A', 'smoke-nvl-a-' || v_suffix, 'kg')
  returning id into v_material_a;
  insert into public.sku_cogs_materials (material_code, canonical_name, normalized_name, default_unit)
  values ('SMOKE-Q7B-' || v_suffix, 'Smoke NVL B', 'smoke-nvl-b-' || v_suffix, 'kg')
  returning id into v_material_b;
  insert into public.sku_cogs_materials (material_code, canonical_name, normalized_name, default_unit)
  values ('SMOKE-Q7C-' || v_suffix, 'Smoke NVL C', 'smoke-nvl-c-' || v_suffix, 'g')
  returning id into v_material_c;

  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit, canonical_material_id, material_resolution_status)
  values ('SMOKE-Q7-A-' || v_suffix, 'smoke-q7-a-' || v_suffix, 'ingredient',
          'Smoke bột A', 'kg', v_material_a, 'linked')
  returning id into v_item_a;
  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit, canonical_material_id, material_resolution_status)
  values ('SMOKE-Q7-B-' || v_suffix, 'smoke-q7-b-' || v_suffix, 'ingredient',
          'Smoke bột B', 'kg', v_material_b, 'linked')
  returning id into v_item_b;
  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit, canonical_material_id, material_resolution_status)
  values ('SMOKE-Q7-C-' || v_suffix, 'smoke-q7-c-' || v_suffix, 'ingredient',
          'Smoke bột C (25kg)', 'g', v_material_c, 'linked')
  returning id into v_item_c;

  insert into public.q7_material_issue_material_mappings
    (canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit, conversion_factor, approval_status, approved_by, approved_at)
  values (v_material_a, 'kg', v_item_a, 'kg', 1, 'approved', v_actor, now())
  returning id into v_mapping_a;
  insert into public.q7_material_issue_material_mappings
    (canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit, conversion_factor, approval_status, approved_by, approved_at)
  values (v_material_b, 'kg', v_item_b, 'kg', 1, 'approved', v_actor, now())
  returning id into v_mapping_b;
  insert into public.q7_material_issue_material_mappings
    (canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit, conversion_factor, approval_status, approved_by, approved_at)
  values (v_material_c, 'g', v_item_c, 'g', 1, 'approved', v_actor, now())
  returning id into v_mapping_c;

  -- Generic aliases let the forecast read a last unit price from PO lines.
  insert into public.stock_material_aliases
    (supplier_id, normalized_name, location, kitchen_inventory_item_id, conversion_factor, unit, created_by)
  values (null, public.normalize_stock_item_name('Smoke A NVL'), 'q7', v_item_a, 1, 'kg', v_actor);
  insert into public.stock_material_aliases
    (supplier_id, normalized_name, location, kitchen_inventory_item_id, conversion_factor, unit, created_by)
  values (null, public.normalize_stock_item_name('Smoke B NVL'), 'q7', v_item_b, 1, 'kg', v_actor);

  -- A completed PO supplies each item's last price (never counts as inbound).
  insert into public.purchase_orders (po_number, supplier_id, status, order_date, notes, total_amount, created_by)
  values ('SMOKE-PO-A-' || v_suffix, v_supplier_a, 'completed', current_date - 10, 'smoke price A', 20000, v_actor)
  returning id into v_po_src;
  insert into public.purchase_order_items (purchase_order_id, product_name, quantity, unit, unit_price, line_total)
  values (v_po_src, 'Smoke A NVL', 1, 'kg', 20000, 20000);

  insert into public.purchase_orders (po_number, supplier_id, status, order_date, notes, total_amount, created_by)
  values ('SMOKE-PO-B-' || v_suffix, v_supplier_b, 'completed', current_date - 10, 'smoke price B', 30000, v_actor)
  returning id into v_po_src;
  insert into public.purchase_order_items (purchase_order_id, product_name, quantity, unit, unit_price, line_total)
  values (v_po_src, 'Smoke B NVL', 1, 'kg', 30000, 30000);

  ------------------------------------------------------------------
  -- Item preferences: A auto_send, B auto_send, C suggest.
  ------------------------------------------------------------------
  insert into public.q7_purchase_item_settings
    (kitchen_inventory_item_id, mode, supplier_id, pack_size, pack_label, lead_time_days, safety_days, order_cycle_days)
  values (v_item_a, 'auto_send', v_supplier_a, 25, '25kg', 2, 2, 7);
  insert into public.q7_purchase_item_settings
    (kitchen_inventory_item_id, mode, supplier_id, pack_size, pack_label, lead_time_days, safety_days, order_cycle_days)
  values (v_item_b, 'auto_send', v_supplier_b, 25, '25kg', 2, 2, 7);
  insert into public.q7_purchase_item_settings
    (kitchen_inventory_item_id, mode, order_cycle_days)
  values (v_item_c, 'suggest', 7);

  ------------------------------------------------------------------
  -- 21 days of Q7 material issues (10 units/day per item) with the
  -- cutover cleared so usage does not post into the ledger yet.
  ------------------------------------------------------------------
  update public.stock_ledger_settings set q7_cutover_date = null, updated_at = now() where id = 1;

  -- One production order per day: (production_order_id, revision) is unique.
  for v_day in 1..21 loop
    insert into public.production_orders (production_number)
    values ('SMOKE-Q7-SX-' || v_suffix || '-' || v_day)
    returning id into v_po_src;
    insert into public.production_order_items (production_order_id, product_name, unit)
    values (v_po_src, 'Smoke bánh mì', 'cái')
    returning id into v_poi_src;

    insert into public.production_material_issues
      (issue_number, production_order_id, issue_date, status, location_code, revision, source_hash, is_current)
    values ('SMOKE-Q7-PXK-' || v_suffix || '-' || v_day, v_po_src, current_date - v_day,
            'pdf_ready', 'q7', 1, repeat('b', 64), true)
    returning id into v_issue;

    insert into public.production_material_issue_items
      (material_issue_id, production_order_item_id, kitchen_inventory_item_id, ingredient_name,
       required_qty, unit, source_ref_key, canonical_material_id, q7_mapping_id, source_unit, conversion_factor)
    values (v_issue, v_poi_src, v_item_a, 'Smoke bột A', 10, 'kg', 'a-' || v_suffix || '-' || v_day,
            v_material_a, v_mapping_a, 'kg', 1);
    insert into public.production_material_issue_items
      (material_issue_id, production_order_item_id, kitchen_inventory_item_id, ingredient_name,
       required_qty, unit, source_ref_key, canonical_material_id, q7_mapping_id, source_unit, conversion_factor)
    values (v_issue, v_poi_src, v_item_b, 'Smoke bột B', 10, 'kg', 'b-' || v_suffix || '-' || v_day,
            v_material_b, v_mapping_b, 'kg', 1);
    insert into public.production_material_issue_items
      (material_issue_id, production_order_item_id, kitchen_inventory_item_id, ingredient_name,
       required_qty, unit, source_ref_key, canonical_material_id, q7_mapping_id, source_unit, conversion_factor)
    values (v_issue, v_poi_src, v_item_c, 'Smoke bột C', 10, 'g', 'c-' || v_suffix || '-' || v_day,
            v_material_c, v_mapping_c, 'g', 1);
  end loop;

  -- A fresh count for A (on-hand 10) and a stale count for B (on-hand 5).
  v_result := public.record_q7_stock_count(v_item_a, 10, current_date - 2, 'Smoke kiểm kê A', 'smoke-a-' || v_suffix);
  v_result := public.record_q7_stock_count(v_item_b, 5, current_date - 30, 'Smoke kiểm kê B', 'smoke-b-' || v_suffix);

  ------------------------------------------------------------------
  -- 1. Disabled: a run is recorded but no PO is created.
  ------------------------------------------------------------------
  update public.q7_auto_purchase_settings
  set enabled = false, system_actor_id = v_actor,
      max_po_amount = 10000000, max_daily_amount = 30000000,
      max_stock_count_age_days = 10, max_backtest_error = 0.25
  where id = 1;

  v_run := public.run_q7_auto_purchase(current_date - 2);
  if v_run ->> 'status' <> 'disabled' then
    raise exception 'disabled run expected, got %', v_run ->> 'status';
  end if;
  select count(*) into v_count
  from public.purchase_orders
  where notes = 'Tự động từ dự báo NVL Q7 ' || (current_date - 2)::text;
  if v_count <> 0 then
    raise exception 'disabled run must not create POs, found %', v_count;
  end if;

  ------------------------------------------------------------------
  -- 2. Enabled: A auto_send is sent, rounded to the 25kg pack.
  ------------------------------------------------------------------
  update public.q7_auto_purchase_settings set enabled = true, updated_at = now() where id = 1;

  v_run := public.run_q7_auto_purchase(current_date);
  if v_run ->> 'status' <> 'done' then
    raise exception 'enabled run expected done, got %', v_run ->> 'status';
  end if;

  select count(*) into v_sent
  from public.purchase_orders
  where status = 'sent'
    and notes = 'Tự động từ dự báo NVL Q7 ' || current_date::text;
  if v_sent <> 1 then
    raise exception 'expected exactly one sent PO, found %', v_sent;
  end if;

  select poi.quantity into v_qty
  from public.purchase_order_items poi
  join public.purchase_orders po on po.id = poi.purchase_order_id
  where po.status = 'sent'
    and po.notes = 'Tự động từ dự báo NVL Q7 ' || current_date::text
    and poi.product_name = 'Smoke bột A';
  if v_qty is distinct from 4 then
    raise exception 'A pack-rounded quantity expected 4, found %', v_qty;
  end if;

  ------------------------------------------------------------------
  -- 3. B stale count: the PO stays draft with stale_stock_count.
  ------------------------------------------------------------------
  select count(*) into v_draft
  from public.purchase_orders
  where status = 'draft'
    and notes = 'Tự động từ dự báo NVL Q7 ' || current_date::text;
  if v_draft <> 1 then
    raise exception 'expected exactly one draft PO, found %', v_draft;
  end if;

  if not exists (
    select 1
    from public.q7_auto_purchase_decisions d
    join public.q7_auto_purchase_runs r on r.id = d.run_id
    where r.run_date = current_date
      and d.item_id = v_item_b
      and d.decision = 'draft'
      and 'stale_stock_count' = any(d.reason_codes)
  ) then
    raise exception 'B must be downgraded with stale_stock_count';
  end if;

  ------------------------------------------------------------------
  -- 4. C suggest: a decision but no PO.
  ------------------------------------------------------------------
  if not exists (
    select 1
    from public.q7_auto_purchase_decisions d
    join public.q7_auto_purchase_runs r on r.id = d.run_id
    where r.run_date = current_date and d.item_id = v_item_c and d.decision = 'suggest'
  ) then
    raise exception 'C must record a suggest decision';
  end if;

  ------------------------------------------------------------------
  -- 5. A tiny per-PO limit keeps every PO draft with over_po_limit.
  ------------------------------------------------------------------
  update public.q7_auto_purchase_settings
  set max_po_amount = 1000, updated_at = now()
  where id = 1;

  v_run := public.run_q7_auto_purchase(current_date - 1);
  select count(*) into v_sent
  from public.purchase_orders
  where status = 'sent'
    and notes = 'Tự động từ dự báo NVL Q7 ' || (current_date - 1)::text;
  if v_sent <> 0 then
    raise exception 'over-limit run must not send POs, found %', v_sent;
  end if;
  if not exists (
    select 1
    from public.q7_auto_purchase_decisions d
    join public.q7_auto_purchase_runs r on r.id = d.run_id
    where r.run_date = current_date - 1
      and 'over_po_limit' = any(d.reason_codes)
  ) then
    raise exception 'over-limit run must record over_po_limit';
  end if;

  ------------------------------------------------------------------
  -- 6. Re-running the same day is idempotent.
  ------------------------------------------------------------------
  select count(*) into v_count
  from public.purchase_orders
  where notes = 'Tự động từ dự báo NVL Q7 ' || current_date::text;

  v_run := public.run_q7_auto_purchase(current_date);
  if coalesce((v_run ->> 'idempotent')::boolean, false) is not true then
    raise exception 'second run of the same day must be idempotent';
  end if;
  select count(*) into v_draft
  from public.purchase_orders
  where notes = 'Tự động từ dự báo NVL Q7 ' || current_date::text;
  if v_draft <> v_count then
    raise exception 'idempotent run created extra POs (% vs %)', v_draft, v_count;
  end if;

  ------------------------------------------------------------------
  -- 7. Learning writes 25000 for 'Smoke bột C (25kg)' with a g book unit.
  ------------------------------------------------------------------
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_result := public.learn_q7_purchase_parameters();
  select learned_pack_size into v_pack
  from public.q7_purchase_item_settings
  where kitchen_inventory_item_id = v_item_c;
  if v_pack is distinct from 25000 then
    raise exception 'learned pack size for (25kg) in g expected 25000, found %', v_pack;
  end if;

  ------------------------------------------------------------------
  -- 8. The internal Zalo outbox carries both new event types.
  ------------------------------------------------------------------
  if not exists (
    select 1 from public.finance_zalo_notifications
    where event_type = 'auto_purchase_order_sent'
  ) then
    raise exception 'missing auto_purchase_order_sent Zalo notice';
  end if;
  if not exists (
    select 1 from public.finance_zalo_notifications
    where event_type = 'auto_purchase_daily_summary'
  ) then
    raise exception 'missing auto_purchase_daily_summary Zalo notice';
  end if;

  raise notice 'q7 auto purchase smoke passed';
end;
$smoke$;

rollback;
