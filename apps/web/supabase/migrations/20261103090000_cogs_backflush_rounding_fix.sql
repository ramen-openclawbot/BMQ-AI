-- COGS backflush: ledger precision rounding guard and stock-count freeze.
--
-- public.run_cogs_backflush computed desired/posted quantities at 6 decimals
-- while q7_inventory_movements.quantity and tan_tao_material_movements.quantity
-- are numeric(15,3).  A sub-0.0005 delta rounded to 0.000 on insert, violated
-- q7_inventory_movements_quantity_check (adjustment requires quantity <> 0) and
-- aborted the whole run.
--
-- Desired/posted quantities now round to ledger precision, a delta that rounds
-- to zero is skipped, and revenue dates on or before an item's latest stock
-- count at that kho are excluded from both sides, so a frozen date neither
-- posts nor reverses.  The 27/10 counts are therefore not deducted twice.
--
-- Abnormal positive daily usage is also held for an owner decision: fewer
-- than 5 reference days, more than 5x the 30-day median, or a changed date
-- beyond the approved 1.10 allowance is not posted until approved.

create or replace function public.cogs_backflush_ledger_qty(p_delta numeric)
returns numeric
language sql
immutable
as $$
  select nullif(round(p_delta, 3), 0::numeric);
$$;

revoke all on function public.cogs_backflush_ledger_qty(numeric) from public, anon, authenticated;
grant execute on function public.cogs_backflush_ledger_qty(numeric) to service_role;

create or replace function public.cogs_backflush_item_frozen_through(
  p_location text,
  p_item uuid
)
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case p_location
           when 'q7' then (
             select max(m.movement_date)
             from public.q7_inventory_movements m
             where m.kitchen_inventory_item_id = p_item
               and m.movement_type = 'adjustment'
               and m.source_ref_key like 'q7-stock-count:%'
           )
           when 'tan_tao' then (
             select max(m.movement_date)
             from public.tan_tao_material_movements m
             where m.kitchen_inventory_item_id = p_item
               and m.movement_type = 'adjustment'
               and m.source_ref_key like 'tt-material-count:%'
           )
         end;
$$;

revoke all on function public.cogs_backflush_item_frozen_through(text, uuid) from public, anon, authenticated;
grant execute on function public.cogs_backflush_item_frozen_through(text, uuid) to service_role;

create table if not exists public.cogs_backflush_holds (
  id uuid primary key default gen_random_uuid(),
  location text not null check (location in ('q7', 'tan_tao')),
  kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id),
  movement_date date not null,
  desired_qty numeric(15, 3) not null,
  delta_qty numeric(15, 3) not null,
  reference_qty numeric(15, 3),
  reference_days integer not null,
  reason text not null check (reason in ('outlier', 'no_reference')),
  status text not null default 'held' check (status in ('held', 'approved', 'rejected')),
  approved_desired_qty numeric(15, 3),
  run_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  unique (location, kitchen_inventory_item_id, movement_date)
);

alter table public.cogs_backflush_holds enable row level security;
revoke all on table public.cogs_backflush_holds from public, anon, authenticated;

create or replace function public.cogs_backflush_usage_reference(
  p_location text,
  p_item uuid,
  p_date date
)
returns table(reference_qty numeric, reference_days integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with daily as (
    select m.movement_date, sum(m.quantity) as qty
    from public.q7_inventory_movements m
    where p_location = 'q7'
      and m.kitchen_inventory_item_id = p_item
      and m.movement_type = 'production_usage'
      and m.movement_date between p_date - 30 and p_date - 1
    group by m.movement_date
    having sum(m.quantity) > 0
    union all
    select m.movement_date, sum(m.quantity) as qty
    from public.tan_tao_material_movements m
    where p_location = 'tan_tao'
      and m.kitchen_inventory_item_id = p_item
      and m.movement_type = 'production_usage'
      and m.movement_date between p_date - 30 and p_date - 1
    group by m.movement_date
    having sum(m.quantity) > 0
  )
  select (percentile_cont(0.5)
            within group (order by daily.qty::double precision))::numeric as reference_qty,
         count(*)::integer as reference_days
  from daily;
$$;

revoke all on function public.cogs_backflush_usage_reference(text, uuid, date) from public, anon, authenticated;
grant execute on function public.cogs_backflush_usage_reference(text, uuid, date) to service_role;

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
  v_held integer := 0;
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
  v_reference_qty numeric;
  v_reference_days integer;
  v_hold_reason text;
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
              -- Hold an abnormal positive day until an owner decides.
              v_hold_reason := null;
              v_hold_found := false;
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

              if v_hold_found
                 and v_hold.status = 'approved'
                 and v_delta.desired_qty <= v_hold.approved_desired_qty * 1.10 then
                -- Approved and still within the owner's 1.10 allowance.
                null;
              else
                select r.reference_qty, r.reference_days
                  into v_reference_qty, v_reference_days
                from public.cogs_backflush_usage_reference(
                  v_setting.location, v_delta.item_id, v_delta.movement_date
                ) r;

                if v_hold_found and v_hold.status = 'approved' then
                  -- An approval is stale once the 1.10 allowance is exceeded.
                  v_hold_reason := case
                    when v_reference_days < 5 then 'no_reference'
                    else 'outlier'
                  end;
                elsif v_reference_days < 5 then
                  v_hold_reason := 'no_reference';
                elsif v_delta.desired_qty > 5 * v_reference_qty then
                  v_hold_reason := 'outlier';
                end if;

                if v_hold_reason is not null then
                  insert into public.cogs_backflush_holds(
                    location, kitchen_inventory_item_id, movement_date,
                    desired_qty, delta_qty, reference_qty, reference_days,
                    reason, status, run_id
                  ) values (
                    v_setting.location, v_delta.item_id, v_delta.movement_date,
                    v_delta.desired_qty, v_delta_qty,
                    case when v_hold_reason = 'no_reference' then null
                         else v_reference_qty end,
                    v_reference_days,
                    v_hold_reason, 'held', v_run_id
                  )
                  on conflict (location, kitchen_inventory_item_id, movement_date)
                  do update set
                    desired_qty = excluded.desired_qty,
                    delta_qty = excluded.delta_qty,
                    reference_qty = excluded.reference_qty,
                    reference_days = excluded.reference_days,
                    reason = excluded.reason,
                    status = 'held',
                    run_id = excluded.run_id,
                    updated_at = now();
                  v_held := v_held + 1;
                  continue;
                end if;
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
              -- Hold an abnormal positive day until an owner decides.
              v_hold_reason := null;
              v_hold_found := false;
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

              if v_hold_found
                 and v_hold.status = 'approved'
                 and v_delta.desired_qty <= v_hold.approved_desired_qty * 1.10 then
                -- Approved and still within the owner's 1.10 allowance.
                null;
              else
                select r.reference_qty, r.reference_days
                  into v_reference_qty, v_reference_days
                from public.cogs_backflush_usage_reference(
                  v_setting.location, v_delta.item_id, v_delta.movement_date
                ) r;

                if v_hold_found and v_hold.status = 'approved' then
                  -- An approval is stale once the 1.10 allowance is exceeded.
                  v_hold_reason := case
                    when v_reference_days < 5 then 'no_reference'
                    else 'outlier'
                  end;
                elsif v_reference_days < 5 then
                  v_hold_reason := 'no_reference';
                elsif v_delta.desired_qty > 5 * v_reference_qty then
                  v_hold_reason := 'outlier';
                end if;

                if v_hold_reason is not null then
                  insert into public.cogs_backflush_holds(
                    location, kitchen_inventory_item_id, movement_date,
                    desired_qty, delta_qty, reference_qty, reference_days,
                    reason, status, run_id
                  ) values (
                    v_setting.location, v_delta.item_id, v_delta.movement_date,
                    v_delta.desired_qty, v_delta_qty,
                    case when v_hold_reason = 'no_reference' then null
                         else v_reference_qty end,
                    v_reference_days,
                    v_hold_reason, 'held', v_run_id
                  )
                  on conflict (location, kitchen_inventory_item_id, movement_date)
                  do update set
                    desired_qty = excluded.desired_qty,
                    delta_qty = excluded.delta_qty,
                    reference_qty = excluded.reference_qty,
                    reference_days = excluded.reference_days,
                    reason = excluded.reason,
                    status = 'held',
                    run_id = excluded.run_id,
                    updated_at = now();
                  v_held := v_held + 1;
                  continue;
                end if;
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
      'held_rows', v_held,
      'rejected_skip_rows', v_rejected_skip,
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
      'held_rows', v_held,
      'rejected_skip_rows', v_rejected_skip,
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

create or replace function public.cogs_backflush_list_holds(
  p_status text default 'held'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows jsonb;
begin
  if auth.uid() is null or not public.has_role(auth.uid(), 'owner') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('held', 'approved', 'rejected') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select coalesce(
           jsonb_agg(
             to_jsonb(h) || jsonb_build_object(
               'item_name', kii.name,
               'item_unit', kii.unit
             )
             order by h.movement_date desc, h.created_at desc, h.id desc
           ),
           '[]'::jsonb
         )
    into v_rows
  from (
    select h.*
    from public.cogs_backflush_holds h
    where p_status is null or h.status = p_status
    order by h.movement_date desc, h.created_at desc, h.id desc
    limit 200
  ) h
  join public.kitchen_inventory_items kii on kii.id = h.kitchen_inventory_item_id;

  return v_rows;
end;
$$;

revoke all on function public.cogs_backflush_list_holds(text) from public, anon;
grant execute on function public.cogs_backflush_list_holds(text) to authenticated;

create or replace function public.cogs_backflush_decide_hold(
  p_hold_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hold public.cogs_backflush_holds%rowtype;
begin
  if auth.uid() is null or not public.has_role(auth.uid(), 'owner') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_hold_id is null then
    raise exception 'hold_id_required' using errcode = '22023';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;

  select * into v_hold
  from public.cogs_backflush_holds h
  where h.id = p_hold_id
  for update;
  if not found then
    raise exception 'hold_not_found' using errcode = 'P0002';
  end if;

  if v_hold.status = 'held' then
    if p_decision = 'approve' then
      update public.cogs_backflush_holds
      set status = 'approved',
          approved_desired_qty = desired_qty,
          decided_by = auth.uid(),
          decided_at = now(),
          updated_at = now()
      where id = p_hold_id
        and status = 'held'
      returning * into v_hold;
    else
      update public.cogs_backflush_holds
      set status = 'rejected',
          decided_by = auth.uid(),
          decided_at = now(),
          updated_at = now()
      where id = p_hold_id
        and status = 'held'
      returning * into v_hold;
    end if;
    return to_jsonb(v_hold);
  end if;

  if v_hold.status = 'approved' and p_decision = 'approve' then
    return to_jsonb(v_hold);
  end if;
  if v_hold.status = 'rejected' and p_decision = 'reject' then
    return to_jsonb(v_hold);
  end if;
  raise exception 'hold_already_decided' using errcode = '22023';
end;
$$;

revoke all on function public.cogs_backflush_decide_hold(uuid, text) from public, anon;
grant execute on function public.cogs_backflush_decide_hold(uuid, text) to authenticated;
