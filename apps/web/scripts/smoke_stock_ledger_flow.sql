-- Smoke test for the automatic stock ledger flow (Q7 / Tân Tạo data layer).
-- Runs entirely inside BEGIN ... ROLLBACK so it never keeps fixtures.
-- Prerequisites (real data only, never created by this script):
--   * at least one public.user_roles row with role 'owner'
-- Run with:  psql "$DATABASE_URL" -f scripts/smoke_stock_ledger_flow.sql
--
-- Shared normalization test cases (must match src/lib/stock-ledger.ts):
--   'tỏi ngày 10'               -> 'toi'
--   'bánh mì lớn 17'            -> 'banh mi lon'
--   'Chả lụa lá TVP XL (kg)'    -> 'cha lua la tvp xl'

begin;

select set_config('request.jwt.claim.role', 'service_role', true);

do $smoke$
declare
  v_actor uuid;
  v_supplier uuid;
  v_material_a uuid;
  v_material_b uuid;
  v_item_a uuid;
  v_item_b uuid;
  v_mapping_a uuid;
  v_mapping_b uuid;
  v_receipt1 uuid;
  v_receipt2 uuid;
  v_receipt3 uuid;
  v_line_ok uuid;
  v_line_missing uuid;
  v_line_other_receipt uuid;
  v_line_before_cutover uuid;
  v_cutover date;
  v_po uuid;
  v_poi uuid;
  v_issue uuid;
  v_count integer;
  v_qty numeric;
  v_book numeric;
  v_result jsonb;
  v_diff numeric;
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
begin
  ------------------------------------------------------------------
  -- Shared normalization contract
  ------------------------------------------------------------------
  if public.normalize_stock_item_name('tỏi ngày 10') <> 'toi' then
    raise exception 'normalize failed for tỏi ngày 10';
  end if;
  if public.normalize_stock_item_name('bánh mì lớn 17') <> 'banh mi lon' then
    raise exception 'normalize failed for bánh mì lớn 17';
  end if;
  if public.normalize_stock_item_name('Chả lụa lá TVP XL (kg)') <> 'cha lua la tvp xl' then
    raise exception 'normalize failed for Chả lụa lá TVP XL (kg)';
  end if;

  ------------------------------------------------------------------
  -- Actor: an owner so the adjustment RPC permission check passes.
  -- ------------------------------------------------------------------
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
  -- Fixtures: supplier, canonical materials, Q7 items and mappings
  ------------------------------------------------------------------
  insert into public.suppliers (name, default_receiving_location)
  values ('Smoke NCC ' || v_suffix, 'q7')
  returning id into v_supplier;

  insert into public.sku_cogs_materials (material_code, canonical_name, normalized_name, default_unit)
  values ('SMOKE-A-' || v_suffix, 'Smoke Tỏi', 'smoke-toi-' || v_suffix, 'kg')
  returning id into v_material_a;

  insert into public.sku_cogs_materials (material_code, canonical_name, normalized_name, default_unit)
  values ('SMOKE-B-' || v_suffix, 'Smoke Hành', 'smoke-hanh-' || v_suffix, 'kg')
  returning id into v_material_b;

  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit, canonical_material_id, material_resolution_status)
  values ('SMOKE-ITEM-A-' || v_suffix, 'smoke-item-a-' || v_suffix, 'ingredient', 'Tỏi', 'kg', v_material_a, 'linked')
  returning id into v_item_a;

  insert into public.kitchen_inventory_items
    (item_code, normalized_key, item_type, name, unit, canonical_material_id, material_resolution_status)
  values ('SMOKE-ITEM-B-' || v_suffix, 'smoke-item-b-' || v_suffix, 'ingredient', 'Hành lá', 'kg', v_material_b, 'linked')
  returning id into v_item_b;

  insert into public.q7_material_issue_material_mappings
    (canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit, conversion_factor, approval_status, approved_by, approved_at)
  values (v_material_a, 'kg', v_item_a, 'kg', 1, 'approved', v_actor, now())
  returning id into v_mapping_a;

  insert into public.q7_material_issue_material_mappings
    (canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit, conversion_factor, approval_status, approved_by, approved_at)
  values (v_material_b, 'kg', v_item_b, 'kg', 1, 'approved', v_actor, now())
  returning id into v_mapping_b;

  ------------------------------------------------------------------
  -- Cutover: start 60 days ago so the main fixtures are in range.
  -- ------------------------------------------------------------------
  update public.stock_ledger_settings
  set q7_cutover_date = current_date - 60
  where id = 1;

  ------------------------------------------------------------------
  -- Pre-cutover receipt is never posted
  ------------------------------------------------------------------
  insert into public.goods_receipts
    (receipt_number, receipt_date, supplier_id, status, receiving_location, payable_status)
  values ('SMOKE-GR-PRE-' || v_suffix, current_date - 90, v_supplier, 'draft', 'q7', 'not_generated')
  returning id into v_receipt3;

  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, quantity, actual_quantity, unit)
  values (v_receipt3, 'Tỏi ngày 10', 5, 5, 'kg')
  returning id into v_line_before_cutover;

  update public.goods_receipts set status = 'confirmed' where id = v_receipt3;

  select count(*) into v_count
  from public.q7_inventory_movements
  where source = 'goods_receipt' and source_ref_key = 'gr-item:' || v_line_before_cutover::text;
  if v_count <> 0 then
    raise exception 'pre-cutover receipt must not post, found % rows', v_count;
  end if;

  ------------------------------------------------------------------
  -- One alias exists, one line stays pending
  ------------------------------------------------------------------
  insert into public.stock_material_aliases
    (supplier_id, normalized_name, location, kitchen_inventory_item_id, conversion_factor, unit, created_by)
  values (v_supplier, 'toi', 'q7', v_item_a, 1, 'kg', v_actor);

  insert into public.goods_receipts
    (receipt_number, receipt_date, supplier_id, status, receiving_location, payable_status)
  values ('SMOKE-GR-1-' || v_suffix, current_date - 5, v_supplier, 'draft', 'q7', 'not_generated')
  returning id into v_receipt1;

  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, quantity, actual_quantity, unit)
  values (v_receipt1, 'Tỏi ngày 10', 7, 7, 'kg')
  returning id into v_line_ok;

  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, quantity, actual_quantity, unit)
  values (v_receipt1, 'Hành lá', 4, 4, 'kg')
  returning id into v_line_missing;

  update public.goods_receipts set status = 'confirmed' where id = v_receipt1;

  select count(*) into v_count
  from public.q7_inventory_movements
  where source = 'goods_receipt' and source_ref_key = 'gr-item:' || v_line_ok::text;
  if v_count <> 1 then
    raise exception 'aliased line must post exactly once, found %', v_count;
  end if;

  select quantity into v_qty
  from public.q7_inventory_movements
  where source = 'goods_receipt' and source_ref_key = 'gr-item:' || v_line_ok::text;
  if v_qty <> 7 then
    raise exception 'aliased line quantity expected 7, found %', v_qty;
  end if;

  select count(*) into v_count
  from public.q7_inventory_movements
  where source = 'goods_receipt' and source_ref_key = 'gr-item:' || v_line_missing::text;
  if v_count <> 0 then
    raise exception 'unaliased line must stay pending, found % rows', v_count;
  end if;

  ------------------------------------------------------------------
  -- Another receipt from the same supplier with the same item name
  ------------------------------------------------------------------
  insert into public.goods_receipts
    (receipt_number, receipt_date, supplier_id, status, receiving_location, payable_status)
  values ('SMOKE-GR-2-' || v_suffix, current_date - 4, v_supplier, 'draft', 'q7', 'not_generated')
  returning id into v_receipt2;

  insert into public.goods_receipt_items
    (goods_receipt_id, product_name, quantity, actual_quantity, unit)
  values (v_receipt2, 'Hành lá 17', 3, 3, 'kg')
  returning id into v_line_other_receipt;

  update public.goods_receipts set status = 'confirmed' where id = v_receipt2;

  ------------------------------------------------------------------
  -- Assigning the alias writes the pending line and the sibling line
  ------------------------------------------------------------------
  v_count := public.resolve_stock_alias(v_line_missing, 'q7', v_item_b, null, 1, true);
  if v_count <> 2 then
    raise exception 'resolve_stock_alias expected to post 2 lines, got %', v_count;
  end if;

  select count(*) into v_count
  from public.q7_inventory_movements
  where source = 'goods_receipt'
    and source_ref_key in ('gr-item:' || v_line_missing::text, 'gr-item:' || v_line_other_receipt::text);
  if v_count <> 2 then
    raise exception 'resolve_stock_alias must post both sibling lines, found %', v_count;
  end if;

  ------------------------------------------------------------------
  -- Re-posting is idempotent
  ------------------------------------------------------------------
  perform public.post_goods_receipt_to_stock(v_receipt1);

  select count(*) into v_count
  from public.q7_inventory_movements
  where source = 'goods_receipt' and source_ref_key = 'gr-item:' || v_line_ok::text;
  if v_count <> 1 then
    raise exception 're-posting duplicated the aliased line: %', v_count;
  end if;

  ------------------------------------------------------------------
  -- Material issue: pdf_ready posts usage, supersede reverses it
  ------------------------------------------------------------------
  insert into public.production_orders (production_number)
  values ('SMOKE-SX-' || v_suffix)
  returning id into v_po;

  insert into public.production_order_items (production_order_id, product_name, unit)
  values (v_po, 'Smoke bánh mì', 'que')
  returning id into v_poi;

  insert into public.production_material_issues
    (issue_number, production_order_id, issue_date, status, location_code, revision, source_hash, is_current)
  values ('SMOKE-PXK-' || v_suffix, v_po, current_date, 'generated', 'q7', 1, repeat('a', 64), true)
  returning id into v_issue;

  insert into public.production_material_issue_items
    (material_issue_id, production_order_item_id, kitchen_inventory_item_id, ingredient_name,
     required_qty, unit, source_ref_key, canonical_material_id, q7_mapping_id, source_unit, conversion_factor)
  values (v_issue, v_poi, v_item_a, 'Tỏi', 2, 'kg', 'smoke-' || v_suffix, v_material_a, v_mapping_a, 'kg', 1);

  update public.production_material_issues set status = 'pdf_ready' where id = v_issue;

  select count(*) into v_count
  from public.q7_inventory_movements
  where source = 'production_material_issue' and source_issue_id = v_issue;
  if v_count <> 1 then
    raise exception 'pdf_ready material issue must post usage, found %', v_count;
  end if;

  update public.production_material_issues
  set superseded_by_issue_id = id, is_current = false
  where id = v_issue;

  select count(*) into v_count
  from public.q7_inventory_movements
  where source = 'production_material_issue_reversal' and source_issue_id = v_issue;
  if v_count <> 1 then
    raise exception 'superseded material issue must reverse usage, found %', v_count;
  end if;

  ------------------------------------------------------------------
  -- Weekly stock count returns the counted difference
  ------------------------------------------------------------------
  select s.balance_qty into v_book
  from public.get_q7_inventory_snapshot(current_date) s
  where s.kitchen_inventory_item_id = v_item_b;
  v_book := coalesce(v_book, 0);

  v_result := public.record_q7_stock_count(
    v_item_b, v_book + 5, current_date, 'Smoke kiểm kê', 'smoke-count-' || v_suffix
  );
  v_diff := coalesce((v_result ->> 'difference_qty')::numeric, null);
  if v_diff is distinct from 5 then
    raise exception 'stock count difference expected 5, got %', v_diff;
  end if;

  select s.balance_qty into v_book
  from public.get_q7_inventory_snapshot(current_date) s
  where s.kitchen_inventory_item_id = v_item_b;
  if v_book is distinct from (select (v_result ->> 'counted_qty')::numeric) then
    raise exception 'stock count balance does not match the counted quantity';
  end if;

  ------------------------------------------------------------------
  -- Receiving location RPC and the overview payload used by the page
  ------------------------------------------------------------------
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform public.set_goods_receipt_receiving_location(v_receipt3, 'q7', true);
  if (select default_receiving_location from public.suppliers where id = v_supplier) <> 'q7' then
    raise exception 'receiving location must be remembered for the supplier';
  end if;
  v_result := public.get_stock_ledger_overview('q7', current_date);
  if not exists (
    select 1 from jsonb_array_elements(v_result -> 'items') it
    where it ->> 'item_id' = v_item_b::text
  ) then
    raise exception 'overview items must carry item_id';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_result -> 'pending_aliases') p
    where p ->> 'goods_receipt_item_id' is null
  ) then
    raise exception 'pending rows must carry goods_receipt_item_id';
  end if;
  v_result := public.get_stock_ledger_overview('tan_tao', current_date);
  if jsonb_typeof(v_result -> 'items') <> 'array' then
    raise exception 'tan_tao overview must return items';
  end if;

  raise notice 'stock ledger flow smoke passed';
end;
$smoke$;

rollback;
