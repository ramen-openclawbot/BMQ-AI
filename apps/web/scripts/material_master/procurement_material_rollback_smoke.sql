\echo 'Task6 procurement material controller rollback smoke: begin'
BEGIN;

create or replace function pg_temp.task6_smoke_direct_authenticated_dml()
returns void language sql security definer set search_path = public, pg_temp
as $$
  update public.purchase_order_items set canonical_material_id = canonical_material_id,
      material_resolution_status = 'controller_error'
  where id = '00000000-0000-0000-0000-000000101706'::uuid;
$$;
alter function pg_temp.task6_smoke_direct_authenticated_dml() owner to authenticated;

create or replace function pg_temp.task6_smoke_direct_service_dml()
returns void language sql security definer set search_path = public, pg_temp
as $$
  update public.purchase_order_items set canonical_material_id = canonical_material_id,
      material_resolution_status = 'controller_error'
  where id = '00000000-0000-0000-0000-000000101706'::uuid;
$$;
alter function pg_temp.task6_smoke_direct_service_dml() owner to service_role;

DO $$
declare
  v_actor uuid := '00000000-0000-0000-0000-0000000a1706'::uuid;
  v_supplier uuid := '00000000-0000-0000-0000-0000000b1706'::uuid;
  v_material uuid := '00000000-0000-0000-0000-0000000c1706'::uuid;
  v_raw_sku uuid := '00000000-0000-0000-0000-0000000d1706'::uuid;
  v_fg_sku uuid := '00000000-0000-0000-0000-0000000e1706'::uuid;
  v_po uuid := '00000000-0000-0000-0000-0000000f1706'::uuid;
  v_poi uuid := '00000000-0000-0000-0000-000000101706'::uuid;
  v_unknown_po uuid := '00000000-0000-0000-0000-000000111706'::uuid;
  v_unknown_poi uuid := '00000000-0000-0000-0000-000000121706'::uuid;
  v_pr uuid := '00000000-0000-0000-0000-000000131706'::uuid;
  v_pri uuid := '00000000-0000-0000-0000-000000141706'::uuid;
  v_created_pri uuid;
  v_created_poi uuid;
  v_invoice uuid;
  v_invoice_item uuid;
  v_before_gr integer;
  v_before_pr integer;
  v_after_gr integer;
  v_after_pr integer;
  v_hist_before integer := 0;
  v_hist_after integer := 0;
  v_q7_before integer := 0;
  v_q7_after integer := 0;
  v_invoice_before integer := 0;
  v_invoice_after integer := 0;
  v_inventory_before integer := 0;
  v_inventory_after integer := 0;
  v_payment_request_before integer := 0;
  v_payment_request_after integer := 0;
  v_result jsonb;
  v_result2 jsonb;
  v_receipt uuid;
begin
  raise notice 'protected_history_ledger_counts_unchanged';
  if to_regclass('public.sku_cogs_version_formulations') is not null then execute 'select count(*) from public.sku_cogs_version_formulations' into v_hist_before; end if;
  if to_regclass('public.q7_inventory_movements') is not null then execute 'select count(*) from public.q7_inventory_movements' into v_q7_before; end if;
  if to_regclass('public.invoices') is not null then execute 'select count(*) from public.invoices' into v_invoice_before; end if;
  if to_regclass('public.inventory_items') is not null then execute 'select count(*) from public.inventory_items' into v_inventory_before; end if;
  if to_regclass('public.payment_requests') is not null then execute 'select count(*) from public.payment_requests' into v_payment_request_before; end if;

  raise notice 'exact_repeat_unknown_fuzzy_direct_dml';

  insert into auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
  values (v_actor, 'authenticated', 'authenticated', 'task6-procurement-smoke@example.invalid', '', now(), now(), now())
  on conflict (id) do nothing;

  insert into public.user_roles(user_id, role)
  values (v_actor, 'owner')
  on conflict do nothing;

  insert into public.user_module_permissions(user_id, module_key, can_view, can_edit)
  values
    (v_actor, 'purchase_orders', true, true),
    (v_actor, 'payment_requests', true, true),
    (v_actor, 'finance_cost', true, true),
    (v_actor, 'material_master', true, true)
  on conflict (user_id, module_key) do update set can_view = true, can_edit = true;

  perform set_config('request.jwt.claim.sub', v_actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_actor::text, 'role', 'authenticated')::text, true);

  insert into public.suppliers(id, name, short_code, created_by)
  values (v_supplier, 'Task6 Procurement Smoke Supplier', 'T6SMOKE', v_actor);

  insert into public.sku_cogs_materials(id, material_code, canonical_name, normalized_name, default_unit, active, category, created_by, updated_by, version)
  values (v_material, 'T6-NVL-SMOKE', 'Task6 Smoke Raw Flour', public.material_master_normalize('Task6 Smoke Raw Flour'), 'kg', true, 'NVL', v_actor, v_actor, 1);

  insert into public.material_supplier_products(material_id, supplier_id, supplier_product_name, normalized_supplier_product_name, purchase_unit, base_quantity, base_unit, approved, approved_by, approved_at, created_by)
  values (v_material, v_supplier, 'Task6 Smoke Raw Flour', public.material_master_normalize('Task6 Smoke Raw Flour'), 'kg', 1, 'kg', true, v_actor, now(), v_actor);

  insert into public.product_skus(id, sku_code, product_name, sku_type, supplier_id, unit, unit_price, canonical_material_id)
  values (v_raw_sku, 'T6-RAW-SMOKE', 'Task6 Smoke Raw Flour', 'raw_material', v_supplier, 'kg', 12, v_material);
  insert into public.product_skus(id, sku_code, product_name, sku_type, supplier_id, unit, unit_price)
  values (v_fg_sku, 'T6-FG-SMOKE', 'Task6 Smoke Finished Bun', 'finished_good', v_supplier, 'cái', 20);

  insert into public.purchase_orders(id, po_number, supplier_id, order_date, status, total_amount, vat_amount, created_by)
  values (v_po, 'PO-TASK6-SMOKE-EXACT', v_supplier, current_date, 'draft', 120, 0, v_actor);
  insert into public.purchase_order_items(id, purchase_order_id, product_name, quantity, unit, unit_price, line_total, sku_id)
  values (v_poi, v_po, 'Task6 Smoke Raw Flour', 10, 'kg', 12, 120, v_raw_sku);

  raise notice 'create_procurement_line_with_material_resolution_raw_exact';
  v_result := public.create_procurement_line_with_material_resolution(
    'purchase_order_items', v_po,
    jsonb_build_object('product_name','Task6 Smoke Raw Flour','unit','kg','quantity',1,'unit_price',12,'sku_id',v_raw_sku,'expected_material_id',v_material),
    'purchase_order', v_actor
  );
  if v_result->>'status' <> 'created' or v_result#>>'{line,status}' not in ('linked','linked_unchanged') or (v_result->>'material_id')::uuid is distinct from v_material then
    raise exception 'server-authority line wrapper exact failed: %', v_result;
  end if;
  v_created_poi := (v_result->>'line_id')::uuid;

  v_result := public.apply_procurement_line_material_resolution('purchase_order_items', v_poi, 'Task6 Smoke Raw Flour', 'T6-NVL-SMOKE', 'kg', v_supplier, 'purchase_order', 'Task6 rollback smoke exact', v_material);
  if v_result->>'status' <> 'linked' or (v_result->>'material_id')::uuid is distinct from v_material then
    raise exception 'exact link failed: %', v_result;
  end if;
  v_result2 := public.apply_procurement_line_material_resolution('purchase_order_items', v_poi, 'Task6 Smoke Raw Flour', 'T6-NVL-SMOKE', 'kg', v_supplier, 'purchase_order', 'Task6 rollback smoke exact retry', v_material);
  if v_result2->>'status' <> 'linked_unchanged' then
    raise exception 'exact retry failed: %', v_result2;
  end if;

  perform set_config('material_master.procurement_line_resolution', v_poi::text, true);
  begin
    perform pg_temp.task6_smoke_direct_authenticated_dml();
    raise exception 'direct authenticated DML unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform pg_temp.task6_smoke_direct_service_dml();
    raise exception 'direct service-role DML unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;
  perform set_config('material_master.procurement_line_resolution', '', true);

  raise notice 'po_line_identity_drift_direct_update_fails';
  begin
    update public.purchase_order_items set product_name = 'Task6 Smoke Raw Flour Drifted' where id = v_poi;
    raise exception 'PO identity drift direct update unexpectedly succeeded';
  exception when check_violation then
    null;
  end;
  if not exists (select 1 from public.purchase_order_items where id = v_poi and product_name = 'Task6 Smoke Raw Flour' and canonical_material_id = v_material and material_resolution_request_id is not null and raw_product_name = 'Task6 Smoke Raw Flour') then
    raise exception 'PO identity drift changed protected row';
  end if;

  raise notice 'po_line_delete_with_evidence_fails';
  begin
    delete from public.purchase_order_items where id = v_poi;
    raise exception 'PO evidence delete unexpectedly succeeded';
  exception when check_violation then
    null;
  end;

  raise notice 'po_server_nonidentity_edit_preserves_history';
  v_result := public.update_procurement_document_with_material_controller(
    'purchase_order', v_po,
    jsonb_build_object('notes','Task6 edited without identity drift','total_amount',144,'vat_amount',0),
    jsonb_build_array(jsonb_build_object('id',v_poi,'product_name','Task6 Smoke Raw Flour','unit','kg','quantity',12,'unit_price',12,'line_total',144,'notes','qty only edit'), jsonb_build_object('id',v_created_poi,'product_name','Task6 Smoke Raw Flour','unit','kg','quantity',1,'unit_price',12,'line_total',12)),
    v_actor
  );
  if v_result->>'status' <> 'updated' or (v_result->>'updated_items_count')::int <> 2 then
    raise exception 'PO server nonidentity edit failed: %', v_result;
  end if;
  if not exists (select 1 from public.purchase_order_items where id = v_poi and quantity = 12 and unit_price = 12 and line_total = 144 and product_name = 'Task6 Smoke Raw Flour' and unit = 'kg' and canonical_material_id = v_material and material_resolution_request_id is not null and raw_product_name = 'Task6 Smoke Raw Flour') then
    raise exception 'PO server nonidentity edit did not preserve id/history';
  end if;

  raise notice 'po_server_identity_edit_and_removal_fail_unchanged';
  begin
    perform public.update_procurement_document_with_material_controller(
      'purchase_order', v_po, '{}'::jsonb,
      jsonb_build_array(jsonb_build_object('id',v_poi,'product_name','Task6 Smoke Raw Flour Renamed','unit','kg','quantity',12,'unit_price',12,'line_total',144), jsonb_build_object('id',v_created_poi,'product_name','Task6 Smoke Raw Flour','unit','kg','quantity',1,'unit_price',12,'line_total',12)),
      v_actor
    );
    raise exception 'PO server identity edit unexpectedly succeeded';
  exception when check_violation then
    null;
  end;
  begin
    perform public.update_procurement_document_with_material_controller('purchase_order', v_po, '{}'::jsonb, '[]'::jsonb, v_actor);
    raise exception 'PO server evidence removal unexpectedly succeeded';
  exception when check_violation then
    null;
  end;
  if not exists (select 1 from public.purchase_order_items where id = v_poi and product_name = 'Task6 Smoke Raw Flour' and quantity = 12 and canonical_material_id = v_material) then
    raise exception 'PO identity/removal failure did not leave row unchanged';
  end if;


  raise notice 'po_status_send_authority';
  begin
    update public.purchase_orders set status = 'sent' where id = v_po;
    raise exception 'direct PO sent update unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;
  v_result := public.update_purchase_order_status_with_material_controller(v_po, 'sent', v_actor);
  if v_result->>'status' <> 'updated' then raise exception 'PO status wrapper failed: %', v_result; end if;
  update public.purchase_orders set status = 'draft' where id = v_po;

  raise notice 'po_to_gr_carry';
  v_receipt := public.ensure_purchase_order_receipt_queue(v_po);
  if not exists (
    select 1 from public.goods_receipt_items
    where goods_receipt_id = v_receipt and purchase_order_item_id = v_poi
      and canonical_material_id = v_material and material_resolution_status = 'resolved_exact' and raw_product_name = 'Task6 Smoke Raw Flour'
  ) then
    raise exception 'PO to GR canonical carry failed';
  end if;
  if not exists (
    select 1 from public.payment_request_items
    where purchase_order_item_id = v_poi
      and canonical_material_id = v_material and material_resolution_status = 'resolved_exact' and raw_product_name = 'Task6 Smoke Raw Flour'
  ) then
    raise exception 'PO to PR schema-authoritative canonical carry failed';
  end if;

  raise notice 'pr_to_invoice_carry';
  select pri.payment_request_id, pri.id into v_pr, v_pri
  from public.payment_request_items pri
  where pri.purchase_order_item_id = v_poi
  order by pri.created_at asc limit 1;
  select pri.id into v_created_pri
  from public.payment_request_items pri
  where pri.payment_request_id = v_pr and pri.purchase_order_item_id = v_created_poi
  order by pri.created_at asc limit 1;
  if v_created_pri is null then raise exception 'second PO to PR canonical carry line missing'; end if;

  raise notice 'pr_server_identity_drift_fails';
  begin
    perform public.update_procurement_document_with_material_controller(
      'payment_request', v_pr,
      jsonb_build_object('title','Duyệt chi PO edited nonidentity','total_amount',144,'vat_amount',0),
      jsonb_build_array(
        jsonb_build_object('id',v_pri,'product_name','Task6 Smoke Raw Flour Drifted','unit','kg','quantity',12,'unit_price',12,'line_total',144),
        jsonb_build_object('id',v_created_pri,'product_name','Task6 Smoke Raw Flour','unit','kg','quantity',1,'unit_price',12,'line_total',12)
      ),
      v_actor
    );
    raise exception 'PR server identity drift unexpectedly succeeded';
  exception when check_violation then
    null;
  end;
  v_result := public.update_procurement_document_with_material_controller(
    'payment_request', v_pr,
    jsonb_build_object('title','Duyệt chi PO edited nonidentity','total_amount',156,'vat_amount',0),
    jsonb_build_array(
      jsonb_build_object('id',v_pri,'product_name','Task6 Smoke Raw Flour','unit','kg','quantity',13,'unit_price',12,'line_total',156),
      jsonb_build_object('id',v_created_pri,'product_name','Task6 Smoke Raw Flour','unit','kg','quantity',1,'unit_price',12,'line_total',12)
    ),
    v_actor
  );
  if v_result->>'status' <> 'updated' or not exists (select 1 from public.payment_request_items where id = v_pri and quantity = 13 and product_name = 'Task6 Smoke Raw Flour' and canonical_material_id = v_material and material_resolution_request_id is not null) then
    raise exception 'PR nonidentity edit failed/preserved history failed: %', v_result;
  end if;

  v_result := public.approve_payment_request_with_material_controller(v_pr, 'bank_transfer', v_actor);
  if v_result->>'status' <> 'approved' then raise exception 'payment request approval wrapper failed: %', v_result; end if;

  v_result := public.create_invoice_from_payment_request(v_pr, 'INV-TASK6-SMOKE', current_date, 0, 'Task6 smoke', null, v_actor);
  if v_result->>'status' <> 'created' or (v_result->>'items_count')::int < 1 then
    raise exception 'PR to invoice RPC failed: %', v_result;
  end if;
  v_invoice := (v_result->>'invoice_id')::uuid;
  select id into v_invoice_item from public.invoice_items where invoice_id = v_invoice limit 1;
  if not exists (select 1 from public.invoice_items where id = v_invoice_item and canonical_material_id = v_material and material_resolution_status = 'resolved_exact' and raw_product_name = 'Task6 Smoke Raw Flour') then
    raise exception 'PR to invoice canonical carry failed';
  end if;

  raise notice 'invoice_item_history_delete_fails';
  begin
    delete from public.invoice_items where id = v_invoice_item;
    raise exception 'invoice history delete unexpectedly succeeded';
  exception when check_violation then
    null;
  end;


  raise notice 'shadow_no_false_resolved';
  insert into public.payment_requests(id, request_number, title, supplier_id, total_amount, status, payment_status, delivery_status, payment_type, payment_method, created_by)
  values ('00000000-0000-0000-0000-000000151706'::uuid, 'PR-TASK6-SMOKE-UNKNOWN', 'Task6 unknown', v_supplier, 1, 'pending', 'unpaid', 'pending', 'new_order', 'bank_transfer', v_actor);
  insert into public.payment_request_items(id, payment_request_id, product_name, quantity, unit, unit_price, standard_cost_code_type)
  values ('00000000-0000-0000-0000-000000161706'::uuid, '00000000-0000-0000-0000-000000151706'::uuid, 'Task6 Smoke Mystery Line', 1, 'kg', 1, null);
  v_result := public.apply_procurement_line_material_resolution('payment_request_items', '00000000-0000-0000-0000-000000161706'::uuid, 'Task6 Smoke Mystery Line', null, 'kg', v_supplier, 'payment_request', 'Task6 rollback smoke unknown request', null);
  v_result2 := public.apply_procurement_line_material_resolution('payment_request_items', '00000000-0000-0000-0000-000000161706'::uuid, 'Task6 Smoke Mystery Line', null, 'kg', v_supplier, 'payment_request', 'Task6 rollback smoke unknown request repeat', null);
  if v_result->>'status' <> 'unknown' or v_result->>'request_id' is null or v_result2->>'request_id' is distinct from v_result->>'request_id' then
    raise exception 'unknown request/repeat did not stay stable: %, %', v_result, v_result2;
  end if;
  v_result := public.assert_procurement_materials_ready('00000000-0000-0000-0000-000000151706'::uuid, 'payment_request', v_actor);
  if v_result->>'ready' <> 'false' then raise exception 'unknown line should not be ready: %', v_result; end if;
  if exists (select 1 from public.payment_request_items where id = '00000000-0000-0000-0000-000000161706'::uuid and canonical_material_id is not null) then
    raise exception 'unknown line was falsely resolved';
  end if;

  raise notice 'enforced_blocker_before_side_effects';
  insert into public.purchase_orders(id, po_number, supplier_id, order_date, status, total_amount, created_by)
  values (v_unknown_po, 'PO-TASK6-SMOKE-UNKNOWN', v_supplier, current_date, 'draft', 1, v_actor);
  insert into public.purchase_order_items(id, purchase_order_id, product_name, quantity, unit, unit_price, line_total)
  values (v_unknown_poi, v_unknown_po, 'Task6 Smoke Unclassified Thing', 1, 'kg', 1, 1);
  update public.material_master_enforcement_config set mode = 'enforced' where source_type = 'purchase_order';
  select count(*) into v_before_gr from public.goods_receipts where purchase_order_id = v_unknown_po;
  select count(*) into v_before_pr from public.payment_requests where purchase_order_id = v_unknown_po;
  begin
    perform public.ensure_purchase_order_receipt_queue(v_unknown_po);
    raise exception 'enforced unknown PO unexpectedly queued';
  exception when check_violation then
    null;
  end;
  select count(*) into v_after_gr from public.goods_receipts where purchase_order_id = v_unknown_po;
  select count(*) into v_after_pr from public.payment_requests where purchase_order_id = v_unknown_po;
  if v_before_gr <> v_after_gr or v_before_pr <> v_after_pr then
    raise exception 'enforced blocker happened after side effects';
  end if;

  raise notice 'finished_good_and_service_no_nvl';
  if public.procurement_material_line_kind('purchase_order_items', null, null, v_fg_sku, null) <> 'finished_good' then
    raise exception 'finished good SKU classification failed';
  end if;
  if public.procurement_material_line_kind('invoice_items', null, 'OPEX', null, null) <> 'service_or_non_material' then
    raise exception 'service/OPEX classification failed';
  end if;

  raise notice 'manual_invoice_batch_no_inventory_or_standard_cost';
  v_result := public.create_invoice_with_material_controller(
    jsonb_build_object('invoice_number','INV-TASK6-SMOKE-MANUAL','invoice_date',current_date,'supplier_id',v_supplier,'subtotal',1,'vat_amount',0,'total_amount',1,'notes','manual smoke'),
    jsonb_build_array(jsonb_build_object('product_name','Task6 Smoke Mystery Invoice Line','unit','kg','quantity',1,'unit_price',1)),
    v_actor
  );
  if v_result->>'status' <> 'created' then raise exception 'manual invoice batch wrapper failed: %', v_result; end if;

  if to_regclass('public.sku_cogs_version_formulations') is not null then execute 'select count(*) from public.sku_cogs_version_formulations' into v_hist_after; end if;
  if to_regclass('public.q7_inventory_movements') is not null then execute 'select count(*) from public.q7_inventory_movements' into v_q7_after; end if;
  if to_regclass('public.invoices') is not null then execute 'select count(*) from public.invoices' into v_invoice_after; end if;
  if to_regclass('public.inventory_items') is not null then execute 'select count(*) from public.inventory_items' into v_inventory_after; end if;
  if to_regclass('public.payment_requests') is not null then execute 'select count(*) from public.payment_requests' into v_payment_request_after; end if;
  if v_hist_before <> v_hist_after or v_q7_before <> v_q7_after or v_inventory_before <> v_inventory_after then
    raise exception 'protected history/Q7/inventory counts changed';
  end if;
  if v_invoice_after <= v_invoice_before or v_payment_request_after <= v_payment_request_before then
    raise exception 'invoice/payment request smoke did not exercise side-effect counts';
  end if;
end $$;

ROLLBACK;

DO $$
begin
  raise notice 'post_rollback_absence';
  if exists (select 1 from public.suppliers where short_code = 'T6SMOKE') then raise exception 'supplier persisted after rollback'; end if;
  if exists (select 1 from public.purchase_orders where po_number like 'PO-TASK6-SMOKE-%') then raise exception 'PO persisted after rollback'; end if;
  if exists (select 1 from public.invoices where invoice_number like 'INV-TASK6-SMOKE%') then raise exception 'invoice persisted after rollback'; end if;
  if exists (select 1 from public.sku_cogs_materials where material_code = 'T6-NVL-SMOKE') then raise exception 'material persisted after rollback'; end if;
end $$;

\echo 'Task6 procurement material controller rollback smoke: ok'
