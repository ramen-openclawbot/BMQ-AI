-- Trừ kho tự động + cảnh báo, tự học hao hụt từ kiểm kê, đọc số theo ngày.
--
-- 1. run_cogs_backflush no longer creates, approves or clears holds.  A
--    rejected hold still blocks its day; every other positive delta posts,
--    except a day whose (kho, item) has a fresh 'unit' warning.
-- 2. cogs_backflush_warnings records per run window: 'usual' (day desired >
--    5 x the 30-day median with >= 5 reference days, posted), 'unit' (a
--    g/ml item whose day desired / finished units > 500, not posted) and
--    'shrink' (learned loss beyond +/-15%, informational).
-- 3. cogs_learn_usage_factors() learns shrinkage from stock counts into
--    cogs_usage_factors with source 'learned', which cogs_explode_revenue
--    already applies by effective_from.  It never writes a ledger row.
-- 4. run_cogs_backflush_nightly() learns before it backflushes.
-- 5. kho_revenue_day(p_day) is the read-only, gated day payload for the
--    inventory page, matching src/data/tru-kho-demo-20261028.ts.
--
-- All objects are created here only; the Maestro applies this migration.

-- ===========================================================================
-- A. Warnings
-- ===========================================================================

create table if not exists public.cogs_backflush_warnings (
  id uuid primary key default gen_random_uuid(),
  location text not null check (location in ('q7', 'tan_tao')),
  kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id),
  movement_date date,
  kind text not null check (kind in ('usual', 'unit', 'shrink')),
  desired_qty numeric(15, 3),
  reference_qty numeric(15, 3),
  reference_days integer,
  finished_units numeric,
  per_unit numeric,
  shrink_rate numeric,
  evidence jsonb default '{}'::jsonb,
  run_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists cogs_backflush_warnings_key_uidx
  on public.cogs_backflush_warnings(
    location,
    kitchen_inventory_item_id,
    coalesce(movement_date, '1900-01-01'),
    kind
  );

alter table public.cogs_backflush_warnings enable row level security;
revoke all on table public.cogs_backflush_warnings from public, anon, authenticated;

-- ===========================================================================
-- B. run_cogs_backflush
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
  v_warned integer := 0;
  v_blocked integer := 0;
  v_rejected_skip integer := 0;
  v_summary jsonb := '{}'::jsonb;
  v_setting record;
  v_cutover date;
  v_delta record;
  v_delta_qty numeric;
  v_unit text;
  v_row_count integer;
  v_hold public.cogs_backflush_holds%rowtype;
  v_hold_found boolean;
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

      -- Warnings are observations for the page: a day far above the item's
      -- usual usage ('usual') and a weighed/measured item that would deduct
      -- absurdly many g/ml per finished item ('unit').  A unit warning also
      -- blocks that day's posting in the loops below.
      delete from public.cogs_backflush_warnings w
      where w.kind in ('usual', 'unit')
        and w.movement_date between p_from and p_to;

      with settings as (
        select s.location,
               s.start_date,
               public.stock_ledger_cutover_date(s.location) as cutover
        from public.cogs_backflush_settings s
        where s.enabled = true
          and s.start_date is not null
      ),
      candidate as (
        select t.location,
               t.kitchen_inventory_item_id as item_id,
               t.revenue_date,
               t.revenue_line_id,
               t.stock_qty
        from public.cogs_backflush_trace t
        join settings s on s.location = t.location
        where t.revenue_date between p_from and p_to
          and t.status = 'ok'
          and t.location is not null
          and t.kitchen_inventory_item_id is not null
          and s.cutover is not null
          and t.revenue_date >= greatest(s.start_date, s.cutover + 1)
          and (
            public.cogs_backflush_item_frozen_through(t.location, t.kitchen_inventory_item_id) is null
            or t.revenue_date > public.cogs_backflush_item_frozen_through(t.location, t.kitchen_inventory_item_id)
          )
      ),
      day_totals as (
        select c.location,
               c.item_id,
               c.revenue_date,
               round(sum(c.stock_qty), 3) as desired_qty
        from candidate c
        group by c.location, c.item_id, c.revenue_date
      ),
      line_totals as (
        select distinct c.location, c.item_id, c.revenue_date, c.revenue_line_id
        from candidate c
      ),
      finished as (
        select l.location,
               l.item_id,
               l.revenue_date,
               sum(r.quantity) as finished_units
        from line_totals l
        join public.revenue_ledger_lines r on r.id = l.revenue_line_id
        group by l.location, l.item_id, l.revenue_date
      ),
      unit_warnings as (
        select d.location,
               d.item_id,
               d.revenue_date,
               d.desired_qty,
               f.finished_units,
               round(d.desired_qty / f.finished_units, 3) as per_unit
        from day_totals d
        join finished f
          on f.location = d.location
         and f.item_id = d.item_id
         and f.revenue_date = d.revenue_date
        join public.kitchen_inventory_items kii on kii.id = d.item_id
        where lower(btrim(kii.unit)) in ('g', 'ml')
          and f.finished_units > 0
          and d.desired_qty / f.finished_units > 500
      ),
      usual_warnings as (
        select d.location,
               d.item_id,
               d.revenue_date,
               d.desired_qty,
               r.reference_qty,
               r.reference_days
        from day_totals d
        cross join lateral public.cogs_backflush_usage_reference(
          d.location, d.item_id, d.revenue_date
        ) r
        where r.reference_days >= 5
          and d.desired_qty > 5 * r.reference_qty
      ),
      fresh as (
        select u.location,
               u.item_id,
               u.revenue_date,
               'unit'::text as kind,
               u.desired_qty,
               null::numeric as reference_qty,
               null::integer as reference_days,
               u.finished_units,
               u.per_unit,
               null::numeric as shrink_rate
        from unit_warnings u
        union all
        select w.location,
               w.item_id,
               w.revenue_date,
               'usual'::text,
               w.desired_qty,
               w.reference_qty,
               w.reference_days,
               null::numeric,
               null::numeric,
               null::numeric
        from usual_warnings w
      )
      insert into public.cogs_backflush_warnings(
        location, kitchen_inventory_item_id, movement_date, kind,
        desired_qty, reference_qty, reference_days, finished_units, per_unit,
        shrink_rate, evidence, run_id
      )
      select f.location,
             f.item_id,
             f.revenue_date,
             f.kind,
             f.desired_qty,
             f.reference_qty,
             f.reference_days,
             f.finished_units,
             f.per_unit,
             f.shrink_rate,
             '{}'::jsonb,
             v_run_id
      from fresh f;
      get diagnostics v_warned = row_count;
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
                     round(sum(t.stock_qty), 3) as desired_qty
              from public.cogs_backflush_trace t
              where t.revenue_date between p_from and p_to
                and t.status = 'ok'
                and t.location = 'q7'
                and t.kitchen_inventory_item_id is not null
                and t.revenue_date >= greatest(v_setting.start_date, v_cutover + 1)
                and (
                  public.cogs_backflush_item_frozen_through('q7', t.kitchen_inventory_item_id) is null
                  or t.revenue_date > public.cogs_backflush_item_frozen_through('q7', t.kitchen_inventory_item_id)
                )
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
                     ), 3) as posted_qty
              from public.q7_inventory_movements m
              where m.movement_date between p_from and p_to
                and m.movement_date >= greatest(v_setting.start_date, v_cutover + 1)
                and m.source = 'revenue_cogs'
                and (
                  public.cogs_backflush_item_frozen_through('q7', m.kitchen_inventory_item_id) is null
                  or m.movement_date > public.cogs_backflush_item_frozen_through('q7', m.kitchen_inventory_item_id)
                )
              group by m.movement_date, m.kitchen_inventory_item_id
            )
            select coalesce(d.revenue_date, p.movement_date) as movement_date,
                   coalesce(d.item_id, p.item_id) as item_id,
                   round(coalesce(d.desired_qty, 0) - coalesce(p.posted_qty, 0), 6) as delta,
                   coalesce(d.desired_qty, 0) as desired_qty
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

            v_delta_qty := public.cogs_backflush_ledger_qty(v_delta.delta);
            if v_delta_qty is null then
              continue;
            end if;
            if v_delta_qty > 0 then
              select * into v_hold
              from public.cogs_backflush_holds h
              where h.location = v_setting.location
                and h.kitchen_inventory_item_id = v_delta.item_id
                and h.movement_date = v_delta.movement_date;
              v_hold_found := found;

              if v_hold_found and v_hold.status = 'rejected' then
                v_rejected_skip := v_rejected_skip + 1;
                continue;
              end if;

              if exists (
                select 1
                from public.cogs_backflush_warnings w
                where w.location = v_setting.location
                  and w.kitchen_inventory_item_id = v_delta.item_id
                  and w.movement_date = v_delta.movement_date
                  and w.kind = 'unit'
              ) then
                v_blocked := v_blocked + 1;
                continue;
              end if;
            end if;
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
                     round(sum(t.stock_qty), 3) as desired_qty
              from public.cogs_backflush_trace t
              where t.revenue_date between p_from and p_to
                and t.status = 'ok'
                and t.location = 'tan_tao'
                and t.kitchen_inventory_item_id is not null
                and t.revenue_date >= greatest(v_setting.start_date, v_cutover + 1)
                and (
                  public.cogs_backflush_item_frozen_through('tan_tao', t.kitchen_inventory_item_id) is null
                  or t.revenue_date > public.cogs_backflush_item_frozen_through('tan_tao', t.kitchen_inventory_item_id)
                )
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
                     ), 3) as posted_qty
              from public.tan_tao_material_movements m
              where m.movement_date between p_from and p_to
                and m.movement_date >= greatest(v_setting.start_date, v_cutover + 1)
                and m.source = 'revenue_cogs'
                and (
                  public.cogs_backflush_item_frozen_through('tan_tao', m.kitchen_inventory_item_id) is null
                  or m.movement_date > public.cogs_backflush_item_frozen_through('tan_tao', m.kitchen_inventory_item_id)
                )
              group by m.movement_date, m.kitchen_inventory_item_id
            )
            select coalesce(d.revenue_date, p.movement_date) as movement_date,
                   coalesce(d.item_id, p.item_id) as item_id,
                   round(coalesce(d.desired_qty, 0) - coalesce(p.posted_qty, 0), 6) as delta,
                   coalesce(d.desired_qty, 0) as desired_qty
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

            v_delta_qty := public.cogs_backflush_ledger_qty(v_delta.delta);
            if v_delta_qty is null then
              continue;
            end if;
            if v_delta_qty > 0 then
              select * into v_hold
              from public.cogs_backflush_holds h
              where h.location = v_setting.location
                and h.kitchen_inventory_item_id = v_delta.item_id
                and h.movement_date = v_delta.movement_date;
              v_hold_found := found;

              if v_hold_found and v_hold.status = 'rejected' then
                v_rejected_skip := v_rejected_skip + 1;
                continue;
              end if;

              if exists (
                select 1
                from public.cogs_backflush_warnings w
                where w.location = v_setting.location
                  and w.kitchen_inventory_item_id = v_delta.item_id
                  and w.movement_date = v_delta.movement_date
                  and w.kind = 'unit'
              ) then
                v_blocked := v_blocked + 1;
                continue;
              end if;
            end if;
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
      'warned_rows', v_warned,
      'rejected_skip_rows', v_rejected_skip,
      'blocked_rows', v_blocked,
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
      'warned_rows', v_warned,
      'rejected_skip_rows', v_rejected_skip,
      'blocked_rows', v_blocked,
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

-- ===========================================================================
-- C. Learn shrinkage from stock counts
-- ===========================================================================

create or replace function public.cogs_learn_usage_factors()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_learned integer := 0;
  v_skipped integer := 0;
  v_warned integer := 0;
  v_row record;
  v_base numeric;
  v_factor numeric;
  v_written integer;
begin
  for v_row in
    with counts as (
      select 'q7'::text as location,
             m.kitchen_inventory_item_id as item_id,
             m.movement_date as count_date,
             sum(m.quantity) as adj,
             max(m.created_at) as at
      from public.q7_inventory_movements m
      where m.movement_type = 'adjustment'
        and m.source_ref_key like 'q7-stock-count:%'
      group by 1, 2, 3
      union all
      select 'tan_tao',
             m.kitchen_inventory_item_id,
             m.movement_date,
             sum(m.quantity),
             max(m.created_at)
      from public.tan_tao_material_movements m
      where m.movement_type = 'adjustment'
        and m.source_ref_key like 'tt-material-count:%'
      group by 1, 2, 3
    ),
    paired as (
      select c.*,
             lag(c.count_date) over (
               partition by c.location, c.item_id order by c.count_date
             ) as prev_date
      from counts c
    ),
    periods as (
      select p.location,
             p.item_id,
             p.prev_date,
             p.count_date,
             p.adj,
             case p.location
               when 'q7' then (
                 select coalesce(sum(
                   case
                     when m.movement_type = 'production_usage' then m.quantity
                     when m.movement_type = 'adjustment'
                      and m.source in ('revenue_cogs', 'production_material_issue_reversal')
                       then -m.quantity
                     else 0
                   end
                 ), 0)
                 from public.q7_inventory_movements m
                 where m.kitchen_inventory_item_id = p.item_id
                   and m.movement_date > p.prev_date
                   and m.movement_date <= p.count_date
                   and m.created_at < p.at
               )
               when 'tan_tao' then (
                 select coalesce(sum(
                   case
                     when m.movement_type = 'production_usage' then m.quantity
                     when m.movement_type = 'adjustment'
                      and m.source in ('revenue_cogs', 'production_material_issue_reversal')
                       then -m.quantity
                     else 0
                   end
                 ), 0)
                 from public.tan_tao_material_movements m
                 where m.kitchen_inventory_item_id = p.item_id
                   and m.movement_date > p.prev_date
                   and m.movement_date <= p.count_date
                   and m.created_at < p.at
               )
             end as booked
      from paired p
      where p.prev_date is not null
    ),
    valid as (
      select *
      from periods
      where booked > 0
        and count_date - prev_date >= 3
    ),
    ranked as (
      select v.*,
             row_number() over (
               partition by v.location, v.item_id order by v.count_date desc
             ) as rn
      from valid v
    ),
    learned as (
      select r.location,
             r.item_id,
             sum(-r.adj) / sum(r.booked) as rate,
             max(r.count_date) as latest_count,
             jsonb_agg(jsonb_build_object(
               'from', r.prev_date,
               'to', r.count_date,
               'adj', round(r.adj, 3),
               'booked', round(r.booked, 3)
             ) order by r.count_date) as periods
      from ranked r
      where r.rn <= 3
      group by r.location, r.item_id
    )
    select *
    from learned
    order by location, item_id
  loop
    if v_row.rate is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if abs(v_row.rate) < 0.02 then
      v_skipped := v_skipped + 1;
      delete from public.cogs_backflush_warnings w
      where w.location = v_row.location
        and w.kitchen_inventory_item_id = v_row.item_id
        and w.kind = 'shrink';
    elsif abs(v_row.rate) <= 0.15 then
      v_base := 1;
      select f.factor into v_base
      from public.cogs_usage_factors f
      where f.location = v_row.location
        and f.kitchen_inventory_item_id = v_row.item_id
        and f.effective_from <= v_row.latest_count
      order by f.effective_from desc, f.id::text desc
      limit 1;
      v_base := coalesce(v_base, 1);
      v_factor := least(2, greatest(0.5, v_base * (1 + v_row.rate)));

      insert into public.cogs_usage_factors(
        location, kitchen_inventory_item_id, factor, effective_from,
        source, evidence
      ) values (
        v_row.location,
        v_row.item_id,
        v_factor,
        v_row.latest_count + 1,
        'learned',
        jsonb_build_object('rate', v_row.rate, 'periods', v_row.periods)
      )
      on conflict (location, kitchen_inventory_item_id, effective_from)
      do update set
        factor = excluded.factor,
        source = 'learned',
        evidence = excluded.evidence
      where cogs_usage_factors.source = 'learned';
      get diagnostics v_written = row_count;
      if v_written > 0 then
        v_learned := v_learned + 1;
      else
        v_skipped := v_skipped + 1;
      end if;

      delete from public.cogs_backflush_warnings w
      where w.location = v_row.location
        and w.kitchen_inventory_item_id = v_row.item_id
        and w.kind = 'shrink';
    else
      insert into public.cogs_backflush_warnings(
        location, kitchen_inventory_item_id, movement_date, kind,
        shrink_rate, evidence
      ) values (
        v_row.location,
        v_row.item_id,
        null,
        'shrink',
        v_row.rate,
        jsonb_build_object('rate', v_row.rate, 'periods', v_row.periods)
      )
      on conflict (
        location,
        kitchen_inventory_item_id,
        (coalesce(movement_date, '1900-01-01')),
        kind
      )
      do update set
        shrink_rate = excluded.shrink_rate,
        evidence = excluded.evidence,
        updated_at = now();
      v_warned := v_warned + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'learned', v_learned,
    'skipped', v_skipped,
    'warned', v_warned
  );
end;
$$;

revoke all on function public.cogs_learn_usage_factors() from public, anon, authenticated;
grant execute on function public.cogs_learn_usage_factors() to service_role;

-- ===========================================================================
-- D. Nightly wrapper: learn first, then backflush
-- ===========================================================================

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
  perform public.cogs_learn_usage_factors();
  return public.run_cogs_backflush(v_today - 35, v_today + 14, false);
end;
$$;

revoke all on function public.run_cogs_backflush_nightly() from public, anon, authenticated;
grant execute on function public.run_cogs_backflush_nightly() to service_role;

-- ===========================================================================
-- E. Read-only day payload for the inventory page
-- ===========================================================================

create or replace function public.kho_revenue_day(p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_items jsonb;
  v_item_rows jsonb;
  v_channels jsonb;
  v_materials jsonb;
  v_posted jsonb;
  v_warnings jsonb;
  v_refs jsonb;
  v_counts jsonb;
  v_periods jsonb;
  v_factors jsonb;
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
  if p_day is null or p_day > v_today or p_day < v_today - 120 then
    raise exception 'invalid_day' using errcode = '22023';
  end if;

  v_items := public.kho_get_items();

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e ->> 'id',
           'name', e ->> 'name',
           'unit', e ->> 'unit',
           'code', e ->> 'item_code',
           'qty', coalesce(e -> 'qty', '{}'::jsonb),
           'last_count', coalesce(e -> 'last_count_date', '{}'::jsonb)
         ) order by e ->> 'name', e ->> 'id'), '[]'::jsonb)
    into v_item_rows
  from jsonb_array_elements(coalesce(v_items -> 'items', '[]'::jsonb)) e
  where exists (
    select 1
    from public.cogs_backflush_trace t
    where t.revenue_date = p_day
      and t.kitchen_inventory_item_id = (e ->> 'id')::uuid
  );

  with base as (
    select l.*
    from public.revenue_ledger_lines l
    where l.revenue_date = p_day
      and l.approval_status = 'approved'
      and l.quantity > 0
      and not (
        lower(coalesce(l.channel, '')) like '%test%'
        or lower(coalesce(l.customer_name, '')) like '%test%'
        or lower(coalesce(l.raw_payload ->> 'location_name', '')) like '%test%'
      )
  ),
  ch as (
    select l.channel,
           count(distinct coalesce(l.invoice_no, l.id::text))::integer as orders,
           count(distinct coalesce(nullif(btrim(l.customer_name), ''), l.customer_id::text))::integer as customers,
           sum(l.quantity) as qty,
           sum(l.gross_revenue) as value
    from base l
    group by l.channel
  ),
  skus as (
    select s.channel,
           jsonb_agg(jsonb_build_object(
             'code', s.product_code,
             'name', s.product_name,
             'qty', s.qty,
             'value', s.value
           ) order by s.qty desc, s.product_name) as skus
    from (
      select l.channel, l.product_code, l.product_name,
             sum(l.quantity) as qty,
             sum(l.gross_revenue) as value
      from base l
      group by l.channel, l.product_code, l.product_name
    ) s
    group by s.channel
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'channel', ch.channel,
           'orders', ch.orders,
           'customers', ch.customers,
           'qty', ch.qty,
           'value', ch.value,
           'skus', coalesce(skus.skus, '[]'::jsonb)
         ) order by ch.qty desc, ch.channel), '[]'::jsonb)
    into v_channels
  from ch
  join skus on skus.channel = ch.channel;

  with trace as (
    select t.*
    from public.cogs_backflush_trace t
    where t.revenue_date = p_day
  ),
  grouped as (
    select t.channel,
           t.location,
           t.kitchen_inventory_item_id as item_id,
           t.status,
           coalesce(kii.name, scm.canonical_name, '') as material,
           t.recipe_unit,
           sum(t.stock_qty) as qty,
           sum(t.recipe_qty) as recipe_qty,
           coalesce(jsonb_agg(distinct ps.sku_code order by ps.sku_code)
                    filter (where ps.sku_code is not null), '[]'::jsonb) as skus
    from trace t
    left join public.kitchen_inventory_items kii on kii.id = t.kitchen_inventory_item_id
    left join public.sku_cogs_materials scm on scm.id = t.canonical_material_id
    left join public.product_skus ps on ps.id = t.sku_id
    group by t.channel, t.location, t.kitchen_inventory_item_id, t.status,
             coalesce(kii.name, scm.canonical_name, ''), t.recipe_unit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'channel', g.channel,
           'item_id', g.item_id,
           'location', g.location,
           'material', g.material,
           'qty', g.qty,
           'recipe_qty', g.recipe_qty,
           'recipe_unit', g.recipe_unit,
           'skus', g.skus,
           'status', g.status
         ) order by g.channel, g.location nulls last, g.item_id nulls last, g.material), '[]'::jsonb)
    into v_materials
  from grouped g;

  with moves as (
    select 'q7'::text as loc,
           m.kitchen_inventory_item_id as item_id,
           m.movement_date as d,
           round(sum(
             case
               when m.movement_type = 'production_usage' then m.quantity
               when m.movement_type = 'adjustment' then -m.quantity
               else 0
             end
           ), 3) as qty
    from public.q7_inventory_movements m
    where m.source = 'revenue_cogs'
      and m.movement_date between p_day - 6 and p_day
    group by m.kitchen_inventory_item_id, m.movement_date
    union all
    select 'tan_tao',
           m.kitchen_inventory_item_id,
           m.movement_date,
           round(sum(
             case
               when m.movement_type = 'production_usage' then m.quantity
               when m.movement_type = 'adjustment' then -m.quantity
               else 0
             end
           ), 3)
    from public.tan_tao_material_movements m
    where m.source = 'revenue_cogs'
      and m.movement_date between p_day - 6 and p_day
    group by m.kitchen_inventory_item_id, m.movement_date
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'loc', m.loc,
           'item_id', m.item_id,
           'd', m.d,
           'qty', m.qty
         ) order by m.d, m.loc, m.item_id), '[]'::jsonb)
    into v_posted
  from moves m;

  select coalesce(jsonb_agg(jsonb_build_object(
           'loc', w.location,
           'item_id', w.kitchen_inventory_item_id,
           'd', w.movement_date,
           'kind', w.kind,
           'desired', w.desired_qty,
           'reference', w.reference_qty,
           'reference_days', w.reference_days,
           'finished_units', w.finished_units,
           'per_unit', w.per_unit,
           'shrink_rate', w.shrink_rate,
           'evidence', w.evidence
         ) order by w.kind, w.location, w.kitchen_inventory_item_id), '[]'::jsonb)
    into v_warnings
  from public.cogs_backflush_warnings w
  where (w.movement_date = p_day or w.kind = 'shrink')
    and exists (
      select 1
      from public.cogs_backflush_trace t
      where t.revenue_date = p_day
        and t.location = w.location
        and t.kitchen_inventory_item_id = w.kitchen_inventory_item_id
    );

  select coalesce(jsonb_agg(jsonb_build_object(
           'loc', u.location,
           'item_id', u.item_id,
           'ref', r.reference_qty,
           'days', r.reference_days
         ) order by u.location, u.item_id), '[]'::jsonb)
    into v_refs
  from (
    select distinct t.location, t.kitchen_inventory_item_id as item_id
    from public.cogs_backflush_trace t
    where t.revenue_date = p_day
      and t.location is not null
      and t.kitchen_inventory_item_id is not null
  ) u
  cross join lateral public.cogs_backflush_usage_reference(
    u.location, u.item_id, p_day
  ) r;

  with counts as (
    select 'q7'::text as location,
           m.kitchen_inventory_item_id as item_id,
           m.movement_date as count_date,
           sum(m.quantity) as adj,
           max(m.created_at) as at
    from public.q7_inventory_movements m
    where m.movement_type = 'adjustment'
      and m.source_ref_key like 'q7-stock-count:%'
    group by 1, 2, 3
    union all
    select 'tan_tao',
           m.kitchen_inventory_item_id,
           m.movement_date,
           sum(m.quantity),
           max(m.created_at)
    from public.tan_tao_material_movements m
    where m.movement_type = 'adjustment'
      and m.source_ref_key like 'tt-material-count:%'
    group by 1, 2, 3
  ),
  used as (
    select distinct t.location, t.kitchen_inventory_item_id as item_id
    from public.cogs_backflush_trace t
    where t.revenue_date = p_day
      and t.location is not null
      and t.kitchen_inventory_item_id is not null
  ),
  ranked as (
    select c.*,
           row_number() over (
             partition by c.location, c.item_id
             order by c.count_date desc, c.at desc
           ) as rn
    from counts c
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'loc', r.location,
           'item_id', r.item_id,
           'd', r.count_date,
           'adj', r.adj
         ) order by r.location, r.item_id), '[]'::jsonb)
    into v_counts
  from ranked r
  join used u on u.location = r.location and u.item_id = r.item_id
  where r.rn = 1;

  with counts as (
    select 'q7'::text as location,
           m.kitchen_inventory_item_id as item_id,
           m.movement_date as count_date,
           sum(m.quantity) as adj,
           max(m.created_at) as at
    from public.q7_inventory_movements m
    where m.movement_type = 'adjustment'
      and m.source_ref_key like 'q7-stock-count:%'
    group by 1, 2, 3
    union all
    select 'tan_tao',
           m.kitchen_inventory_item_id,
           m.movement_date,
           sum(m.quantity),
           max(m.created_at)
    from public.tan_tao_material_movements m
    where m.movement_type = 'adjustment'
      and m.source_ref_key like 'tt-material-count:%'
    group by 1, 2, 3
  ),
  paired as (
    select c.*,
           lag(c.count_date) over (
             partition by c.location, c.item_id order by c.count_date
           ) as prev_date
    from counts c
  ),
  periods as (
    select p.location,
           p.item_id,
           p.prev_date,
           p.count_date,
           p.adj,
           case p.location
             when 'q7' then (
               select coalesce(sum(
                 case
                   when m.movement_type = 'production_usage' then m.quantity
                   when m.movement_type = 'adjustment'
                    and m.source in ('revenue_cogs', 'production_material_issue_reversal')
                     then -m.quantity
                   else 0
                 end
               ), 0)
               from public.q7_inventory_movements m
               where m.kitchen_inventory_item_id = p.item_id
                 and m.movement_date > p.prev_date
                 and m.movement_date <= p.count_date
                 and m.created_at < p.at
             )
             when 'tan_tao' then (
               select coalesce(sum(
                 case
                   when m.movement_type = 'production_usage' then m.quantity
                   when m.movement_type = 'adjustment'
                    and m.source in ('revenue_cogs', 'production_material_issue_reversal')
                     then -m.quantity
                   else 0
                 end
               ), 0)
               from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = p.item_id
                 and m.movement_date > p.prev_date
                 and m.movement_date <= p.count_date
                 and m.created_at < p.at
             )
           end as booked
    from paired p
    where p.prev_date is not null
  ),
  used as (
    select distinct t.location, t.kitchen_inventory_item_id as item_id
    from public.cogs_backflush_trace t
    where t.revenue_date = p_day
      and t.location is not null
      and t.kitchen_inventory_item_id is not null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'loc', p.location,
           'item_id', p.item_id,
           'from', p.prev_date,
           'to', p.count_date,
           'adj', p.adj,
           'deducted', p.booked
         ) order by p.location, p.item_id, p.count_date), '[]'::jsonb)
    into v_periods
  from periods p
  join used u on u.location = p.location and u.item_id = p.item_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'loc', f.location,
           'item_id', f.kitchen_inventory_item_id,
           'factor', f.factor,
           'source', f.source,
           'effective_from', f.effective_from
         ) order by f.location, f.kitchen_inventory_item_id), '[]'::jsonb)
    into v_factors
  from (
    select distinct on (f.location, f.kitchen_inventory_item_id)
           f.location,
           f.kitchen_inventory_item_id,
           f.factor,
           f.source,
           f.effective_from
    from public.cogs_usage_factors f
    where f.effective_from <= p_day
      and exists (
        select 1
        from public.cogs_backflush_trace t
        where t.revenue_date = p_day
          and t.location = f.location
          and t.kitchen_inventory_item_id = f.kitchen_inventory_item_id
      )
    order by f.location, f.kitchen_inventory_item_id,
             f.effective_from desc, f.id::text desc
  ) f;

  return jsonb_build_object(
    'day', p_day,
    'generated_at', now(),
    'channels', v_channels,
    'materials', v_materials,
    'items', v_item_rows,
    'posted', v_posted,
    'warnings', v_warnings,
    'refs', v_refs,
    'counts', v_counts,
    'count_periods', v_periods,
    'factors', v_factors
  );
end;
$$;

revoke all on function public.kho_revenue_day(date) from public, anon;
grant execute on function public.kho_revenue_day(date) to authenticated;
