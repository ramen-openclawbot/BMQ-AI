-- Q7 finished-goods auto ledger: receive each current Q7 production-order line
-- from the plan (actual produced qty when known, otherwise planned qty) and
-- dispatch the customer PO quantity capped to the resulting on-hand.
--
-- Idempotency:
--   * receipt request id = uuid(md5('q7-fg-receipt:' || item_id))
--   * dispatch request id = uuid(md5('q7-fg-dispatch:' || item_id))
--   * audit events are unique per (action, production_order_item_id)
-- so a retry never posts a second receipt/dispatch movement. A manual receipt
-- already linked to the item is never duplicated; the dispatch step still runs.
--
-- Nothing is posted for a production date on/before the Q7 stock-count cutover
-- (public.stock_ledger_cutover_date('q7')); those lines are audited as
-- 'before_cutover'. Revenue tables are never read or written here.

-- ---------------------------------------------------------------------------
-- 1. Run/event audit tables
-- ---------------------------------------------------------------------------

create table if not exists public.q7_fg_auto_runs (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  dry_run boolean not null default false,
  result jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.q7_fg_auto_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.q7_fg_auto_runs(id) on delete cascade,
  production_order_item_id uuid not null references public.production_order_items(id) on delete cascade,
  action text not null,
  quantity numeric,
  business_date date,
  reason text,
  created_at timestamptz not null default now(),
  constraint q7_fg_auto_events_action_check
    check (action in ('received', 'dispatched', 'skipped')),
  constraint q7_fg_auto_events_unique
    unique (action, production_order_item_id)
);

create index if not exists idx_q7_fg_auto_events_run
  on public.q7_fg_auto_events(run_id, created_at desc);
create index if not exists idx_q7_fg_auto_runs_created
  on public.q7_fg_auto_runs(created_at desc);

alter table public.q7_fg_auto_runs enable row level security;
alter table public.q7_fg_auto_events enable row level security;

revoke all on table public.q7_fg_auto_runs from public, anon, authenticated;
revoke all on table public.q7_fg_auto_events from public, anon, authenticated;
grant select on table public.q7_fg_auto_runs to authenticated;
grant select on table public.q7_fg_auto_events to authenticated;
grant all on table public.q7_fg_auto_runs to service_role;
grant all on table public.q7_fg_auto_events to service_role;

drop policy if exists q7_fg_auto_runs_select on public.q7_fg_auto_runs;
create policy q7_fg_auto_runs_select
  on public.q7_fg_auto_runs for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner'::public.app_role)
    or public.q7_material_inventory_can_view((select auth.uid()))
  );

drop policy if exists q7_fg_auto_events_select on public.q7_fg_auto_events;
create policy q7_fg_auto_events_select
  on public.q7_fg_auto_events for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner'::public.app_role)
    or public.q7_material_inventory_can_view((select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 2. Internal helpers (deterministic request id + in-memory totals)
-- ---------------------------------------------------------------------------

create or replace function public.q7_fg_auto_request_id(
  p_kind text,
  p_production_order_item_id uuid
)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select (
    substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-' || substr(h, 13, 4)
    || '-' || substr(h, 17, 4) || '-' || substr(h, 21, 12)
  )::uuid
  from (select md5(p_kind || p_production_order_item_id::text) as h) s;
$$;

create or replace function public.q7_fg_auto_bump_totals(
  p_totals jsonb,
  p_key text,
  p_label jsonb,
  p_received_count integer,
  p_received_quantity numeric,
  p_dispatched_count integer,
  p_dispatched_quantity numeric,
  p_skipped_reason text
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb := coalesce(
    p_totals -> p_key,
    coalesce(p_label, '{}'::jsonb) || jsonb_build_object(
      'received_count', 0,
      'received_quantity', 0,
      'dispatched_count', 0,
      'dispatched_quantity', 0,
      'skipped_count', 0,
      'skipped_by_reason', '{}'::jsonb
    )
  );
begin
  v_item := jsonb_set(
    v_item,
    '{received_count}',
    to_jsonb(coalesce((v_item ->> 'received_count')::integer, 0) + coalesce(p_received_count, 0)),
    true
  );
  v_item := jsonb_set(
    v_item,
    '{received_quantity}',
    to_jsonb(coalesce((v_item ->> 'received_quantity')::numeric, 0) + coalesce(p_received_quantity, 0)),
    true
  );
  v_item := jsonb_set(
    v_item,
    '{dispatched_count}',
    to_jsonb(coalesce((v_item ->> 'dispatched_count')::integer, 0) + coalesce(p_dispatched_count, 0)),
    true
  );
  v_item := jsonb_set(
    v_item,
    '{dispatched_quantity}',
    to_jsonb(coalesce((v_item ->> 'dispatched_quantity')::numeric, 0) + coalesce(p_dispatched_quantity, 0)),
    true
  );

  if p_skipped_reason is not null then
    v_item := jsonb_set(
      v_item,
      '{skipped_count}',
      to_jsonb(coalesce((v_item ->> 'skipped_count')::integer, 0) + 1),
      true
    );
    v_item := jsonb_set(
      v_item,
      array['skipped_by_reason', p_skipped_reason],
      to_jsonb(coalesce((v_item #>> array['skipped_by_reason', p_skipped_reason])::integer, 0) + 1),
      true
    );
  end if;

  return jsonb_set(p_totals, array[p_key], v_item, true);
end;
$$;

revoke all on function public.q7_fg_auto_request_id(text, uuid) from public, anon, authenticated;
revoke all on function public.q7_fg_auto_bump_totals(jsonb, text, jsonb, integer, numeric, integer, numeric, text) from public, anon, authenticated;
grant execute on function public.q7_fg_auto_request_id(text, uuid) to service_role;
grant execute on function public.q7_fg_auto_bump_totals(jsonb, text, jsonb, integer, numeric, integer, numeric, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Daily receive + dispatch job
-- ---------------------------------------------------------------------------

create or replace function public.run_q7_fg_daily_ledger(
  p_as_of date default (now() at time zone 'Asia/Ho_Chi_Minh')::date,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_as_of date := coalesce(p_as_of, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_cutover date;
  v_run_id uuid;
  v_item record;
  v_sku_key text;
  v_sku_label jsonb;
  v_order_key text;
  v_order_label jsonb;
  v_reason text;
  v_receipt_reason text;
  v_dispatch_reason text;
  v_receipt_qty numeric;
  v_dispatch_qty numeric;
  v_on_hand numeric;
  v_receipt_request uuid;
  v_dispatch_request uuid;
  v_dispatch_date date;
  v_received_count integer := 0;
  v_received_quantity numeric := 0;
  v_dispatched_count integer := 0;
  v_dispatched_quantity numeric := 0;
  v_skipped_count integer := 0;
  v_skipped_reasons jsonb := '{}'::jsonb;
  v_items jsonb := '{}'::jsonb;
  v_orders jsonb := '{}'::jsonb;
  v_items_array jsonb := '[]'::jsonb;
  v_orders_array jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  -- The scheduler has no JWT; treat that invocation as the service role, exactly
  -- like run_tan_tao_daily_ledger. An owner JWT passes the owner gate.
  if v_actor is null and coalesce(auth.role(), '') <> 'service_role' then
    perform set_config('request.jwt.claim.role', 'service_role', true);
  end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_role(v_actor, 'owner'::public.app_role) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('q7_fg_auto_ledger', 0));

  v_cutover := public.stock_ledger_cutover_date('q7');

  -- Dry runs write nothing at all: no run row, no event, no movement.
  if not p_dry_run then
    insert into public.q7_fg_auto_runs (
      run_date, dry_run, result, created_by
    ) values (
      v_as_of, false, '{}'::jsonb, v_actor
    ) returning id into v_run_id;
  end if;

  for v_item in
    select
      poi.id as item_id,
      poi.sku_id,
      poi.planned_qty,
      poi.actual_qty,
      poi.ordered_qty,
      poi.delivery_date,
      poi.product_name,
      po.production_number,
      po.planned_start_date,
      ps.sku_code,
      coalesce(cpi.po_number, po.production_number) as po_number
    from public.production_order_items poi
    join public.production_orders po on po.id = poi.production_order_id
    left join public.product_skus ps on ps.id = poi.sku_id
    left join public.customer_po_inbox cpi on cpi.id = po.source_po_inbox_id
    where po.location_code = 'q7'
      and po.status::text <> 'cancelled'
      and po.planned_start_date is not null
      and po.planned_start_date <= v_as_of
    order by po.planned_start_date, po.production_number, poi.id
  loop
    v_reason := null;
    v_receipt_reason := null;
    v_dispatch_reason := null;
    v_receipt_qty := 0;
    v_dispatch_qty := 0;
    v_receipt_request := public.q7_fg_auto_request_id('q7-fg-receipt:', v_item.item_id);
    v_dispatch_request := public.q7_fg_auto_request_id('q7-fg-dispatch:', v_item.item_id);
    v_dispatch_date := least(
      coalesce(v_item.delivery_date, v_item.planned_start_date),
      v_as_of,
      v_today
    );
    v_sku_key := coalesce(v_item.sku_id::text, 'no-sku:' || v_item.item_id::text);
    v_sku_label := jsonb_build_object(
      'sku_id', v_item.sku_id,
      'sku_code', v_item.sku_code
    );
    v_order_key := v_item.production_number;
    v_order_label := jsonb_build_object(
      'production_number', v_item.production_number,
      'po_number', v_item.po_number,
      'planned_start_date', v_item.planned_start_date
    );

    -- A line dated on/before the Q7 count date is never posted.
    if v_cutover is null then
      v_reason := 'cutover_not_set';
    elsif v_item.planned_start_date <= v_cutover then
      v_reason := 'before_cutover';
    elsif v_item.sku_id is null then
      v_reason := 'no_sku';
    end if;

    if v_reason is not null then
      v_skipped_count := v_skipped_count + 1;
      v_skipped_reasons := jsonb_set(
        v_skipped_reasons,
        array[v_reason],
        to_jsonb(coalesce((v_skipped_reasons ->> v_reason)::integer, 0) + 1),
        true
      );
      if not p_dry_run then
        insert into public.q7_fg_auto_events (
          run_id, production_order_item_id, action, quantity, business_date, reason
        ) values (
          v_run_id, v_item.item_id, 'skipped', v_item.planned_qty,
          v_item.planned_start_date, v_reason
        )
        on conflict (action, production_order_item_id) do nothing;
      end if;
      if v_item.sku_id is not null then
        v_items := public.q7_fg_auto_bump_totals(
          v_items, v_sku_key, v_sku_label, 0, 0, 0, 0, v_reason
        );
      end if;
      v_orders := public.q7_fg_auto_bump_totals(
        v_orders, v_order_key, v_order_label, 0, 0, 0, 0, v_reason
      );
      continue;
    end if;

    -- Receipt: actual produced qty when > 0, otherwise the planned qty. A
    -- receipt movement already linked to this item (manual or a previous run)
    -- means the receipt step is skipped, but the dispatch step still runs.
    if exists (
      select 1
      from public.q7_finished_goods_movements m
      where m.movement_type = 'production_receipt'
        and (
          m.production_order_item_id = v_item.item_id
          or m.request_id = v_receipt_request
        )
    ) then
      v_receipt_reason := 'manual_receipt';
    else
      v_receipt_qty := case
        when coalesce(v_item.actual_qty, 0) > 0 then v_item.actual_qty
        else v_item.planned_qty
      end;

      if v_receipt_qty is null or v_receipt_qty <= 0 then
        v_receipt_reason := 'no_receipt_quantity';
      elsif not p_dry_run then
        begin
          perform public.create_q7_finished_goods_receipt(
            jsonb_build_array(jsonb_build_object(
              'sku_id', v_item.sku_id,
              'quantity', v_receipt_qty,
              'production_order_item_id', v_item.item_id
            )),
            'Tự nhập theo ' || v_item.production_number,
            v_receipt_request,
            v_item.planned_start_date
          );
        exception when others then
          v_receipt_reason := case
            when sqlerrm like '%finished_goods_insufficient%' then 'insufficient_stock'
            when sqlerrm like '%date_invalid%' then 'invalid_date'
            else 'receipt_failed'
          end;
        end;
      end if;
    end if;

    if v_receipt_reason is null then
      v_received_count := v_received_count + 1;
      v_received_quantity := v_received_quantity + v_receipt_qty;
      if not p_dry_run then
        insert into public.q7_fg_auto_events (
          run_id, production_order_item_id, action, quantity, business_date, reason
        ) values (
          v_run_id, v_item.item_id, 'received', v_receipt_qty,
          v_item.planned_start_date, null
        )
        on conflict (action, production_order_item_id) do nothing;
      end if;
      v_items := public.q7_fg_auto_bump_totals(
        v_items, v_sku_key, v_sku_label, 1, v_receipt_qty, 0, 0, null
      );
      v_orders := public.q7_fg_auto_bump_totals(
        v_orders, v_order_key, v_order_label, 1, v_receipt_qty, 0, 0, null
      );
    else
      v_skipped_count := v_skipped_count + 1;
      v_skipped_reasons := jsonb_set(
        v_skipped_reasons,
        array[v_receipt_reason],
        to_jsonb(coalesce((v_skipped_reasons ->> v_receipt_reason)::integer, 0) + 1),
        true
      );
      if not p_dry_run then
        insert into public.q7_fg_auto_events (
          run_id, production_order_item_id, action, quantity, business_date, reason
        ) values (
          v_run_id, v_item.item_id, 'skipped', v_receipt_qty,
          v_item.planned_start_date, v_receipt_reason
        )
        on conflict (action, production_order_item_id) do nothing;
      end if;
      v_items := public.q7_fg_auto_bump_totals(
        v_items, v_sku_key, v_sku_label, 0, 0, 0, 0, v_receipt_reason
      );
      v_orders := public.q7_fg_auto_bump_totals(
        v_orders, v_order_key, v_order_label, 0, 0, 0, 0, v_receipt_reason
      );
    end if;

    -- Dispatch: the ordered quantity, capped to the on-hand after the receipt.
    -- An existing dispatch/write-off linked to the item (or the same
    -- deterministic request id) is never repeated.
    if exists (
      select 1
      from public.q7_finished_goods_movements m
      where m.movement_type in ('dispatch', 'write_off')
        and (
          m.production_order_item_id = v_item.item_id
          or m.request_id = v_dispatch_request
        )
    ) then
      v_dispatch_reason := 'manual_dispatch';
    else
      v_dispatch_qty := coalesce(v_item.ordered_qty, 0);

      if v_dispatch_qty <= 0 then
        v_dispatch_reason := 'no_dispatch_quantity';
      else
        select coalesce(sum(m.quantity), 0) into v_on_hand
        from public.q7_finished_goods_movements m
        where m.sku_id = v_item.sku_id;

        -- A dry run must see the receipt it would have written.
        if p_dry_run and v_receipt_reason is null and v_receipt_qty > 0 then
          v_on_hand := v_on_hand + v_receipt_qty;
        end if;

        v_dispatch_qty := least(v_dispatch_qty, v_on_hand);

        if v_dispatch_qty is null or v_dispatch_qty <= 0 then
          v_dispatch_reason := 'insufficient_stock';
        elsif not p_dry_run then
          begin
            perform public.create_q7_finished_goods_issue(
              jsonb_build_array(jsonb_build_object(
                'sku_id', v_item.sku_id,
                'quantity', v_dispatch_qty
              )),
              'dispatch',
              'Tự xuất giao PO ' || v_item.po_number,
              v_dispatch_request,
              v_dispatch_date
            );
          exception when others then
            v_dispatch_reason := case
              when sqlerrm like '%finished_goods_insufficient%' then 'insufficient_stock'
              when sqlerrm like '%date_invalid%' then 'invalid_date'
              else 'dispatch_failed'
            end;
          end;
        end if;
      end if;
    end if;

    if v_dispatch_reason is null then
      v_dispatched_count := v_dispatched_count + 1;
      v_dispatched_quantity := v_dispatched_quantity + v_dispatch_qty;
      if not p_dry_run then
        insert into public.q7_fg_auto_events (
          run_id, production_order_item_id, action, quantity, business_date, reason
        ) values (
          v_run_id, v_item.item_id, 'dispatched', v_dispatch_qty,
          v_dispatch_date, null
        )
        on conflict (action, production_order_item_id) do nothing;
      end if;
      v_items := public.q7_fg_auto_bump_totals(
        v_items, v_sku_key, v_sku_label, 0, 0, 1, v_dispatch_qty, null
      );
      v_orders := public.q7_fg_auto_bump_totals(
        v_orders, v_order_key, v_order_label, 0, 0, 1, v_dispatch_qty, null
      );
    else
      v_skipped_count := v_skipped_count + 1;
      v_skipped_reasons := jsonb_set(
        v_skipped_reasons,
        array[v_dispatch_reason],
        to_jsonb(coalesce((v_skipped_reasons ->> v_dispatch_reason)::integer, 0) + 1),
        true
      );
      if not p_dry_run then
        insert into public.q7_fg_auto_events (
          run_id, production_order_item_id, action, quantity, business_date, reason
        ) values (
          v_run_id, v_item.item_id, 'skipped', v_item.ordered_qty,
          v_dispatch_date, v_dispatch_reason
        )
        on conflict (action, production_order_item_id) do nothing;
      end if;
      v_items := public.q7_fg_auto_bump_totals(
        v_items, v_sku_key, v_sku_label, 0, 0, 0, 0, v_dispatch_reason
      );
      v_orders := public.q7_fg_auto_bump_totals(
        v_orders, v_order_key, v_order_label, 0, 0, 0, 0, v_dispatch_reason
      );
    end if;
  end loop;

  select coalesce(
    jsonb_agg(entry.value order by entry.value ->> 'sku_code' nulls last, entry.key),
    '[]'::jsonb
  )
  into v_items_array
  from jsonb_each(v_items) entry;

  select coalesce(
    jsonb_agg(
      entry.value
      order by entry.value ->> 'planned_start_date', entry.value ->> 'production_number'
    ),
    '[]'::jsonb
  )
  into v_orders_array
  from jsonb_each(v_orders) entry;

  v_result := jsonb_build_object(
    'mode', 'daily',
    'as_of', v_as_of,
    'dry_run', p_dry_run,
    'cutover_date', v_cutover,
    'received_count', v_received_count,
    'received_quantity', v_received_quantity,
    'dispatched_count', v_dispatched_count,
    'dispatched_quantity', v_dispatched_quantity,
    'skipped_count', v_skipped_count,
    'skipped_by_reason', v_skipped_reasons,
    'on_hand_delta', v_received_quantity - v_dispatched_quantity,
    'items', v_items_array,
    'orders', v_orders_array,
    'run_id', v_run_id
  );

  if not p_dry_run then
    update public.q7_fg_auto_runs
    set result = v_result
    where id = v_run_id;
  end if;

  return v_result;
end;
$$;

revoke all on function public.run_q7_fg_daily_ledger(date, boolean) from public, anon, authenticated;
grant execute on function public.run_q7_fg_daily_ledger(date, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Owner / Q7-viewer readable status
-- ---------------------------------------------------------------------------

create or replace function public.get_q7_fg_auto_status(p_limit integer default 14)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 14), 1), 100);
  v_runs jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not (
       public.has_role((select auth.uid()), 'owner'::public.app_role)
       or public.q7_material_inventory_can_view((select auth.uid()))
     ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', recent.id,
      'run_date', recent.run_date,
      'dry_run', recent.dry_run,
      'created_by', recent.created_by,
      'created_at', recent.created_at,
      'result', recent.result,
      'totals', coalesce(recent.result -> 'items', '[]'::jsonb),
      'orders', coalesce(recent.result -> 'orders', '[]'::jsonb)
    ) order by recent.created_at desc, recent.id desc
  ), '[]'::jsonb)
  into v_runs
  from (
    select r.*
    from public.q7_fg_auto_runs r
    order by r.created_at desc, r.id desc
    limit v_limit
  ) recent;

  return jsonb_build_object(
    'generated_at', now(),
    'limit', v_limit,
    'runs', v_runs
  );
end;
$$;

revoke all on function public.get_q7_fg_auto_status(integer) from public, anon, authenticated;
grant execute on function public.get_q7_fg_auto_status(integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Daily schedule at 22:10 Asia/Ho_Chi_Minh (15:10 UTC)
-- ---------------------------------------------------------------------------

do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'q7-fg-daily-ledger'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'q7-fg-daily-ledger',
    '10 15 * * *',
    $job$ select public.run_q7_fg_daily_ledger(); $job$
  );
end;
$$;
