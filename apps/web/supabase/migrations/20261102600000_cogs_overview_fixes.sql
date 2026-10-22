-- 2026-10-22 — Giá vốn → Kho screen (GĐ2) data fixes on top of 20261102590000.
--
-- cogs_backflush_overview
--   * items compare in kho units: the trace stock qty (recipe qty × map factor
--     × usage factor), not the recipe qty, against the PXK rows;
--   * PXK usage leaves out rows given back by their 'pmi-item-reverse:' row;
--   * an ingredient whose only linked kho item lacks a factor or stock offers
--     that item as its candidate;
--   * returns can_decide / can_switch (the decision and switch gates) and the
--     finished-good SKU list for the product picker.
-- cogs_explode_revenue
--   * a revenue product marked "không trừ kho" (rejected map) is 'skipped'
--     instead of a gap on every run.
-- cogs_item_usage_trace
--   * read the recipe version number from sku_cogs_versions (the trace keeps
--     only version_id; the first body referenced a missing column), show the
--     order / PO / invoice number before the internal source_ref, and add the
--     customer and the revenue quantity.
-- cogs_refresh_now
--   * owner / kho admins re-run the window after a decision (same as cron).

create or replace function public.cogs_backflush_overview(
  p_from date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date - 20),
  p_to date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date)
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_as_of date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_settings jsonb := '[]'::jsonb;
  v_last_run jsonb := null;
  v_coverage jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_gap_products jsonb := '[]'::jsonb;
  v_gap_ingredients jsonb := '[]'::jsonb;
  v_gap_recipes jsonb := '[]'::jsonb;
  v_sku_options jsonb := '[]'::jsonb;
  v_can_decide boolean := false;
  v_can_switch boolean := false;
begin
  if v_actor is null then
    raise exception 'actor_required' using errcode = '42501';
  end if;
  if not (
    public.q7_material_inventory_can_view(v_actor)
    or public.stock_count_can_view('tan_tao')
    or public.stock_count_can_view('q7')
    or public.kho_item_can_edit(v_actor)
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'invalid_window' using errcode = '22023';
  end if;

  -- Same gates as the decision RPCs and cogs_set_backflush, so the screen
  -- only offers what the server will accept.
  v_can_switch := public.has_role(v_actor, 'owner');
  v_can_decide := v_can_switch or public.material_alias_can_admin(v_actor);

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'sku_id', ps.id,
               'sku_code', ps.sku_code,
               'name', ps.product_name,
               'unit', coalesce(ps.finished_output_unit, ps.unit)
             )
             order by ps.product_name, ps.sku_code
           ),
           '[]'::jsonb
         )
    into v_sku_options
  from public.product_skus ps
  where ps.sku_type = 'finished_good';

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'location', s.location,
               'enabled', s.enabled,
               'start_date', s.start_date,
               'cutover_date', public.stock_ledger_cutover_date(s.location),
               'updated_at', s.updated_at
             )
             order by s.location
           ),
           '[]'::jsonb
         )
    into v_settings
  from public.cogs_backflush_settings s;

  select to_jsonb(r)
    into v_last_run
  from public.cogs_backflush_runs r
  order by r.started_at desc, r.id desc
  limit 1;
  v_last_run := coalesce(v_last_run, 'null'::jsonb);

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'channel', c.channel,
               'lines', c.lines,
               'qty', c.qty,
               'value', c.value,
               'mapped_lines', c.mapped_lines,
               'mapped_qty', c.mapped_qty,
               'mapped_value', c.mapped_value,
               'mapped_pct', case when c.lines = 0 then 0
                                  else round(100.0 * c.mapped_lines / c.lines, 1) end,
               'mapped_value_pct', case when c.value = 0 then 0
                                        else round(100.0 * c.mapped_value / c.value, 1) end
             )
             order by c.channel
           ),
           '[]'::jsonb
         )
    into v_coverage
  from (
    select l.channel,
           count(*)::integer as lines,
           coalesce(sum(l.quantity), 0) as qty,
           coalesce(sum(l.gross_revenue), 0) as value,
           count(*) filter (
             where exists (
               select 1
               from public.revenue_product_sku_map m
               where m.status in ('auto', 'confirmed')
                 and m.sku_id is not null
                 and (
                   (
                     l.product_code is not null
                     and m.product_code is not null
                     and lower(m.product_code) = lower(l.product_code)
                     and lower(coalesce(m.channel, '')) = lower(coalesce(l.channel, ''))
                   )
                   or (
                     l.product_code is not null
                     and m.product_code is not null
                     and lower(m.product_code) = lower(l.product_code)
                   )
                   or (
                     m.name_key = regexp_replace(
                       coalesce(public.normalize_stock_item_name(l.product_name), ''),
                       '^bmq\s*-\s*', '', 'i'
                     )
                     and lower(coalesce(m.channel, '')) = lower(coalesce(l.channel, ''))
                   )
                 )
             )
           )::integer as mapped_lines,
           coalesce(sum(l.quantity) filter (
             where exists (
               select 1
               from public.revenue_product_sku_map m
               where m.status in ('auto', 'confirmed')
                 and m.sku_id is not null
                 and (
                   (
                     l.product_code is not null
                     and m.product_code is not null
                     and lower(m.product_code) = lower(l.product_code)
                     and lower(coalesce(m.channel, '')) = lower(coalesce(l.channel, ''))
                   )
                   or (
                     l.product_code is not null
                     and m.product_code is not null
                     and lower(m.product_code) = lower(l.product_code)
                   )
                   or (
                     m.name_key = regexp_replace(
                       coalesce(public.normalize_stock_item_name(l.product_name), ''),
                       '^bmq\s*-\s*', '', 'i'
                     )
                     and lower(coalesce(m.channel, '')) = lower(coalesce(l.channel, ''))
                   )
                 )
             )
           ), 0) as mapped_qty,
           coalesce(sum(l.gross_revenue) filter (
             where exists (
               select 1
               from public.revenue_product_sku_map m
               where m.status in ('auto', 'confirmed')
                 and m.sku_id is not null
                 and (
                   (
                     l.product_code is not null
                     and m.product_code is not null
                     and lower(m.product_code) = lower(l.product_code)
                     and lower(coalesce(m.channel, '')) = lower(coalesce(l.channel, ''))
                   )
                   or (
                     l.product_code is not null
                     and m.product_code is not null
                     and lower(m.product_code) = lower(l.product_code)
                   )
                   or (
                     m.name_key = regexp_replace(
                       coalesce(public.normalize_stock_item_name(l.product_name), ''),
                       '^bmq\s*-\s*', '', 'i'
                     )
                     and lower(coalesce(m.channel, '')) = lower(coalesce(l.channel, ''))
                   )
                 )
             )
           ), 0) as mapped_value
    from public.revenue_ledger_lines l
    where l.approval_status = 'approved'
      and l.quantity > 0
      and l.revenue_date between p_from and p_to
      and not (
        lower(coalesce(l.channel, '')) like '%test%'
        or lower(coalesce(l.customer_name, '')) like '%test%'
        or lower(coalesce(l.raw_payload ->> 'location_name', '')) like '%test%'
      )
    group by l.channel
  ) c;

  with trace_items as (
    select t.location,
           t.kitchen_inventory_item_id as item_id,
           -- kho units (recipe qty × map factor × usage factor), the same
           -- unit as the PXK rows it is compared with
           round(sum(t.stock_qty) filter (where t.status = 'ok'), 6) as recipe_qty
    from public.cogs_backflush_trace t
    where t.revenue_date between p_from and p_to
    group by t.location, t.kitchen_inventory_item_id
  ),
  pxk_usage as (
    select 'q7'::text as location,
           m.kitchen_inventory_item_id as item_id,
           round(sum(m.quantity), 6) as pxk_usage
    from public.q7_inventory_movements m
    where m.movement_date between p_from and p_to
      and m.source = 'production_material_issue'
      and m.movement_type = 'production_usage'
      and not (
        m.source_issue_item_id is not null
        and exists (
          select 1
          from public.q7_inventory_movements r
          where r.source = 'production_material_issue_reversal'
            and r.source_ref_key = 'pmi-item-reverse:' || m.source_issue_item_id::text
        )
      )
    group by m.kitchen_inventory_item_id
  ),
  posted_q7 as (
    select 'q7'::text as location,
           m.kitchen_inventory_item_id as item_id,
           round(sum(
             case
               when m.movement_type = 'production_usage' then m.quantity
               when m.movement_type = 'adjustment' then -m.quantity
               else 0
             end
           ), 6) as posted_cogs
    from public.q7_inventory_movements m
    where m.movement_date between p_from and p_to
      and m.source = 'revenue_cogs'
    group by m.kitchen_inventory_item_id
  ),
  posted_tt as (
    select 'tan_tao'::text as location,
           m.kitchen_inventory_item_id as item_id,
           round(sum(
             case
               when m.movement_type = 'production_usage' then m.quantity
               when m.movement_type = 'adjustment' then -m.quantity
               else 0
             end
           ), 6) as posted_cogs
    from public.tan_tao_material_movements m
    where m.movement_date between p_from and p_to
      and m.source = 'revenue_cogs'
    group by m.kitchen_inventory_item_id
  ),
  keys as (
    select location, item_id from trace_items where item_id is not null
    union
    select location, item_id from pxk_usage where item_id is not null
    union
    select location, item_id from posted_q7 where item_id is not null
    union
    select location, item_id from posted_tt where item_id is not null
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'item_id', k.item_id,
               'name', kii.name,
               'unit', kii.unit,
               'location', k.location,
               'recipe_qty', coalesce(ti.recipe_qty, 0),
               'pxk_usage', coalesce(pu.pxk_usage, 0),
               'posted_cogs', coalesce(pq.posted_cogs, pt.posted_cogs, 0)
             )
             order by k.location, kii.name, k.item_id::text
           ),
           '[]'::jsonb
         )
    into v_items
  from keys k
  left join public.kitchen_inventory_items kii on kii.id = k.item_id
  left join trace_items ti on ti.location = k.location and ti.item_id = k.item_id
  left join pxk_usage pu on pu.location = k.location and pu.item_id = k.item_id
  left join posted_q7 pq on pq.location = k.location and pq.item_id = k.item_id
  left join posted_tt pt on pt.location = k.location and pt.item_id = k.item_id;

  with gap_rows as (
    select t.*, l.product_code, l.product_name, l.quantity, l.gross_revenue
    from public.cogs_backflush_trace t
    join public.revenue_ledger_lines l on l.id = t.revenue_line_id
    where t.revenue_date between p_from and p_to
      and t.status = 'gap_product'
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'map_id', g.map_id,
               'channel', g.channel,
               'product_code', g.product_code,
               'name', g.name,
               'lines', g.lines,
               'qty', g.qty,
               'value', g.value,
               'candidates', g.candidates
             )
             order by g.channel, g.product_code, g.name
           ),
           '[]'::jsonb
         )
    into v_gap_products
  from (
    select m.id as map_id,
           g.channel,
           g.product_code,
           coalesce(g.product_name, m.name_key) as name,
           count(distinct g.revenue_line_id)::integer as lines,
           round(sum(g.quantity), 6) as qty,
           round(sum(g.gross_revenue), 2) as value,
           coalesce(m.evidence -> 'candidates', '[]'::jsonb) as candidates
    from gap_rows g
    left join lateral (
      select m.*
      from public.revenue_product_sku_map m
      where m.status in ('auto', 'confirmed', 'suggested')
        and (
        (
        m.product_code is not null
        and g.product_code is not null
        and lower(m.product_code) = lower(g.product_code)
        and lower(coalesce(m.channel, '')) = lower(coalesce(g.channel, ''))
      ) or (
        m.product_code is not null
        and g.product_code is not null
        and lower(m.product_code) = lower(g.product_code)
      ) or (
        m.name_key = regexp_replace(
          coalesce(public.normalize_stock_item_name(g.product_name), ''),
          '^bmq\s*-\s*', '', 'i'
        )
        and lower(coalesce(m.channel, '')) = lower(coalesce(g.channel, ''))
      )
      )
      order by
        case
          when m.product_code is not null
               and g.product_code is not null
               and lower(m.product_code) = lower(g.product_code)
               and lower(coalesce(m.channel, '')) = lower(coalesce(g.channel, '')) then 0
          when m.product_code is not null
               and g.product_code is not null
               and lower(m.product_code) = lower(g.product_code) then 1
          else 2
        end,
        m.updated_at desc,
        m.id::text
      limit 1
    ) m on true
    group by g.channel, g.product_code, g.product_name, m.id, m.name_key, m.evidence
  ) g;

  with gap_rows as (
    select t.*, ps.sku_code, scm.canonical_name
    from public.cogs_backflush_trace t
    left join public.product_skus ps on ps.id = t.sku_id
    left join public.sku_cogs_materials scm on scm.id = t.canonical_material_id
    where t.revenue_date between p_from and p_to
      and t.status in ('gap_ingredient', 'gap_material', 'gap_sub_recipe_unit')
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'canonical_material_id', g.canonical_material_id,
               'material_name', g.material_name,
               'recipe_unit', g.recipe_unit,
               'reason', g.reason,
               'sku_codes', g.sku_codes,
               'candidates', g.candidates
             )
             order by g.material_name nulls last, g.recipe_unit, g.reason
           ),
           '[]'::jsonb
         )
    into v_gap_ingredients
  from (
    select g.canonical_material_id,
           g.canonical_name as material_name,
           g.recipe_unit,
           case
             when g.status = 'gap_material' then 'material'
             when g.status = 'gap_sub_recipe_unit' then 'sub_recipe_unit'
             else coalesce(m.reason, 'map')
           end as reason,
           coalesce(
             jsonb_agg(distinct g.sku_code) filter (where g.sku_code is not null),
             '[]'::jsonb
           ) as sku_codes,
           coalesce(
             m.evidence -> 'items',
             m.evidence -> 'candidates',
             case when m.evidence ? 'item_id' then jsonb_build_array(jsonb_build_object(
               'item_id', m.evidence -> 'item_id',
               'name', m.evidence -> 'item_name',
               'unit', m.evidence -> 'item_unit'
             )) end,
             '[]'::jsonb
           ) as candidates
    from gap_rows g
    left join public.cogs_ingredient_stock_map m
      on m.canonical_material_id = g.canonical_material_id
     and m.recipe_unit = g.recipe_unit
    group by g.canonical_material_id, g.canonical_name, g.recipe_unit, g.status,
             m.reason, m.evidence
  ) g;

  with gap_rows as (
    select t.*, ps.sku_code, ps.product_name
    from public.cogs_backflush_trace t
    left join public.product_skus ps on ps.id = t.sku_id
    where t.revenue_date between p_from and p_to
      and t.status = 'gap_recipe'
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'sku_code', g.sku_code,
               'name', g.product_name,
               'reason', 'no_recipe',
               'lines', g.lines
             )
             order by g.sku_code, g.product_name
           ),
           '[]'::jsonb
         )
    into v_gap_recipes
  from (
    select g.sku_id, g.sku_code, g.product_name,
           count(distinct g.revenue_line_id)::integer as lines
    from gap_rows g
    group by g.sku_id, g.sku_code, g.product_name
  ) g;

  return jsonb_build_object(
    'as_of', v_as_of,
    'from', p_from,
    'to', p_to,
    'settings', v_settings,
    'last_run', v_last_run,
    'coverage', v_coverage,
    'items', v_items,
    'can_decide', v_can_decide,
    'can_switch', v_can_switch,
    'sku_options', v_sku_options,
    'gaps', jsonb_build_object(
      'products', v_gap_products,
      'ingredients', v_gap_ingredients,
      'recipes', v_gap_recipes
    )
  );
end;
$$;

revoke all on function public.cogs_backflush_overview(date, date) from public, anon;
grant execute on function public.cogs_backflush_overview(date, date) to authenticated, service_role;

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
        select f.id, f.canonical_material_id, f.ingredient_sku_id,
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
                select f.id, f.canonical_material_id, f.ingredient_sku_id,
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

-- Re-run the backflush window now (same as the hourly job) so a decision on
-- the Giá vốn → Kho screen shows at once. Posts only for an enabled kho.
create or replace function public.cogs_refresh_now()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_result jsonb;
begin
  if not (
    coalesce(auth.role(), '') = 'service_role'
    or (v_actor is not null and (
      public.has_role(v_actor, 'owner')
      or public.material_alias_can_admin(v_actor)
    ))
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  v_result := public.run_cogs_backflush(v_today - 35, v_today + 14, false);
  return jsonb_build_object(
    'run_id', v_result -> 'run_id',
    'posted_rows', v_result -> 'posted_rows'
  );
end;
$$;

revoke all on function public.cogs_refresh_now() from public, anon;
grant execute on function public.cogs_refresh_now() to authenticated, service_role;

create or replace function public.cogs_item_usage_trace(
  p_location text,
  p_item_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_rows jsonb := '[]'::jsonb;
begin
  if v_actor is null then
    raise exception 'actor_required' using errcode = '42501';
  end if;
  if not (
    public.q7_material_inventory_can_view(v_actor)
    or public.stock_count_can_view('tan_tao')
    or public.stock_count_can_view('q7')
    or public.kho_item_can_edit(v_actor)
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_location is null or p_location not in ('q7', 'tan_tao') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;
  if p_item_id is null or p_from is null or p_to is null or p_from > p_to then
    raise exception 'invalid_window' using errcode = '22023';
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'revenue_date', t.revenue_date,
               'sku_id', t.sku_id,
               'sku_code', ps.sku_code,
               'sku_name', ps.product_name,
               'revenue_line_id', t.revenue_line_id,
               'channel', l.channel,
               -- a person-readable order / PO / invoice number first; the
               -- source_ref is often an internal id
               'ref', coalesce(
                 nullif(l.raw_payload ->> 'order_number', ''),
                 nullif(l.raw_payload ->> 'po_number', ''),
                 nullif(l.raw_payload ->> 'invoice_number', ''),
                 nullif(l.invoice_no, ''),
                 nullif(l.source_ref, '')
               ),
               'customer', coalesce(nullif(l.customer_name, ''), l.raw_payload ->> 'location_name'),
               'revenue_qty', l.quantity,
               'version_id', t.version_id,
               'version_no', v.version_no,
               'version_no_text', v.version_no::text,
               'recipe_unit', t.recipe_unit,
               'recipe_qty', t.recipe_qty,
               'stock_qty', t.stock_qty,
               'status', t.status
             )
             order by t.revenue_date, t.sku_id, t.revenue_line_id, t.formulation_id
           ),
           '[]'::jsonb
         )
    into v_rows
  from public.cogs_backflush_trace t
  left join public.revenue_ledger_lines l on l.id = t.revenue_line_id
  left join public.product_skus ps on ps.id = t.sku_id
  left join public.sku_cogs_versions v on v.id = t.version_id
  where t.location = p_location
    and t.kitchen_inventory_item_id = p_item_id
    and t.revenue_date between p_from and p_to;

  return jsonb_build_object(
    'location', p_location,
    'item_id', p_item_id,
    'from', p_from,
    'to', p_to,
    'rows', v_rows
  );
end;
$$;

revoke all on function public.cogs_item_usage_trace(text, uuid, date, date) from public, anon;
grant execute on function public.cogs_item_usage_trace(text, uuid, date, date) to authenticated, service_role;
