-- Đơn vị định lượng cho công thức giá vốn.
--
-- A formulation line can now say which unit its dosage_qty is expressed in,
-- independently of the material default unit kept in `unit`.  The dosage_unit
-- is the same unit the unit_price is quoted per, so cogs_explode_revenue
-- normalizes coalesce(dosage_unit, unit).  Lines without dosage_unit keep the
-- exact old behaviour.
--
-- This migration:
--   (a) adds dosage_unit (nullable) to both sku_formulations and its published
--       sku_cogs_version_formulations snapshot;
--   (b) recreates save_sku_cogs with the same signature, security, search_path
--       and grants, persisting item->>'dosage_unit' into both tables;
--   (c) recreates cogs_explode_revenue so both formulation loops read
--       coalesce(dosage_unit, unit);
--   (d) backfills dosage_unit='Kg' for the 11 current TP-PATE version lines and
--       their source formulations only, inside the existing guard setting.
--
-- dosage_qty, unit_price and the `unit` column are never changed.

alter table public.sku_formulations
  add column if not exists dosage_unit text;

alter table public.sku_cogs_version_formulations
  add column if not exists dosage_unit text;

do $do$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sku_formulations_dosage_unit_check'
      and conrelid = 'public.sku_formulations'::regclass
  ) then
    alter table public.sku_formulations
      add constraint sku_formulations_dosage_unit_check
      check (dosage_unit is null or public.normalize_document_unit(dosage_unit) is not null);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'sku_cogs_version_formulations_dosage_unit_check'
      and conrelid = 'public.sku_cogs_version_formulations'::regclass
  ) then
    alter table public.sku_cogs_version_formulations
      add constraint sku_cogs_version_formulations_dosage_unit_check
      check (dosage_unit is null or public.normalize_document_unit(dosage_unit) is not null);
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
    insert into public.sku_formulations (sku_id, canonical_material_id, ingredient_name, raw_ocr_name, material_code, unit, unit_price, dosage_qty, wastage_percent, sort_order, effective_from, material_resolution_status, material_resolution_request_id, canonical_default_unit, standard_unit_price, standard_price_id, dosage_unit)
    values (target_sku_id, (v_apply->>'material_id')::uuid, v_apply->>'canonical_material_name', nullif(item->>'raw_ocr_name',''), v_apply->>'canonical_material_code', v_apply->>'canonical_default_unit', (v_apply->>'standard_unit_price')::numeric, coalesce((item->>'dosage_qty')::numeric,0) * coalesce((v_apply->>'input_to_default_factor')::numeric, 1), coalesce((item->>'wastage_percent')::numeric,0), coalesce((item->>'sort_order')::integer,0), p_effective_from, 'resolved_exact', nullif(v_apply->>'request_id','')::uuid, v_apply->>'canonical_default_unit', (v_apply->>'standard_unit_price')::numeric, (v_apply->>'price_id')::uuid, nullif(btrim(item->>'dosage_unit'),''))
    returning id into inserted_id;
  end loop;

  select coalesce(max(v.version_no), 0) + 1 into next_version from public.sku_cogs_versions v where v.sku_id = target_sku_id;
  insert into public.sku_cogs_versions (sku_id, version_no, effective_from, effective_to, change_reason, product_snapshot, changed_by)
  select target_sku_id, next_version, p_effective_from, null, coalesce(nullif(btrim(p_change_reason), ''), 'Cập nhật SKU COGS'), to_jsonb(ps), actor_id
  from public.product_skus ps where ps.id = target_sku_id
  returning id into new_version_id;

  insert into public.sku_cogs_version_formulations (version_id, source_formulation_id, canonical_material_id, ingredient_sku_id, ingredient_name, raw_ocr_name, material_code, unit, unit_price, dosage_qty, wastage_percent, sort_order, canonical_material_snapshot, dosage_unit)
  select new_version_id, f.id, f.canonical_material_id, f.ingredient_sku_id, f.ingredient_name, f.raw_ocr_name, f.material_code, f.unit, f.unit_price, f.dosage_qty, f.wastage_percent, f.sort_order,
    jsonb_build_object('canonical_material_id', m.id, 'canonical_material_name', m.canonical_name, 'canonical_material_code', m.material_code, 'canonical_default_unit', m.default_unit, 'standard_unit_price', f.standard_unit_price, 'standard_price_id', f.standard_price_id, 'published_at', now()),
    f.dosage_unit
  from public.sku_formulations f join public.sku_cogs_materials m on m.id = f.canonical_material_id
  where f.sku_id = target_sku_id;

  return query select target_sku_id, new_version_id, next_version;
end;
$$;

revoke all on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) from public, anon, service_role;
grant execute on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) to authenticated;

create or replace function public.cogs_explode_revenue(
  p_from date,
  p_to date
)
returns table (
  revenue_date date,
  revenue_line_id uuid,
  channel text,
  product_code text,
  product_name text,
  revenue_qty numeric,
  revenue_value numeric,
  sku_id uuid,
  sku_code text,
  version_id uuid,
  version_no integer,
  formulation_id uuid,
  depth integer,
  canonical_material_id uuid,
  material_name text,
  recipe_unit text,
  recipe_qty numeric,
  location text,
  kitchen_inventory_item_id uuid,
  stock_qty numeric,
  factor_used numeric,
  status text,
  source_ref text,
  raw_payload jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line record;
  v_map_id uuid;
  v_map_sku_id uuid;
  v_map_units numeric;
  v_sku public.product_skus%rowtype;
  v_version_id uuid;
  v_version_no integer;
  v_snapshot jsonb;
  v_output_qty numeric;
  v_formula_count integer;
  v_formula record;
  v_recipe_qty numeric;
  v_recipe_unit text;
  v_material_name text;
  v_name_key text;
  v_node record;
  v_depth integer;
  v_child_sku public.product_skus%rowtype;
  v_child_version_id uuid;
  v_child_version_no integer;
  v_child_snapshot jsonb;
  v_child_output_qty numeric;
  v_child_unit text;
  v_child_formula_count integer;
  v_child_factor numeric;
  v_expanded boolean;
  v_map_action text;
  v_map_location text;
  v_map_item uuid;
  v_map_factor numeric;
  v_map_status text;
  v_map_evidence jsonb;
  v_unit_fallback record;
  v_usage_factor numeric;
  v_stock_qty numeric;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'invalid_window' using errcode = '22023';
  end if;

  create temp table if not exists pg_temp.cogs_bf_queue (
    revenue_date date,
    revenue_line_id uuid,
    channel text,
    product_code text,
    product_name text,
    revenue_qty numeric,
    revenue_value numeric,
    sku_id uuid,
    sku_code text,
    version_id uuid,
    version_no integer,
    formulation_id uuid,
    depth integer,
    canonical_material_id uuid,
    ingredient_sku_id uuid,
    ingredient_name text,
    recipe_unit text,
    recipe_qty numeric,
    path uuid[]
  ) on commit drop;
  truncate table pg_temp.cogs_bf_queue;

  create temp table if not exists pg_temp.cogs_bf_out (
    revenue_date date,
    revenue_line_id uuid,
    channel text,
    product_code text,
    product_name text,
    revenue_qty numeric,
    revenue_value numeric,
    sku_id uuid,
    sku_code text,
    version_id uuid,
    version_no integer,
    formulation_id uuid,
    depth integer,
    canonical_material_id uuid,
    material_name text,
    recipe_unit text,
    recipe_qty numeric,
    location text,
    kitchen_inventory_item_id uuid,
    stock_qty numeric,
    factor_used numeric,
    status text,
    source_ref text,
    raw_payload jsonb
  ) on commit drop;
  truncate table pg_temp.cogs_bf_out;

  for v_line in
    select l.*
    from public.revenue_ledger_lines l
    where l.approval_status = 'approved'
      and l.quantity > 0
      and l.revenue_date between p_from and p_to
      and not (
        lower(coalesce(l.channel, '')) like '%test%'
        or lower(coalesce(l.customer_name, '')) like '%test%'
        or lower(coalesce(l.raw_payload ->> 'location_name', '')) like '%test%'
      )
    order by l.revenue_date, l.id
  loop
    v_map_id := null;
    v_map_sku_id := null;
    v_map_units := null;
    v_name_key := regexp_replace(
      coalesce(public.normalize_stock_item_name(v_line.product_name), ''),
      '^bmq\s*-\s*', '', 'i'
    );

    -- Same precedence as the reader: (channel, product_code), product_code,
    -- then (channel, name_key). Only learned/confirmed maps participate.
    if v_line.product_code is not null and btrim(v_line.product_code) <> '' then
      select m.id, m.sku_id, m.units_per_revenue_unit
        into v_map_id, v_map_sku_id, v_map_units
      from public.revenue_product_sku_map m
      where m.status in ('auto', 'confirmed')
        and m.sku_id is not null
        and lower(coalesce(m.channel, '')) = lower(coalesce(v_line.channel, ''))
        and m.product_code is not null
        and lower(m.product_code) = lower(v_line.product_code)
      order by (m.status = 'confirmed') desc, m.updated_at desc, m.id::text
      limit 1;
    end if;

    if v_map_id is null and v_line.product_code is not null and btrim(v_line.product_code) <> '' then
      select m.id, m.sku_id, m.units_per_revenue_unit
        into v_map_id, v_map_sku_id, v_map_units
      from public.revenue_product_sku_map m
      where m.status in ('auto', 'confirmed')
        and m.sku_id is not null
        and m.product_code is not null
        and lower(m.product_code) = lower(v_line.product_code)
      order by (m.status = 'confirmed') desc, m.updated_at desc, m.id::text
      limit 1;
    end if;

    if v_map_id is null and v_name_key <> '' then
      select m.id, m.sku_id, m.units_per_revenue_unit
        into v_map_id, v_map_sku_id, v_map_units
      from public.revenue_product_sku_map m
      where m.status in ('auto', 'confirmed')
        and m.sku_id is not null
        and lower(coalesce(m.channel, '')) = lower(coalesce(v_line.channel, ''))
        and m.name_key = v_name_key
      order by (m.status = 'confirmed') desc, m.updated_at desc, m.id::text
      limit 1;
    end if;

    if v_map_sku_id is null then
      -- A product the owner marked "không trừ kho" (rejected map) is skipped,
      -- not reported as a gap on every run.
      insert into pg_temp.cogs_bf_out(
        revenue_date, revenue_line_id, channel, product_code, product_name,
        revenue_qty, revenue_value, status, source_ref, raw_payload
      ) values (
        v_line.revenue_date, v_line.id, v_line.channel, v_line.product_code, v_line.product_name,
        v_line.quantity, v_line.gross_revenue,
        case when exists (
          select 1
          from public.revenue_product_sku_map m
          where m.status = 'rejected'
            and (
              (v_line.product_code is not null and btrim(v_line.product_code) <> ''
               and m.product_code is not null
               and lower(m.product_code) = lower(v_line.product_code)
               and lower(coalesce(m.channel, '')) = lower(coalesce(v_line.channel, '')))
              or (coalesce(btrim(v_line.product_code), '') = ''
                  and m.product_code is null
                  and lower(coalesce(m.channel, '')) = lower(coalesce(v_line.channel, ''))
                  and m.name_key = v_name_key)
            )
        ) then 'skipped' else 'gap_product' end,
        v_line.source_ref, v_line.raw_payload
      );
      continue;
    end if;

    select * into v_sku from public.product_skus ps where ps.id = v_map_sku_id;
    if not found then
      insert into pg_temp.cogs_bf_out(
        revenue_date, revenue_line_id, channel, product_code, product_name,
        revenue_qty, revenue_value, status, source_ref, raw_payload
      ) values (
        v_line.revenue_date, v_line.id, v_line.channel, v_line.product_code, v_line.product_name,
        v_line.quantity, v_line.gross_revenue, 'gap_product', v_line.source_ref, v_line.raw_payload
      );
      continue;
    end if;

    v_version_id := null;
    v_version_no := null;
    v_snapshot := null;
    select v.id, v.version_no, v.product_snapshot
      into v_version_id, v_version_no, v_snapshot
    from public.sku_cogs_versions v
    where v.sku_id = v_sku.id
      and v.effective_from <= v_line.revenue_date
      and (v.effective_to is null or v_line.revenue_date <= v.effective_to)
    order by v.effective_from desc, v.version_no desc, v.id::text desc
    limit 1;

    v_output_qty := null;
    if v_snapshot is not null
       and coalesce(v_snapshot ->> 'finished_output_qty', '') ~ '^[0-9]+(\.[0-9]+)?$' then
      v_output_qty := (v_snapshot ->> 'finished_output_qty')::numeric;
    end if;
    v_output_qty := coalesce(v_output_qty, v_sku.finished_output_qty);

    if v_version_id is not null then
      select count(*) into v_formula_count
      from public.sku_cogs_version_formulations f
      where f.version_id = v_version_id;
    else
      select count(*) into v_formula_count
      from public.sku_formulations f
      where f.sku_id = v_sku.id;
    end if;

    if v_formula_count = 0 or coalesce(v_output_qty, 0) <= 0 then
      insert into pg_temp.cogs_bf_out(
        revenue_date, revenue_line_id, channel, product_code, product_name,
        revenue_qty, revenue_value, sku_id, sku_code, version_id, version_no,
        depth, status, source_ref, raw_payload
      ) values (
        v_line.revenue_date, v_line.id, v_line.channel, v_line.product_code, v_line.product_name,
        v_line.quantity, v_line.gross_revenue, v_sku.id, v_sku.sku_code, v_version_id, v_version_no,
        0, 'gap_recipe', v_line.source_ref, v_line.raw_payload
      );
      continue;
    end if;

    for v_formula in
      select f.id, f.canonical_material_id, f.ingredient_sku_id,
             f.ingredient_name,
             public.normalize_document_unit(coalesce(nullif(f.dosage_unit, ''), f.unit)) as recipe_unit,
             f.dosage_qty, f.wastage_percent, f.sort_order
      from (
        select f.id, f.canonical_material_id, public.cogs_resolve_child_sku(f.ingredient_sku_id, f.canonical_material_id, f.material_code) as ingredient_sku_id,
               f.ingredient_name, f.unit, f.dosage_unit, f.dosage_qty, f.wastage_percent, f.sort_order
        from public.sku_cogs_version_formulations f
        where v_version_id is not null and f.version_id = v_version_id
          -- Same leaf rule as generate_q7_production_material_issue: a
          -- "Parent" row whose "Parent > Child" rows are listed is not used
          -- itself, or its ingredients would be counted twice.
          and not exists (
            select 1
            from public.sku_cogs_version_formulations child
            where child.version_id = f.version_id
              and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
          )
        union all
        select f.id, f.canonical_material_id, f.ingredient_sku_id,
               f.ingredient_name, f.unit, f.dosage_unit, f.dosage_qty, f.wastage_percent, f.sort_order
        from public.sku_formulations f
        where v_version_id is null and f.sku_id = v_sku.id
          and not exists (
            select 1
            from public.sku_formulations child
            where child.sku_id = f.sku_id
              and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
          )
      ) f
      order by f.sort_order, f.id
    loop
      v_recipe_unit := v_formula.recipe_unit;
      v_recipe_qty := round(
        (
          (v_line.quantity * coalesce(v_map_units, 1) / v_output_qty)
          * coalesce(v_formula.dosage_qty, 0)
          * (1 + coalesce(v_formula.wastage_percent, 0) / 100.0)
        )::numeric,
        6
      );

      if coalesce(v_recipe_qty, 0) <= 0 then
        insert into pg_temp.cogs_bf_out(
          revenue_date, revenue_line_id, channel, product_code, product_name,
          revenue_qty, revenue_value, sku_id, sku_code, version_id, version_no,
          formulation_id, depth, canonical_material_id, recipe_unit, recipe_qty,
          status, source_ref, raw_payload
        ) values (
          v_line.revenue_date, v_line.id, v_line.channel, v_line.product_code, v_line.product_name,
          v_line.quantity, v_line.gross_revenue, v_sku.id, v_sku.sku_code, v_version_id, v_version_no,
          v_formula.id, 0, v_formula.canonical_material_id, v_recipe_unit, v_recipe_qty,
          'gap_recipe', v_line.source_ref, v_line.raw_payload
        );
        continue;
      end if;

      insert into pg_temp.cogs_bf_queue(
        revenue_date, revenue_line_id, channel, product_code, product_name,
        revenue_qty, revenue_value, sku_id, sku_code, version_id, version_no,
        formulation_id, depth, canonical_material_id, ingredient_sku_id,
        ingredient_name, recipe_unit, recipe_qty, path
      ) values (
        v_line.revenue_date, v_line.id, v_line.channel, v_line.product_code, v_line.product_name,
        v_line.quantity, v_line.gross_revenue, v_sku.id, v_sku.sku_code, v_version_id, v_version_no,
        v_formula.id, 0, v_formula.canonical_material_id, v_formula.ingredient_sku_id,
        v_formula.ingredient_name, v_recipe_unit, v_recipe_qty, array[v_sku.id]
      );
    end loop;
  end loop;

  for v_depth in 0 .. 3 loop
    for v_node in
      select q.*
      from pg_temp.cogs_bf_queue q
      where q.depth = v_depth
      order by q.revenue_line_id, q.formulation_id
    loop
      v_expanded := false;

      if v_node.ingredient_sku_id is not null then
        select * into v_child_sku
        from public.product_skus ps
        where ps.id = v_node.ingredient_sku_id;

        if found and v_child_sku.sku_type is distinct from 'raw_material' then
          v_child_version_id := null;
          v_child_version_no := null;
          v_child_snapshot := null;
          select v.id, v.version_no, v.product_snapshot
            into v_child_version_id, v_child_version_no, v_child_snapshot
          from public.sku_cogs_versions v
          where v.sku_id = v_child_sku.id
            and v.effective_from <= v_node.revenue_date
            and (v.effective_to is null or v_node.revenue_date <= v.effective_to)
          order by v.effective_from desc, v.version_no desc, v.id::text desc
          limit 1;

          v_child_output_qty := null;
          if v_child_snapshot is not null
             and coalesce(v_child_snapshot ->> 'finished_output_qty', '') ~ '^[0-9]+(\.[0-9]+)?$' then
            v_child_output_qty := (v_child_snapshot ->> 'finished_output_qty')::numeric;
          end if;
          v_child_output_qty := coalesce(v_child_output_qty, v_child_sku.finished_output_qty);
          v_child_unit := coalesce(v_child_sku.finished_output_unit, v_child_sku.unit);

          select count(*) into v_child_formula_count
          from (
            select 1
            from public.sku_cogs_version_formulations f
            where v_child_version_id is not null and f.version_id = v_child_version_id
            union all
            select 1
            from public.sku_formulations f
            where v_child_version_id is null and f.sku_id = v_child_sku.id
          ) c;

          if v_child_formula_count > 0
             and v_depth < 3
             and not (v_child_sku.id = any(v_node.path)) then
            v_child_factor := public.stock_unit_line_factor(v_node.recipe_unit, v_child_unit);
            if v_child_factor is null or coalesce(v_child_output_qty, 0) <= 0 then
              insert into pg_temp.cogs_bf_out(
                revenue_date, revenue_line_id, channel, product_code, product_name,
                revenue_qty, revenue_value, sku_id, sku_code, version_id, version_no,
                formulation_id, depth, canonical_material_id, recipe_unit, recipe_qty,
                status, source_ref, raw_payload
              ) values (
                v_node.revenue_date, v_node.revenue_line_id, v_node.channel,
                v_node.product_code, v_node.product_name, v_node.revenue_qty, v_node.revenue_value,
                v_node.sku_id, v_node.sku_code, v_node.version_id, v_node.version_no,
                v_node.formulation_id, v_node.depth, v_node.canonical_material_id,
                v_node.recipe_unit, v_node.recipe_qty,
                'gap_sub_recipe_unit', v_node.revenue_line_id::text, null
              );
              continue;
            end if;

            for v_formula in
              select f.id, f.canonical_material_id, f.ingredient_sku_id,
                     f.ingredient_name,
                     public.normalize_document_unit(coalesce(nullif(f.dosage_unit, ''), f.unit)) as recipe_unit,
                     f.dosage_qty, f.wastage_percent, f.sort_order
              from (
                select f.id, f.canonical_material_id, public.cogs_resolve_child_sku(f.ingredient_sku_id, f.canonical_material_id, f.material_code) as ingredient_sku_id,
                       f.ingredient_name, f.unit, f.dosage_unit, f.dosage_qty, f.wastage_percent, f.sort_order
                from public.sku_cogs_version_formulations f
                where v_child_version_id is not null and f.version_id = v_child_version_id
                  and not exists (
                    select 1
                    from public.sku_cogs_version_formulations child
                    where child.version_id = f.version_id
                      and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
                  )
                union all
                select f.id, f.canonical_material_id, f.ingredient_sku_id,
                       f.ingredient_name, f.unit, f.dosage_unit, f.dosage_qty, f.wastage_percent, f.sort_order
                from public.sku_formulations f
                where v_child_version_id is null and f.sku_id = v_child_sku.id
                  and not exists (
                    select 1
                    from public.sku_formulations child
                    where child.sku_id = f.sku_id
                      and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
                  )
              ) f
              order by f.sort_order, f.id
            loop
              v_recipe_qty := round(
                (
                  (v_node.recipe_qty * v_child_factor / v_child_output_qty)
                  * coalesce(v_formula.dosage_qty, 0)
                  * (1 + coalesce(v_formula.wastage_percent, 0) / 100.0)
                )::numeric,
                6
              );

              if coalesce(v_recipe_qty, 0) <= 0 then
                insert into pg_temp.cogs_bf_out(
                  revenue_date, revenue_line_id, channel, product_code, product_name,
                  revenue_qty, revenue_value, sku_id, sku_code, version_id, version_no,
                  formulation_id, depth, canonical_material_id, recipe_unit, recipe_qty,
                  status, source_ref, raw_payload
                ) values (
                  v_node.revenue_date, v_node.revenue_line_id, v_node.channel,
                  v_node.product_code, v_node.product_name, v_node.revenue_qty, v_node.revenue_value,
                  v_node.sku_id, v_node.sku_code, v_child_version_id, v_child_version_no,
                  v_formula.id, v_node.depth + 1, v_formula.canonical_material_id,
                  v_formula.recipe_unit, v_recipe_qty, 'gap_recipe',
                  v_node.revenue_line_id::text, null
                );
                continue;
              end if;

              insert into pg_temp.cogs_bf_queue(
                revenue_date, revenue_line_id, channel, product_code, product_name,
                revenue_qty, revenue_value, sku_id, sku_code, version_id, version_no,
                formulation_id, depth, canonical_material_id, ingredient_sku_id,
                ingredient_name, recipe_unit, recipe_qty, path
              ) values (
                v_node.revenue_date, v_node.revenue_line_id, v_node.channel,
                v_node.product_code, v_node.product_name, v_node.revenue_qty, v_node.revenue_value,
                v_node.sku_id, v_node.sku_code, v_child_version_id, v_child_version_no,
                v_formula.id, v_node.depth + 1, v_formula.canonical_material_id,
                v_formula.ingredient_sku_id, v_formula.ingredient_name,
                v_formula.recipe_unit, v_recipe_qty,
                array_append(v_node.path, v_child_sku.id)
              );
              v_expanded := true;
            end loop;

            if v_expanded then
              continue;
            end if;
          end if;
        end if;
      end if;

      -- Leaf: classify the ingredient map. Every input row ends in a status.
      v_map_action := null;
      v_map_location := null;
      v_map_item := null;
      v_map_factor := null;
      v_map_status := null;
      v_map_evidence := '{}'::jsonb;
      v_material_name := null;

      if v_node.canonical_material_id is not null then
        select m.canonical_name into v_material_name
        from public.sku_cogs_materials m
        where m.id = v_node.canonical_material_id;
      end if;
      v_material_name := coalesce(v_material_name, v_node.ingredient_name);

      if v_node.canonical_material_id is null then
        insert into pg_temp.cogs_bf_out(
          revenue_date, revenue_line_id, channel, product_code, product_name,
          revenue_qty, revenue_value, sku_id, sku_code, version_id, version_no,
          formulation_id, depth, canonical_material_id, material_name, recipe_unit,
          recipe_qty, status, source_ref, raw_payload
        ) values (
          v_node.revenue_date, v_node.revenue_line_id, v_node.channel,
          v_node.product_code, v_node.product_name, v_node.revenue_qty, v_node.revenue_value,
          v_node.sku_id, v_node.sku_code, v_node.version_id, v_node.version_no,
          v_node.formulation_id, v_node.depth, v_node.canonical_material_id,
          v_material_name, v_node.recipe_unit, v_node.recipe_qty,
          'gap_material', v_node.revenue_line_id::text, null
        );
        continue;
      end if;

      if v_node.recipe_unit is not null then
        select m.action, m.location, m.kitchen_inventory_item_id, m.factor,
               m.status, m.evidence
          into v_map_action, v_map_location, v_map_item, v_map_factor,
               v_map_status, v_map_evidence
        from public.cogs_ingredient_stock_map m
        where m.canonical_material_id = v_node.canonical_material_id
          and m.recipe_unit = v_node.recipe_unit
        limit 1;
      end if;

      -- The map may be stored in another convertible unit (kg vs g).  Keep the
      -- exact lookup above first; only fall back for a missing, suggested or
      -- actionless row.
      if v_node.recipe_unit is not null
         and (v_map_status is null or v_map_status = 'suggested' or v_map_action is null) then
        select m.action, m.location, m.kitchen_inventory_item_id,
               public.stock_unit_line_factor(v_node.recipe_unit, m.recipe_unit) * m.factor as factor,
               m.status,
               coalesce(m.evidence, '{}'::jsonb)
                 || jsonb_build_object('unit_fallback_from', m.recipe_unit) as evidence
          into v_unit_fallback
        from public.cogs_ingredient_stock_map m
        where m.canonical_material_id = v_node.canonical_material_id
          and m.status in ('auto', 'confirmed')
          and m.action is not null
          and public.stock_unit_line_factor(v_node.recipe_unit, m.recipe_unit) is not null
        order by (m.status = 'confirmed') desc, m.recipe_unit, m.id
        limit 1;
        if found then
          v_map_action := v_unit_fallback.action;
          v_map_location := v_unit_fallback.location;
          v_map_item := v_unit_fallback.kitchen_inventory_item_id;
          v_map_factor := v_unit_fallback.factor;
          v_map_status := v_unit_fallback.status;
          v_map_evidence := v_unit_fallback.evidence;
        end if;
      end if;

      if v_node.recipe_unit is null
         or v_map_status is null
         or v_map_status = 'suggested'
         or v_map_action is null then
        insert into pg_temp.cogs_bf_out(
          revenue_date, revenue_line_id, channel, product_code, product_name,
          revenue_qty, revenue_value, sku_id, sku_code, version_id, version_no,
          formulation_id, depth, canonical_material_id, material_name, recipe_unit,
          recipe_qty, location, kitchen_inventory_item_id, factor_used,
          status, source_ref, raw_payload
        ) values (
          v_node.revenue_date, v_node.revenue_line_id, v_node.channel,
          v_node.product_code, v_node.product_name, v_node.revenue_qty, v_node.revenue_value,
          v_node.sku_id, v_node.sku_code, v_node.version_id, v_node.version_no,
          v_node.formulation_id, v_node.depth, v_node.canonical_material_id,
          v_material_name, v_node.recipe_unit, v_node.recipe_qty,
          v_map_location, v_map_item, v_map_factor,
          'gap_ingredient', v_node.revenue_line_id::text, null
        );
        continue;
      end if;

      if v_map_action in ('not_tracked', 'finished_goods_ledger') then
        insert into pg_temp.cogs_bf_out(
          revenue_date, revenue_line_id, channel, product_code, product_name,
          revenue_qty, revenue_value, sku_id, sku_code, version_id, version_no,
          formulation_id, depth, canonical_material_id, material_name, recipe_unit,
          recipe_qty, location, kitchen_inventory_item_id, factor_used,
          status, source_ref, raw_payload
        ) values (
          v_node.revenue_date, v_node.revenue_line_id, v_node.channel,
          v_node.product_code, v_node.product_name, v_node.revenue_qty, v_node.revenue_value,
          v_node.sku_id, v_node.sku_code, v_node.version_id, v_node.version_no,
          v_node.formulation_id, v_node.depth, v_node.canonical_material_id,
          v_material_name, v_node.recipe_unit, v_node.recipe_qty,
          v_map_location, v_map_item, v_map_factor,
          'skipped', v_node.revenue_line_id::text, null
        );
        continue;
      end if;

      if v_map_action = 'deduct'
         and v_map_location is not null
         and v_map_item is not null
         and coalesce(v_map_factor, 0) > 0 then
        -- >>> production-kho override (cogs_sku_production_location)
        -- The top-level revenue SKU can be produced at a different kho than
        -- the ingredient map learned.  Use that kho only when this mapped
        -- item has a place there; otherwise keep the map location as-is.
        v_map_location := coalesce((
          select p.location
          from public.cogs_sku_production_location p
          join public.kitchen_inventory_items k on k.id = v_map_item
          where p.sku_id = v_node.sku_id
            and p.location is distinct from v_map_location
            and (
              (p.location = 'tan_tao' and k.in_tan_tao is true)
              or (p.location = 'q7' and k.pastry_q7 is true)
            )
          limit 1
        ), v_map_location);
        -- <<< production-kho override (cogs_sku_production_location)
        v_usage_factor := null;
        select f.factor into v_usage_factor
        from public.cogs_usage_factors f
        where f.location = v_map_location
          and f.kitchen_inventory_item_id = v_map_item
          and f.effective_from <= v_node.revenue_date
        order by f.effective_from desc, f.id::text desc
        limit 1;
        v_usage_factor := coalesce(v_usage_factor, 1);
        v_stock_qty := round(
          coalesce(v_node.recipe_qty, 0) * v_map_factor * v_usage_factor,
          6
        );

        if coalesce(v_stock_qty, 0) <= 0 then
          insert into pg_temp.cogs_bf_out(
            revenue_date, revenue_line_id, channel, product_code, product_name,
            revenue_qty, revenue_value, sku_id, sku_code, version_id, version_no,
            formulation_id, depth, canonical_material_id, material_name, recipe_unit,
            recipe_qty, location, kitchen_inventory_item_id, factor_used,
            status, source_ref, raw_payload
          ) values (
            v_node.revenue_date, v_node.revenue_line_id, v_node.channel,
            v_node.product_code, v_node.product_name, v_node.revenue_qty, v_node.revenue_value,
            v_node.sku_id, v_node.sku_code, v_node.version_id, v_node.version_no,
            v_node.formulation_id, v_node.depth, v_node.canonical_material_id,
            v_material_name, v_node.recipe_unit, v_node.recipe_qty,
            v_map_location, v_map_item, v_map_factor,
            'gap_ingredient', v_node.revenue_line_id::text, null
          );
          continue;
        end if;

        insert into pg_temp.cogs_bf_out(
          revenue_date, revenue_line_id, channel, product_code, product_name,
          revenue_qty, revenue_value, sku_id, sku_code, version_id, version_no,
          formulation_id, depth, canonical_material_id, material_name, recipe_unit,
          recipe_qty, location, kitchen_inventory_item_id, stock_qty, factor_used,
          status, source_ref, raw_payload
        ) values (
          v_node.revenue_date, v_node.revenue_line_id, v_node.channel,
          v_node.product_code, v_node.product_name, v_node.revenue_qty, v_node.revenue_value,
          v_node.sku_id, v_node.sku_code, v_node.version_id, v_node.version_no,
          v_node.formulation_id, v_node.depth, v_node.canonical_material_id,
          v_material_name, v_node.recipe_unit, v_node.recipe_qty,
          v_map_location, v_map_item, v_stock_qty, v_map_factor,
          'ok', v_node.revenue_line_id::text, null
        );
        continue;
      end if;

      insert into pg_temp.cogs_bf_out(
        revenue_date, revenue_line_id, channel, product_code, product_name,
        revenue_qty, revenue_value, sku_id, sku_code, version_id, version_no,
        formulation_id, depth, canonical_material_id, material_name, recipe_unit,
        recipe_qty, location, kitchen_inventory_item_id, factor_used,
        status, source_ref, raw_payload
      ) values (
        v_node.revenue_date, v_node.revenue_line_id, v_node.channel,
        v_node.product_code, v_node.product_name, v_node.revenue_qty, v_node.revenue_value,
        v_node.sku_id, v_node.sku_code, v_node.version_id, v_node.version_no,
        v_node.formulation_id, v_node.depth, v_node.canonical_material_id,
        v_material_name, v_node.recipe_unit, v_node.recipe_qty,
        v_map_location, v_map_item, v_map_factor,
        'gap_ingredient', v_node.revenue_line_id::text, null
      );
    end loop;
  end loop;

  return query
  select o.revenue_date, o.revenue_line_id, o.channel, o.product_code, o.product_name,
         o.revenue_qty, o.revenue_value, o.sku_id, o.sku_code, o.version_id, o.version_no,
         o.formulation_id, o.depth, o.canonical_material_id, o.material_name, o.recipe_unit,
         o.recipe_qty, o.location, o.kitchen_inventory_item_id, o.stock_qty, o.factor_used,
         o.status, o.source_ref, o.raw_payload
  from pg_temp.cogs_bf_out o
  order by o.revenue_date, o.revenue_line_id, o.depth, o.formulation_id;
end;
$$;

revoke all on function public.cogs_explode_revenue(date, date) from public, anon, authenticated;
grant execute on function public.cogs_explode_revenue(date, date) to service_role;

-- Backfill only the current TP-PATE version and the formulations it came from.
-- The guard trigger on sku_formulations needs the same bypass save_sku_cogs
-- uses; no trigger is dropped or disabled.
do $do$
declare
  v_version_id constant uuid := '59b2950e-949f-4ab8-8b76-8d4c4eb642b2';
  v_version_rows integer;
begin
  perform set_config('material_master.sku_cogs_save', 'save_sku_cogs', true);

  update public.sku_cogs_version_formulations
  set dosage_unit = 'Kg'
  where version_id = v_version_id
    and dosage_unit is null;
  get diagnostics v_version_rows = row_count;
  if v_version_rows <> 11 then
    raise exception 'TP-PATE dosage_unit backfill expected 11 version rows, updated %', v_version_rows
      using errcode = '23514';
  end if;

  update public.sku_formulations
  set dosage_unit = 'Kg'
  where id in (
    select vf.source_formulation_id
    from public.sku_cogs_version_formulations vf
    where vf.version_id = v_version_id
      and vf.source_formulation_id is not null
  )
    and dosage_unit is null;
end;
$do$;
