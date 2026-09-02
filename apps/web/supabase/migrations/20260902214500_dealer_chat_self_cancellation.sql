-- Customer self-cancellation for same-Vietnam-day dealer orders.
-- Service-role-only RPCs keep customer identity server-derived by the Edge Function.

create table if not exists public.dealer_order_cancellation_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.dealer_orders(id) on delete restrict,
  customer_id uuid not null references public.mini_crm_customers(id) on delete restrict,
  contact_id uuid references public.dealer_customer_contacts(id) on delete set null,
  session_id uuid references public.dealer_sessions(id) on delete set null,
  source text not null default 'dealer_portal',
  previous_status text not null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint dealer_order_cancellation_events_order_unique unique (order_id),
  constraint dealer_order_cancellation_events_source_check check (source in ('dealer_portal', 'operator'))
);

alter table public.dealer_order_cancellation_events enable row level security;
revoke all on table public.dealer_order_cancellation_events from public, anon, authenticated;
grant select, insert on table public.dealer_order_cancellation_events to service_role;

alter table public.dealer_order_notifications
  drop constraint if exists dealer_order_notifications_status_check;
alter table public.dealer_order_notifications
  add constraint dealer_order_notifications_status_check
  check (status in ('pending', 'processing', 'sent', 'failed', 'pending_owner_review', 'cancelled'));

create index if not exists dealer_order_cancellation_events_customer_created_idx
  on public.dealer_order_cancellation_events (customer_id, created_at desc);

create or replace function public.dealer_self_cancellable_orders(
  p_customer_id uuid,
  p_is_test boolean
)
returns table (
  id uuid,
  order_number text,
  submitted_at timestamptz,
  requested_delivery_date date,
  physical_quantity numeric,
  total_amount_vnd numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select
      date_trunc('day', timezone('Asia/Ho_Chi_Minh', now())) at time zone 'Asia/Ho_Chi_Minh' as starts_at,
      (date_trunc('day', timezone('Asia/Ho_Chi_Minh', now())) + interval '1 day') at time zone 'Asia/Ho_Chi_Minh' as ends_at
  )
  select
    o.id,
    o.order_number,
    o.submitted_at,
    o.requested_delivery_date,
    coalesce(sum(coalesce(i.physical_quantity, coalesce(i.ordered_quantity, i.quantity) + i.exchange_quantity + i.makeup_quantity)), 0)::numeric as physical_quantity,
    o.total_amount_vnd
  from public.dealer_orders o
  cross join bounds b
  join public.dealer_order_items i on i.order_id = o.id
  where o.customer_id = p_customer_id
    and o.is_test = p_is_test
    and o.status = 'submitted'
    and o.submitted_at >= b.starts_at
    and o.submitted_at < b.ends_at
    and not exists (
      select 1
      from public.dealer_order_items revenue_item
      join public.revenue_ledger_lines ledger
        on ledger.raw_payload->>'dealer_order_item_id' = revenue_item.id::text
      where revenue_item.order_id = o.id
        and (ledger.approval_status <> 'superseded' or ledger.approval_status is null)
    )
    and not exists (
      select 1
      from public.tan_tao_warehouse_reservations reservation
      where reservation.source_type = 'dealer_order'
        and reservation.source_id = o.id
        and reservation.status = 'dispatched'
    )
    and (
      p_is_test = true
      or not exists (
        select 1
        from public.dealer_order_notifications supplier_notice
        where supplier_notice.notification_type = 'production_bread_order'
          and supplier_notice.digest_date = o.requested_delivery_date
      )
    )
  group by o.id, o.order_number, o.submitted_at, o.requested_delivery_date, o.total_amount_vnd
  order by o.submitted_at desc
  limit 20;
$$;

revoke all on function public.dealer_self_cancellable_orders(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.dealer_self_cancellable_orders(uuid, boolean)
  to service_role;

create or replace function public.cancel_dealer_orders_from_portal(
  p_customer_id uuid,
  p_contact_id uuid,
  p_session_id uuid,
  p_is_test boolean,
  p_order_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_ids uuid[];
  v_requested_count integer;
  v_owned_count integer;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_cancelled_count integer;
  v_total_quantity numeric;
  v_total_amount numeric;
  v_orders jsonb;
begin
  select coalesce(array_agg(distinct requested_id order by requested_id), '{}'::uuid[])
    into v_order_ids
  from unnest(coalesce(p_order_ids, '{}'::uuid[])) requested_id;

  v_requested_count := cardinality(v_order_ids);
  if v_requested_count < 1 or v_requested_count > 20 then
    raise exception 'invalid_self_cancel_selection' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from public.dealer_sessions session_row
    join public.dealer_customer_contacts contact_row
      on contact_row.id = session_row.contact_id
    where session_row.id = p_session_id
      and session_row.customer_id = p_customer_id
      and session_row.contact_id = p_contact_id
      and session_row.revoked_at is null
      and session_row.expires_at > now()
      and contact_row.is_active = true
      and contact_row.is_test = p_is_test
  ) then
    raise exception 'self_cancel_session_invalid' using errcode = 'P0001';
  end if;

  v_day_start := date_trunc('day', timezone('Asia/Ho_Chi_Minh', now())) at time zone 'Asia/Ho_Chi_Minh';
  v_day_end := (date_trunc('day', timezone('Asia/Ho_Chi_Minh', now())) + interval '1 day') at time zone 'Asia/Ho_Chi_Minh';

  perform o.id
  from public.dealer_orders o
  where o.id = any(v_order_ids)
  order by o.id
  for update;

  -- Serialize against warehouse dispatch before checking dispatch eligibility.
  -- The existing dealer-order cancellation trigger releases active reservations
  -- after the order status changes, in this same transaction.
  perform reservation.id
  from public.tan_tao_warehouse_reservations reservation
  where reservation.source_type = 'dealer_order'
    and reservation.source_id = any(v_order_ids)
  order by reservation.id
  for update of reservation;

  -- Prevent the outbox worker from claiming a pending notice while cancellation
  -- is being committed. A notice already in flight fails closed below.
  perform notification.id
  from public.dealer_order_notifications notification
  where notification.order_id = any(v_order_ids)
    and notification.notification_type = 'order'
  order by notification.id
  for update of notification;

  select count(*)
    into v_owned_count
  from public.dealer_orders o
  where o.id = any(v_order_ids)
    and o.customer_id = p_customer_id
    and o.is_test = p_is_test
    and o.submitted_at >= v_day_start
    and o.submitted_at < v_day_end;

  if v_owned_count <> v_requested_count then
    raise exception 'self_cancel_order_not_owned_or_expired' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.dealer_orders o
    where o.id = any(v_order_ids)
      and o.status not in ('submitted', 'cancelled')
  ) then
    raise exception 'self_cancel_order_not_cancellable' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.dealer_orders o
    where o.id = any(v_order_ids)
      and o.status = 'cancelled'
      and not exists (
        select 1
        from public.dealer_order_cancellation_events event
        where event.order_id = o.id
          and event.customer_id = p_customer_id
          and event.source = 'dealer_portal'
      )
  ) then
    raise exception 'self_cancel_order_already_handled' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.dealer_orders o
    join public.dealer_order_items item on item.order_id = o.id
    join public.revenue_ledger_lines ledger
      on ledger.raw_payload->>'dealer_order_item_id' = item.id::text
    where o.id = any(v_order_ids)
      and o.status = 'submitted'
      and (ledger.approval_status <> 'superseded' or ledger.approval_status is null)
  ) then
    raise exception 'self_cancel_revenue_already_recorded' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.dealer_orders o
    join public.tan_tao_warehouse_reservations reservation
      on reservation.source_type = 'dealer_order'
     and reservation.source_id = o.id
    where o.id = any(v_order_ids)
      and o.status = 'submitted'
      and reservation.status = 'dispatched'
  ) then
    raise exception 'self_cancel_order_already_dispatched' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.dealer_order_notifications notification
    where notification.order_id = any(v_order_ids)
      and notification.notification_type = 'order'
      and notification.status = 'processing'
  ) then
    raise exception 'self_cancel_notification_in_flight' using errcode = 'P0001';
  end if;

  if p_is_test = false and exists (
    select 1
    from public.dealer_orders o
    join public.dealer_order_notifications supplier_notice
      on supplier_notice.notification_type = 'production_bread_order'
     and supplier_notice.digest_date = o.requested_delivery_date
    where o.id = any(v_order_ids)
      and o.status = 'submitted'
  ) then
    raise exception 'self_cancel_supplier_order_finalized' using errcode = 'P0001';
  end if;

  with selected_totals as (
    select
      o.id,
      o.order_number,
      o.submitted_at,
      o.requested_delivery_date,
      o.total_amount_vnd,
      coalesce(sum(coalesce(i.physical_quantity, coalesce(i.ordered_quantity, i.quantity) + i.exchange_quantity + i.makeup_quantity)), 0)::numeric as physical_quantity
    from public.dealer_orders o
    join public.dealer_order_items i on i.order_id = o.id
    where o.id = any(v_order_ids)
    group by o.id, o.order_number, o.submitted_at, o.requested_delivery_date, o.total_amount_vnd
  )
  select
    coalesce(sum(physical_quantity), 0),
    coalesce(sum(total_amount_vnd), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'order_number', order_number,
      'submitted_at', submitted_at,
      'requested_delivery_date', requested_delivery_date,
      'physical_quantity', physical_quantity,
      'total_amount_vnd', total_amount_vnd
    ) order by submitted_at desc), '[]'::jsonb)
  into v_total_quantity, v_total_amount, v_orders
  from selected_totals;

  update public.dealer_order_notifications
  set status = 'cancelled',
      locked_at = null,
      last_error = 'cancelled_by_dealer_portal',
      updated_at = now()
  where order_id = any(v_order_ids)
    and notification_type = 'order'
    and status in ('pending', 'failed');

  update public.dealer_orders
  set status = 'cancelled',
      updated_at = now()
  where id = any(v_order_ids)
    and status = 'submitted';
  get diagnostics v_cancelled_count = row_count;

  insert into public.dealer_order_cancellation_events (
    order_id,
    customer_id,
    contact_id,
    session_id,
    source,
    previous_status,
    metadata
  )
  select
    o.id,
    p_customer_id,
    p_contact_id,
    p_session_id,
    'dealer_portal',
    'submitted',
    jsonb_build_object(
      'time_zone', 'Asia/Ho_Chi_Minh',
      'requested_delivery_date', o.requested_delivery_date,
      'is_test', p_is_test
    )
  from public.dealer_orders o
  where o.id = any(v_order_ids)
  on conflict (order_id) do nothing;

  update public.tan_tao_warehouse_documents document
  set metadata = coalesce(document.metadata, '{}'::jsonb) || jsonb_build_object(
    'cancelled_by', 'dealer_portal',
    'dealer_contact_id', p_contact_id,
    'dealer_session_id', p_session_id
  )
  where document.idempotency_key = any(
    select 'dealer-order-cancellation:' || selected_id::text
    from unnest(v_order_ids) selected_id
  );

  return jsonb_build_object(
    'cancelled_count', v_cancelled_count,
    'selected_count', v_requested_count,
    'physical_quantity', v_total_quantity,
    'total_amount_vnd', v_total_amount,
    'orders', v_orders
  );
end;
$$;

revoke all on function public.cancel_dealer_orders_from_portal(uuid, uuid, uuid, boolean, uuid[])
  from public, anon, authenticated;
grant execute on function public.cancel_dealer_orders_from_portal(uuid, uuid, uuid, boolean, uuid[])
  to service_role;
