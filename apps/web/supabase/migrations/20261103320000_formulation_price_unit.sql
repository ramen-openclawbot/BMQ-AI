-- Đơn vị của đơn giá cho công thức giá vốn.
--
-- A formulation line can now state which unit its unit_price is quoted per,
-- independently of the unit its dosage_qty is expressed in.  The line cost is
-- unit_price * dosage_qty converted from the dosage unit to the price unit, so
-- a line saved before this change (price_unit null) keeps its exact cost.
--
-- This migration:
--   (a) adds price_unit (nullable) to both sku_formulations and its published
--       sku_cogs_version_formulations snapshot, with the same normalize check
--       used for dosage_unit;
--   (b) recreates save_sku_cogs with the same signature, security, search_path
--       and grants, persisting item->>'price_unit' into both tables.
--
--   (c) for lines saved with a smaller dosage unit than the material unit the
--       price was entered per (owner 29/10: BMQ-002 Pate heo 25 g at 94.418 đ/kg),
--       sets price_unit to that material unit, so 25 g × 94.418 đ/kg = 2.360 đ.
--       Only rows with dosage_unit g/ml, unit kg/l and price_unit null change.
--
-- unit_price, dosage_qty and `unit` are never changed; cogs_explode_revenue and
-- run_cogs_backflush are untouched.

alter table public.sku_formulations
  add column if not exists price_unit text;

alter table public.sku_cogs_version_formulations
  add column if not exists price_unit text;

do $do$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sku_formulations_price_unit_check'
      and conrelid = 'public.sku_formulations'::regclass
  ) then
    alter table public.sku_formulations
      add constraint sku_formulations_price_unit_check
      check (price_unit is null or public.normalize_document_unit(price_unit) is not null);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'sku_cogs_version_formulations_price_unit_check'
      and conrelid = 'public.sku_cogs_version_formulations'::regclass
  ) then
    alter table public.sku_cogs_version_formulations
      add constraint sku_cogs_version_formulations_price_unit_check
      check (price_unit is null or public.normalize_document_unit(price_unit) is not null);
  end if;
end;
$do$;

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
    insert into public.sku_formulations (sku_id, canonical_material_id, ingredient_name, raw_ocr_name, material_code, unit, unit_price, dosage_qty, wastage_percent, sort_order, effective_from, material_resolution_status, material_resolution_request_id, canonical_default_unit, standard_unit_price, standard_price_id, dosage_unit, price_unit)
    values (target_sku_id, (v_apply->>'material_id')::uuid, v_apply->>'canonical_material_name', nullif(item->>'raw_ocr_name',''), v_apply->>'canonical_material_code', v_apply->>'canonical_default_unit', (v_apply->>'standard_unit_price')::numeric, coalesce((item->>'dosage_qty')::numeric,0) * coalesce((v_apply->>'input_to_default_factor')::numeric, 1), coalesce((item->>'wastage_percent')::numeric,0), coalesce((item->>'sort_order')::integer,0), p_effective_from, 'resolved_exact', nullif(v_apply->>'request_id','')::uuid, v_apply->>'canonical_default_unit', (v_apply->>'standard_unit_price')::numeric, (v_apply->>'price_id')::uuid, nullif(btrim(item->>'dosage_unit'),''), nullif(btrim(item->>'price_unit'),''))
    returning id into inserted_id;
  end loop;

  select coalesce(max(v.version_no), 0) + 1 into next_version from public.sku_cogs_versions v where v.sku_id = target_sku_id;
  insert into public.sku_cogs_versions (sku_id, version_no, effective_from, effective_to, change_reason, product_snapshot, changed_by)
  select target_sku_id, next_version, p_effective_from, null, coalesce(nullif(btrim(p_change_reason), ''), 'Cập nhật SKU COGS'), to_jsonb(ps), actor_id
  from public.product_skus ps where ps.id = target_sku_id
  returning id into new_version_id;

  insert into public.sku_cogs_version_formulations (version_id, source_formulation_id, canonical_material_id, ingredient_sku_id, ingredient_name, raw_ocr_name, material_code, unit, unit_price, dosage_qty, wastage_percent, sort_order, canonical_material_snapshot, dosage_unit, price_unit)
  select new_version_id, f.id, f.canonical_material_id, f.ingredient_sku_id, f.ingredient_name, f.raw_ocr_name, f.material_code, f.unit, f.unit_price, f.dosage_qty, f.wastage_percent, f.sort_order,
    jsonb_build_object('canonical_material_id', m.id, 'canonical_material_name', m.canonical_name, 'canonical_material_code', m.material_code, 'canonical_default_unit', m.default_unit, 'standard_unit_price', f.standard_unit_price, 'standard_price_id', f.standard_price_id, 'published_at', now()),
    f.dosage_unit, f.price_unit
  from public.sku_formulations f join public.sku_cogs_materials m on m.id = f.canonical_material_id
  where f.sku_id = target_sku_id;

  return query select target_sku_id, new_version_id, next_version;
end;
$$;

revoke all on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) from public, anon, service_role;
grant execute on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) to authenticated;

do $do$
declare
  v_rows integer;
begin
  perform set_config('material_master.sku_cogs_save', 'save_sku_cogs', true);

  update public.sku_cogs_version_formulations
  set price_unit = unit
  where price_unit is null
    and public.normalize_document_unit(dosage_unit) in ('g', 'ml')
    and public.normalize_document_unit(unit) in ('kg', 'l');
  get diagnostics v_rows = row_count;
  raise notice 'price_unit set on % version lines', v_rows;

  update public.sku_formulations
  set price_unit = unit
  where price_unit is null
    and public.normalize_document_unit(dosage_unit) in ('g', 'ml')
    and public.normalize_document_unit(unit) in ('kg', 'l');
end;
$do$;
