-- Trừ kho chờ duyệt (owner 28/10): a held day that a later run no longer holds is taken off the list.
--
-- run_cogs_backflush only refreshed a hold when the day was still abnormal, so a
-- day that became normal (recipe fixed, then posted in full) stayed "held" with
-- its old figure, e.g. Bơ Peerless 28/10 shown as 1.024 kg after 7,87 kg was
-- posted. After the posting loop, held rows in the run window that this run did
-- not hold again are deleted. Approved/rejected rows, the ledger and every other
-- part of the function are unchanged (body = 20261103090000 + this block and the
-- cleared_holds summary key).

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
  v_cleared integer := 0;
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

      -- A held day this run did not hold again has nothing abnormal left to post
      -- (fixed recipe, posted normally, or frozen by a stock count): take it off
      -- the owner's list. Approved and rejected decisions are kept.
      delete from public.cogs_backflush_holds h
      where h.status = 'held'
        and h.movement_date between p_from and p_to
        and h.run_id is distinct from v_run_id
        and exists (
          select 1 from public.cogs_backflush_settings s
          where s.enabled = true and s.location = h.location
        );
      get diagnostics v_cleared = row_count;
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
      'cleared_holds', v_cleared,
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
      'cleared_holds', v_cleared,
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
