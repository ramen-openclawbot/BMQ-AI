-- 2026-10-22 — Trừ kho theo công thức giá vốn từ doanh thu đã ghi nhận.
--
-- GĐ1 (shadow first): approved revenue lines drive recipe raw-material usage.
-- The hourly/nightly runner refreshes the learned maps, rebuilds the trace for
-- its window, and — only for a location the owner explicitly enabled, with a
-- start date after the stock-count cutover — appends revenue_cogs ledger rows.
-- It never updates or deletes a ledger row. Re-runs are delta postings.
--
-- No UI is added here. All reads go through SECURITY DEFINER RPCs; the new
-- tables have RLS enabled with no policies and no anon/authenticated grants.
--
-- The Maestro applies this migration. It does not run against live from here.

-- ===========================================================================
-- 1. Ledger sources: revenue_cogs
-- ===========================================================================

alter table public.q7_inventory_movements
  drop constraint if exists q7_inventory_movements_source_check;
alter table public.q7_inventory_movements
  add constraint q7_inventory_movements_source_check
  check (source in (
    'manual_receipt', 'signed_q7_issue', 'manual_adjustment',
    'goods_receipt', 'production_material_issue', 'production_material_issue_reversal',
    'item_merge', 'item_merge_revert', 'stock_transfer', 'unit_factor_fix',
    'revenue_cogs'
  ));

alter table public.tan_tao_material_movements
  drop constraint if exists tan_tao_material_movements_source_check;
alter table public.tan_tao_material_movements
  add constraint tan_tao_material_movements_source_check
  check (source in (
    'goods_receipt', 'manual_adjustment', 'item_merge', 'item_merge_revert',
    'stock_transfer', 'production', 'unit_factor_fix', 'revenue_cogs'
  ));

-- ===========================================================================
-- 2. Learned maps, events, settings, usage factors, runs and trace
-- ===========================================================================

create table if not exists public.revenue_product_sku_map (
  id uuid primary key default gen_random_uuid(),
  channel text,
  product_code text,
  name_key text,
  sku_id uuid references public.product_skus(id) on delete set null,
  units_per_revenue_unit numeric not null default 1,
  status text not null default 'suggested'
    check (status in ('auto', 'confirmed', 'suggested', 'rejected')),
  source text not null default 'production_name'
    check (source in ('exact_code', 'payload_sku', 'production_name', 'manual')),
  confidence numeric,
  evidence jsonb not null default '{}'::jsonb,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint revenue_product_sku_map_units_check check (
    units_per_revenue_unit > 0
    and units_per_revenue_unit::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  constraint revenue_product_sku_map_confidence_check check (
    confidence is null
    or (
      confidence >= 0 and confidence <= 1
      and confidence::text not in ('NaN', 'Infinity', '-Infinity')
    )
  )
);

create unique index if not exists revenue_product_sku_map_key_uidx
  on public.revenue_product_sku_map(
    coalesce(channel, ''),
    coalesce(product_code, ''),
    coalesce(name_key, '')
  );

create index if not exists idx_revenue_product_sku_map_sku
  on public.revenue_product_sku_map(sku_id)
  where sku_id is not null;

alter table public.revenue_product_sku_map enable row level security;
revoke all on table public.revenue_product_sku_map from public, anon, authenticated;

create table if not exists public.cogs_ingredient_stock_map (
  id uuid primary key default gen_random_uuid(),
  canonical_material_id uuid not null references public.sku_cogs_materials(id) on delete restrict,
  recipe_unit text not null,
  action text check (action in ('deduct', 'not_tracked', 'finished_goods_ledger')),
  location text check (location in ('q7', 'tan_tao')),
  kitchen_inventory_item_id uuid references public.kitchen_inventory_items(id) on delete restrict,
  factor numeric,
  status text not null default 'suggested'
    check (status in ('auto', 'confirmed', 'suggested')),
  source text not null default 'kho_canonical'
    check (source in ('q7_bom_decision', 'q7_pxk_mapping', 'kho_canonical', 'manual')),
  reason text,
  evidence jsonb not null default '{}'::jsonb,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cogs_ingredient_stock_map_unit_check check (btrim(recipe_unit) <> ''),
  constraint cogs_ingredient_stock_map_factor_check check (
    factor is null
    or (
      factor > 0
      and factor::text not in ('NaN', 'Infinity', '-Infinity')
    )
  ),
  constraint cogs_ingredient_stock_map_deduct_check check (
    action is distinct from 'deduct'
    or (
      location is not null
      and kitchen_inventory_item_id is not null
      and factor is not null
      and factor > 0
    )
  )
);

create unique index if not exists cogs_ingredient_stock_map_key_uidx
  on public.cogs_ingredient_stock_map(canonical_material_id, recipe_unit);

alter table public.cogs_ingredient_stock_map enable row level security;
revoke all on table public.cogs_ingredient_stock_map from public, anon, authenticated;

create table if not exists public.cogs_mapping_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('revenue_product', 'ingredient', 'setting')),
  map_id uuid,
  action text not null,
  before jsonb,
  after jsonb,
  actor_id uuid references auth.users(id) on delete set null,
  request_id uuid not null unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_cogs_mapping_events_map
  on public.cogs_mapping_events(kind, map_id, created_at desc);

alter table public.cogs_mapping_events enable row level security;
revoke all on table public.cogs_mapping_events from public, anon, authenticated;

create table if not exists public.cogs_backflush_settings (
  location text primary key check (location in ('q7', 'tan_tao')),
  enabled boolean not null default false,
  start_date date,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.cogs_backflush_settings(location, enabled, start_date)
values ('q7', false, null), ('tan_tao', false, null)
on conflict (location) do nothing;

alter table public.cogs_backflush_settings enable row level security;
revoke all on table public.cogs_backflush_settings from public, anon, authenticated;

create table if not exists public.cogs_usage_factors (
  id uuid primary key default gen_random_uuid(),
  location text not null check (location in ('q7', 'tan_tao')),
  kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id) on delete restrict,
  factor numeric not null default 1,
  effective_from date not null default current_date,
  source text not null default 'default' check (source in ('default', 'learned', 'owner')),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint cogs_usage_factors_factor_check check (
    factor >= 0.5 and factor <= 2
    and factor::text not in ('NaN', 'Infinity', '-Infinity')
  )
);

create unique index if not exists cogs_usage_factors_key_uidx
  on public.cogs_usage_factors(location, kitchen_inventory_item_id, effective_from);

alter table public.cogs_usage_factors enable row level security;
revoke all on table public.cogs_usage_factors from public, anon, authenticated;

create table if not exists public.cogs_backflush_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  window_from date not null,
  window_to date not null,
  dry_run boolean not null default true,
  posted_rows integer not null default 0,
  summary jsonb not null default '{}'::jsonb,
  error text
);

create index if not exists idx_cogs_backflush_runs_started
  on public.cogs_backflush_runs(started_at desc, id desc);

alter table public.cogs_backflush_runs enable row level security;
revoke all on table public.cogs_backflush_runs from public, anon, authenticated;

create table if not exists public.cogs_backflush_trace (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.cogs_backflush_runs(id) on delete cascade,
  revenue_date date not null,
  revenue_line_id uuid not null,
  channel text,
  sku_id uuid,
  version_id uuid,
  formulation_id uuid,
  depth integer not null default 0,
  canonical_material_id uuid,
  recipe_unit text,
  recipe_qty numeric,
  location text,
  kitchen_inventory_item_id uuid,
  stock_qty numeric,
  factor_used numeric,
  status text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_cogs_backflush_trace_date
  on public.cogs_backflush_trace(revenue_date);
create index if not exists idx_cogs_backflush_trace_item_date
  on public.cogs_backflush_trace(kitchen_inventory_item_id, revenue_date);
create index if not exists idx_cogs_backflush_trace_line
  on public.cogs_backflush_trace(revenue_line_id);

alter table public.cogs_backflush_trace enable row level security;
revoke all on table public.cogs_backflush_trace from public, anon, authenticated;

-- ===========================================================================
-- 3. cogs_refresh_mappings — learned revenue-product and ingredient maps
-- ===========================================================================

create or replace function public.cogs_refresh_mappings()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_rec record;
  v_item_id uuid;
  v_item_name text;
  v_item_unit text;
  v_item_pastry boolean;
  v_existing public.revenue_product_sku_map%rowtype;
  v_existing_ing public.cogs_ingredient_stock_map%rowtype;
  v_sku_id uuid;
  v_map_id uuid;
  v_status text;
  v_source text;
  v_confidence numeric;
  v_evidence jsonb;
  v_name_key text;
  v_norm text;
  v_tokens text[];
  v_sizes text[];
  v_best numeric;
  v_second numeric;
  v_best_sku uuid;
  v_best_code text;
  v_best_name text;
  v_candidates jsonb;
  v_material_name text;
  v_decision public.q7_bom_line_decisions%rowtype;
  v_q7map public.q7_material_issue_material_mappings%rowtype;
  v_count integer;
  v_location text;
  v_factor numeric;
  v_has_movement boolean;
  v_action text;
  v_reason text;
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

  -- -----------------------------------------------------------------------
  -- Revenue products: last 120 days of approved, positive revenue lines.
  -- -----------------------------------------------------------------------
  -- Candidate SKUs for the name rule, built once per refresh: finished
  -- goods on production orders of the last 90 days, under their own name and
  -- under the order line's name.
  create temp table if not exists pg_temp.cogs_bf_cand (
    sku_id uuid,
    sku_code text,
    name text,
    toks text[],
    sizes text[]
  ) on commit drop;
  truncate table pg_temp.cogs_bf_cand;

  insert into pg_temp.cogs_bf_cand(sku_id, sku_code, name, toks, sizes)
  with candidate_names as (
    select ps.id as sku_id, ps.sku_code, ps.product_name as name
    from public.product_skus ps
    where ps.sku_type = 'finished_good'
      and exists (
        select 1
        from public.production_order_items poi
        join public.production_orders po on po.id = poi.production_order_id
        where poi.sku_id = ps.id
          and coalesce(poi.delivery_date, po.planned_start_date, po.created_at::date)
              >= v_today - 90
      )
    union
    select distinct ps.id, ps.sku_code, poi.product_name
    from public.production_order_items poi
    join public.production_orders po on po.id = poi.production_order_id
    join public.product_skus ps on ps.id = poi.sku_id
    where ps.sku_type = 'finished_good'
      and coalesce(poi.delivery_date, po.planned_start_date, po.created_at::date)
          >= v_today - 90
  ),
  normalized as (
    select sku_id, sku_code, name,
           regexp_replace(
             coalesce(public.normalize_stock_item_name(name), ''),
             '^bmq\s*-\s*', '', 'i'
           ) as norm_name
    from candidate_names
  )
  select sku_id, sku_code, name,
         array(
           select distinct t
           from unnest(regexp_split_to_array(norm_name, '\s+')) t
           where t <> ''
             and t !~ '^[0-9]+([.,][0-9]+)?(kg|g|gr|gram|ml|l)$'
           order by t
         ),
         array(
           select distinct m[1] || m[3]
           from regexp_matches(
             norm_name,
             '([0-9]+([.,][0-9]+)?)\s*(kg|g|gr|gram|ml|l)\y',
             'g'
           ) m
           order by m[1] || m[3]
         )
  from normalized;

  for v_rec in
    with lines as (
      select l.channel,
             l.product_code,
             regexp_replace(
               coalesce(public.normalize_stock_item_name(l.product_name), ''),
               '^bmq\s*-\s*', '', 'i'
             ) as name_key,
             l.revenue_date,
             l.id,
             nullif(btrim(l.raw_payload ->> 'sku_id'), '') as payload_sku_id,
             lower(nullif(btrim(l.raw_payload ->> 'sku_code'), '')) as payload_sku_code
      from public.revenue_ledger_lines l
      where l.approval_status = 'approved'
        and l.quantity > 0
        and l.revenue_date >= v_today - 120
        and l.revenue_date <= v_today
    )
    select channel, product_code, name_key,
           (array_agg(payload_sku_id order by revenue_date desc, id desc)
              filter (where payload_sku_id is not null))[1] as payload_sku_id,
           (array_agg(payload_sku_code order by revenue_date desc, id desc)
              filter (where payload_sku_code is not null))[1] as payload_sku_code
    from lines
    group by channel, product_code, name_key
    order by channel, product_code, name_key
  loop
    v_name_key := v_rec.name_key;
    v_sku_id := null;
    v_status := null;
    v_source := 'production_name';
    v_confidence := null;
    v_evidence := '{}'::jsonb;

    v_existing := null;
    select * into v_existing
    from public.revenue_product_sku_map m
    where coalesce(m.channel, '') = coalesce(v_rec.channel, '')
      and coalesce(m.product_code, '') = coalesce(v_rec.product_code, '')
      and coalesce(m.name_key, '') = coalesce(v_name_key, '')
    limit 1;

    if found and v_existing.status in ('confirmed', 'rejected') then
      continue;
    end if;

    -- 1. exact product code
    if v_rec.product_code is not null and btrim(v_rec.product_code) <> '' then
      select ps.id into v_sku_id
      from public.product_skus ps
      where lower(btrim(ps.sku_code)) = lower(btrim(v_rec.product_code))
      order by ps.id::text
      limit 1;
      if v_sku_id is not null then
        v_status := 'auto';
        v_source := 'exact_code';
        v_confidence := 1;
      end if;
    end if;

    -- 2. the payload carries a SKU id or code
    if v_sku_id is null
       and (v_rec.payload_sku_id is not null or v_rec.payload_sku_code is not null) then
      select ps.id into v_sku_id
      from public.product_skus ps
      where ps.id::text = v_rec.payload_sku_id
         or lower(btrim(ps.sku_code)) = v_rec.payload_sku_code
      order by (ps.id::text = coalesce(v_rec.payload_sku_id, '')) desc, ps.id::text
      limit 1;
      if v_sku_id is not null then
        v_status := 'auto';
        v_source := 'payload_sku';
        v_confidence := 1;
      end if;
    end if;

    -- 3. production-order name score. Size tokens must agree when both sides
    --    carry one, so a 50g name is never mapped to a 160g SKU.
    if v_sku_id is null then
      v_norm := coalesce(v_name_key, '');
      select coalesce(array_agg(distinct t order by t), '{}'::text[])
        into v_tokens
      from unnest(regexp_split_to_array(v_norm, '\s+')) t
      where t <> ''
        and t !~ '^[0-9]+([.,][0-9]+)?(kg|g|gr|gram|ml|l)$';

      select coalesce(array_agg(distinct m[1] || m[3] order by m[1] || m[3]), '{}'::text[])
        into v_sizes
      from regexp_matches(
        v_norm,
        '([0-9]+([.,][0-9]+)?)\s*(kg|g|gr|gram|ml|l)\y',
        'g'
      ) m;

      create temp table if not exists pg_temp.cogs_bf_score (
        sku_id uuid,
        sku_code text,
        name text,
        score numeric
      ) on commit drop;
      truncate table pg_temp.cogs_bf_score;

      insert into pg_temp.cogs_bf_score(sku_id, sku_code, name, score)
      select c.sku_id, c.sku_code, c.name,
             round(
               case
                 when cardinality(c.toks) = 0 then 0
                 when cardinality(c.sizes) > 0
                      and cardinality(v_sizes) > 0
                      and c.sizes <> v_sizes then 0
                 else (
                   select count(*)::numeric
                   from unnest(c.toks) tk
                   where tk = any(v_tokens)
                 ) / greatest(cardinality(c.toks), cardinality(v_tokens), 1)
               end,
               4
             )
      from pg_temp.cogs_bf_cand c
      where cardinality(c.toks) > 0;

      v_candidates := '[]'::jsonb;
      select coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'sku_id', sku_id,
                   'sku_code', sku_code,
                   'name', name,
                   'score', score
                 )
                 order by score desc, sku_code
               ),
               '[]'::jsonb
             )
        into v_candidates
      from (
        select distinct on (sku_id) sku_id, sku_code, name, score
        from pg_temp.cogs_bf_score
        order by sku_id, score desc, sku_code
      ) deduped;

      select sku_id, sku_code, name, score
        into v_best_sku, v_best_code, v_best_name, v_best
      from (
        select distinct on (sku_id) sku_id, sku_code, name, score
        from pg_temp.cogs_bf_score
        order by sku_id, score desc, sku_code
      ) deduped
      order by score desc, sku_code
      limit 1;

      select score into v_second
      from (
        select distinct on (sku_id) sku_id, sku_code, name, score
        from pg_temp.cogs_bf_score
        order by sku_id, score desc, sku_code
      ) deduped
      order by score desc, sku_code
      offset 1 limit 1;

      if v_best is not null and v_best >= 0.85
         and (v_second is null or v_best - v_second >= 0.15) then
        v_status := 'auto';
        v_source := 'production_name';
        v_confidence := round(v_best, 4);
        v_sku_id := v_best_sku;
        v_evidence := jsonb_build_object(
          'rule', 'production_name',
          'best', jsonb_build_object(
            'sku_id', v_best_sku,
            'sku_code', v_best_code,
            'name', v_best_name,
            'score', v_best
          ),
          'candidates', v_candidates
        );
      else
        v_status := 'suggested';
        v_source := 'production_name';
        v_confidence := case when v_best is null then null else round(v_best, 4) end;
        v_sku_id := null;
        v_evidence := jsonb_build_object(
          'rule', 'production_name',
          'candidates', v_candidates
        );
      end if;
    end if;

    if v_status is null then
      v_status := 'suggested';
      v_source := 'production_name';
      v_evidence := jsonb_build_object('rule', 'production_name', 'candidates', '[]'::jsonb);
    end if;

    if v_existing.id is null then
      insert into public.revenue_product_sku_map(
        channel, product_code, name_key, sku_id, units_per_revenue_unit,
        status, source, confidence, evidence
      ) values (
        v_rec.channel, v_rec.product_code, v_name_key, v_sku_id, 1,
        v_status, v_source, v_confidence, v_evidence
      );
    else
      update public.revenue_product_sku_map
      set sku_id = v_sku_id,
          status = v_status,
          source = v_source,
          confidence = v_confidence,
          evidence = v_evidence,
          updated_at = now()
      where id = v_existing.id
        and status not in ('confirmed', 'rejected');
    end if;
  end loop;

  -- -----------------------------------------------------------------------
  -- Ingredients used by mapped finished SKUs.
  -- -----------------------------------------------------------------------
  for v_rec in
    select distinct
           f.canonical_material_id,
           public.normalize_document_unit(f.unit) as recipe_unit
    from (
      select f.canonical_material_id, f.unit, v.sku_id
      from public.sku_cogs_version_formulations f
      join public.sku_cogs_versions v on v.id = f.version_id
      where f.canonical_material_id is not null
        and v.effective_from <= v_today
        and (v.effective_to is null or v.effective_to >= v_today - 120)
        and not exists (
          select 1
          from public.sku_cogs_version_formulations child
          where child.version_id = f.version_id
            and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
        )
      union all
      select f.canonical_material_id, f.unit, f.sku_id
      from public.sku_formulations f
      where f.canonical_material_id is not null
        and not exists (
          select 1
          from public.sku_formulations child
          where child.sku_id = f.sku_id
            and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
        )
    ) f
    where f.canonical_material_id is not null
      and public.normalize_document_unit(f.unit) is not null
      and exists (
        select 1
        from public.revenue_product_sku_map m
        where m.status in ('auto', 'confirmed')
          and m.sku_id = f.sku_id
      )
    order by 1, 2
  loop
    v_existing_ing := null;
    select * into v_existing_ing
    from public.cogs_ingredient_stock_map m
    where m.canonical_material_id = v_rec.canonical_material_id
      and m.recipe_unit = v_rec.recipe_unit
    limit 1;

    if found and v_existing_ing.status in ('confirmed', 'rejected') then
      continue;
    end if;

    v_item_id := null;
    v_item_name := null;
    v_item_unit := null;
    v_item_pastry := null;
    v_action := null;
    v_location := null;
    v_factor := null;
    v_status := 'suggested';
    v_source := 'kho_canonical';
    v_reason := null;
    v_evidence := '{}'::jsonb;

    -- 1. an active Q7 BOM decision that drops the line (not_tracked /
    --    bom_error) wins. A 'remap' decision rewrites the Q7 PXK mapping row,
    --    so step 2 already follows it.
    select * into v_decision
    from public.q7_bom_line_decisions d
    where d.active = true
      and d.action in ('not_tracked', 'bom_error')
      and d.canonical_material_id = v_rec.canonical_material_id
      and lower(btrim(d.source_unit)) = lower(btrim(v_rec.recipe_unit))
    order by d.created_at desc, d.id::text
    limit 1;

    if found then
      v_source := 'q7_bom_decision';
      v_action := 'not_tracked';
      v_status := 'auto';
      v_reason := v_decision.action;
      v_evidence := jsonb_build_object(
        'decision_id', v_decision.id,
        'decision_action', v_decision.action
      );
    else
      -- 2. the approved Q7 PXK mapping: the item and factor the material
      --    issue posts with today (generate_q7_production_material_issue
      --    multiplies the recipe qty by conversion_factor).
      v_q7map := null;
      select * into v_q7map
      from public.q7_material_issue_material_mappings m
      where m.approval_status = 'approved'
        and m.canonical_material_id = v_rec.canonical_material_id
        and lower(btrim(m.source_unit)) = lower(btrim(v_rec.recipe_unit))
      order by m.id::text
      limit 1;
    end if;

    if v_action is null and v_q7map.id is not null
       and v_q7map.kitchen_inventory_item_id is not null
       and coalesce(v_q7map.conversion_factor, 0) > 0 then
      v_source := 'q7_pxk_mapping';
      v_action := 'deduct';
      v_location := 'q7';
      v_item_id := v_q7map.kitchen_inventory_item_id;
      v_factor := v_q7map.conversion_factor;
      v_status := 'auto';
      v_evidence := jsonb_build_object(
        'q7_mapping_id', v_q7map.id,
        'kitchen_unit', v_q7map.kitchen_unit
      );
    elsif v_action is null then
      -- 3. the single active kho item linked to the material.
      select count(*) into v_count
      from public.kitchen_inventory_items kii
      where kii.canonical_material_id = v_rec.canonical_material_id
        and kii.active = true
        and kii.merged_into_id is null;

      if v_count = 1 then
        select kii.id, kii.name, kii.unit, kii.pastry_q7
          into v_item_id, v_item_name, v_item_unit, v_item_pastry
        from public.kitchen_inventory_items kii
        where kii.canonical_material_id = v_rec.canonical_material_id
          and kii.active = true
          and kii.merged_into_id is null
        order by kii.id::text
        limit 1;

        v_location := case when v_item_pastry then 'q7' else 'tan_tao' end;

        v_factor := public.stock_unit_line_factor(v_rec.recipe_unit, v_item_unit);
        if v_factor is null then
          select f.factor into v_factor
          from public.stock_item_unit_factors f
          where f.kitchen_inventory_item_id = v_item_id
            and lower(btrim(f.unit)) = lower(btrim(v_rec.recipe_unit))
          order by f.updated_at desc, f.id::text
          limit 1;
        end if;
        if v_factor is null then
          select c.factor into v_factor
          from public.material_unit_conversions c
          where c.material_id = v_rec.canonical_material_id
            and c.active = true
            and c.approved = true
            and c.effective_from <= v_today
            and (c.effective_to is null or v_today <= c.effective_to)
            and lower(btrim(c.from_unit)) = lower(btrim(v_rec.recipe_unit))
            and lower(btrim(c.to_unit)) = lower(btrim(v_item_unit))
          order by c.effective_from desc, c.id::text desc
          limit 1;
        end if;

        if v_location = 'q7' then
          select exists (
            select 1
            from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = v_item_id
          ) into v_has_movement;
        else
          select exists (
            select 1
            from public.tan_tao_material_movements m
            where m.kitchen_inventory_item_id = v_item_id
          ) into v_has_movement;
        end if;

        v_evidence := jsonb_build_object(
          'item_id', v_item_id,
          'item_name', v_item_name,
          'item_unit', v_item_unit,
          'has_movements', v_has_movement
        );

        if v_factor is not null and v_has_movement then
          v_action := 'deduct';
          v_status := 'auto';
          v_source := 'kho_canonical';
          v_reason := null;
        else
          v_action := case when v_factor is not null then 'deduct' else null end;
          v_status := 'suggested';
          v_source := 'kho_canonical';
          v_reason := case when v_factor is null then 'unit' else 'never_stocked' end;
        end if;
      elsif v_count = 0 then
        v_status := 'suggested';
        v_source := 'kho_canonical';
        v_reason := 'no_item';
        v_evidence := jsonb_build_object('items', '[]'::jsonb);
      else
        v_status := 'suggested';
        v_source := 'kho_canonical';
        v_reason := 'several_items';
        select coalesce(
                 jsonb_agg(jsonb_build_object(
                   'item_id', kii.id,
                   'name', kii.name,
                   'unit', kii.unit,
                   'pastry_q7', kii.pastry_q7
                 ) order by kii.name, kii.id::text),
                 '[]'::jsonb
               )
          into v_evidence
        from (
          select kii.*
          from public.kitchen_inventory_items kii
          where kii.canonical_material_id = v_rec.canonical_material_id
            and kii.active = true
            and kii.merged_into_id is null
          order by kii.name, kii.id::text
          limit 10
        ) kii;
        v_evidence := jsonb_build_object('items', v_evidence);
      end if;
    end if;

    if v_existing_ing.id is null then
      insert into public.cogs_ingredient_stock_map(
        canonical_material_id, recipe_unit, action, location,
        kitchen_inventory_item_id, factor, status, source, reason, evidence
      ) values (
        v_rec.canonical_material_id, v_rec.recipe_unit, v_action, v_location,
        v_item_id, v_factor, v_status, v_source, v_reason, v_evidence
      );
    else
      update public.cogs_ingredient_stock_map
      set action = v_action,
          location = v_location,
          kitchen_inventory_item_id = v_item_id,
          factor = v_factor,
          status = v_status,
          source = v_source,
          reason = v_reason,
          evidence = v_evidence,
          updated_at = now()
      where id = v_existing_ing.id
        and status not in ('confirmed', 'rejected');
    end if;
  end loop;

  return jsonb_build_object(
    'revenue_product',
    coalesce((
      select jsonb_object_agg(status, cnt)
      from (
        select status, count(*)::integer as cnt
        from public.revenue_product_sku_map
        group by status
      ) s
    ), '{}'::jsonb),
    'ingredient',
    coalesce((
      select jsonb_object_agg(status, cnt)
      from (
        select status, count(*)::integer as cnt
        from public.cogs_ingredient_stock_map
        group by status
      ) s
    ), '{}'::jsonb)
  );
end;
$$;

revoke all on function public.cogs_refresh_mappings() from public, anon;
grant execute on function public.cogs_refresh_mappings() to authenticated, service_role;

-- ===========================================================================
-- 4. cogs_explode_revenue — recipe expansion for one date window
-- ===========================================================================

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
      insert into pg_temp.cogs_bf_out(
        revenue_date, revenue_line_id, channel, product_code, product_name,
        revenue_qty, revenue_value, status, source_ref, raw_payload
      ) values (
        v_line.revenue_date, v_line.id, v_line.channel, v_line.product_code, v_line.product_name,
        v_line.quantity, v_line.gross_revenue, 'gap_product', v_line.source_ref, v_line.raw_payload
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

-- ===========================================================================
-- 5. Runner — trace refresh, shadow summary, delta posting
-- ===========================================================================

create or replace function public.run_cogs_backflush(
  p_from date,
  p_to date,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_refresh jsonb;
  v_lines_read integer := 0;
  v_coverage jsonb := '[]'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_gap_products integer := 0;
  v_gap_ingredients integer := 0;
  v_gap_recipes integer := 0;
  v_shadow jsonb := '{}'::jsonb;
  v_posted integer := 0;
  v_summary jsonb := '{}'::jsonb;
  v_setting record;
  v_cutover date;
  v_delta record;
  v_delta_qty numeric;
  v_unit text;
  v_row_count integer;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'invalid_window' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('cogs_backflush'));

  insert into public.cogs_backflush_runs(
    started_at, window_from, window_to, dry_run
  ) values (
    now(), p_from, p_to, coalesce(p_dry_run, true)
  ) returning id into v_run_id;

  begin
    v_refresh := public.cogs_refresh_mappings();

    delete from public.cogs_backflush_trace
    where revenue_date between p_from and p_to;

    insert into public.cogs_backflush_trace(
      run_id, revenue_date, revenue_line_id, channel, sku_id, version_id,
      formulation_id, depth, canonical_material_id, recipe_unit, recipe_qty,
      location, kitchen_inventory_item_id, stock_qty, factor_used, status
    )
    select v_run_id, e.revenue_date, e.revenue_line_id, e.channel, e.sku_id,
           e.version_id, e.formulation_id, coalesce(e.depth, 0), e.canonical_material_id,
           e.recipe_unit, e.recipe_qty, e.location, e.kitchen_inventory_item_id,
           e.stock_qty, e.factor_used, e.status
    from public.cogs_explode_revenue(p_from, p_to) e;

    select count(distinct t.revenue_line_id)::integer
      into v_lines_read
    from public.cogs_backflush_trace t
    where t.revenue_date between p_from and p_to;

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
                 from public.cogs_backflush_trace t
                 where t.revenue_line_id = l.id
                   and t.sku_id is not null
               )
             )::integer as mapped_lines,
             coalesce(sum(l.quantity) filter (
               where exists (
                 select 1
                 from public.cogs_backflush_trace t
                 where t.revenue_line_id = l.id
                   and t.sku_id is not null
               )
             ), 0) as mapped_qty,
             coalesce(sum(l.gross_revenue) filter (
               where exists (
                 select 1
                 from public.cogs_backflush_trace t
                 where t.revenue_line_id = l.id
                   and t.sku_id is not null
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

    select coalesce(jsonb_object_agg(status, cnt), '{}'::jsonb)
      into v_counts
    from (
      select t.status, count(*)::integer as cnt
      from public.cogs_backflush_trace t
      where t.revenue_date between p_from and p_to
      group by t.status
    ) s;

    -- Gaps are counted as things to fix, not trace rows: revenue lines with
    -- no product map, distinct ingredient+unit pairs, SKUs without a recipe.
    select count(distinct t.revenue_line_id) filter (where t.status = 'gap_product')::integer,
           count(distinct coalesce(t.canonical_material_id::text, 'f:' || coalesce(t.formulation_id::text, ''))
                          || '|' || coalesce(t.recipe_unit, ''))
             filter (where t.status in ('gap_ingredient', 'gap_material', 'gap_sub_recipe_unit'))::integer,
           count(distinct t.sku_id) filter (where t.status = 'gap_recipe')::integer
      into v_gap_products, v_gap_ingredients, v_gap_recipes
    from public.cogs_backflush_trace t
    where t.revenue_date between p_from and p_to;

    v_shadow := jsonb_build_object(
      'q7', coalesce((
        select round(sum(t.stock_qty), 6)
        from public.cogs_backflush_trace t
        where t.revenue_date between p_from and p_to
          and t.status = 'ok'
          and t.location = 'q7'
      ), 0),
      'tan_tao', coalesce((
        select round(sum(t.stock_qty), 6)
        from public.cogs_backflush_trace t
        where t.revenue_date between p_from and p_to
          and t.status = 'ok'
          and t.location = 'tan_tao'
      ), 0)
    );

    if not coalesce(p_dry_run, true) then
      for v_setting in
        select s.*
        from public.cogs_backflush_settings s
        where s.enabled = true
        order by s.location
      loop
        if v_setting.start_date is null then
          continue;
        end if;

        v_cutover := public.stock_ledger_cutover_date(v_setting.location);
        if v_cutover is null then
          continue;
        end if;

        if v_setting.location = 'q7' then
          for v_delta in
            with desired as (
              select t.revenue_date,
                     t.kitchen_inventory_item_id as item_id,
                     round(sum(t.stock_qty), 6) as desired_qty
              from public.cogs_backflush_trace t
              where t.revenue_date between p_from and p_to
                and t.status = 'ok'
                and t.location = 'q7'
                and t.kitchen_inventory_item_id is not null
                and t.revenue_date >= greatest(v_setting.start_date, v_cutover + 1)
              group by t.revenue_date, t.kitchen_inventory_item_id
            ),
            posted as (
              select m.movement_date,
                     m.kitchen_inventory_item_id as item_id,
                     round(sum(
                       case
                         when m.movement_type = 'production_usage' then m.quantity
                         when m.movement_type = 'adjustment' then -m.quantity
                         else 0
                       end
                     ), 6) as posted_qty
              from public.q7_inventory_movements m
              where m.movement_date between p_from and p_to
                and m.movement_date >= greatest(v_setting.start_date, v_cutover + 1)
                and m.source = 'revenue_cogs'
              group by m.movement_date, m.kitchen_inventory_item_id
            )
            select coalesce(d.revenue_date, p.movement_date) as movement_date,
                   coalesce(d.item_id, p.item_id) as item_id,
                   round(coalesce(d.desired_qty, 0) - coalesce(p.posted_qty, 0), 6) as delta
            from desired d
            full join posted p
              on p.movement_date = d.revenue_date
             and p.item_id = d.item_id
            where abs(coalesce(d.desired_qty, 0) - coalesce(p.posted_qty, 0)) >= 0.0000005
            order by 1, 2
          loop
            select kii.unit into v_unit
            from public.kitchen_inventory_items kii
            where kii.id = v_delta.item_id;

            if v_unit is null then
              continue;
            end if;

            v_delta_qty := v_delta.delta;
            if v_delta_qty > 0 then
              insert into public.q7_inventory_movements(
                kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
                source, source_ref_key, note, created_by
              ) values (
                v_delta.item_id, v_delta.movement_date, 'production_usage', v_delta_qty, v_unit,
                'revenue_cogs',
                'cogs:' || v_delta.movement_date::text || ':' || v_delta.item_id::text || ':' || v_run_id::text,
                'Trừ theo giá vốn — đơn doanh thu', auth.uid()
              );
            else
              insert into public.q7_inventory_movements(
                kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
                source, source_ref_key, note, created_by
              ) values (
                v_delta.item_id, v_delta.movement_date, 'adjustment', -v_delta_qty, v_unit,
                'revenue_cogs',
                'cogs:' || v_delta.movement_date::text || ':' || v_delta.item_id::text || ':' || v_run_id::text,
                'Trừ theo giá vốn — đơn doanh thu', auth.uid()
              );
            end if;
            get diagnostics v_row_count = row_count;
            v_posted := v_posted + v_row_count;
          end loop;
        elsif v_setting.location = 'tan_tao' then
          for v_delta in
            with desired as (
              select t.revenue_date,
                     t.kitchen_inventory_item_id as item_id,
                     round(sum(t.stock_qty), 6) as desired_qty
              from public.cogs_backflush_trace t
              where t.revenue_date between p_from and p_to
                and t.status = 'ok'
                and t.location = 'tan_tao'
                and t.kitchen_inventory_item_id is not null
                and t.revenue_date >= greatest(v_setting.start_date, v_cutover + 1)
              group by t.revenue_date, t.kitchen_inventory_item_id
            ),
            posted as (
              select m.movement_date,
                     m.kitchen_inventory_item_id as item_id,
                     round(sum(
                       case
                         when m.movement_type = 'production_usage' then m.quantity
                         when m.movement_type = 'adjustment' then -m.quantity
                         else 0
                       end
                     ), 6) as posted_qty
              from public.tan_tao_material_movements m
              where m.movement_date between p_from and p_to
                and m.movement_date >= greatest(v_setting.start_date, v_cutover + 1)
                and m.source = 'revenue_cogs'
              group by m.movement_date, m.kitchen_inventory_item_id
            )
            select coalesce(d.revenue_date, p.movement_date) as movement_date,
                   coalesce(d.item_id, p.item_id) as item_id,
                   round(coalesce(d.desired_qty, 0) - coalesce(p.posted_qty, 0), 6) as delta
            from desired d
            full join posted p
              on p.movement_date = d.revenue_date
             and p.item_id = d.item_id
            where abs(coalesce(d.desired_qty, 0) - coalesce(p.posted_qty, 0)) >= 0.0000005
            order by 1, 2
          loop
            select kii.unit into v_unit
            from public.kitchen_inventory_items kii
            where kii.id = v_delta.item_id;

            if v_unit is null then
              continue;
            end if;

            v_delta_qty := v_delta.delta;
            if v_delta_qty > 0 then
              insert into public.tan_tao_material_movements(
                kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
                source, source_ref_key, note, created_by
              ) values (
                v_delta.item_id, v_delta.movement_date, 'production_usage', v_delta_qty, v_unit,
                'revenue_cogs',
                'cogs:' || v_delta.movement_date::text || ':' || v_delta.item_id::text || ':' || v_run_id::text,
                'Trừ theo giá vốn — đơn doanh thu', auth.uid()
              );
            else
              insert into public.tan_tao_material_movements(
                kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
                source, source_ref_key, note, created_by
              ) values (
                v_delta.item_id, v_delta.movement_date, 'adjustment', -v_delta_qty, v_unit,
                'revenue_cogs',
                'cogs:' || v_delta.movement_date::text || ':' || v_delta.item_id::text || ':' || v_run_id::text,
                'Trừ theo giá vốn — đơn doanh thu', auth.uid()
              );
            end if;
            get diagnostics v_row_count = row_count;
            v_posted := v_posted + v_row_count;
          end loop;
        end if;
      end loop;
    end if;

    v_summary := jsonb_build_object(
      'lines_read', v_lines_read,
      'coverage', v_coverage,
      'statuses', v_counts,
      'gap_products', v_gap_products,
      'gap_ingredients', v_gap_ingredients,
      'gap_recipes', v_gap_recipes,
      'gaps', jsonb_build_object(
        'products', v_gap_products,
        'ingredients', v_gap_ingredients,
        'recipes', v_gap_recipes
      ),
      'shadow', v_shadow,
      'posted_rows', v_posted,
      'refresh', v_refresh
    );

    update public.cogs_backflush_runs
    set finished_at = now(),
        posted_rows = v_posted,
        summary = v_summary,
        error = null
    where id = v_run_id;

    return jsonb_build_object(
      'run_id', v_run_id,
      'window_from', p_from,
      'window_to', p_to,
      'dry_run', coalesce(p_dry_run, true),
      'posted_rows', v_posted,
      'summary', v_summary
    );
  exception when others then
    update public.cogs_backflush_runs
    set finished_at = now(),
        error = sqlerrm,
        summary = coalesce(v_summary, '{}'::jsonb)
    where id = v_run_id;
    raise;
  end;
end;
$$;

revoke all on function public.run_cogs_backflush(date, date, boolean) from public, anon, authenticated;
grant execute on function public.run_cogs_backflush(date, date, boolean) to service_role;

create or replace function public.run_cogs_backflush_scheduled()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  return public.run_cogs_backflush(v_today - 7, v_today + 14, false);
end;
$$;

revoke all on function public.run_cogs_backflush_scheduled() from public, anon, authenticated;
grant execute on function public.run_cogs_backflush_scheduled() to service_role;

create or replace function public.run_cogs_backflush_nightly()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  return public.run_cogs_backflush(v_today - 35, v_today + 14, false);
end;
$$;

revoke all on function public.run_cogs_backflush_nightly() from public, anon, authenticated;
grant execute on function public.run_cogs_backflush_nightly() to service_role;

-- ===========================================================================
-- 6. cogs_set_backflush — owner gate, replay-safe, gives back open Q7 PXK
-- ===========================================================================

create or replace function public.cogs_set_backflush(
  p_location text,
  p_enabled boolean,
  p_start_date date,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_setting public.cogs_backflush_settings%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_event public.cogs_mapping_events%rowtype;
  v_cutover date;
  v_issue_id uuid;
  v_result jsonb;
  v_reversed integer := 0;
  v_direct integer := 0;
begin
  if not (
    coalesce(auth.role(), '') = 'service_role'
    or (v_actor is not null and public.has_role(v_actor, 'owner'))
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('cogs_set_backflush:' || p_request_id::text));

  select * into v_event
  from public.cogs_mapping_events e
  where e.request_id = p_request_id;
  if found then
    if v_event.kind <> 'setting' then
      raise exception 'request_id_reused' using errcode = '22023';
    end if;
    return coalesce(v_event.after, '{}'::jsonb)
      || jsonb_build_object('status', 'replayed');
  end if;

  if p_location is null or p_location not in ('q7', 'tan_tao') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;
  if p_enabled is null then
    raise exception 'enabled_required' using errcode = '22023';
  end if;

  select * into v_setting
  from public.cogs_backflush_settings s
  where s.location = p_location
  for update;
  if not found then
    insert into public.cogs_backflush_settings(location, enabled)
    values (p_location, false)
    returning * into v_setting;
  end if;

  v_before := to_jsonb(v_setting);

  if p_enabled then
    if p_start_date is null then
      raise exception 'start_date_required' using errcode = '22023';
    end if;
    if p_start_date < v_today then
      raise exception 'start_date_before_today' using errcode = '22023';
    end if;

    v_cutover := public.stock_ledger_cutover_date(p_location);
    if v_cutover is null or p_start_date <= v_cutover then
      raise exception 'start_date_not_after_cutover' using errcode = '22023';
    end if;

    update public.cogs_backflush_settings
    set enabled = true,
        start_date = p_start_date,
        updated_by = v_actor,
        updated_at = now()
    where location = p_location
    returning * into v_setting;

    if p_location = 'q7' then
      -- Give back every PXK usage row dated on/after the start, dated on the
      -- usage's own day (not today): a future-dated usage is not in today's
      -- book yet, so a reversal dated today would inflate today's stock.
      -- Same row shape and key as reverse_material_issue_usage, so a later
      -- supersede/cancel of that issue finds the reversal and adds nothing.
      insert into public.q7_inventory_movements(
        kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
        source, source_ref_key, source_issue_id, source_issue_item_id,
        q7_mapping_id, canonical_material_id, note, created_by
      )
      select m.kitchen_inventory_item_id,
             m.movement_date,
             'adjustment',
             m.quantity,
             m.unit,
             'production_material_issue_reversal',
             'pmi-item-reverse:' || m.source_issue_item_id::text,
             m.source_issue_id,
             m.source_issue_item_id,
             m.q7_mapping_id,
             m.canonical_material_id,
             'Đảo phiếu xuất NVL — kho Q7 trừ theo giá vốn từ ' || to_char(p_start_date, 'DD/MM/YYYY'),
             auth.uid()
      from public.q7_inventory_movements m
      where m.source = 'production_material_issue'
        and m.movement_type = 'production_usage'
        and m.movement_date >= p_start_date
        and m.source_issue_id is not null
        and m.source_issue_item_id is not null
        and not exists (
          select 1
          from public.q7_inventory_movements r
          where r.source = 'production_material_issue_reversal'
            and r.source_ref_key = 'pmi-item-reverse:' || m.source_issue_item_id::text
        )
      on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
      get diagnostics v_direct = row_count;
      v_reversed := v_reversed + v_direct;
    end if;
  else
    update public.cogs_backflush_settings
    set enabled = false,
        updated_by = v_actor,
        updated_at = now()
    where location = p_location
    returning * into v_setting;
  end if;

  v_after := to_jsonb(v_setting);

  insert into public.cogs_mapping_events(
    kind, map_id, action, before, after, actor_id, request_id
  ) values (
    'setting', null,
    case when p_enabled then 'enabled' else 'disabled' end,
    v_before, v_after, v_actor, p_request_id
  );

  if p_enabled then
    return v_after || jsonb_build_object(
      'status', 'enabled',
      'given_back_rows', v_reversed
    );
  end if;

  return v_after || jsonb_build_object(
    'status', 'disabled',
    'warning', 'Đã tắt trừ kho theo giá vốn; các bút toán đã đăng vẫn giữ nguyên và PXK không tự đăng lại cho các ngày đó.'
  );
end;
$$;

revoke all on function public.cogs_set_backflush(text, boolean, date, uuid) from public, anon;
grant execute on function public.cogs_set_backflush(text, boolean, date, uuid) to authenticated, service_role;

-- ===========================================================================
-- 7. Decision RPCs — one append-only event per request
-- ===========================================================================

create or replace function public.cogs_decide_revenue_product(
  p_map_id uuid,
  p_sku_id uuid,
  p_units_per_revenue_unit numeric,
  p_reject boolean,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_map public.revenue_product_sku_map%rowtype;
  v_before jsonb;
  v_event public.cogs_mapping_events%rowtype;
  v_units numeric;
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
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('cogs_decide_revenue:' || p_request_id::text));

  select * into v_event
  from public.cogs_mapping_events e
  where e.request_id = p_request_id;
  if found then
    if v_event.kind <> 'revenue_product' then
      raise exception 'request_id_reused' using errcode = '22023';
    end if;
    return coalesce(v_event.after, '{}'::jsonb)
      || jsonb_build_object('status', 'replayed');
  end if;

  select * into v_map
  from public.revenue_product_sku_map m
  where m.id = p_map_id
  for update;
  if not found then
    raise exception 'map_not_found' using errcode = 'P0002';
  end if;

  v_before := to_jsonb(v_map);
  v_units := coalesce(p_units_per_revenue_unit, v_map.units_per_revenue_unit, 1);

  if coalesce(p_reject, false) then
    update public.revenue_product_sku_map
    set status = 'rejected',
        sku_id = null,
        source = 'manual',
        confidence = 1,
        units_per_revenue_unit = v_units,
        decided_by = v_actor,
        decided_at = now(),
        updated_at = now()
    where id = v_map.id
    returning * into v_map;
  else
    if p_sku_id is null then
      raise exception 'sku_required' using errcode = '22023';
    end if;
    if v_units is null
       or v_units <= 0
       or v_units::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'invalid_units_per_revenue_unit' using errcode = '22023';
    end if;
    if not exists (select 1 from public.product_skus ps where ps.id = p_sku_id) then
      raise exception 'sku_not_found' using errcode = 'P0002';
    end if;

    update public.revenue_product_sku_map
    set status = 'confirmed',
        sku_id = p_sku_id,
        source = 'manual',
        confidence = 1,
        units_per_revenue_unit = v_units,
        decided_by = v_actor,
        decided_at = now(),
        updated_at = now()
    where id = v_map.id
    returning * into v_map;
  end if;

  insert into public.cogs_mapping_events(
    kind, map_id, action, before, after, actor_id, request_id
  ) values (
    'revenue_product', v_map.id,
    case when coalesce(p_reject, false) then 'rejected' else 'confirmed' end,
    v_before, to_jsonb(v_map), v_actor, p_request_id
  );

  return to_jsonb(v_map);
end;
$$;

revoke all on function public.cogs_decide_revenue_product(uuid, uuid, numeric, boolean, uuid)
  from public, anon;
grant execute on function public.cogs_decide_revenue_product(uuid, uuid, numeric, boolean, uuid)
  to authenticated, service_role;

create or replace function public.cogs_decide_ingredient(
  p_canonical_material_id uuid,
  p_recipe_unit text,
  p_action text,
  p_location text,
  p_item_id uuid,
  p_factor numeric,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_unit text;
  v_map public.cogs_ingredient_stock_map%rowtype;
  v_before jsonb;
  v_event public.cogs_mapping_events%rowtype;
  v_item public.kitchen_inventory_items%rowtype;
  v_expected_location text;
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
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('cogs_decide_ingredient:' || p_request_id::text));

  select * into v_event
  from public.cogs_mapping_events e
  where e.request_id = p_request_id;
  if found then
    if v_event.kind <> 'ingredient' then
      raise exception 'request_id_reused' using errcode = '22023';
    end if;
    return coalesce(v_event.after, '{}'::jsonb)
      || jsonb_build_object('status', 'replayed');
  end if;

  if p_canonical_material_id is null then
    raise exception 'canonical_material_required' using errcode = '22023';
  end if;
  v_unit := public.normalize_document_unit(p_recipe_unit);
  if v_unit is null then
    raise exception 'recipe_unit_required' using errcode = '22023';
  end if;
  if p_action is null or p_action not in ('deduct', 'not_tracked', 'finished_goods_ledger') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.sku_cogs_materials m
    where m.id = p_canonical_material_id
  ) then
    raise exception 'canonical_material_not_found' using errcode = 'P0002';
  end if;

  if p_action = 'deduct' then
    if p_item_id is null then
      raise exception 'item_required' using errcode = '22023';
    end if;
    if p_factor is null
       or p_factor <= 0
       or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'factor_required' using errcode = '22023';
    end if;
    select * into v_item
    from public.kitchen_inventory_items kii
    where kii.id = p_item_id;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;
    if v_item.active is not true or v_item.merged_into_id is not null then
      raise exception 'item_not_active' using errcode = '22023';
    end if;
    v_expected_location := case when v_item.pastry_q7 then 'q7' else 'tan_tao' end;
    if p_location is distinct from v_expected_location then
      raise exception 'location_mismatch' using errcode = '22023';
    end if;
  end if;

  select * into v_map
  from public.cogs_ingredient_stock_map m
  where m.canonical_material_id = p_canonical_material_id
    and m.recipe_unit = v_unit
  for update;

  if found then
    v_before := to_jsonb(v_map);
    update public.cogs_ingredient_stock_map
    set action = p_action,
        location = case when p_action = 'deduct' then p_location else null end,
        kitchen_inventory_item_id = case when p_action = 'deduct' then p_item_id else null end,
        factor = case when p_action = 'deduct' then p_factor else null end,
        status = 'confirmed',
        source = 'manual',
        reason = null,
        decided_by = v_actor,
        decided_at = now(),
        updated_at = now()
    where id = v_map.id
    returning * into v_map;
  else
    v_before := null;
    insert into public.cogs_ingredient_stock_map(
      canonical_material_id, recipe_unit, action, location,
      kitchen_inventory_item_id, factor, status, source, reason,
      decided_by, decided_at
    ) values (
      p_canonical_material_id, v_unit, p_action,
      case when p_action = 'deduct' then p_location else null end,
      case when p_action = 'deduct' then p_item_id else null end,
      case when p_action = 'deduct' then p_factor else null end,
      'confirmed', 'manual', null, v_actor, now()
    ) returning * into v_map;
  end if;

  insert into public.cogs_mapping_events(
    kind, map_id, action, before, after, actor_id, request_id
  ) values (
    'ingredient', v_map.id, p_action, v_before, to_jsonb(v_map), v_actor, p_request_id
  );

  return to_jsonb(v_map);
end;
$$;

revoke all on function public.cogs_decide_ingredient(uuid, text, text, text, uuid, numeric, uuid)
  from public, anon;
grant execute on function public.cogs_decide_ingredient(uuid, text, text, text, uuid, numeric, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 8. Read RPCs for the Kho screen
-- ===========================================================================

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
           round(sum(t.recipe_qty) filter (where t.status = 'ok'), 6) as recipe_qty
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
           coalesce(m.evidence -> 'items', m.evidence -> 'candidates', '[]'::jsonb) as candidates
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
               'ref', coalesce(
                 nullif(l.source_ref, ''),
                 nullif(l.raw_payload ->> 'order_number', ''),
                 nullif(l.raw_payload ->> 'po_number', ''),
                 nullif(l.raw_payload ->> 'invoice_number', '')
               ),
               'version_id', t.version_id,
               'version_no', t.version_no,
               'version_no_text', t.version_no::text,
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


-- ===========================================================================
-- 9. post_material_issue_usage — same latest body, with a Q7 backflush stop
-- ===========================================================================

create or replace function public.post_material_issue_usage(p_issue_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_issue public.production_material_issues%rowtype;
  v_cutover date;
  v_row record;
  v_inserted integer := 0;
  v_row_count integer := 0;
  v_skipped integer := 0;
  v_excluded boolean := false;
begin
  select * into v_issue from public.production_material_issues where id = p_issue_id;
  if not found then
    return jsonb_build_object('status', 'issue_not_found');
  end if;
  if v_issue.location_code is distinct from 'q7' then
    return jsonb_build_object('status', 'unsupported_location');
  end if;
  if v_issue.is_current is not true then
    return jsonb_build_object('status', 'not_current');
  end if;
  if v_issue.status not in ('pdf_ready', 'posted') then
    return jsonb_build_object('status', 'not_postable');
  end if;

  if exists (
    select 1
    from public.cogs_backflush_settings s
    where s.location = 'q7'
      and s.enabled = true
      and s.start_date is not null
      and v_issue.issue_date >= s.start_date
  ) then
    return jsonb_build_object(
      'status', 'cogs_backflush_enabled',
      'issue_id', p_issue_id,
      'movement_count', 0,
      'skipped_count', 0
    );
  end if;

  if exists (
    select 1
    from public.production_orders po
    where po.id = v_issue.production_order_id
      and po.status::text = 'cancelled'
  ) then
    return jsonb_build_object(
      'status', 'order_cancelled',
      'issue_id', p_issue_id,
      'movement_count', 0,
      'skipped_count', 0
    );
  end if;

  v_cutover := public.stock_ledger_cutover_date('q7');
  -- The count date itself is the truth: issue_date = cutover is NOT posted.
  if v_cutover is null or v_issue.issue_date <= v_cutover then
    return jsonb_build_object(
      'status', 'before_cutover',
      'issue_id', p_issue_id,
      'movement_count', 0,
      'skipped_count', 0
    );
  end if;

  for v_row in
    select i.id as item_id,
           i.kitchen_inventory_item_id,
           i.unit,
           i.required_qty,
           i.q7_mapping_id,
           i.canonical_material_id,
           i.source_unit,
           kii.item_class
    from public.production_material_issue_items i
    left join public.kitchen_inventory_items kii on kii.id = i.kitchen_inventory_item_id
    where i.material_issue_id = p_issue_id
      and i.kitchen_inventory_item_id is not null
      and coalesce(i.required_qty, 0) > 0
      and i.required_qty::text not in ('NaN', 'Infinity', '-Infinity')
      and exists (
        select 1
        from public.q7_material_issue_material_mappings m
        where m.approval_status = 'approved'
          and (
            m.id = i.q7_mapping_id
            or (
              i.q7_mapping_id is null
              and i.canonical_material_id is not null
              and m.canonical_material_id = i.canonical_material_id
            )
          )
      )
  loop
    select exists (
      select 1
      from public.q7_bom_line_decisions d
      where d.active = true
        and d.action in ('not_tracked', 'bom_error')
        and d.canonical_material_id = v_row.canonical_material_id
        and lower(btrim(d.source_unit)) = lower(btrim(coalesce(v_row.source_unit, '')))
    ) into v_excluded;

    if v_excluded or coalesce(v_row.item_class, '') = 'non_stock' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Write the issue item's own canonical_material_id / q7_mapping_id instead
    -- of calling resolve_q7_canonical_inventory_item(). A resolved remap can
    -- leave the target kitchen item linked to another material or holding its
    -- own approved mapping; the resolver would then refuse the pair with
    -- q7_mapping_identity_mismatch. The approved mapping row for this BOM line
    -- is the authority for where this material's usage goes, so post it
    -- directly with the ids carried by the issue item.
    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, source_issue_id, source_issue_item_id,
      q7_mapping_id, canonical_material_id, note, created_by
    ) values (
      v_row.kitchen_inventory_item_id, v_issue.issue_date, 'production_usage', v_row.required_qty,
      v_row.unit, 'production_material_issue', 'pmi-item:' || v_row.item_id::text,
      v_issue.id, v_row.item_id, v_row.q7_mapping_id, v_row.canonical_material_id,
      'Xuất NVL cho sản xuất ' || v_issue.issue_number, auth.uid()
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
    get diagnostics v_row_count = row_count;
    v_inserted := v_inserted + v_row_count;
  end loop;

  return jsonb_build_object(
    'status', 'posted',
    'issue_id', p_issue_id,
    'movement_count', v_inserted,
    'skipped_count', v_skipped
  );
end;
$$;

revoke all on function public.post_material_issue_usage(uuid) from public, anon, authenticated;
grant execute on function public.post_material_issue_usage(uuid) to service_role;


-- ===========================================================================
-- 10. kho_get_commitments — same reader, revenue_cogs refs + cogs gap counts
-- ===========================================================================

create or replace function public.kho_get_commitments()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_as_of date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_cutover date;
  v_tt_snapshot jsonb := '{}'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_skus jsonb := '[]'::jsonb;
  v_gaps jsonb := '{}'::jsonb;
begin
  -- The exact kho_get_items() reader gate.
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

  v_cutover := public.stock_ledger_cutover_date('q7');
  v_tt_snapshot := public.get_tan_tao_warehouse_snapshot();

  -- -------------------------------------------------------------------------
  -- 1. Ingredient commitments: future-dated production usage, per item/location
  -- -------------------------------------------------------------------------
  with usage as (
    -- PXK (and other) usage still standing: a PXK row given back by its
    -- 'pmi-item-reverse:' reversal (supersede, cancel, or the switch to
    -- revenue-COGS deduction) no longer holds stock.
    select m.kitchen_inventory_item_id as item_id,
           'q7'::text as location,
           m.movement_date,
           abs(m.quantity) as qty,
           m.source,
           m.source_ref_key,
           m.created_at,
           m.id
    from public.q7_inventory_movements m
    where m.movement_type = 'production_usage'
      and m.movement_date > v_as_of
      and m.source <> 'revenue_cogs'
      and not (
        m.source = 'production_material_issue'
        and m.source_issue_item_id is not null
        and exists (
          select 1
          from public.q7_inventory_movements r
          where r.source = 'production_material_issue_reversal'
            and r.source_ref_key = 'pmi-item-reverse:' || m.source_issue_item_id::text
        )
      )
    union all
    select m.kitchen_inventory_item_id,
           'tan_tao'::text,
           m.movement_date,
           abs(m.quantity),
           m.source,
           m.source_ref_key,
           m.created_at,
           m.id
    from public.tan_tao_material_movements m
    where m.movement_type = 'production_usage'
      and m.movement_date > v_as_of
      and m.source <> 'revenue_cogs'
    union all
    -- Revenue-COGS deduction: net per item and day (usage minus the
    -- correcting adjustments), one hold row per order day.
    select c.item_id, c.location, c.movement_date, c.qty, 'revenue_cogs'::text,
           null::text, c.created_at, null::uuid
    from (
      select m.kitchen_inventory_item_id as item_id,
             'q7'::text as location,
             m.movement_date,
             sum(case when m.movement_type = 'production_usage' then m.quantity
                      when m.movement_type = 'adjustment' then -m.quantity
                      else 0 end) as qty,
             min(m.created_at) as created_at
      from public.q7_inventory_movements m
      where m.source = 'revenue_cogs'
        and m.movement_date > v_as_of
      group by m.kitchen_inventory_item_id, m.movement_date
      union all
      select m.kitchen_inventory_item_id,
             'tan_tao'::text,
             m.movement_date,
             sum(case when m.movement_type = 'production_usage' then m.quantity
                      when m.movement_type = 'adjustment' then -m.quantity
                      else 0 end),
             min(m.created_at)
      from public.tan_tao_material_movements m
      where m.source = 'revenue_cogs'
        and m.movement_date > v_as_of
      group by m.kitchen_inventory_item_id, m.movement_date
    ) c
    where c.qty > 0.0000005
  ),
  usage_src as (
    select u.*,
           pmi.issue_number
    from usage u
    left join public.production_material_issue_items pmii
      on u.source_ref_key like 'pmi-item:%'
     and pmii.id::text = substr(u.source_ref_key, 10)
    left join public.production_material_issues pmi
      on pmi.id = pmii.material_issue_id
  ),
  item_group as (
    select item_id,
           location,
           sum(qty) as committed_qty,
           min(movement_date) as next_date
    from usage_src
    group by item_id, location
  ),
  item_sources as (
    select item_id,
           location,
           jsonb_agg(jsonb_build_object(
             'kind', 'pxk',
             'ref', case
                      when source = 'revenue_cogs'
                        then 'Đơn ' || to_char(movement_date, 'DD/MM')
                      else coalesce(issue_number, source)
                    end,
             'date', movement_date,
             'qty', qty
           ) order by movement_date, created_at, id) as sources
    from (
      select s.*,
             row_number() over (
               partition by item_id, location
               order by movement_date, created_at, id
             ) as rn
      from usage_src s
    ) ranked
    where rn <= 5
    group by item_id, location
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'kitchen_inventory_item_id', g.item_id,
           'location', g.location,
           'committed_qty', g.committed_qty,
           'unit', kii.unit,
           'next_date', g.next_date,
           'sources', s.sources
         ) order by kii.name, g.location), '[]'::jsonb)
  into v_items
  from item_group g
  join public.kitchen_inventory_items kii on kii.id = g.item_id
  join item_sources s
    on s.item_id = g.item_id
   and s.location = g.location;

  -- -------------------------------------------------------------------------
  -- 2. Finished-goods commitments per location
  -- -------------------------------------------------------------------------
  -- A delivered order keeps status 'reserved'; its posted dispatch document
  -- (source_document_id = the order) is what says it left the warehouse.
  -- Orders dated on/before the SKU cutover were settled by the count and are
  -- not commitments.
  with tt_docs as (
    select d.sku_id,
           public.tan_tao_auto_ledger_business_date(d.id) as business_date,
           d.quantity
    from public.tan_tao_warehouse_documents d
    where d.document_type = 'outbound_order'
      and d.status = 'reserved'
      and not exists (
        select 1
        from public.tan_tao_warehouse_documents x
        where x.source_document_id = d.id
          and x.document_type = 'dispatch'
          and x.status = 'posted'
      )
      and public.tan_tao_auto_ledger_business_date(d.id)
          > coalesce(public.tan_tao_auto_ledger_cutover(d.sku_id), '-infinity'::date)
  ),
  tt_group as (
    select sku_id,
           coalesce(sum(quantity) filter (where business_date >= v_as_of), 0) as committed_qty,
           coalesce(sum(quantity) filter (where business_date < v_as_of), 0) as overdue_qty,
           count(*)::integer as orders,
           min(business_date) filter (where business_date >= v_as_of) as next_date
    from tt_docs
    group by sku_id
  ),
  -- Bánh mì que is bought per order: the supplier orders still expected for
  -- today or later are the incoming side of the same deliveries.
  tt_in as (
    select d.sku_id,
           sum(greatest(d.quantity - coalesce((
             select sum(rd.quantity)
             from public.tan_tao_warehouse_documents rd
             where rd.source_document_id = d.id
               and rd.document_type = 'receipt'
               and rd.status = 'posted'
           ), 0), 0)) as incoming_qty
    from public.tan_tao_warehouse_documents d
    where d.document_type = 'supplier_order'
      and d.status = 'expected'
      and coalesce(public.tan_tao_auto_ledger_business_date(d.id), v_as_of) >= v_as_of
    group by d.sku_id
  ),
  tt_snap as (
    select (it ->> 'sku_id')::uuid as sku_id,
           max((it ->> 'on_hand_quantity')::numeric) as on_hand
    from jsonb_array_elements(coalesce(v_tt_snapshot -> 'items', '[]'::jsonb)) it
    where nullif(it ->> 'sku_id', '') is not null
    group by 1
  ),
  tt_skus as (
    select jsonb_build_object(
             'location', 'tan_tao',
             'sku_id', ps.id,
             'sku_code', ps.sku_code,
             'name', ps.product_name,
             'unit', ps.unit,
             'on_hand', coalesce(s.on_hand, 0),
             'incoming_qty', coalesce(i.incoming_qty, 0),
             'committed_qty', g.committed_qty,
             'overdue_qty', g.overdue_qty,
             'available', coalesce(s.on_hand, 0) + coalesce(i.incoming_qty, 0) - g.committed_qty - g.overdue_qty,
             'orders', g.orders,
             'next_date', g.next_date
           ) as sku_row
    from tt_group g
    join public.product_skus ps on ps.id = g.sku_id
    left join tt_snap s on s.sku_id = g.sku_id
    left join tt_in i on i.sku_id = g.sku_id
  ),
  q7_group as (
    select poi.sku_id,
           sum(poi.ordered_qty) as committed_qty,
           -- Q7 bakes to order: the same lines are produced on their day
           -- (actual when recorded, else planned), as run_q7_fg_daily_ledger receives them.
           sum(coalesce(nullif(poi.actual_qty, 0), poi.planned_qty, poi.ordered_qty)) as incoming_qty,
           count(distinct po.id)::integer as orders,
           min(po.planned_start_date) as next_date
    from public.production_order_items poi
    join public.production_orders po on po.id = poi.production_order_id
    where po.location_code = 'q7'
      and po.status::text <> 'cancelled'
      and po.planned_start_date > v_as_of
      and poi.sku_id is not null
      and not exists (
        select 1
        from public.q7_finished_goods_movements m
        where m.movement_type in ('dispatch', 'write_off')
          and (
            m.production_order_item_id = poi.id
            or m.request_id = public.q7_fg_auto_request_id('q7-fg-dispatch:', poi.id)
          )
      )
    group by poi.sku_id
  ),
  q7_balance as (
    select m.sku_id,
           sum(m.quantity) as on_hand
    from public.q7_finished_goods_movements m
    group by m.sku_id
  ),
  q7_skus as (
    select jsonb_build_object(
             'location', 'q7',
             'sku_id', ps.id,
             'sku_code', ps.sku_code,
             'name', ps.product_name,
             'unit', ps.unit,
             'on_hand', coalesce(b.on_hand, 0),
             'incoming_qty', g.incoming_qty,
             'committed_qty', g.committed_qty,
             'overdue_qty', 0,
             'available', coalesce(b.on_hand, 0) + g.incoming_qty - g.committed_qty,
             'orders', g.orders,
             'next_date', g.next_date
           ) as sku_row
    from q7_group g
    join public.product_skus ps on ps.id = g.sku_id
    left join q7_balance b on b.sku_id = g.sku_id
  )
  select coalesce(jsonb_agg(
           sku_row
           order by sku_row ->> 'location', sku_row ->> 'sku_code'
         ), '[]'::jsonb)
  into v_skus
  from (
    select sku_row from tt_skus
    union all
    select sku_row from q7_skus
  ) all_skus;

  -- -------------------------------------------------------------------------
  -- 3. PXK lines still without their pmi-item movement
  -- -------------------------------------------------------------------------
  with gap_lines as (
    select pmii.id,
           pmi.issue_number
    from public.production_material_issue_items pmii
    join public.production_material_issues pmi
      on pmi.id = pmii.material_issue_id
    where pmi.status not in ('cancelled', 'superseded')
      and pmi.issue_date > v_cutover
      and not exists (
        select 1
        from public.q7_inventory_movements m
        where m.source_ref_key = 'pmi-item:' || pmii.id::text
      )
      -- When Q7 backflush is enabled, PXK lines from its start date are
      -- intentionally not posted, so they are not a gap.
      and not exists (
        select 1
        from public.cogs_backflush_settings s
        where s.location = 'q7'
          and s.enabled = true
          and s.start_date is not null
          and pmi.issue_date >= s.start_date
      )
  )
  select jsonb_build_object(
           'pxk_lines_unposted', count(*)::integer,
           'pxk_unposted_issues', coalesce((
             select jsonb_agg(x.issue_number order by x.issue_number)
             from (
               select distinct issue_number
               from gap_lines
               order by issue_number
               limit 10
             ) x
           ), '[]'::jsonb)
         )
  into v_gaps
  from gap_lines;

  v_gaps := v_gaps || jsonb_build_object(
    'cogs', jsonb_build_object(
      'enabled_locations', coalesce((
        select jsonb_agg(s.location order by s.location)
        from public.cogs_backflush_settings s
        where s.enabled = true
      ), '[]'::jsonb),
      'gap_products', coalesce((
        select (r.summary ->> 'gap_products')::integer
        from public.cogs_backflush_runs r
        order by r.started_at desc, r.id desc
        limit 1
      ), 0),
      'gap_ingredients', coalesce((
        select (r.summary ->> 'gap_ingredients')::integer
        from public.cogs_backflush_runs r
        order by r.started_at desc, r.id desc
        limit 1
      ), 0)
    )
  );

  return jsonb_build_object(
    'as_of', v_as_of,
    'items', v_items,
    'skus', v_skus,
    'gaps', v_gaps
  );
end;
$$;

revoke all on function public.kho_get_commitments() from public, anon;
grant execute on function public.kho_get_commitments() to authenticated, service_role;

-- ===========================================================================
-- 11. Schedules — hourly shadow refresh, nightly wider refresh
-- ===========================================================================

do $$
declare
  job_name text;
begin
  for job_name in
    select j.jobname
    from cron.job j
    where j.jobname in ('cogs-backflush-hourly', 'cogs-backflush-nightly')
  loop
    perform cron.unschedule(job_name);
  end loop;

  perform cron.schedule(
    'cogs-backflush-hourly',
    '15 * * * *',
    'select public.run_cogs_backflush_scheduled();'
  );
  perform cron.schedule(
    'cogs-backflush-nightly',
    '45 22 * * *',
    'select public.run_cogs_backflush_nightly();'
  );
end;
$$;
