-- Auto-link a sub-recipe child SKU for a COGS formulation row whose
-- ingredient_sku_id is still empty.
--
-- Live data already links the BMQ-003 sub-recipes (Pate heo, Bơ Bánh mì,
-- Đồ chua) on versions 6-10.  Older/imported rows can still carry only
-- canonical_material_id/material_code, so cogs_explode_revenue falls back to
-- the material's linked SKU or the matching child SKU code.  A fallback is
-- used only when it identifies exactly one non-raw child SKU with its own
-- COGS version; ambiguity keeps the current leaf/gap behaviour.
--
-- Everything in cogs_explode_revenue other than the two ingredient_sku_id
-- selects over public.sku_cogs_version_formulations is unchanged.

create or replace function public.cogs_resolve_child_sku(
  p_ingredient_sku_id uuid,
  p_canonical_material_id uuid,
  p_material_code text
)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    -- (a) the SKU explicitly linked to the formulation's canonical material
    select 1 as priority, ps.id as sku_id
    from public.sku_cogs_materials m
    join public.product_skus ps on ps.id = m.ingredient_sku_id
    where p_ingredient_sku_id is null
      and m.id = p_canonical_material_id
      and ps.sku_type is distinct from 'raw_material'
      and exists (
        select 1 from public.sku_cogs_versions v where v.sku_id = ps.id
      )

    union all

    -- (b) the SKU whose own canonical material link matches the row
    select 2, ps.id
    from public.product_skus ps
    where p_ingredient_sku_id is null
      and p_canonical_material_id is not null
      and ps.canonical_material_id = p_canonical_material_id
      and ps.sku_type is distinct from 'raw_material'
      and exists (
        select 1 from public.sku_cogs_versions v where v.sku_id = ps.id
      )

    union all

    -- (c) the SKU code equals the row material code, ignoring whitespace/case
    select 3, ps.id
    from public.product_skus ps
    where p_ingredient_sku_id is null
      and p_material_code is not null
      and upper(regexp_replace(coalesce(ps.sku_code, ''), '\s', '', 'g'))
          = upper(regexp_replace(p_material_code, '\s', '', 'g'))
      and ps.sku_type is distinct from 'raw_material'
      and exists (
        select 1 from public.sku_cogs_versions v where v.sku_id = ps.id
      )
  ),
  ranked as (
    select c.priority, c.sku_id,
           count(*) over (partition by c.priority) as match_count,
           min(c.priority) over () as first_priority
    from candidates c
  )
  select case
    when p_ingredient_sku_id is not null then p_ingredient_sku_id
    else (
      select r.sku_id
      from ranked r
      where r.priority = r.first_priority
        and r.match_count = 1
      limit 1
    )
  end;
$$;

revoke execute on function public.cogs_resolve_child_sku(uuid, uuid, text) from public, anon;
grant execute on function public.cogs_resolve_child_sku(uuid, uuid, text) to authenticated, service_role;

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
             public.normalize_document_unit(f.unit) as recipe_unit,
             f.dosage_qty, f.wastage_percent, f.sort_order
      from (
        select f.id, f.canonical_material_id, public.cogs_resolve_child_sku(f.ingredient_sku_id, f.canonical_material_id, f.material_code) as ingredient_sku_id,
               f.ingredient_name, f.unit, f.dosage_qty, f.wastage_percent, f.sort_order
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
               f.ingredient_name, f.unit, f.dosage_qty, f.wastage_percent, f.sort_order
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
                     public.normalize_document_unit(f.unit) as recipe_unit,
                     f.dosage_qty, f.wastage_percent, f.sort_order
              from (
                select f.id, f.canonical_material_id, public.cogs_resolve_child_sku(f.ingredient_sku_id, f.canonical_material_id, f.material_code) as ingredient_sku_id,
                       f.ingredient_name, f.unit, f.dosage_qty, f.wastage_percent, f.sort_order
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
                       f.ingredient_name, f.unit, f.dosage_qty, f.wastage_percent, f.sort_order
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
