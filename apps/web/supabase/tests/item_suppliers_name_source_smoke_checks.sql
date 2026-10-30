-- 2026-10-30 — Rollback-only smoke checks for
-- 20261103460000_item_suppliers_name_source.sql.
--
-- Run against a linked/staging database after the migration is applied:
--   npx supabase db query --linked -f supabase/tests/item_suppliers_name_source_smoke_checks.sql
--
-- Everything runs in one transaction and ends with PASS + ROLLBACK, so the live
-- database keeps no supplier link, alias, item, Material Master, formulation or
-- merge change.

begin;

-- The migration's RPCs accept service_role without a JWT; set both the role and
-- the JWT claim so auth.role() also answers service_role on hosted Supabase.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  v_supplier_1 uuid := gen_random_uuid();
  v_supplier_2 uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_request_2 uuid := gen_random_uuid();
  v_item uuid;
  v_item_replay uuid;
  v_count integer;
  v_result jsonb;
  v_checklist jsonb;
  v_ok boolean;

  v_material_unique uuid := gen_random_uuid();
  v_material_shared uuid := gen_random_uuid();
  v_item_unique uuid := gen_random_uuid();
  v_item_shared_a uuid := gen_random_uuid();
  v_item_shared_b uuid := gen_random_uuid();
  v_sku uuid;
  v_version uuid;
  v_formulation uuid;
  v_old_amount numeric;
  v_old_qty numeric;
  v_material_name text;

  v_merge_source uuid := gen_random_uuid();
  v_merge_target uuid := gen_random_uuid();
  v_candidate record;
begin
  insert into public.suppliers (id, name)
  values
    (v_supplier_1, 'SMOKE NCC ' || substr(v_supplier_1::text, 1, 8)),
    (v_supplier_2, 'SMOKE NCC ' || substr(v_supplier_2::text, 1, 8));

  -- (1) No supplier yet -> supplier_required.
  v_ok := false;
  begin
    perform public.kho_create_item(
      'SMOKE thiếu NCC ' || substr(v_request::text, 1, 8),
      'kg', 'raw_material', false, true, null, null, v_request,
      array[]::uuid[]
    );
  exception when others then
    v_ok := sqlerrm like '%supplier_required%';
  end;
  if not v_ok then raise exception 'SMOKE_RESULT FAIL supplier_required'; end if;

  -- An unknown supplier -> supplier_not_found.
  v_ok := false;
  begin
    perform public.kho_create_item(
      'SMOKE sai NCC ' || substr(v_request::text, 1, 8),
      'kg', 'raw_material', false, true, null, null, gen_random_uuid(),
      array[gen_random_uuid()]
    );
  exception when others then
    v_ok := sqlerrm like '%supplier_not_found%';
  end;
  if not v_ok then raise exception 'SMOKE_RESULT FAIL supplier_not_found'; end if;

  -- (2) Create with one supplier: one item, one link, one seeded alias.
  v_result := public.kho_create_item(
    'SMOKE món có NCC ' || substr(v_request::text, 1, 8),
    'kg', 'raw_material', false, true, null, null, v_request,
    array[v_supplier_1]
  );
  if v_result->>'status' <> 'created' then
    raise exception 'SMOKE_RESULT FAIL create_status %', v_result;
  end if;
  v_item := (v_result->>'item_id')::uuid;

  select count(*) into v_count
  from public.kitchen_inventory_items
  where id = v_item;
  if v_count <> 1 then raise exception 'SMOKE_RESULT FAIL create_item_count'; end if;

  select count(*) into v_count
  from public.kitchen_item_suppliers
  where item_id = v_item
    and supplier_id = v_supplier_1;
  if v_count <> 1 then raise exception 'SMOKE_RESULT FAIL create_link_count'; end if;

  select count(*) into v_count
  from public.stock_material_aliases
  where kitchen_inventory_item_id = v_item
    and supplier_id = v_supplier_1
    and location = 'q7'
    and line_class = 'stock';
  if v_count <> 1 then raise exception 'SMOKE_RESULT FAIL create_alias_count'; end if;

  -- Replay of the same request id returns the same item and writes nothing new.
  v_result := public.kho_create_item(
    'SMOKE món có NCC ' || substr(v_request::text, 1, 8),
    'kg', 'raw_material', false, true, null, null, v_request,
    array[v_supplier_1]
  );
  v_item_replay := (v_result->>'item_id')::uuid;
  if v_item_replay <> v_item then raise exception 'SMOKE_RESULT FAIL replay_item'; end if;

  select count(*) into v_count
  from public.kitchen_inventory_items
  where public.kho_item_name_key(name) = public.kho_item_name_key(
    'SMOKE món có NCC ' || substr(v_request::text, 1, 8)
  );
  if v_count <> 1 then raise exception 'SMOKE_RESULT FAIL replay_duplicate'; end if;

  -- kho_set_item_suppliers adds/removes and refuses to remove every supplier of
  -- an active item.
  v_result := public.kho_set_item_suppliers(
    v_item, array[v_supplier_1, v_supplier_2], v_request_2
  );
  if v_result->>'status' <> 'updated' then
    raise exception 'SMOKE_RESULT FAIL set_suppliers %', v_result;
  end if;
  select count(*) into v_count from public.kitchen_item_suppliers where item_id = v_item;
  if v_count <> 2 then raise exception 'SMOKE_RESULT FAIL set_suppliers_count'; end if;

  v_ok := false;
  begin
    perform public.kho_set_item_suppliers(v_item, array[]::uuid[], gen_random_uuid());
  exception when others then
    v_ok := sqlerrm like '%supplier_required%';
  end;
  if not v_ok then raise exception 'SMOKE_RESULT FAIL remove_all_guard'; end if;

  -- (3) The new item appears in ATTP before any receipt exists.
  v_checklist := public.kho_attp_checklist(180);
  if not exists (
    select 1
    from jsonb_array_elements(v_checklist->'suppliers') sup
    where (sup->>'supplier_id')::uuid = v_supplier_1
      and exists (
        select 1
        from jsonb_array_elements(sup->'items') item
        where (item->>'item_id')::uuid = v_item
      )
  ) then
    raise exception 'SMOKE_RESULT FAIL attp_explicit_scope';
  end if;

  -- (4) Rename an item with a unique canonical: canonical name + formulation
  -- ingredient_name follow, while amount/quantity stay unchanged.
  insert into public.sku_cogs_materials (
    id, material_code, canonical_name, normalized_name, default_unit, active, version
  ) values (
    v_material_unique,
    'SMOKE-' || substr(v_material_unique::text, 1, 8),
    'SMOKE tên chuẩn cũ ' || substr(v_material_unique::text, 1, 8),
    public.material_master_normalize('SMOKE tên chuẩn cũ ' || substr(v_material_unique::text, 1, 8)),
    'kg', true, 1
  );

  insert into public.kitchen_inventory_items (
    id, item_code, normalized_key, item_type, name, unit, active, item_class,
    in_tan_tao, pastry_q7, canonical_material_id
  ) values (
    v_item_unique,
    'SMOKE-' || substr(v_item_unique::text, 1, 8),
    'smoke:' || v_item_unique::text,
    'ingredient',
    'SMOKE tên kho cũ ' || substr(v_item_unique::text, 1, 8),
    'kg', true, 'raw_material', false, true, v_material_unique
  );

  insert into public.product_skus (
    sku_code, product_name, unit, category, base_unit,
    finished_output_qty, finished_output_unit, cost_template, cost_values,
    cost_widgets, hide_from_dealer_portal, sku_type
  ) values (
    'SMOKE-SKU-' || substr(v_item_unique::text, 1, 8),
    'SMOKE SKU', 'kg', 'smoke', 'kg', 1, 'kg', '{}'::jsonb, '{}'::jsonb,
    '{}'::jsonb, true, 'finished_good'
  )
  returning id into v_sku;

  insert into public.sku_cogs_versions (
    sku_id, version_no, effective_from, change_reason
  ) values (
    v_sku, 1, current_date, 'smoke item supplier name source'
  )
  returning id into v_version;

  insert into public.sku_cogs_version_formulations (
    version_id, canonical_material_id, ingredient_name, material_code,
    unit, unit_price, dosage_qty, wastage_percent, sort_order
  ) values (
    v_version, v_material_unique,
    'SMOKE tên chuẩn cũ ' || substr(v_material_unique::text, 1, 8),
    'SMOKE-' || substr(v_material_unique::text, 1, 8),
    'g', 12345, 7, 0, 1
  )
  returning id into v_formulation;

  select unit_price, dosage_qty into v_old_amount, v_old_qty
  from public.sku_cogs_version_formulations where id = v_formulation;

  perform public.rename_stock_item(
    v_item_unique,
    'SMOKE tên kho mới ' || substr(v_item_unique::text, 1, 8),
    gen_random_uuid()
  );

  select canonical_name into v_material_name
  from public.sku_cogs_materials where id = v_material_unique;
  if v_material_name <> 'SMOKE tên kho mới ' || substr(v_item_unique::text, 1, 8) then
    raise exception 'SMOKE_RESULT FAIL canonical_follow_rename got %', v_material_name;
  end if;

  select count(*) into v_count
  from public.sku_cogs_version_formulations
  where id = v_formulation
    and ingredient_name = 'SMOKE tên kho mới ' || substr(v_item_unique::text, 1, 8)
    and unit_price = v_old_amount
    and dosage_qty = v_old_qty;
  if v_count <> 1 then raise exception 'SMOKE_RESULT FAIL formulation_follow_rename'; end if;

  -- (5) A canonical shared by two active items is not renamed; the conflict is
  -- saved for the owner.
  insert into public.sku_cogs_materials (
    id, material_code, canonical_name, normalized_name, default_unit, active, version
  ) values (
    v_material_shared,
    'SMOKE-' || substr(v_material_shared::text, 1, 8),
    'SMOKE tên chuẩn dùng chung ' || substr(v_material_shared::text, 1, 8),
    public.material_master_normalize('SMOKE tên chuẩn dùng chung ' || substr(v_material_shared::text, 1, 8)),
    'kg', true, 1
  );

  insert into public.kitchen_inventory_items (
    id, item_code, normalized_key, item_type, name, unit, active, item_class,
    in_tan_tao, pastry_q7, canonical_material_id
  ) values
    (v_item_shared_a, 'SMOKE-' || substr(v_item_shared_a::text, 1, 8),
     'smoke:' || v_item_shared_a::text, 'ingredient',
     'SMOKE dùng chung A ' || substr(v_item_shared_a::text, 1, 8),
     'kg', true, 'raw_material', false, true, v_material_shared),
    (v_item_shared_b, 'SMOKE-' || substr(v_item_shared_b::text, 1, 8),
     'smoke:' || v_item_shared_b::text, 'ingredient',
     'SMOKE dùng chung B ' || substr(v_item_shared_b::text, 1, 8),
     'kg', true, 'raw_material', false, true, v_material_shared);

  perform public.rename_stock_item(
    v_item_shared_a,
    'SMOKE dùng chung A đổi ' || substr(v_item_shared_a::text, 1, 8),
    gen_random_uuid()
  );

  select canonical_name into v_material_name
  from public.sku_cogs_materials where id = v_material_shared;
  if v_material_name <> 'SMOKE tên chuẩn dùng chung ' || substr(v_material_shared::text, 1, 8) then
    raise exception 'SMOKE_RESULT FAIL shared_canonical_changed';
  end if;

  select count(*) into v_count
  from public.kho_item_name_sync_skips
  where item_id = v_item_shared_a
    and material_id = v_material_shared
    and reason = 'canonical_shared'
    and status = 'pending';
  if v_count <> 1 then raise exception 'SMOKE_RESULT FAIL shared_skip_row'; end if;

  -- (7) Merge keeps the target catalog name; source item name and supplier
  -- invoice name stay scan aliases; the candidate shows the target name.
  insert into public.kitchen_inventory_items (
    id, item_code, normalized_key, item_type, name, unit, active, item_class,
    in_tan_tao, pastry_q7
  ) values
    (v_merge_source, 'SMOKE-' || substr(v_merge_source::text, 1, 8),
     'smoke:' || v_merge_source::text, 'ingredient',
     'SMOKE tên nguồn ' || substr(v_merge_source::text, 1, 8),
     'kg', true, 'raw_material', false, true),
    (v_merge_target, 'SMOKE-' || substr(v_merge_target::text, 1, 8),
     'smoke:' || v_merge_target::text, 'ingredient',
     'SMOKE tên đích ' || substr(v_merge_target::text, 1, 8),
     'kg', true, 'raw_material', false, true);

  insert into public.kitchen_item_suppliers (item_id, supplier_id)
  values (v_merge_source, v_supplier_1);

  insert into public.supplier_order_catalog_items (
    supplier_id, kitchen_inventory_item_id, product_name, po_unit, po_unit_factor
  ) values (
    v_supplier_1, v_merge_source,
    'SMOKE tên hóa đơn ' || substr(v_merge_source::text, 1, 8),
    'kg', 1
  );

  perform public.apply_stock_item_merge(v_merge_source, v_merge_target, 1, null);

  select name into v_material_name
  from public.kitchen_inventory_items where id = v_merge_target;
  if v_material_name <> 'SMOKE tên đích ' || substr(v_merge_target::text, 1, 8) then
    raise exception 'SMOKE_RESULT FAIL merge_target_name';
  end if;

  select count(*) into v_count
  from public.stock_material_aliases
  where kitchen_inventory_item_id = v_merge_target
    and normalized_name = public.normalize_stock_item_name(
      'SMOKE tên nguồn ' || substr(v_merge_source::text, 1, 8)
    );
  if v_count < 1 then raise exception 'SMOKE_RESULT FAIL merge_source_alias'; end if;

  -- supplier_order_catalog_use_kho_name already forces catalog rows to the kho name, so the
  -- per-supplier invoice spellings live in stock_material_aliases and move with the source.

  select * into v_candidate
  from public.material_alias_candidates(
    'SMOKE tên nguồn ' || substr(v_merge_source::text, 1, 8),
    'q7', 5
  )
  limit 1;

  if v_candidate.item_id is distinct from v_merge_target
     or v_candidate.name <> 'SMOKE tên đích ' || substr(v_merge_target::text, 1, 8) then
    raise exception 'SMOKE_RESULT FAIL merge_candidate_name item=% name=%',
      v_candidate.item_id, v_candidate.name;
  end if;

  raise exception 'SMOKE_RESULT PASS item_suppliers_name_source (item=%, merge=%)',
    v_item, v_merge_target;
end;
$$;

rollback;
