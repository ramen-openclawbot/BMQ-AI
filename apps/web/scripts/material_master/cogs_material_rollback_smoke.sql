-- Task7 COGS canonical controller executable rollback smoke.
-- Intended shape: concatenate Task2 foundation + Task7 migration + this file, then run in a linked DB inside BEGIN/ROLLBACK.
-- No production apply/deploy/push. This smoke uses assertions and rolls back every fixture.

BEGIN;

select set_config('request.jwt.claim.role','service_role', true);
select set_config('request.jwt.claims', jsonb_build_object('role','service_role','sub', coalesce((select user_id::text from public.user_roles where role='owner' limit 1), '00000000-0000-0000-0000-000000000000'))::text, true);

DO $$
DECLARE
  v_before_linked integer;
  v_after_linked integer;
  v_before_versions integer;
  v_after_versions integer;
  v_material_id uuid;
  v_material_b uuid;
  v_request_one uuid;
  v_request_two uuid;
  v_res jsonb;
  v_ready jsonb;
  v_sku_id uuid;
  v_version_id uuid;
  v_snapshot_before jsonb;
  v_snapshot_after jsonb;
BEGIN
  PERFORM 'service_role_actor_spoof_denial';
  IF has_function_privilege('service_role', 'public.save_sku_cogs(uuid,jsonb,jsonb,date,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.apply_sku_cogs_material_resolution(uuid,text,text,text,date,boolean,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.assert_sku_cogs_materials_ready(jsonb,date,boolean)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.sku_cogs_material_price_snapshot(uuid,text,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role actor spoof path unexpectedly has Task7 execute privilege';
  END IF;

  -- exact_alias_unit_price_snapshot
  SELECT count(*) INTO v_before_linked FROM public.sku_formulations WHERE canonical_material_id IS NOT NULL;
  SELECT count(*) INTO v_before_versions FROM public.sku_cogs_versions;

  INSERT INTO public.sku_cogs_materials(material_code, canonical_name, normalized_name, default_unit, active)
  VALUES ('NVL-TASK7-EXACT', 'Task7 Exact Flour', public.material_master_normalize('Task7 Exact Flour'), 'g', true)
  RETURNING id INTO v_material_id;

  INSERT INTO public.sku_cogs_material_aliases(material_id, alias_name, normalized_alias, source, active)
  VALUES (v_material_id, 'Task7 OCR Flour', public.material_master_normalize('Task7 OCR Flour'), 'approved_global_alias', true);

  INSERT INTO public.material_price_history(material_id, price_type, price, price_unit, normalized_base_unit_price, effective_from, approved, approved_by, approved_at)
  VALUES (v_material_id, 'standard_cost', 12, 'g', 12, current_date - 1, true, auth.uid(), now());

  PERFORM public.resolve_canonical_material('Task7 OCR Flour', NULL, 'g', NULL, 'sku_cogs', current_date, array['unit','standard_cost']);
  v_res := public.apply_sku_cogs_material_resolution(NULL, 'Task7 OCR Flour', NULL, 'g', current_date, false, 'exact_alias_unit_price_snapshot');
  IF coalesce((v_res->>'resolved_exact')::boolean, false) IS NOT TRUE OR v_res->>'canonical_material_code' <> 'NVL-TASK7-EXACT' OR nullif(v_res->>'request_id','') IS NOT NULL THEN
    RAISE EXCEPTION 'exact_alias_unit_price_snapshot failed or created a spurious pending request: %', v_res;
  END IF;

  -- ambiguous_missing_request_idempotent
  INSERT INTO public.sku_cogs_materials(material_code, canonical_name, normalized_name, default_unit, active)
  VALUES ('NVL-TASK7-AMB-A', 'Task7 Ambiguous A', public.material_master_normalize('Task7 Ambiguous A'), 'g', true)
  RETURNING id INTO v_material_b;
  INSERT INTO public.sku_cogs_materials(material_code, canonical_name, normalized_name, default_unit, active)
  VALUES ('NVL-TASK7-AMB-B', 'Task7 Ambiguous B', public.material_master_normalize('Task7 Ambiguous B'), 'g', true);
  v_res := public.apply_sku_cogs_material_resolution(NULL, 'Task7 Ambiguous', NULL, 'g', current_date, false, 'ambiguous_missing_request_idempotent');
  v_request_one := (v_res->>'request_id')::uuid;
  v_res := public.apply_sku_cogs_material_resolution(NULL, 'Task7 Ambiguous', NULL, 'g', current_date, false, 'ambiguous_missing_request_idempotent repeat');
  v_request_two := (v_res->>'request_id')::uuid;
  IF v_request_one IS NULL OR v_request_one IS DISTINCT FROM v_request_two THEN
    RAISE EXCEPTION 'ambiguous_missing_request_idempotent failed: %, %', v_request_one, v_request_two;
  END IF;
  PERFORM public.request_material_resolution('sku_cogs', 'sku_formulations', NULL, NULL, 'Task7 Missing', NULL, 'g', NULL, jsonb_build_object('candidate_source','smoke','confidence','pending','field_name','sku_formulations.canonical_material_id'));

  -- incompatible_unit_blocked
  v_res := public.apply_sku_cogs_material_resolution(NULL, 'Task7 OCR Flour', NULL, 'kg', current_date, false, 'incompatible_unit_blocked');
  IF coalesce((v_res->>'resolved_exact')::boolean, false) IS TRUE THEN
    RAISE EXCEPTION 'incompatible_unit_blocked failed: %', v_res;
  END IF;

  -- zero_cost_requires_policy_approval
  INSERT INTO public.sku_cogs_materials(material_code, canonical_name, normalized_name, default_unit, active)
  VALUES ('NVL-TASK7-ZERO', 'Task7 Zero', public.material_master_normalize('Task7 Zero'), 'g', true)
  RETURNING id INTO v_material_b;
  INSERT INTO public.material_price_history(material_id, price_type, price, price_unit, normalized_base_unit_price, effective_from, approved, approved_by, approved_at)
  VALUES (v_material_b, 'standard_cost', 0, 'g', 0, current_date - 1, true, auth.uid(), now());
  v_res := public.apply_sku_cogs_material_resolution(NULL, 'Task7 Zero', NULL, 'g', current_date, false, 'zero_cost_requires_policy_approval');
  IF coalesce((v_res->>'resolved_exact')::boolean, false) IS TRUE THEN
    RAISE EXCEPTION 'zero cost without approval unexpectedly resolved: %', v_res;
  END IF;
  v_res := public.apply_sku_cogs_material_resolution(NULL, 'Task7 Zero', NULL, 'g', current_date, true, 'zero_cost_requires_policy_approval approved');
  IF coalesce((v_res->>'resolved_exact')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'zero cost with approval failed: %', v_res;
  END IF;

  -- publish_snapshot_immutability_idempotency
  v_ready := public.assert_sku_cogs_materials_ready(jsonb_build_array(jsonb_build_object('ingredient_name','Task7 OCR Flour','unit','g','dosage_qty',2)), current_date, false);
  IF coalesce((v_ready->>'ready')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'assert_sku_cogs_materials_ready failed: %', v_ready;
  END IF;
  SELECT saved_sku_id, version_id INTO v_sku_id, v_version_id
  FROM public.save_sku_cogs(NULL, jsonb_build_object('sku_code','TASK7-SMOKE','product_name','Task7 Smoke SKU','unit','cái','category','Thành phẩm','base_unit','cái','finished_output_qty',1,'finished_output_unit','cái','zeroCostApproval',false), jsonb_build_array(jsonb_build_object('ingredient_name','Task7 OCR Flour','unit','g','dosage_qty',2,'sort_order',1)), current_date + 30, 'publish_snapshot_immutability_idempotency');
  SELECT canonical_material_snapshot INTO v_snapshot_before FROM public.sku_cogs_version_formulations WHERE version_id = v_version_id LIMIT 1;
  PERFORM set_config('material_master.rpc_update', 'on', true);
  UPDATE public.sku_cogs_materials SET canonical_name = 'Task7 Exact Flour Renamed', normalized_name = public.material_master_normalize('Task7 Exact Flour Renamed'), version = coalesce(version, 1) + 1 WHERE id = v_material_id;
  SELECT canonical_material_snapshot INTO v_snapshot_after FROM public.sku_cogs_version_formulations WHERE version_id = v_version_id LIMIT 1;
  IF v_snapshot_before IS DISTINCT FROM v_snapshot_after THEN
    RAISE EXCEPTION 'publish snapshot was mutable';
  END IF;

  -- protected_149_linked_formulations_unchanged
  SELECT count(*) INTO v_after_linked FROM public.sku_formulations WHERE canonical_material_id IS NOT NULL;
  SELECT count(*) INTO v_after_versions FROM public.sku_cogs_versions;
  IF v_after_linked < v_before_linked OR v_before_linked <> 149 THEN
    RAISE EXCEPTION 'protected_149_linked_formulations_unchanged failed before %, after %', v_before_linked, v_after_linked;
  END IF;
  IF v_after_versions < v_before_versions THEN
    RAISE EXCEPTION 'historical version count decreased';
  END IF;

  PERFORM 'direct_authenticated_bypass_denial';
  PERFORM set_config('material_master.sku_cogs_save', '', true);
  BEGIN
    update public.sku_formulations set canonical_material_id = v_material_id where id = (select id from public.sku_formulations where sku_id = v_sku_id limit 1);
    raise exception 'direct authenticated cogs bypass unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
  BEGIN
    update public.product_skus set cost_values = jsonb_build_object('unsafe_inline_cost', 1) where id = v_sku_id;
    raise exception 'direct product sku cogs bypass unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
  BEGIN
    delete from public.product_skus where id = v_sku_id;
    raise exception 'published product sku delete unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END $$;

ROLLBACK;

-- post_rollback_absence
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sku_cogs_materials WHERE material_code LIKE 'NVL-TASK7-%') THEN
    RAISE EXCEPTION 'post_rollback_absence failed: Task7 fixture material residue';
  END IF;
END $$;
