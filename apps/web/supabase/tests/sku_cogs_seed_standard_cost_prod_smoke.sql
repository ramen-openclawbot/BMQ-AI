-- Rollback-only production smoke for migration
-- 20261028100000_sku_cogs_seed_standard_cost.sql.
--
-- Run as one file: `supabase db query --linked -f supabase/tests/sku_cogs_seed_standard_cost_prod_smoke.sql`.
-- The file opens one transaction, applies the migration SQL inline (nothing is
-- persisted because the transaction is always aborted), builds a rollback-only
-- fixture from real canonical NVL and exercises seed + save_sku_cogs. The final
-- RAISE ends the transaction, so every product_skus, sku_cogs_versions,
-- sku_formulations and material_price_history row created here is rolled back.
begin;
-- Lưu SKU COGS được khi NVL đã xác định nhưng thiếu giá chuẩn:
-- lấy đơn giá trên form làm giá chuẩn NVL còn thiếu trước bước assert.
--
-- Additive only. This migration:
--   (a) adds public.seed_sku_cogs_standard_costs(...), a SECURITY DEFINER helper
--       that, for each COGS formulation row whose canonical material is resolved
--       exactly (same resolver used by apply_sku_cogs_material_resolution) and
--       that has no effective approved standard_cost, writes one approved
--       standard_cost row made from the form unit price (source_type
--       'sku_cogs_form'),
--   (b) CREATE OR REPLACEs public.save_sku_cogs with the current body plus one
--       seed call right before assert_sku_cogs_materials_ready.
--
-- It never updates or deletes public.material_price_history, never overwrites an
-- existing standard cost, and does not change assert_sku_cogs_materials_ready,
-- apply_sku_cogs_material_resolution or link_material_to_sku_cogs.

create or replace function public.seed_sku_cogs_standard_costs(
  p_formulations jsonb,
  p_effective_from date,
  p_zero_cost_approved boolean,
  p_actor uuid,
  p_sku_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  v_idx int := 0;
  v_raw_name text;
  v_raw_code text;
  v_raw_unit text;
  v_resolved jsonb;
  v_material_id uuid;
  v_material public.sku_cogs_materials%rowtype;
  v_unit text;
  v_unit_price numeric;
  v_zero_ok boolean;
  v_seeded jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(coalesce(p_formulations, '[]'::jsonb)) <> 'array' then
    raise exception 'Danh sách NVL không hợp lệ' using errcode='22023';
  end if;

  for item in select value from jsonb_array_elements(coalesce(p_formulations, '[]'::jsonb)) loop
    v_idx := v_idx + 1;
    v_raw_name := coalesce(item->>'raw_ocr_name', item->>'ingredient_name');
    v_raw_code := item->>'material_code';
    v_raw_unit := coalesce(item->>'unit', item->>'canonical_default_unit');

    -- Same identity resolver that apply_sku_cogs_material_resolution uses. The
    -- missing capability here is exactly standard_cost (what this helper is
    -- about to create), so only the unit capability is required for identity.
    v_resolved := public.resolve_canonical_material(
      v_raw_name, v_raw_code, v_raw_unit, null, 'sku_cogs', p_effective_from, array['unit']
    );
    v_material_id := nullif(v_resolved->>'material_id', '')::uuid;
    if coalesce((v_resolved->>'resolved_exact')::boolean, false) is not true or v_material_id is null then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'row', v_idx, 'reason', coalesce(nullif(v_resolved->>'status', ''), 'material_resolution_required')
      ));
      continue;
    end if;

    select * into v_material from public.sku_cogs_materials where id = v_material_id;
    if not found then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('row', v_idx, 'reason', 'material_not_found'));
      continue;
    end if;

    -- Never overwrite an existing effective approved standard cost.
    if exists (
      select 1
      from public.material_price_history ph
      where ph.material_id = v_material_id
        and ph.supplier_product_id is null
        and ph.price_type = 'standard_cost'
        and ph.approved = true
        and ph.effective_from <= p_effective_from
        and (ph.effective_to is null or ph.effective_to >= p_effective_from)
    ) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('row', v_idx, 'reason', 'standard_cost_exists'));
      continue;
    end if;

    -- price_unit is the row unit, defaulting to the material default unit.
    v_unit := coalesce(nullif(btrim(v_raw_unit), ''), nullif(btrim(v_material.default_unit), ''));
    if v_unit is null then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('row', v_idx, 'reason', 'unit_unmapped'));
      continue;
    end if;
    -- normalized_base_unit_price must be expressed in the material default unit.
    -- Only seed when the row unit is the material default unit; otherwise leave
    -- the existing unit_unmapped blocker for assert to report.
    if lower(btrim(v_unit)) <> lower(btrim(v_material.default_unit)) then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('row', v_idx, 'reason', 'unit_unmapped'));
      continue;
    end if;

    v_unit_price := nullif(item->>'unit_price', '')::numeric;
    if v_unit_price is null or v_unit_price::text in ('NaN', 'Infinity', '-Infinity') or v_unit_price < 0 then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('row', v_idx, 'reason', 'invalid_price'));
      continue;
    end if;

    v_zero_ok := coalesce(p_zero_cost_approved, false)
      or coalesce((item->>'zeroCostApproval')::boolean, false);
    if v_unit_price = 0 and not v_zero_ok then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('row', v_idx, 'reason', 'zero_cost_requires_approval'));
      continue;
    end if;

    begin
      insert into public.material_price_history (
        material_id, supplier_product_id, price_type, price, price_unit,
        normalized_base_unit_price, effective_from, effective_to,
        source_type, approved, approved_by, approved_at, metadata, created_by
      ) values (
        v_material_id, null, 'standard_cost', v_unit_price, v_unit,
        v_unit_price, p_effective_from, null,
        'sku_cogs_form', true, p_actor, now(),
        jsonb_build_object('sku_code', p_sku_code), p_actor
      );
      v_seeded := v_seeded || jsonb_build_array(jsonb_build_object(
        'row', v_idx, 'material_code', v_material.material_code, 'price', v_unit_price
      ));
    exception when unique_violation then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'row', v_idx, 'reason', 'overlapping_standard_cost'
      ));
    end;
  end loop;

  return jsonb_build_object('seeded', v_seeded, 'skipped', v_skipped);
end;
$$;

revoke all on function public.seed_sku_cogs_standard_costs(jsonb, date, boolean, uuid, text) from public, anon, authenticated;

create or replace function public.save_sku_cogs(
  p_sku_id uuid,
  p_sku_updates jsonb,
  p_formulations jsonb,
  p_effective_from date default current_date,
  p_change_reason text default 'Cập nhật SKU COGS'
)
returns table(saved_sku_id uuid, version_id uuid, version_no integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  target_sku_id uuid := p_sku_id;
  next_version integer;
  new_version_id uuid;
  current_version_id uuid;
  current_effective_from date;
  item jsonb;
  inserted_id uuid;
  v_ready jsonb;
  v_apply jsonb;
  v_snapshot jsonb;
begin
  if actor_id is null or not (public.has_role(actor_id, 'owner') or public.has_role(actor_id, 'staff') or public.has_role(actor_id, 'warehouse')) then
    raise exception 'Không có quyền cập nhật SKU COGS' using errcode = '42501';
  end if;
  if p_effective_from is null then raise exception 'Ngày hiệu lực COGS là bắt buộc' using errcode = '22023'; end if;
  if nullif(btrim(p_sku_updates->>'sku_code'), '') is null or nullif(btrim(p_sku_updates->>'product_name'), '') is null then
    raise exception 'Mã SKU và tên sản phẩm là bắt buộc' using errcode = '22023';
  end if;

  -- Take the form unit price as the missing canonical standard cost first, so
  -- assert_sku_cogs_materials_ready can pass for rows identified exactly.
  perform public.seed_sku_cogs_standard_costs(
    p_formulations,
    p_effective_from,
    coalesce((p_sku_updates->>'zeroCostApproval')::boolean, false),
    actor_id,
    p_sku_updates->>'sku_code'
  );

  v_ready := public.assert_sku_cogs_materials_ready(p_formulations, p_effective_from, coalesce((p_sku_updates->>'zeroCostApproval')::boolean, false));
  if coalesce((v_ready->>'ready')::boolean, false) is not true then
    raise exception 'sku_cogs_material_blocked_before_publish: %', v_ready using errcode='23514', hint='material_resolution_required';
  end if;

  perform set_config('material_master.sku_cogs_save', 'save_sku_cogs', true);

  if target_sku_id is null then
    insert into public.product_skus (sku_code, product_name, unit, category, base_unit, finished_output_qty, finished_output_unit, cost_template, cost_values, cost_widgets, hide_from_dealer_portal, sku_type, created_by)
    values (btrim(p_sku_updates->>'sku_code'), btrim(p_sku_updates->>'product_name'), nullif(p_sku_updates->>'unit',''), coalesce(nullif(p_sku_updates->>'category',''),'Thành phẩm'), nullif(p_sku_updates->>'base_unit',''), coalesce((p_sku_updates->>'finished_output_qty')::numeric,1), nullif(p_sku_updates->>'finished_output_unit',''), p_sku_updates->'cost_template', p_sku_updates->'cost_values', p_sku_updates->'cost_widgets', coalesce((p_sku_updates->>'hide_from_dealer_portal')::boolean,false), 'finished_good', actor_id)
    returning id into target_sku_id;
  else
    perform 1 from public.product_skus where id = target_sku_id for update;
    if not found then raise exception 'SKU không tồn tại' using errcode='P0002'; end if;
  end if;

  select id, effective_from into current_version_id, current_effective_from
  from public.sku_cogs_versions where sku_id = target_sku_id and effective_to is null for update;
  if current_version_id is not null then
    if p_effective_from <= current_effective_from then
      raise exception 'Ngày hiệu lực mới phải sau ngày bắt đầu phiên bản hiện tại (%)', current_effective_from using errcode='22023', hint='SKU_COGS_EFFECTIVE_DATE_NOT_FORWARD';
    end if;
    update public.sku_cogs_versions set effective_to = p_effective_from - 1 where id = current_version_id;
  end if;

  update public.product_skus
  set sku_code = coalesce(nullif(p_sku_updates->>'sku_code', ''), sku_code),
      product_name = coalesce(nullif(p_sku_updates->>'product_name', ''), product_name),
      unit = coalesce(nullif(p_sku_updates->>'unit', ''), unit),
      category = coalesce(nullif(p_sku_updates->>'category', ''), category),
      base_unit = coalesce(nullif(p_sku_updates->>'base_unit', ''), base_unit),
      finished_output_qty = coalesce((p_sku_updates->>'finished_output_qty')::numeric, finished_output_qty),
      finished_output_unit = coalesce(nullif(p_sku_updates->>'finished_output_unit', ''), finished_output_unit),
      cost_template = coalesce(p_sku_updates->'cost_template', cost_template),
      cost_values = coalesce(p_sku_updates->'cost_values', cost_values),
      cost_widgets = coalesce(p_sku_updates->'cost_widgets', cost_widgets),
      hide_from_dealer_portal = coalesce((p_sku_updates->>'hide_from_dealer_portal')::boolean, hide_from_dealer_portal),
      sku_type = 'finished_good', updated_at = now()
  where id = target_sku_id;

  perform set_config('material_master.sku_cogs_save', 'delete-replace', true);
  delete from public.sku_formulations where sku_id = target_sku_id;

  for item in select value from jsonb_array_elements(coalesce(p_formulations, '[]'::jsonb)) loop
    v_apply := public.apply_sku_cogs_material_resolution(null, coalesce(item->>'raw_ocr_name', item->>'ingredient_name'), item->>'material_code', coalesce(item->>'unit', item->>'canonical_default_unit'), p_effective_from, coalesce((p_sku_updates->>'zeroCostApproval')::boolean, false) or coalesce((item->>'zeroCostApproval')::boolean, false), 'Task7 COGS save exact approved canonical material');
    if coalesce((v_apply->>'resolved_exact')::boolean, false) is not true then
      raise exception 'sku_cogs_material_blocked_before_publish: %', v_apply using errcode='23514', hint='material_resolution_required';
    end if;
    perform set_config('material_master.sku_cogs_save', coalesce(v_apply->>'request_id', 'insert'), true);
    insert into public.sku_formulations (sku_id, canonical_material_id, ingredient_name, raw_ocr_name, material_code, unit, unit_price, dosage_qty, wastage_percent, sort_order, effective_from, material_resolution_status, material_resolution_request_id, canonical_default_unit, standard_unit_price, standard_price_id)
    values (target_sku_id, (v_apply->>'material_id')::uuid, v_apply->>'canonical_material_name', nullif(item->>'raw_ocr_name',''), v_apply->>'canonical_material_code', v_apply->>'canonical_default_unit', (v_apply->>'standard_unit_price')::numeric, coalesce((item->>'dosage_qty')::numeric,0) * coalesce((v_apply->>'input_to_default_factor')::numeric, 1), coalesce((item->>'wastage_percent')::numeric,0), coalesce((item->>'sort_order')::integer,0), p_effective_from, 'resolved_exact', nullif(v_apply->>'request_id','')::uuid, v_apply->>'canonical_default_unit', (v_apply->>'standard_unit_price')::numeric, (v_apply->>'price_id')::uuid)
    returning id into inserted_id;
  end loop;

  select coalesce(max(v.version_no), 0) + 1 into next_version from public.sku_cogs_versions v where v.sku_id = target_sku_id;
  insert into public.sku_cogs_versions (sku_id, version_no, effective_from, effective_to, change_reason, product_snapshot, changed_by)
  select target_sku_id, next_version, p_effective_from, null, coalesce(nullif(btrim(p_change_reason), ''), 'Cập nhật SKU COGS'), to_jsonb(ps), actor_id
  from public.product_skus ps where ps.id = target_sku_id
  returning id into new_version_id;

  insert into public.sku_cogs_version_formulations (version_id, source_formulation_id, canonical_material_id, ingredient_sku_id, ingredient_name, raw_ocr_name, material_code, unit, unit_price, dosage_qty, wastage_percent, sort_order, canonical_material_snapshot)
  select new_version_id, f.id, f.canonical_material_id, f.ingredient_sku_id, f.ingredient_name, f.raw_ocr_name, f.material_code, f.unit, f.unit_price, f.dosage_qty, f.wastage_percent, f.sort_order,
    jsonb_build_object('canonical_material_id', m.id, 'canonical_material_name', m.canonical_name, 'canonical_material_code', m.material_code, 'canonical_default_unit', m.default_unit, 'standard_unit_price', f.standard_unit_price, 'standard_price_id', f.standard_price_id, 'published_at', now())
  from public.sku_formulations f join public.sku_cogs_materials m on m.id = f.canonical_material_id
  where f.sku_id = target_sku_id;

  return query select target_sku_id, new_version_id, next_version;
end;
$$;

revoke all on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) from public, anon, service_role;
grant execute on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) to authenticated;

comment on function public.seed_sku_cogs_standard_costs(jsonb, date, boolean, uuid, text) is 'Seed missing approved standard_cost rows from form unit prices before SKU COGS publish; exact canonical resolution, unit-normalized, never overwrites an existing standard cost.';
comment on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) is 'Task7 server-side COGS canonical controller + seed_sku_cogs_standard_costs preflight (form unit price becomes the missing standard cost).';

-- ---------------------------------------------------------------------------
-- Behavioural checks. Every step raises SMOKE_RESULT FAIL <step> on a wrong
-- result and the whole transaction is aborted; the final RAISE is PASS.
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner uuid;
  v_day date := current_date;
  v_pate uuid;
  v_chalua uuid;
  v_banhmi uuid;
  v_dabao uuid;
  v_sku uuid;
  v_sku_b uuid;
  v_version uuid;
  v_version_no integer;
  v_count integer;
  v_price numeric;
  v_updates jsonb;
  v_rows jsonb;
  v_blocked boolean;
  v_err text;
begin
  select user_id into v_owner from public.user_roles where role = 'owner' limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL owner_missing';
  end if;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  select id into v_pate from public.sku_cogs_materials where material_code = 'TP-PATE';
  select id into v_chalua from public.sku_cogs_materials where material_code = 'NVL-CHA LUA LA';
  select id into v_banhmi from public.sku_cogs_materials where material_code = 'NVL-BANH-MI-TUOI';
  select id into v_dabao from public.sku_cogs_materials where material_code = 'NVL-DA BAO';
  if v_pate is null or v_chalua is null or v_banhmi is null or v_dabao is null then
    raise exception 'SMOKE_RESULT FAIL material_fixture_missing';
  end if;

  -- (a) three real NVL, positive form unit price equal to the NVL default unit.
  -- Rows use the exact JSON shape SkuCostsManagement.tsx sends.
  select jsonb_agg(
    jsonb_build_object(
      'sku_id', null,
      'canonical_material_id', m.id,
      'ingredient_name', m.canonical_name,
      'raw_ocr_name', m.canonical_name,
      'material_code', m.material_code,
      'unit', m.default_unit,
      'unit_price', p.unit_price,
      'dosage_qty', p.dosage_qty,
      'wastage_percent', 0,
      'sort_order', p.sort_order,
      'canonical_default_unit', m.default_unit,
      'material_resolution_status', 'resolved_exact',
      'material_resolution_request_id', null
    )
    order by p.sort_order
  )
  into v_rows
  from (values
    ('TP-PATE'::text, 250000::numeric, 50::numeric, 1),
    ('NVL-CHA LUA LA'::text, 180000::numeric, 30::numeric, 2),
    ('NVL-BANH-MI-TUOI'::text, 25::numeric, 2000::numeric, 3)
  ) as p(material_code, unit_price, dosage_qty, sort_order)
  join public.sku_cogs_materials m on m.material_code = p.material_code;
  if jsonb_array_length(coalesce(v_rows, '[]'::jsonb)) <> 3 then
    raise exception 'SMOKE_RESULT FAIL a_rows_built';
  end if;

  v_updates := jsonb_build_object(
    'sku_code', 'SMOKE-SKU-SEED',
    'product_name', 'SMOKE SKU seed giá chuẩn',
    'unit', 'gói',
    'category', 'Thành phẩm',
    'base_unit', 'gói',
    'finished_output_qty', 100,
    'finished_output_unit', 'cái',
    'zeroCostApproval', false
  );

  select saved_sku_id, version_id, version_no
    into v_sku, v_version, v_version_no
    from public.save_sku_cogs(null, v_updates, v_rows, v_day, 'SMOKE seed standard cost');
  if v_sku is null or v_version is null then
    raise exception 'SMOKE_RESULT FAIL a_save_returned_null';
  end if;
  if not exists (
    select 1 from public.sku_cogs_versions
    where id = v_version and sku_id = v_sku and effective_from = v_day
  ) then
    raise exception 'SMOKE_RESULT FAIL a_version_missing';
  end if;

  select count(*) into v_count
  from public.material_price_history ph
  where ph.material_id in (v_pate, v_chalua, v_banhmi)
    and ph.price_type = 'standard_cost'
    and ph.approved = true
    and ph.supplier_product_id is null
    and ph.source_type = 'sku_cogs_form'
    and ph.effective_from = v_day
    and ph.metadata->>'sku_code' = 'SMOKE-SKU-SEED'
    and ph.approved_by = v_owner
    and ph.normalized_base_unit_price = ph.price;
  if v_count <> 3 then
    raise exception 'SMOKE_RESULT FAIL a_seed_count_%', v_count;
  end if;

  select ph.price into v_price
  from public.material_price_history ph
  where ph.material_id = v_pate
    and ph.price_type = 'standard_cost'
    and ph.metadata->>'sku_code' = 'SMOKE-SKU-SEED'
    and ph.effective_from = v_day
  order by ph.created_at desc limit 1;
  if v_price <> 250000 then
    raise exception 'SMOKE_RESULT FAIL a_pate_price_%', coalesce(v_price, -1);
  end if;
  select ph.price into v_price
  from public.material_price_history ph
  where ph.material_id = v_banhmi
    and ph.price_type = 'standard_cost'
    and ph.metadata->>'sku_code' = 'SMOKE-SKU-SEED'
    and ph.effective_from = v_day
  order by ph.created_at desc limit 1;
  if v_price <> 25 then
    raise exception 'SMOKE_RESULT FAIL a_banhmi_price_%', coalesce(v_price, -1);
  end if;

  -- (b) same SKU, later effective date, different form prices: the existing
  -- standard costs still cover the date, so no new price row is written.
  select jsonb_agg(
    jsonb_build_object(
      'sku_id', v_sku,
      'canonical_material_id', m.id,
      'ingredient_name', m.canonical_name,
      'raw_ocr_name', m.canonical_name,
      'material_code', m.material_code,
      'unit', m.default_unit,
      'unit_price', p.unit_price,
      'dosage_qty', p.dosage_qty,
      'wastage_percent', 0,
      'sort_order', p.sort_order,
      'canonical_default_unit', m.default_unit,
      'material_resolution_status', 'resolved_exact',
      'material_resolution_request_id', null
    )
    order by p.sort_order
  )
  into v_rows
  from (values
    ('TP-PATE'::text, 999999::numeric, 11::numeric, 1),
    ('NVL-CHA LUA LA'::text, 777777::numeric, 22::numeric, 2),
    ('NVL-BANH-MI-TUOI'::text, 999::numeric, 33::numeric, 3)
  ) as p(material_code, unit_price, dosage_qty, sort_order)
  join public.sku_cogs_materials m on m.material_code = p.material_code;

  select saved_sku_id into v_sku_b
  from public.save_sku_cogs(v_sku, v_updates, v_rows, v_day + 1, 'SMOKE later price');
  if v_sku_b is null or v_sku_b <> v_sku then
    raise exception 'SMOKE_RESULT FAIL b_save_returned_null';
  end if;
  select count(*) into v_count
  from public.material_price_history
  where material_id in (v_pate, v_chalua, v_banhmi)
    and price_type = 'standard_cost' and approved = true;
  if v_count <> 3 then
    raise exception 'SMOKE_RESULT FAIL b_seed_count_%', v_count;
  end if;
  if exists (
    select 1 from public.material_price_history
    where material_id in (v_pate, v_chalua, v_banhmi) and price in (999999, 777777, 999)
  ) then
    raise exception 'SMOKE_RESULT FAIL b_overwrote_standard_cost';
  end if;

  -- (c) a real NVL still without a standard cost, form price 0 and no zero-cost
  -- approval: seed must not invent a price and the save must still block.
  v_updates := v_updates || jsonb_build_object('sku_code', 'SMOKE-SKU-ZERO');
  v_rows := jsonb_build_array(
    jsonb_build_object(
      'sku_id', null,
      'canonical_material_id', v_dabao,
      'ingredient_name', 'Da bao TVP',
      'raw_ocr_name', 'Da bao TVP',
      'material_code', 'NVL-DA BAO',
      'unit', 'Kg',
      'unit_price', 0,
      'dosage_qty', 10,
      'wastage_percent', 0,
      'sort_order', 1,
      'canonical_default_unit', 'Kg',
      'material_resolution_status', 'resolved_exact',
      'material_resolution_request_id', null
    )
  );
  v_blocked := false;
  v_err := null;
  begin
    perform public.save_sku_cogs(null, v_updates, v_rows, v_day, 'SMOKE zero cost block');
  exception when others then
    v_blocked := position('sku_cogs_material_blocked_before_publish' in sqlerrm) > 0;
    v_err := sqlerrm;
  end;
  if not v_blocked then
    raise exception 'SMOKE_RESULT FAIL c_not_blocked_%', coalesce(v_err, 'no_error');
  end if;

  -- (d) an unknown material code is never seeded and still blocks.
  v_updates := v_updates || jsonb_build_object('sku_code', 'SMOKE-SKU-BAD-NVL');
  v_rows := jsonb_build_array(
    jsonb_build_object(
      'sku_id', null,
      'canonical_material_id', null,
      'ingredient_name', 'NVL không tồn tại',
      'raw_ocr_name', 'NVL không tồn tại',
      'material_code', 'NVL-KHONG-TON-TAI',
      'unit', 'g',
      'unit_price', 1000,
      'dosage_qty', 1,
      'wastage_percent', 0,
      'sort_order', 1,
      'canonical_default_unit', 'g',
      'material_resolution_status', 'resolved_exact',
      'material_resolution_request_id', null
    )
  );
  v_blocked := false;
  v_err := null;
  begin
    perform public.save_sku_cogs(null, v_updates, v_rows, v_day, 'SMOKE bad nvl block');
  exception when others then
    v_blocked := position('sku_cogs_material_blocked_before_publish' in sqlerrm) > 0;
    v_err := sqlerrm;
  end;
  if not v_blocked then
    raise exception 'SMOKE_RESULT FAIL d_not_blocked_%', coalesce(v_err, 'no_error');
  end if;

  raise exception 'SMOKE_RESULT PASS: sku cogs standard cost seed ok';
end $$;
