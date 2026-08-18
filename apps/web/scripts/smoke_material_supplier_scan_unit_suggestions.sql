begin;

-- Load the migration in the same transaction before this smoke file when executing.
do $$
declare
  v_material public.sku_cogs_materials%rowtype;
  v_supplier_id uuid;
  v_receipt_id uuid;
  v_item_id uuid;
  v_actor uuid;
  v_name text := 'SCAN-SMOKE-' || gen_random_uuid()::text;
  v_pending_name text := 'SCAN-PENDING-' || gen_random_uuid()::text;
  v_standard_name text := 'SCAN-STANDARD-' || gen_random_uuid()::text;
  v_doc text := 'goods-receipts/scan-smoke-' || gen_random_uuid()::text || '.jpg';
  v_record jsonb;
  v_suggestion record;
  v_confirm jsonb;
  v_pending_suggestion record;
  v_pending_confirm jsonb;
  v_pending_product public.material_supplier_products%rowtype;
  v_standard_suggestion record;
begin
  select * into v_material
  from public.sku_cogs_materials
  where active = true and lower(btrim(default_unit)) = 'g'
  order by created_at, id limit 1;
  if not found then raise exception 'smoke fixture: no active g material'; end if;

  select id into v_supplier_id from public.suppliers order by created_at, id limit 1;
  select id into v_actor from auth.users order by created_at, id limit 1;
  select id into v_receipt_id from public.goods_receipts order by created_at, id limit 1;
  if v_supplier_id is null or v_actor is null or v_receipt_id is null then
    raise exception 'smoke fixture missing supplier/user/receipt';
  end if;

  update public.goods_receipts
  set supplier_id = v_supplier_id, image_url = v_doc
  where id = v_receipt_id;
  insert into public.material_scoped_aliases (
    material_id, supplier_id, source_type, alias_name, normalized_alias,
    approved, approved_by, approved_at, active, metadata, created_by
  ) values (
    v_material.id, v_supplier_id, 'goods_receipt', v_name, public.material_master_normalize(v_name),
    true, v_actor, now(), true, jsonb_build_object('rollback_smoke', true), v_actor
  );
  insert into public.material_supplier_products (
    material_id, supplier_id, supplier_product_name, normalized_supplier_product_name,
    purchase_unit, base_quantity, base_unit, approved, approved_by, approved_at,
    active, metadata, created_by
  ) values (
    v_material.id, v_supplier_id, v_name, public.material_master_normalize(v_name),
    v_material.default_unit, 1, v_material.default_unit, true, v_actor, now(),
    true, jsonb_build_object('rollback_smoke_controller_prerequisite', true), v_actor
  );
  insert into public.goods_receipt_items (goods_receipt_id, product_name, quantity, unit)
  values (v_receipt_id, v_name, 2, v_material.default_unit)
  returning id into v_item_id;

  perform set_config('request.jwt.claims', jsonb_build_object('role','service_role','sub',v_actor::text)::text, true);
  perform public.apply_goods_receipt_item_material_resolution(
    v_item_id, v_material.id, v_name, null, v_material.default_unit,
    v_supplier_id, 'match_delivery_note', 'scan suggestion rollback smoke exact material link'
  );
  v_record := public.record_material_supplier_unit_scan_evidence(
    v_receipt_id,
    v_doc,
    repeat('a', 64),
    v_actor,
    jsonb_build_array(
      jsonb_build_object(
        'goods_receipt_item_id', v_item_id,
        'raw_product_name', v_name,
        'raw_purchase_unit', 'Bao-smoke',
        'raw_quantity', 2,
        'package_quantity', 25,
        'package_unit', 'kg'
      ),
      jsonb_build_object(
        'goods_receipt_item_id', v_item_id,
        'raw_product_name', v_pending_name,
        'raw_purchase_unit', 'Thung-smoke',
        'raw_quantity', 1
      ),
      jsonb_build_object(
        'goods_receipt_item_id', v_item_id,
        'raw_product_name', v_standard_name,
        'raw_purchase_unit', 'kg',
        'raw_quantity', 25,
        'package_quantity', 25,
        'package_unit', 'kg'
      )
    )
  );
  if v_record->>'status' <> 'scan_evidence_recorded' then
    raise exception 'scan evidence not recorded: %', v_record;
  end if;

  select * into v_suggestion
  from public.get_material_supplier_suggestions(v_material.id)
  where candidate_source = 'supplier_delivery_note_scan'
    and public.material_master_normalize(product_name) = public.material_master_normalize(v_name)
  limit 1;
  if not found then raise exception 'scan suggestion missing'; end if;
  if v_suggestion.purchase_unit <> 'Bao-smoke'
    or v_suggestion.suggested_base_quantity <> 25000
    or lower(v_suggestion.suggested_base_unit) <> 'g' then
    raise exception 'scan suggestion conversion mismatch: %', row_to_json(v_suggestion);
  end if;
  if v_suggestion.source_reference like '%goods-receipts/%' then
    raise exception 'private document path leaked in source reference';
  end if;

  perform set_config('request.jwt.claims', jsonb_build_object('role','service_role','sub',v_actor::text)::text, true);
  v_confirm := public.confirm_material_supplier_product(
    v_material.id, v_material.version, v_supplier_id, null,
    v_name, 'Bao-smoke', 'smoke explicit scan confirmation',
    v_suggestion.scan_evidence_id, 25000, 'g'
  );
  if v_confirm->>'status' <> 'supplier_product_confirmed'
    or (v_confirm->>'conversion_pending')::boolean then
    raise exception 'scan confirmation mismatch: %', v_confirm;
  end if;
  if not exists (
    select 1 from public.material_unit_conversions muc
    where muc.material_id = v_material.id and muc.source_id = v_suggestion.scan_evidence_id
      and muc.factor = 25000 and muc.approved = true and muc.active = true
  ) then raise exception 'approved scan conversion missing'; end if;

  select * into v_pending_suggestion
  from public.get_material_supplier_suggestions(v_material.id)
  where candidate_source = 'supplier_delivery_note_scan'
    and public.material_master_normalize(product_name) = public.material_master_normalize(v_pending_name)
  limit 1;
  if not found then raise exception 'pending scan suggestion missing'; end if;
  select * into v_material from public.sku_cogs_materials where id = v_material.id;
  v_pending_confirm := public.confirm_material_supplier_product(
    v_material.id, v_material.version, v_supplier_id, null,
    v_pending_name, 'Thung-smoke', 'smoke scan confirmation without inferred conversion',
    v_pending_suggestion.scan_evidence_id, null, null
  );
  if v_pending_confirm->>'status' <> 'supplier_product_confirmed'
    or not (v_pending_confirm->>'conversion_pending')::boolean then
    raise exception 'pending conversion confirmation mismatch: %', v_pending_confirm;
  end if;
  select * into v_pending_product
  from public.material_supplier_products
  where id = (v_pending_confirm->>'supplier_product_id')::uuid;
  if lower(btrim(v_pending_product.base_unit)) <> lower(btrim(v_material.default_unit))
    or coalesce((v_pending_product.metadata->>'conversion_pending')::boolean, false) is not true then
    raise exception 'pending supplier product did not remain COGS-unit rooted: %', row_to_json(v_pending_product);
  end if;

  select * into v_standard_suggestion
  from public.get_material_supplier_suggestions(v_material.id)
  where candidate_source = 'supplier_delivery_note_scan'
    and public.material_master_normalize(product_name) = public.material_master_normalize(v_standard_name)
  limit 1;
  if not found or v_standard_suggestion.suggested_base_quantity <> 1000 then
    raise exception 'standard kg-to-g unit must not multiply package size: %', row_to_json(v_standard_suggestion);
  end if;
end;
$$;

rollback;
