-- Kho văn phòng — bộ học kho học thêm Kho Tân Tạo + sửa quy đổi trong Máy đặt hàng tự động.
--
-- 1. public.warehouse_item_learning — per-item learned supplier, pack, lead time,
--    order cycle, order size and purchase-based daily usage for Tân Tạo.
-- 2. public.learn_tan_tao_purchase_parameters() — one set-based pass over the
--    shared purchase lines (each purchase counted once), security definer with a
--    pinned search_path and the same permission gate as the Q7 learner.
-- 3. public.run_warehouse_learning_scheduled() — the cron entry point. It sets the
--    service-role claim and runs the Q7 and Tân Tạo learners independently: one
--    failing never stops the other.
-- 4. The daily job 'warehouse-learn-daily' (30 22 * * * UTC = 05:30 VN) replaces
--    'q7-auto-purchase-learn-daily'. The existing auto-purchase job is untouched.
-- 5. public.get_office_order_snapshot(text) keeps every existing key, permission
--    check and grant, and additionally:
--      * converts a receipt quantity exactly like the stock ledger
--        (goods_receipt_effective_quantity, then line unit -> pack name -> alias
--        factor) instead of multiplying every line by the alias factor, and
--      * returns a 'learned' object per item (Q7 from q7_purchase_item_settings,
--        Tân Tạo from warehouse_item_learning), or null when there is no row.
--
-- This migration never writes a document, ledger or order row and never changes
-- q7_auto_purchase_settings. The Maestro applies it after a rollback-only smoke;
-- the Harness does not run it against any database.

-- ===========================================================================
-- 1. warehouse_item_learning — the Tân Tạo per-item learned parameters
-- ===========================================================================

create table if not exists public.warehouse_item_learning (
  id uuid primary key default gen_random_uuid(),
  location text not null check (location in ('tan_tao')),
  kitchen_inventory_item_id uuid not null
    references public.kitchen_inventory_items(id) on delete cascade,
  learned_supplier_id uuid references public.suppliers(id) on delete set null,
  learned_pack_size numeric(18,4),
  learned_pack_label text,
  learned_lead_time_days integer
    check (learned_lead_time_days is null or learned_lead_time_days between 0 and 30),
  learned_cycle_days numeric(8,2),
  learned_order_qty numeric(18,3),
  learned_daily_usage numeric(18,3),
  receipt_days integer not null default 0,
  last_receipt_date date,
  learned_at timestamptz not null default now(),
  unique (location, kitchen_inventory_item_id)
);

alter table public.warehouse_item_learning enable row level security;

create policy warehouse_item_learning_select
  on public.warehouse_item_learning
  for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'owner'::app_role)
    or public.has_module_permission(auth.uid(), 'inventory', 'view')
    or public.has_module_permission(auth.uid(), 'q7_material_inventory', 'view')
  );

revoke all on table public.warehouse_item_learning from public, anon, authenticated;
grant select on table public.warehouse_item_learning to authenticated;
grant all on table public.warehouse_item_learning to service_role;

-- ===========================================================================
-- 2. learn_tan_tao_purchase_parameters — one set-based learning pass
-- ===========================================================================

create or replace function public.learn_tan_tao_purchase_parameters()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item_ids uuid[];
  v_updated integer := 0;
  v_removed integer := 0;
begin
  -- Same gate as the Q7 learner: service_role, or an owner / inventory editor.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner'::app_role)
      or public.has_module_permission(v_actor, 'inventory', 'edit')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  with lines as (
    -- A single shared source: receipt lines plus approved request lines that have
    -- no receipt and no PO. Each purchase is counted exactly once.
    select l.kitchen_inventory_item_id as item_id,
           l.doc_date,
           l.supplier_id,
           l.book_qty
    from public.q7_purchase_usage_purchase_lines(current_date - 120, current_date) l
    join public.kitchen_inventory_items kii on kii.id = l.kitchen_inventory_item_id
    where l.book_qty is not null
      and l.book_qty > 0
      and kii.active is true
      and kii.merged_into_id is null
      and coalesce(kii.item_class, 'raw_material') in ('raw_material', 'packaging_supply')
      and coalesce(kii.pastry_q7, false) = false
  ),
  days as (
    select item_id, doc_date, sum(book_qty) as day_qty
    from lines
    group by item_id, doc_date
  ),
  day_stats as (
    select ds.item_id,
           count(*)::integer as receipt_days,
           min(ds.doc_date) as first_date,
           max(ds.doc_date) as last_date,
           sum(ds.day_qty) as total_qty,
           percentile_cont(0.5) within group (order by ds.day_qty) as median_day_qty
    from days ds
    group by ds.item_id
    having count(distinct ds.doc_date) >= 2
  ),
  gap_days as (
    select item_id,
           doc_date - lag(doc_date) over (partition by item_id order by doc_date) as gap
    from days
  ),
  gap_stats as (
    select g.item_id,
           percentile_cont(0.5) within group (order by g.gap) as median_gap
    from gap_days g
    where g.gap is not null
    group by g.item_id
  ),
  supplier_totals as (
    select l.item_id,
           l.supplier_id,
           sum(l.book_qty) as bought_qty,
           max(l.doc_date) as latest_date
    from lines l
    where l.doc_date >= current_date - 90
      and l.supplier_id is not null
    group by l.item_id, l.supplier_id
  ),
  supplier_pick as (
    -- Largest purchased book quantity in the last 90 days; ties go to the
    -- supplier whose latest purchase is the most recent.
    select distinct on (st.item_id) st.item_id, st.supplier_id
    from supplier_totals st
    order by st.item_id, st.bought_qty desc, st.latest_date desc, st.supplier_id
  ),
  lead_stats as (
    select sp.item_id,
           percentile_cont(0.5) within group (order by (gr.receipt_date - po.order_date)) as median_lead
    from supplier_pick sp
    join public.purchase_orders po on po.supplier_id = sp.supplier_id
    join public.goods_receipts gr on gr.purchase_order_id = po.id
    where gr.receipt_date is not null
      and gr.receipt_date >= current_date - 120
      and (gr.receipt_date - po.order_date) between 0 and 30
    group by sp.item_id
  ),
  learned as (
    select ds.item_id,
           sp.supplier_id,
           (pk.pack ->> 'pack_size')::numeric as pack_size,
           pk.pack ->> 'pack_label' as pack_label,
           round(ls.median_lead::numeric)::integer as lead_time_days,
           case
             when ds.receipt_days >= 3
               then round(gs.median_gap::numeric, 1)
             else null
           end as cycle_days,
           round(ds.median_day_qty::numeric, 3) as order_qty,
           round(
             ds.total_qty / greatest(30, current_date - ds.first_date + 1),
             3
           ) as daily_usage,
           ds.receipt_days,
           ds.last_date
    from day_stats ds
    join public.kitchen_inventory_items kii on kii.id = ds.item_id
    left join gap_stats gs on gs.item_id = ds.item_id
    left join supplier_pick sp on sp.item_id = ds.item_id
    left join lead_stats ls on ls.item_id = ds.item_id
    cross join lateral (
      select public.q7_pack_from_name(kii.name, kii.unit) as pack
    ) pk
  ),
  upserted as (
    insert into public.warehouse_item_learning (
      location,
      kitchen_inventory_item_id,
      learned_supplier_id,
      learned_pack_size,
      learned_pack_label,
      learned_lead_time_days,
      learned_cycle_days,
      learned_order_qty,
      learned_daily_usage,
      receipt_days,
      last_receipt_date,
      learned_at
    )
    select 'tan_tao',
           l.item_id,
           l.supplier_id,
           l.pack_size,
           l.pack_label,
           l.lead_time_days,
           l.cycle_days,
           l.order_qty,
           l.daily_usage,
           l.receipt_days,
           l.last_date,
           now()
    from learned l
    on conflict (location, kitchen_inventory_item_id) do update set
      learned_supplier_id = excluded.learned_supplier_id,
      learned_pack_size = excluded.learned_pack_size,
      learned_pack_label = excluded.learned_pack_label,
      learned_lead_time_days = excluded.learned_lead_time_days,
      learned_cycle_days = excluded.learned_cycle_days,
      learned_order_qty = excluded.learned_order_qty,
      learned_daily_usage = excluded.learned_daily_usage,
      receipt_days = excluded.receipt_days,
      last_receipt_date = excluded.last_receipt_date,
      learned_at = now()
    returning kitchen_inventory_item_id
  )
  select coalesce(array_agg(u.kitchen_inventory_item_id), '{}'::uuid[]),
         count(*)::integer
  into v_item_ids, v_updated
  from upserted u;

  -- Drop Tân Tạo rows whose item no longer qualifies (fewer than two receipt
  -- days in the last 120 days, inactive, merged, pastry Q7 or another class).
  delete from public.warehouse_item_learning w
  where w.location = 'tan_tao'
    and not (w.kitchen_inventory_item_id = any (v_item_ids));
  get diagnostics v_removed = row_count;

  return jsonb_build_object(
    'status', 'learned',
    'location', 'tan_tao',
    'items_updated', v_updated,
    'items_removed', v_removed
  );
end;
$$;

revoke all on function public.learn_tan_tao_purchase_parameters() from public, anon;
grant execute on function public.learn_tan_tao_purchase_parameters() to authenticated, service_role;

-- ===========================================================================
-- 3. run_warehouse_learning_scheduled — independent Q7 + Tân Tạo runs
-- ===========================================================================

create or replace function public.run_warehouse_learning_scheduled()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_q7 jsonb;
  v_tan_tao jsonb;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- Each learner has its own exception block: one failing never stops the other.
  begin
    v_q7 := public.learn_q7_purchase_parameters();
  exception when others then
    v_q7 := jsonb_build_object('status', 'error', 'error', sqlerrm);
  end;

  begin
    v_tan_tao := public.learn_tan_tao_purchase_parameters();
  exception when others then
    v_tan_tao := jsonb_build_object('status', 'error', 'error', sqlerrm);
  end;

  return jsonb_build_object(
    'q7', v_q7,
    'tan_tao', v_tan_tao,
    'ran_at', now()
  );
end;
$$;

revoke all on function public.run_warehouse_learning_scheduled() from public, anon, authenticated;
grant execute on function public.run_warehouse_learning_scheduled() to service_role;

-- ===========================================================================
-- 4. Schedule: one daily warehouse learning job at 05:30 VN
-- ===========================================================================

do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job
    where jobname in ('q7-auto-purchase-learn-daily', 'warehouse-learn-daily')
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'warehouse-learn-daily',
    '30 22 * * *',
    $job$ select public.run_warehouse_learning_scheduled(); $job$
  );
end;
$$;

-- ===========================================================================
-- 5. get_office_order_snapshot — effective quantity + line unit conversion
--    and the per-item learned facts. Every other key is unchanged.
-- ===========================================================================

create or replace function public.get_office_order_snapshot(p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_forecast jsonb;
  v_result jsonb;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'not_authenticated' using errcode = '42501';
    end if;
  end if;

  if p_location is null or p_location not in ('tan_tao', 'q7') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;

  -- The forecast only feeds the Q7 suggestion columns. A denied / failed
  -- forecast call must never fail the whole read.
  if p_location = 'q7' then
    begin
      v_forecast := public.get_q7_purchase_forecast(null, 14);
    exception when others then
      v_forecast := null;
    end;
  end if;

  -- One set-based pass (a per-item loop normalised every receipt line once per
  -- item and took ~6 s on live data).
  with fc as (
    select (e ->> 'item_id')::uuid as item_id,
           (e ->> 'suggested_qty')::numeric as suggested,
           (e ->> 'daily_usage')::numeric as daily
    from jsonb_array_elements(coalesce(v_forecast -> 'items', '[]'::jsonb)) e
  ),
  items as (
    select kii.id, kii.item_code, kii.name, kii.unit, kii.item_class,
           coalesce(kii.pastry_q7, false) as pastry_q7, m.category
    from public.kitchen_inventory_items kii
    left join public.sku_cogs_materials m on m.id = kii.canonical_material_id
    where kii.active = true
      and kii.merged_into_id is null
      and coalesce(kii.item_class, 'raw_material') in ('raw_material', 'packaging_supply')
      and (p_location <> 'q7' or coalesce(kii.pastry_q7, false) = true or exists (select 1 from fc where fc.item_id = kii.id))
  ),
  receipt_lines as (
    select gi.id as line_id, gi.created_at, gr.receipt_date, gr.supplier_id, gi.unit, gi.unit_price,
           coalesce(gi.raw_product_name, gi.product_name) as raw_name,
           greatest(0, coalesce(public.goods_receipt_effective_quantity(gi.actual_quantity, gi.quantity, gi.ordered_quantity, gr.status::text), 0)) as raw_qty,
           public.normalize_stock_item_name(coalesce(gi.raw_product_name, gi.product_name)) as norm
    from public.goods_receipt_items gi
    join public.goods_receipts gr on gr.id = gi.goods_receipt_id
    where gr.status in ('confirmed', 'received')
      and gr.receipt_date >= current_date - 120
      and gr.receipt_date <= current_date
  ),
  -- Purchase history is per item, whichever warehouse classified the line;
  -- one alias per receipt line (this warehouse's first) so nothing counts twice.
  matched as (
    select distinct on (rl.line_id)
           rl.line_id, rl.created_at, rl.receipt_date, rl.supplier_id, rl.unit, rl.unit_price, rl.raw_qty,
           a.kitchen_inventory_item_id as item_id,
           -- Same chain as post_stock_goods_receipt_item: line unit -> pack name -> alias.
           -- (A per-pair factor CTE joined with "is not distinct from" made this 9 s.)
           rl.raw_qty * coalesce(public.stock_unit_line_factor(rl.unit, i.unit), public.stock_unit_pack_factor(rl.raw_name, rl.unit, i.unit), a.conversion_factor, 1) as stock_qty
    from receipt_lines rl
    join public.stock_material_aliases a
      on a.normalized_name = rl.norm
     and a.line_class = 'stock'
     and (a.supplier_id = rl.supplier_id or a.supplier_id is null)
    join items i on i.id = a.kitchen_inventory_item_id
    order by rl.line_id, (a.location = p_location) desc, (a.supplier_id is not null) desc, a.created_at asc, a.id asc
  ),
  days as (
    select item_id, receipt_date, sum(stock_qty) as day_qty
    from matched
    group by item_id, receipt_date
  ),
  gaps as (
    select item_id, receipt_date - lag(receipt_date) over (partition by item_id order by receipt_date) as gap_days
    from days
  ),
  stats as (
    select d.item_id, count(*)::integer as receipts, min(d.receipt_date) as first_date, max(d.receipt_date) as last_date,
           avg(d.day_qty) as avg_qty, sum(d.day_qty) as total_qty,
           (select percentile_cont(0.5) within group (order by g.gap_days)
              from gaps g where g.item_id = d.item_id and g.gap_days is not null) as median_gap_days
    from days d
    group by d.item_id
  ),
  last_line as (
    select distinct on (item_id) item_id, supplier_id, unit, unit_price, receipt_date
    from matched
    order by item_id, receipt_date desc, created_at desc, line_id desc
  ),
  last_raw as (
    select ll.item_id, sum(m.raw_qty) as raw_qty
    from last_line ll
    join matched m on m.item_id = ll.item_id and m.receipt_date = ll.receipt_date and coalesce(m.unit, '') = coalesce(ll.unit, '')
    group by ll.item_id
  )
  select jsonb_build_object(
    'as_of', current_date,
    'location', p_location,
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('code', c.code, 'label_vi', c.label_vi, 'sort_order', c.sort_order) order by c.sort_order, c.code)
      from public.stock_material_categories c
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'item_code', i.item_code, 'name', i.name, 'unit', i.unit, 'item_class', i.item_class,
        'pastry_q7', i.pastry_q7, 'category', i.category,
        'receipts', coalesce(st.receipts, 0), 'first_date', st.first_date, 'last_date', st.last_date,
        'avg_qty', st.avg_qty, 'total_qty', st.total_qty, 'median_gap_days', st.median_gap_days,
        'supplier_id', ll.supplier_id, 'supplier_name', s.name,
        'last_unit', ll.unit, 'last_unit_price', ll.unit_price, 'last_raw_qty', lr.raw_qty,
        'forecast_suggested_qty', fc.suggested, 'forecast_daily_usage', fc.daily,
        'learned', case
          when p_location = 'q7' then case
            when qs.kitchen_inventory_item_id is null then null
            else jsonb_build_object(
              'source', 'q7',
              'supplier_id', qs.learned_supplier_id,
              'supplier_name', qs_sup.name,
              'pack_size', qs.learned_pack_size,
              'pack_label', qs.learned_pack_label,
              'lead_time_days', qs.learned_lead_time_days,
              'safety_days', qs.learned_safety_days,
              'cycle_days', null,
              'order_qty', null,
              'daily_usage', null,
              'receipt_days', null,
              'learned_at', qs.learned_at
            )
          end
          when p_location = 'tan_tao' then case
            when wl.kitchen_inventory_item_id is null then null
            else jsonb_build_object(
              'source', 'tan_tao',
              'supplier_id', wl.learned_supplier_id,
              'supplier_name', wl_sup.name,
              'pack_size', wl.learned_pack_size,
              'pack_label', wl.learned_pack_label,
              'lead_time_days', wl.learned_lead_time_days,
              'safety_days', null,
              'cycle_days', wl.learned_cycle_days,
              'order_qty', wl.learned_order_qty,
              'daily_usage', wl.learned_daily_usage,
              'receipt_days', wl.receipt_days,
              'learned_at', wl.learned_at
            )
          end
          else null
        end
      ) order by i.name, i.id)
      from items i
      left join stats st on st.item_id = i.id
      left join last_line ll on ll.item_id = i.id
      left join last_raw lr on lr.item_id = i.id
      left join public.suppliers s on s.id = ll.supplier_id
      left join fc on fc.item_id = i.id
      left join public.q7_purchase_item_settings qs on qs.kitchen_inventory_item_id = i.id
      left join public.suppliers qs_sup on qs_sup.id = qs.learned_supplier_id
      left join public.warehouse_item_learning wl
        on wl.kitchen_inventory_item_id = i.id
       and wl.location = 'tan_tao'
      left join public.suppliers wl_sup on wl_sup.id = wl.learned_supplier_id
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_office_order_snapshot(text) from public, anon;
grant execute on function public.get_office_order_snapshot(text) to authenticated, service_role;
