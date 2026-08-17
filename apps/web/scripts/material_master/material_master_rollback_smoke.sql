-- Task 2 linked rollback-only runtime smoke for Canonical NVL Master Controller.
-- Execute as one reviewed transaction: BEGIN; <migration SQL>; <this file>; ROLLBACK; then verify synthetic absence.

select 'material_master_smoke: signatures' as step;
do $$
begin
  if to_regprocedure('public.resolve_canonical_material(text,text,text,uuid,text,date,text[])') is null then raise exception 'missing resolve_canonical_material signature'; end if;
  if to_regprocedure('public.request_material_resolution(text,text,uuid,uuid,text,text,text,uuid,jsonb)') is null then raise exception 'missing request_material_resolution signature'; end if;
  if to_regprocedure('public.create_canonical_material(text,text,text,text,text,text,text,uuid)') is null then raise exception 'missing create_canonical_material signature'; end if;
  if to_regprocedure('public.update_canonical_material(uuid,int,jsonb,text,uuid)') is null then raise exception 'missing update_canonical_material signature'; end if;
  if to_regprocedure('public.confirm_material_resolution(uuid,text,uuid,jsonb,jsonb,jsonb,text)') is null then raise exception 'missing confirm_material_resolution signature'; end if;
  if to_regprocedure('public.assert_material_ready(uuid,text[],uuid,text,date)') is null then raise exception 'missing assert_material_ready signature'; end if;
end $$;

create temp table mm_smoke_counts as
select
  (select count(*) from public.sku_cogs_materials) as sku_cogs_materials_count,
  (select count(*) from public.kitchen_inventory_items) as kitchen_inventory_items_count,
  (select count(*) from public.product_skus) as product_skus_count,
  (select count(*) from public.purchase_order_items) as purchase_order_items_count,
  (select count(*) from public.goods_receipt_items) as goods_receipt_items_count,
  (select count(*) from public.payment_request_items) as payment_request_items_count,
  (select count(*) from public.invoice_items) as invoice_items_count,
  (select count(*) from public.sku_cogs_version_formulations) as sku_cogs_version_formulations_count,
  (select count(*) from public.production_material_issue_items) as production_material_issue_items_count,
  (select count(*) from public.kfm_daily_material_issue_items) as kfm_daily_material_issue_items_count;

select set_config('request.jwt.claim.role','service_role', true);
select set_config('request.jwt.claims', jsonb_build_object('role','service_role','sub', coalesce((select user_id::text from public.user_roles where role='owner' limit 1), '00000000-0000-0000-0000-000000000000'))::text, true);

select 'material_master_smoke: ACL/DML privilege hardening' as step;
do $$
begin
  if has_table_privilege('anon', 'public.sku_cogs_materials', 'insert') or has_table_privilege('anon', 'public.sku_cogs_materials', 'update') or has_table_privilege('anon', 'public.sku_cogs_materials', 'delete') or has_table_privilege('anon', 'public.sku_cogs_materials', 'truncate') then
    raise exception 'anon must not have direct sku_cogs_materials DML privileges';
  end if;
  if has_table_privilege('authenticated', 'public.sku_cogs_materials', 'insert') or has_table_privilege('authenticated', 'public.sku_cogs_materials', 'update') or has_table_privilege('authenticated', 'public.sku_cogs_materials', 'delete') or has_table_privilege('authenticated', 'public.sku_cogs_materials', 'truncate') then
    raise exception 'authenticated must not have direct sku_cogs_materials DML privileges';
  end if;
  if has_table_privilege('service_role', 'public.sku_cogs_materials', 'insert') or has_table_privilege('service_role', 'public.sku_cogs_materials', 'update') or has_table_privilege('service_role', 'public.sku_cogs_materials', 'delete') or has_table_privilege('service_role', 'public.sku_cogs_materials', 'truncate') then
    raise exception 'service_role must not have direct canonical root DML privileges';
  end if;
  if has_table_privilege('service_role', 'public.sku_cogs_material_aliases', 'insert') or has_table_privilege('service_role', 'public.sku_cogs_material_aliases', 'update') or has_table_privilege('service_role', 'public.sku_cogs_material_aliases', 'delete') or has_table_privilege('service_role', 'public.sku_cogs_material_aliases', 'truncate') then
    raise exception 'service_role must not have direct global alias DML privileges';
  end if;

  if has_function_privilege('authenticated', 'public.trg_material_unit_conversions_reject_approved_overlap()', 'execute') or has_function_privilege('service_role', 'public.trg_material_unit_conversions_reject_approved_overlap()', 'execute') then raise exception 'trigger-only conversion function execute must be revoked'; end if;
  if has_function_privilege('authenticated', 'public.trg_material_price_history_reject_approved_overlap()', 'execute') or has_function_privilege('service_role', 'public.trg_material_price_history_reject_approved_overlap()', 'execute') then raise exception 'trigger-only price function execute must be revoked'; end if;
  if has_function_privilege('authenticated', 'public.trg_material_master_audit_append_only()', 'execute') or has_function_privilege('service_role', 'public.trg_material_master_audit_append_only()', 'execute') then raise exception 'trigger-only audit function execute must be revoked'; end if;
  if has_function_privilege('authenticated', 'public.trg_guard_canonical_material_identity()', 'execute') or has_function_privilege('service_role', 'public.trg_guard_canonical_material_identity()', 'execute') then raise exception 'trigger-only canonical guard function execute must be revoked'; end if;
  if has_function_privilege('authenticated', 'public.trg_validate_canonical_material_fk_active()', 'execute') or has_function_privilege('service_role', 'public.trg_validate_canonical_material_fk_active()', 'execute') then raise exception 'trigger-only FK active function execute must be revoked'; end if;

end $$;

select 'material_master_smoke: exact existing code/name and candidate fail-closed' as step;
do $$
declare
  v_existing public.sku_cogs_materials%rowtype;
  v_code jsonb;
  v_name jsonb;
  v_unknown jsonb;
begin
  select * into v_existing from public.sku_cogs_materials where active = true order by created_at, id limit 1;
  if not found then raise exception 'smoke requires at least one active canonical material'; end if;
  v_code := public.resolve_canonical_material(v_existing.canonical_name, v_existing.material_code, v_existing.default_unit, null, 'smoke', current_date, '{}'::text[]);
  if coalesce((v_code->>'resolved_exact')::boolean, false) is not true or v_code->>'match_source' <> 'material_code' then raise exception 'existing material_code did not resolve_exact: %', v_code; end if;
  v_name := public.resolve_canonical_material(v_existing.canonical_name, null, v_existing.default_unit, null, 'smoke', current_date, '{}'::text[]);
  if coalesce((v_name->>'resolved_exact')::boolean, false) is not true or v_name->>'match_source' <> 'normalized_name' then raise exception 'existing normalized name did not resolve_exact: %', v_name; end if;
  v_unknown := public.resolve_canonical_material('fuzzy ai_candidate smoke unknown ' || gen_random_uuid()::text, null, null, null, 'smoke', current_date, '{}'::text[]);
  if coalesce((v_unknown->>'resolved_exact')::boolean, false) is true or v_unknown->>'status' not in ('not_found','confirmation_needed','ambiguous') then raise exception 'candidate/fuzzy/unknown must fail closed: %', v_unknown; end if;
end $$;

select 'material_master_smoke: synthetic create/update/request/idempotency/direct guards' as step;
do $$
declare
  v_created jsonb;
  v_material_id uuid;
  v_material2_id uuid;
  v_version int;
  v_update jsonb;
  v_req1 jsonb;
  v_req2 jsonb;
  v_req_exact jsonb;
  v_confirm jsonb;
  v_confirm2 jsonb;
  v_confirm_new jsonb;
  v_alias_count int;
  v_audit_count int;
  v_old_name text;
  v_supplier_id uuid;
  v_supplier_alias text := 'Supplier Scoped Alias ' || gen_random_uuid()::text;
  v_source_alias text := 'Source Scoped Alias ' || gen_random_uuid()::text;
  v_mixed_alias text := 'Mixed Source Alias ' || gen_random_uuid()::text;
  v_ready jsonb;
  v_kitchen_item_id uuid;
  v_conflict_alias text := 'Conflict Alias ' || gen_random_uuid()::text;
  v_new_code text;
  v_new_code2 text;
  v_supplier_product_name text;
  v_existing_supplier_product_id uuid;
begin
  select id into v_supplier_id from public.suppliers order by id limit 1;
  if v_supplier_id is null then raise exception 'smoke requires at least one supplier for scoped alias probes'; end if;

  v_created := public.create_canonical_material('NVL-SMOKE-' || substr(replace(gen_random_uuid()::text,'-',''),1,12), 'Smoke Canonical NVL ' || gen_random_uuid()::text, 'kg', null, null, null, 'rollback smoke create', null);
  v_material_id := (v_created->>'material_id')::uuid;
  v_new_code := v_created->>'material_code';
  v_created := public.create_canonical_material(null, 'Smoke Canonical NVL 2 ' || gen_random_uuid()::text, 'kg', null, null, null, 'rollback smoke sequence collision', null);
  v_material2_id := (v_created->>'material_id')::uuid;
  v_new_code2 := v_created->>'material_code';
  if v_new_code = v_new_code2 then raise exception 'sequence collision generated duplicate code %', v_new_code; end if;

  select id into v_kitchen_item_id from public.kitchen_inventory_items order by id limit 1;
  if v_kitchen_item_id is null then raise exception 'smoke requires at least one kitchen inventory item for q7 mapping probe'; end if;

  raise notice 'material_master_smoke: ready response contract and blockers';
  v_ready := public.assert_material_ready(v_material_id, array['standard_cost','q7_mapping','standard_cost','unknown_capability'], null, 'kg', current_date);
  if not (v_ready ? 'status' and v_ready ? 'material_id' and v_ready ? 'blockers' and (v_ready - 'ready') = jsonb_build_object('status', v_ready->'status', 'material_id', v_ready->'material_id', 'blockers', v_ready->'blockers')) then
    raise exception 'assert_material_ready response contract unexpected: %', v_ready;
  end if;
  if (v_ready->>'material_id')::uuid <> v_material_id then raise exception 'assert_material_ready omitted correct material_id: %', v_ready; end if;
  if not (v_ready->'blockers' ? 'missing_standard_cost') or not (v_ready->'blockers' ? 'missing_q7_mapping') or not (v_ready->'blockers' ? 'unsupported_capability') then
    raise exception 'assert_material_ready missing expected blockers/dedupe vocabulary: %', v_ready;
  end if;
  if (select count(*) from jsonb_array_elements_text(v_ready->'blockers') b where b = 'missing_standard_cost') <> 1 then raise exception 'assert_material_ready blockers were not deduped: %', v_ready; end if;
  raise notice 'material_master_smoke: approved global standard cost satisfies readiness';
  insert into public.material_price_history(material_id, supplier_product_id, price_type, price, price_unit, effective_from, effective_to, approved, approved_by, approved_at)
  values (v_material_id, null, 'standard_cost', 1, 'kg', current_date, null, true, auth.uid(), now());
  v_ready := public.assert_material_ready(v_material_id, array['standard_cost'], null, 'kg', current_date);
  if v_ready->'blockers' ? 'missing_standard_cost' then
    raise exception 'missing_standard_cost should clear after approved global standard cost: %', v_ready;
  end if;
  if coalesce((v_ready->>'ready')::boolean, false) is not true then
    raise exception 'approved global standard cost did not make standard_cost readiness true: %', v_ready;
  end if;
  insert into public.q7_material_issue_material_mappings(canonical_material_id, source_unit, kitchen_inventory_item_id, kitchen_unit, conversion_factor, approval_status, approved_by, approved_at, created_by, updated_by)
  values (v_material_id, 'kg', v_kitchen_item_id, 'kg', 1, 'approved', auth.uid(), now(), auth.uid(), auth.uid());
  v_ready := public.assert_material_ready(v_material_id, array['q7_mapping'], null, 'KG', current_date);
  if v_ready->'blockers' ? 'missing_q7_mapping' then raise exception 'approved q7 mapping with normalized unit did not satisfy readiness: %', v_ready; end if;


  begin
    update public.sku_cogs_materials set active = false where id = v_material_id;
    raise exception 'direct active mutation should have failed';
  exception when check_violation then null;
  end;

  select version, canonical_name into v_version, v_old_name from public.sku_cogs_materials where id=v_material_id;
  v_update := public.update_canonical_material(v_material_id, v_version, jsonb_build_object('canonical_name','Smoke Canonical NVL Renamed ' || gen_random_uuid()::text), 'rollback smoke rename', null);
  if coalesce((v_update->>'alias_created_for_old_name')::boolean, false) is not true then raise exception 'update did not return alias_created_for_old_name: %', v_update; end if;
  select count(*) into v_alias_count from public.sku_cogs_material_aliases where material_id=v_material_id and normalized_alias=public.material_master_normalize(v_old_name);
  if v_alias_count <> 1 then raise exception 'old-name alias was not created'; end if;
  -- approved global legacy alias resolves
  if public.resolve_canonical_material(v_old_name, null, 'kg', null, null, current_date, '{}'::text[])->>'match_source' <> 'approved_global_alias' then raise exception 'approved global legacy alias resolves probe failed'; end if;

  perform set_config('material_master.rpc_update','on', true);
  update public.sku_cogs_materials set version=null where id=v_material_id;
  v_update := public.update_canonical_material(v_material_id, 0, jsonb_build_object('category','Legacy Null Version'), 'legacy null version update', null);
  if (v_update->>'version')::int <> 1 then raise exception 'legacy-null version expected 0 did not become 1: %', v_update; end if;

  v_req1 := public.request_material_resolution('smoke','smoke_table',gen_random_uuid(),gen_random_uuid(),'Smoke raw unresolved ' || gen_random_uuid()::text,'SMK-RAW','kg',null,jsonb_build_object('candidate_source','ocr','confidence',0.5,'field_name','name','raw_text','secret raw'));
  v_req2 := public.request_material_resolution('smoke','smoke_table',(select source_id from public.material_resolution_requests where id=(v_req1->>'request_id')::uuid),(select source_line_id from public.material_resolution_requests where id=(v_req1->>'request_id')::uuid),'Smoke raw unresolved ' || split_part((select raw_name from public.material_resolution_requests where id=(v_req1->>'request_id')::uuid),'Smoke raw unresolved ',2),'SMK-RAW','kg',null,'{}'::jsonb);
  if v_req1->>'status' <> 'request_created' or v_req2->>'status' <> 'request_existing' or v_req1->>'request_id' <> v_req2->>'request_id' then raise exception 'request returns request_created then request_existing failed: % / %', v_req1, v_req2; end if;
  if exists (select 1 from public.material_resolution_requests where id=(v_req1->>'request_id')::uuid and safe_payload ? 'raw_text') then raise exception 'unsafe raw_text stored in resolution request safe_payload'; end if;

  v_req_exact := public.request_material_resolution('smoke','smoke_table',gen_random_uuid(),null,(select canonical_name from public.sku_cogs_materials where id=v_material_id),null,'kg',null,'{}'::jsonb);
  if v_req_exact->>'status' <> 'already_resolved' or v_req_exact->>'resolution_status' <> 'resolved_existing' then raise exception 'exact request can return already_resolved failed: %', v_req_exact; end if;

  v_confirm := public.confirm_material_resolution((v_req1->>'request_id')::uuid, 'resolve_existing', v_material_id, null, jsonb_build_object('alias_name', v_source_alias, 'candidate_source','human'), '{}'::jsonb, 'confirm existing');
  if v_confirm->>'status' <> 'resolved_existing' then raise exception 'confirm resolved_existing failed: %', v_confirm; end if;
  v_confirm2 := public.confirm_material_resolution((v_req1->>'request_id')::uuid, 'resolve_existing', v_material_id, null, '{}'::jsonb, '{}'::jsonb, 'confirm unchanged');
  if v_confirm2->>'status' <> 'resolution_unchanged' then raise exception 'confirm resolution_unchanged semantics failed: %', v_confirm2; end if;
  -- approved source-scoped alias resolves for exact source
  if public.resolve_canonical_material(v_source_alias, null, 'kg', null, 'smoke', current_date, '{}'::text[])->>'match_source' <> 'approved_source_alias' then raise exception 'approved source-scoped alias resolves probe failed'; end if;

  raise notice 'material_master_smoke: mixed-case source scope normalizes';
  v_req1 := public.request_material_resolution('MiXeD_Source','smoke_table',gen_random_uuid(),gen_random_uuid(),v_mixed_alias,null,'kg',null,'{}'::jsonb);
  v_confirm := public.confirm_material_resolution((v_req1->>'request_id')::uuid, 'resolve_existing', v_material_id, null, jsonb_build_object('alias_name', v_mixed_alias), '{}'::jsonb, 'confirm mixed source alias');
  if not exists (select 1 from public.material_resolution_requests where id=(v_req1->>'request_id')::uuid and source_type='mixed_source') then raise exception 'mixed-case request source_type was not normalized'; end if;
  if public.resolve_canonical_material(v_mixed_alias, null, 'kg', null, 'MIXED_SOURCE', current_date, '{}'::text[])->>'match_source' <> 'approved_source_alias' then raise exception 'mixed-case source alias did not resolve from another casing'; end if;
  -- duplicate casing cannot create separate approved alias
  v_req1 := public.request_material_resolution('MIXED_SOURCE','smoke_table',gen_random_uuid(),gen_random_uuid(),'Duplicate casing cannot create separate approved alias ' || gen_random_uuid()::text,null,'kg',null,'{}'::jsonb);
  begin
    perform public.confirm_material_resolution((v_req1->>'request_id')::uuid, 'resolve_existing', v_material2_id, null, jsonb_build_object('alias_name', v_mixed_alias), '{}'::jsonb, 'mixed source alias conflict');
    raise exception 'duplicate casing cannot create separate approved alias probe failed';
  exception when unique_violation then null;
  end;


  v_req1 := public.request_material_resolution('smoke','smoke_table',gen_random_uuid(),gen_random_uuid(),'Smoke create new ' || gen_random_uuid()::text,null,'kg',null,'{}'::jsonb);
  v_confirm_new := public.confirm_material_resolution((v_req1->>'request_id')::uuid, 'create_new', null, jsonb_build_object('canonical_name','Smoke Created From Request ' || gen_random_uuid()::text, 'default_unit','kg'), '{}'::jsonb, '{}'::jsonb, 'confirm created');
  if v_confirm_new->>'status' <> 'created_new' then raise exception 'confirm created_new failed: %', v_confirm_new; end if;

  -- approved supplier scoped alias resolves before a conflicting global alias
  raise notice 'material_master_smoke: idempotent terminal ids';
  v_supplier_product_name := v_supplier_alias;
  v_req1 := public.request_material_resolution('smoke_supplier','smoke_table',gen_random_uuid(),gen_random_uuid(),v_supplier_alias,null,'kg',v_supplier_id,'{}'::jsonb);
  v_confirm := public.confirm_material_resolution((v_req1->>'request_id')::uuid, 'resolve_existing', v_material_id, null, jsonb_build_object('alias_name', v_supplier_alias), jsonb_build_object('name', v_supplier_product_name, 'code', 'SMK-' || substr(replace(gen_random_uuid()::text,'-',''),1,12), 'purchase_unit','kg', 'base_unit','kg', 'base_quantity',1), 'confirm supplier alias with product');
  v_confirm2 := public.confirm_material_resolution((v_req1->>'request_id')::uuid, 'resolve_existing', v_material_id, null, '{}'::jsonb, '{}'::jsonb, 'confirm supplier alias unchanged ids');
  if v_confirm->>'alias_id' is null or v_confirm->>'supplier_product_id' is null or v_confirm2->>'status' <> 'resolution_unchanged' or v_confirm2->>'alias_id' <> v_confirm->>'alias_id' or v_confirm2->>'supplier_product_id' <> v_confirm->>'supplier_product_id' then
    raise exception 'idempotent terminal ids alias_id/supplier_product_id did not persist: % / %', v_confirm, v_confirm2;
  end if;
  v_existing_supplier_product_id := (v_confirm->>'supplier_product_id')::uuid;
  raise notice 'material_master_smoke: same-material supplier product normalized name/unit reuses existing id';
  v_req1 := public.request_material_resolution('smoke_supplier','smoke_table',gen_random_uuid(),gen_random_uuid(),'Same-material supplier product reuse raw alias ' || gen_random_uuid()::text,null,'kg',v_supplier_id,'{}'::jsonb);
  v_confirm := public.confirm_material_resolution((v_req1->>'request_id')::uuid, 'resolve_existing', v_material_id, null, jsonb_build_object('alias_name', 'Same Material Supplier Alias ' || gen_random_uuid()::text), jsonb_build_object('name', v_supplier_product_name, 'purchase_unit','kg', 'base_unit','kg', 'base_quantity',1), 'same-material supplier product normalized name/unit reuse');
  if v_confirm->>'status' <> 'resolved_existing' or (v_confirm->>'supplier_product_id')::uuid <> v_existing_supplier_product_id then
    raise exception 'supplier product same-material duplicate should reuse existing id: existing %, confirm %', v_existing_supplier_product_id, v_confirm;
  end if;
  v_confirm2 := public.confirm_material_resolution((v_req1->>'request_id')::uuid, 'resolve_existing', v_material_id, null, '{}'::jsonb, '{}'::jsonb, 'same-material supplier product terminal id reuse');
  if v_confirm2->>'status' <> 'resolution_unchanged' or (v_confirm2->>'supplier_product_id')::uuid <> v_existing_supplier_product_id then
    raise exception 'supplier product same-material reused id did not persist to terminal request: %', v_confirm2;
  end if;
  raise notice 'material_master_smoke: different purchase unit may coexist';
  insert into public.material_supplier_products(material_id, supplier_id, supplier_product_name, normalized_supplier_product_name, purchase_unit, base_quantity, base_unit, approved, approved_by, approved_at, active, created_by)
  values (v_material2_id, v_supplier_id, v_supplier_product_name, public.material_master_normalize(v_supplier_product_name), 'bag', 1, 'kg', true, auth.uid(), now(), true, auth.uid());
  raise notice 'material_master_smoke: duplicate active supplier product normalized name/unit must fail closed with SQLSTATE 23505';
  v_req1 := public.request_material_resolution('smoke_supplier','smoke_table',gen_random_uuid(),gen_random_uuid(),'Duplicate active supplier product normalized name/unit ' || gen_random_uuid()::text,null,'kg',v_supplier_id,'{}'::jsonb);
  begin
    perform public.confirm_material_resolution((v_req1->>'request_id')::uuid, 'resolve_existing', v_material2_id, null, '{}'::jsonb, jsonb_build_object('name', v_supplier_product_name, 'purchase_unit','kg', 'base_unit','kg', 'base_quantity',1), 'duplicate active supplier product normalized name/unit');
    raise exception 'supplier product duplicate normalized name/unit should have failed';
  exception when unique_violation then null;
  end;
  insert into public.sku_cogs_material_aliases(material_id, alias_name, normalized_alias, source, active, created_by)
  values (v_material2_id, v_supplier_alias, public.material_master_normalize(v_supplier_alias), 'approved_global_alias', true, auth.uid())
  on conflict (normalized_alias) do nothing;
  if public.resolve_canonical_material(v_supplier_alias, null, 'kg', v_supplier_id, 'smoke_supplier', current_date, '{}'::text[])->>'match_source' <> 'approved_supplier_alias' then raise exception 'approved supplier scoped alias resolves before conflicting global alias probe failed'; end if;

  -- attempts to reassign supplier/source/global alias across two synthetic canonical materials reject
  v_req1 := public.request_material_resolution('smoke_supplier','smoke_table',gen_random_uuid(),gen_random_uuid(),'Supplier alias conflict request ' || gen_random_uuid()::text,null,'kg',v_supplier_id,'{}'::jsonb);
  begin
    perform public.confirm_material_resolution((v_req1->>'request_id')::uuid, 'resolve_existing', v_material2_id, null, jsonb_build_object('alias_name', v_supplier_alias), '{}'::jsonb, 'supplier alias conflict');
    raise exception 'supplier alias reassignment did not reject';
  exception when unique_violation then null;
  end;
  v_req1 := public.request_material_resolution('smoke','smoke_table',gen_random_uuid(),gen_random_uuid(),'Source alias conflict request ' || gen_random_uuid()::text,null,'kg',null,'{}'::jsonb);
  begin
    perform public.confirm_material_resolution((v_req1->>'request_id')::uuid, 'resolve_existing', v_material2_id, null, jsonb_build_object('alias_name', v_source_alias), '{}'::jsonb, 'source alias conflict');
    raise exception 'source alias reassignment did not reject';
  exception when unique_violation then null;
  end;
  insert into public.sku_cogs_material_aliases(material_id, alias_name, normalized_alias, source, active, created_by)
  values (v_material_id, v_conflict_alias, public.material_master_normalize(v_conflict_alias), 'approved_global_alias', true, auth.uid());
  begin
    insert into public.sku_cogs_material_aliases(material_id, alias_name, normalized_alias, source, active, created_by)
    values (v_material2_id, v_conflict_alias, public.material_master_normalize(v_conflict_alias), 'approved_global_alias', true, auth.uid());
    raise exception 'global alias reassignment did not reject';
  exception when unique_violation then null;
  end;

  begin
    perform public.confirm_material_resolution(
      (public.request_material_resolution('smoke','smoke_table',gen_random_uuid(),gen_random_uuid(),'Smoke no unit raw',null,null,null,'{}'::jsonb)->>'request_id')::uuid,
      'create_new', null, jsonb_build_object('canonical_name','Smoke Missing Unit'), '{}'::jsonb, '{}'::jsonb, 'missing unit rejection'
    );
    raise exception 'create_new without explicit/default request raw_unit should have failed';
  exception when invalid_parameter_value then null;
  end;

  select count(*) into v_audit_count from public.material_master_audit_logs where material_id=v_material_id;
  if v_audit_count < 2 then raise exception 'audit logs missing for create/update'; end if;
  begin
    update public.material_master_audit_logs set reason='mutated' where material_id=v_material_id;
    raise exception 'audit update was not rejected';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.material_master_audit_logs where material_id=v_material_id;
    raise exception 'audit delete was not rejected';
  exception when insufficient_privilege then null;
  end;
end $$;

select 'material_master_smoke: effective-range overlaps reject and pg_advisory_xact_lock executes' as step;
do $$
declare
  v_material_id uuid;
  v_lock_count_before integer;
  v_lock_count_after_conversion integer;
  v_lock_count_after_price integer;
begin
  select id into v_material_id from public.sku_cogs_materials where active=true order by created_at, id limit 1;
  select count(*) into v_lock_count_before from pg_catalog.pg_locks where locktype='advisory' and pid=pg_backend_pid() and granted;
  insert into public.material_unit_conversions(material_id, from_unit, to_unit, factor, effective_from, effective_to, approved, approved_by, approved_at, active)
  values (v_material_id, 'box', 'kg', 1, date '2026-01-01', date '2026-12-31', true, auth.uid(), now(), true);
  select count(*) into v_lock_count_after_conversion from pg_catalog.pg_locks where locktype='advisory' and pid=pg_backend_pid() and granted;
  if v_lock_count_after_conversion <= v_lock_count_before then raise exception 'conversion overlap trigger did not acquire an advisory xact lock'; end if;
  begin
    insert into public.material_unit_conversions(material_id, from_unit, to_unit, factor, effective_from, effective_to, approved, approved_by, approved_at, active)
    values (v_material_id, 'box', 'kg', 2, date '2026-06-01', date '2027-01-01', true, auth.uid(), now(), true);
    raise exception 'overlapping approved conversion insert was not rejected';
  exception when unique_violation then null;
  end;
  insert into public.material_price_history(material_id, price_type, price, price_unit, effective_from, effective_to, approved, approved_by, approved_at)
  values (v_material_id, 'standard_cost', 1, 'kg', date '2026-01-01', date '2026-12-31', true, auth.uid(), now());
  select count(*) into v_lock_count_after_price from pg_catalog.pg_locks where locktype='advisory' and pid=pg_backend_pid() and granted;
  if v_lock_count_after_price <= v_lock_count_after_conversion then raise exception 'price overlap trigger did not acquire an advisory xact lock'; end if;
  begin
    insert into public.material_price_history(material_id, price_type, price, price_unit, effective_from, effective_to, approved, approved_by, approved_at)
    values (v_material_id, 'standard_cost', 2, 'kg', date '2026-06-01', date '2027-01-01', true, auth.uid(), now());
    raise exception 'overlapping approved price insert was not rejected';
  exception when unique_violation then null;
  end;
end $$;

select 'material_master_smoke: protected counts unchanged except rollback-only synthetic canonical/request/audit rows' as step;
do $$
declare c record;
begin
  select * into c from mm_smoke_counts;
  if (select count(*) from public.kitchen_inventory_items) <> c.kitchen_inventory_items_count then raise exception 'kitchen_inventory_items count changed'; end if;
  if (select count(*) from public.product_skus) <> c.product_skus_count then raise exception 'product_skus count changed'; end if;
  if (select count(*) from public.purchase_order_items) <> c.purchase_order_items_count then raise exception 'purchase_order_items count changed'; end if;
  if (select count(*) from public.goods_receipt_items) <> c.goods_receipt_items_count then raise exception 'goods_receipt_items count changed'; end if;
  if (select count(*) from public.payment_request_items) <> c.payment_request_items_count then raise exception 'payment_request_items count changed'; end if;
  if (select count(*) from public.invoice_items) <> c.invoice_items_count then raise exception 'invoice_items count changed'; end if;
  if (select count(*) from public.sku_cogs_version_formulations) <> c.sku_cogs_version_formulations_count then raise exception 'sku_cogs_version_formulations count changed'; end if;
  if (select count(*) from public.production_material_issue_items) <> c.production_material_issue_items_count then raise exception 'production_material_issue_items count changed'; end if;
  if (select count(*) from public.kfm_daily_material_issue_items) <> c.kfm_daily_material_issue_items_count then raise exception 'kfm_daily_material_issue_items count changed'; end if;
end $$;

select 'material_master_smoke: PASS before explicit ROLLBACK by wrapper' as step;
