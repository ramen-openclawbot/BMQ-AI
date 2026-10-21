-- 2026-10-22 — Kho commitments: what open orders already hold.
--
-- Read-only.  This migration creates one reader RPC and moves the two
-- auto-ledger jobs from a nightly run to an hourly run.  It writes no ledger
-- row, no document row, and changes no posting function or trigger.
--
-- as_of is the Asia/Ho_Chi_Minh business date.  A PXK generated for a future
-- delivery date already has production_usage rows dated on that delivery date;
-- those rows are still in the future, so they are commitments now and the
-- normal ledger subtracts them at the start of their day.
--
-- The Maestro applies this migration; Harness does not.

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
             'ref', coalesce(issue_number, source),
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

-- ---------------------------------------------------------------------------
-- 4. Hourly auto-ledger schedules
--
-- The first run after midnight in Asia/Ho_Chi_Minh posts a delivery on its
-- delivery day.  Every later run that day finds the document already posted or
-- received, so the commands' business-date logic and idempotency keys make it
-- add nothing new.  Commands stay exactly as they are; only the schedules move
-- from nightly to hourly at minute 5 (Tân Tạo) and minute 10 (Q7).
-- ---------------------------------------------------------------------------

do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'tan-tao-daily-ledger'
  order by jobid
  limit 1;
  if v_job_id is not null then
    perform cron.alter_job(v_job_id, '5 * * * *');
  end if;

  select jobid into v_job_id
  from cron.job
  where jobname = 'q7-fg-daily-ledger'
  order by jobid
  limit 1;
  if v_job_id is not null then
    perform cron.alter_job(v_job_id, '10 * * * *');
  end if;
end;
$$;
