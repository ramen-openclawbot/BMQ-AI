-- Task 7 Canonical NVL COGS Controller.
-- Canonical root remains public.sku_cogs_materials only.
-- This migration is additive/controller-only: it does not backfill, merge, delete, or rewrite historical COGS/formulation versions.

alter table public.sku_formulations
  add column if not exists material_resolution_status text,
  add column if not exists material_resolution_request_id uuid references public.material_resolution_requests(id) on delete set null,
  add column if not exists canonical_default_unit text,
  add column if not exists standard_unit_price numeric,
  add column if not exists standard_price_id uuid references public.material_price_history(id) on delete set null;

alter table public.sku_cogs_version_formulations
  add column if not exists canonical_material_snapshot jsonb not null default '{}'::jsonb;

insert into public.material_master_enforcement_config (source_type, mode)
values ('sku_cogs', 'enforced'), ('scan_sku_cost_sheet', 'enforced')
on conflict (source_type) do update set mode = excluded.mode, updated_at = now();

create or replace function public.sku_cogs_material_price_snapshot(
  p_material_id uuid,
  p_input_unit text,
  p_effective_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_material public.sku_cogs_materials%rowtype;
  v_price public.material_price_history%rowtype;
  v_input_unit text := nullif(lower(btrim(coalesce(p_input_unit, ''))), '');
  v_default_unit text;
  v_input_to_default_factor numeric := 1;
  v_price_to_default_factor numeric := 1;
  v_base_unit_price numeric;
begin
  select * into v_material from public.sku_cogs_materials where id = p_material_id and active = true;
  if not found then
    return jsonb_build_object('ready', false, 'blockers', jsonb_build_array('material_not_found'));
  end if;
  v_default_unit := lower(btrim(v_material.default_unit));
  if v_input_unit is null then
    return jsonb_build_object('ready', false, 'blockers', jsonb_build_array('unit_unmapped'));
  end if;
  if v_input_unit <> v_default_unit then
    select c.factor into v_input_to_default_factor
    from public.material_unit_conversions c
    where c.material_id = p_material_id and c.active = true and c.approved = true
      and lower(btrim(c.from_unit)) = v_input_unit
      and lower(btrim(c.to_unit)) = v_default_unit
      and c.effective_from <= coalesce(p_effective_date, current_date)
      and (c.effective_to is null or c.effective_to >= coalesce(p_effective_date, current_date))
    order by c.effective_from desc, c.created_at desc
    limit 1;
    if v_input_to_default_factor is null then
      return jsonb_build_object('ready', false, 'blockers', jsonb_build_array('unit_unmapped'), 'material_id', p_material_id);
    end if;
  end if;

  select * into v_price
  from public.material_price_history ph
  where ph.material_id = p_material_id
    and ph.approved = true
    and ph.price_type = 'standard_cost'
    and ph.effective_from <= coalesce(p_effective_date, current_date)
    and (ph.effective_to is null or ph.effective_to >= coalesce(p_effective_date, current_date))
    and ph.supplier_product_id is null
  order by ph.effective_from desc, ph.created_at desc
  limit 1;

  if not found then
    return jsonb_build_object('ready', false, 'blockers', jsonb_build_array('missing_standard_cost'), 'material_id', p_material_id);
  end if;

  if v_price.normalized_base_unit_price is not null then
    v_base_unit_price := v_price.normalized_base_unit_price;
  elsif lower(btrim(v_price.price_unit)) = v_default_unit then
    v_base_unit_price := v_price.price;
  else
    select c.factor into v_price_to_default_factor
    from public.material_unit_conversions c
    where c.material_id = p_material_id and c.active = true and c.approved = true
      and lower(btrim(c.from_unit)) = lower(btrim(v_price.price_unit))
      and lower(btrim(c.to_unit)) = v_default_unit
      and c.effective_from <= coalesce(p_effective_date, current_date)
      and (c.effective_to is null or c.effective_to >= coalesce(p_effective_date, current_date))
    order by c.effective_from desc, c.created_at desc
    limit 1;
    if v_price_to_default_factor is null then
      return jsonb_build_object('ready', false, 'blockers', jsonb_build_array('unit_unmapped'), 'material_id', p_material_id, 'price_id', v_price.id);
    end if;
    v_base_unit_price := v_price.price / v_price_to_default_factor;
  end if;

  return jsonb_build_object(
    'ready', true,
    'material_id', p_material_id,
    'canonical_material_name', v_material.canonical_name,
    'canonical_material_code', v_material.material_code,
    'canonical_default_unit', v_material.default_unit,
    'standard_unit_price', v_base_unit_price,
    'price_id', v_price.id,
    'input_unit', v_input_unit,
    'input_to_default_factor', v_input_to_default_factor,
    'blockers', '[]'::jsonb
  );
end;
$$;

create or replace function public.apply_sku_cogs_material_resolution(
  p_source_line_id uuid,
  p_raw_name text,
  p_raw_code text default null,
  p_raw_unit text default null,
  p_effective_date date default current_date,
  p_zero_cost_approved boolean default false,
  p_reason text default 'Task7 COGS canonical material resolution'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_raw_name text := nullif(btrim(coalesce(p_raw_name, '')), '');
  v_resolved jsonb;
  v_material_id uuid;
  v_request jsonb;
  v_request_id uuid;
  v_price jsonb;
  v_status text;
  v_blockers jsonb := '[]'::jsonb;
begin
  if v_actor is null then raise exception 'authentication required' using errcode='42501'; end if;
  if not (public.has_role(v_actor, 'owner') or public.has_role(v_actor, 'staff') or public.has_role(v_actor, 'warehouse')) then
    raise exception 'Không có quyền cập nhật SKU COGS' using errcode='42501';
  end if;
  if v_raw_name is null then raise exception 'raw material name required' using errcode='22023'; end if;

  v_resolved := public.resolve_canonical_material(v_raw_name, p_raw_code, p_raw_unit, null, 'sku_cogs', coalesce(p_effective_date, current_date), array['unit','standard_cost']);
  v_status := coalesce(v_resolved->>'status', 'controller_error');
  v_material_id := nullif(v_resolved->>'material_id', '')::uuid;

  if coalesce((v_resolved->>'resolved_exact')::boolean, false) is not true or v_material_id is null then
    v_request := public.request_material_resolution(
      'sku_cogs', 'sku_formulations', null, p_source_line_id, v_raw_name, p_raw_code, p_raw_unit, null,
      jsonb_build_object('candidate_source', coalesce(v_resolved->>'match_source', v_status), 'confidence', 'pending', 'field_name', 'sku_formulations.canonical_material_id')
    );
    v_request_id := nullif(v_request->>'request_id', '')::uuid;
    if p_source_line_id is not null then
      perform set_config('material_master.sku_cogs_save', coalesce(v_request_id::text, 'pending'), true);
      update public.sku_formulations
      set material_resolution_status = case when v_status in ('ambiguous','confirmation_needed','not_found','unit_unmapped','supplier_unmapped','inactive') then v_status else 'not_found' end,
          material_resolution_request_id = v_request_id,
          raw_ocr_name = coalesce(raw_ocr_name, v_raw_name)
      where id = p_source_line_id;
    end if;
    return jsonb_build_object('status', coalesce(v_status, 'not_found'), 'resolved_exact', false, 'material_id', v_material_id, 'request_id', v_request_id, 'blockers', coalesce(v_resolved->'blockers', jsonb_build_array('material_resolution_required')));
  end if;

  v_price := public.sku_cogs_material_price_snapshot(v_material_id, p_raw_unit, coalesce(p_effective_date, current_date));
  if coalesce((v_price->>'ready')::boolean, false) is not true then
    v_blockers := coalesce(v_price->'blockers', jsonb_build_array('missing_standard_cost'));
    v_request := public.request_material_resolution(
      'sku_cogs', 'sku_formulations', null, p_source_line_id, v_raw_name, p_raw_code, p_raw_unit, null,
      jsonb_build_object('candidate_source', 'exact_identity_missing_capability', 'confidence', 'pending', 'field_name', 'sku_formulations.canonical_material_id', 'blockers', v_blockers)
    );
    v_request_id := nullif(v_request->>'request_id', '')::uuid;
    if p_source_line_id is not null then
      perform set_config('material_master.sku_cogs_save', coalesce(v_request_id::text, 'pending'), true);
      update public.sku_formulations
      set material_resolution_status = case when v_blockers ? 'unit_unmapped' then 'unit_unmapped' else 'confirmation_needed' end,
          material_resolution_request_id = v_request_id,
          raw_ocr_name = coalesce(raw_ocr_name, v_raw_name)
      where id = p_source_line_id;
    end if;
    return jsonb_build_object('status', 'blocked', 'resolved_exact', false, 'material_id', v_material_id, 'request_id', v_request_id, 'blockers', v_blockers);
  end if;

  if coalesce((v_price->>'standard_unit_price')::numeric, 0) = 0 and p_zero_cost_approved is not true then
    v_request := public.request_material_resolution(
      'sku_cogs', 'sku_formulations', null, p_source_line_id, v_raw_name, p_raw_code, p_raw_unit, null,
      jsonb_build_object('candidate_source', 'zero_standard_cost_policy', 'confidence', 'pending', 'field_name', 'sku_formulations.standard_unit_price', 'blockers', jsonb_build_array('zero cost standard cost requires explicit approval'))
    );
    v_request_id := nullif(v_request->>'request_id', '')::uuid;
    return jsonb_build_object('status','blocked','resolved_exact',false,'material_id',v_material_id,'request_id',v_request_id,'blockers',jsonb_build_array('zero cost standard cost requires explicit approval'));
  end if;

  if p_source_line_id is not null then
    perform set_config('material_master.sku_cogs_save', coalesce(v_request_id::text, 'exact'), true);
    update public.sku_formulations f
    set canonical_material_id = v_material_id,
        ingredient_name = v_price->>'canonical_material_name',
        raw_ocr_name = coalesce(f.raw_ocr_name, v_raw_name),
        material_code = v_price->>'canonical_material_code',
        unit = v_price->>'canonical_default_unit',
        unit_price = (v_price->>'standard_unit_price')::numeric,
        canonical_default_unit = v_price->>'canonical_default_unit',
        standard_unit_price = (v_price->>'standard_unit_price')::numeric,
        standard_price_id = (v_price->>'price_id')::uuid,
        material_resolution_status = 'resolved_exact',
        material_resolution_request_id = v_request_id
    where f.id = p_source_line_id;
  end if;

  return jsonb_build_object('status','resolved_exact','resolved_exact',true,'material_id',v_material_id,'request_id',v_request_id,'blockers','[]'::jsonb) || v_price || jsonb_build_object('zero_cost_standard_cost_approved', p_zero_cost_approved);
end;
$$;

create or replace function public.assert_sku_cogs_materials_ready(
  p_formulations jsonb,
  p_effective_from date default current_date,
  p_zero_cost_approved boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  item jsonb;
  v_res jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_idx int := 0;
begin
  if jsonb_typeof(coalesce(p_formulations, '[]'::jsonb)) <> 'array' then
    raise exception 'Danh sách NVL không hợp lệ' using errcode='22023';
  end if;
  for item in select value from jsonb_array_elements(coalesce(p_formulations, '[]'::jsonb)) loop
    v_idx := v_idx + 1;
    v_res := public.apply_sku_cogs_material_resolution(
      null,
      coalesce(item->>'raw_ocr_name', item->>'ingredient_name'),
      item->>'material_code',
      coalesce(item->>'unit', item->>'canonical_default_unit'),
      p_effective_from,
      p_zero_cost_approved or coalesce((item->>'zeroCostApproval')::boolean, false),
      'Task7 COGS readiness preflight'
    );
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('row', v_idx, 'result', v_res));
    if coalesce((v_res->>'resolved_exact')::boolean, false) is not true then
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('row', v_idx, 'blockers', coalesce(v_res->'blockers', jsonb_build_array('material_resolution_required')), 'request_id', v_res->>'request_id'));
    end if;
  end loop;
  return jsonb_build_object('ready', jsonb_array_length(v_blockers) = 0, 'status', case when jsonb_array_length(v_blockers)=0 then 'ready' else 'blocked' end, 'blockers', v_blockers, 'rows', v_rows);
end;
$$;

create or replace function public.trg_guard_sku_cogs_material_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('material_master.sku_cogs_save', true), '') = '' then
    raise exception 'direct sku cogs material mutation is not allowed' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_sku_cogs_material_mutation on public.sku_formulations;
create trigger trg_guard_sku_cogs_material_mutation
before insert or update or delete on public.sku_formulations
for each row execute function public.trg_guard_sku_cogs_material_mutation();

create or replace function public.trg_guard_product_sku_cogs_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.sku_cogs_versions v where v.sku_id = old.id) then
      raise exception 'direct product sku cogs mutation is not allowed' using errcode = '42501';
    end if;
    return old;
  end if;
  if coalesce(current_setting('material_master.sku_cogs_save', true), '') = '' then
    if coalesce(old.sku_type::text, '') = 'finished_good'
       or coalesce(new.sku_type::text, '') = 'finished_good'
       or exists (select 1 from public.sku_cogs_versions v where v.sku_id = old.id) then
      raise exception 'direct product sku cogs mutation is not allowed' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_product_sku_cogs_mutation on public.product_skus;
create trigger trg_guard_product_sku_cogs_mutation
before update of sku_code, product_name, unit, category, base_unit, cost_values, cost_widgets, cost_template, finished_output_qty, finished_output_unit, sku_type
on public.product_skus
for each row execute function public.trg_guard_product_sku_cogs_mutation();

drop trigger if exists trg_guard_product_sku_cogs_delete on public.product_skus;
create trigger trg_guard_product_sku_cogs_delete
before delete on public.product_skus
for each row execute function public.trg_guard_product_sku_cogs_mutation();

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

revoke all on function public.sku_cogs_material_price_snapshot(uuid, text, date) from public, anon, authenticated, service_role;
revoke all on function public.apply_sku_cogs_material_resolution(uuid, text, text, text, date, boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.assert_sku_cogs_materials_ready(jsonb, date, boolean) from public, anon, authenticated, service_role;
revoke all on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) from public, anon, service_role;
grant execute on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) to authenticated;
revoke execute on function public.trg_guard_sku_cogs_material_mutation() from public, anon, authenticated, service_role;
revoke execute on function public.trg_guard_product_sku_cogs_mutation() from public, anon, authenticated, service_role;

comment on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) is 'Task7 server-side COGS canonical controller: sku_cogs_materials root, exact approved material/code/alias only, unit+standard_cost readiness, zero-cost explicit policy, immutable published snapshots.';
