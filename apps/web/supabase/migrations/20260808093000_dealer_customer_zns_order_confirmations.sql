-- Transactional customer ZBS confirmation outbox for future dealer orders.
-- The feature stays disabled until the provider approves the dedicated template.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

insert into public.app_settings (key, value)
values ('dealer_order_confirmation_enabled', 'false')
on conflict (key) do nothing;

create table if not exists public.dealer_customer_order_confirmations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.dealer_orders(id) on delete cascade,
  contact_id uuid references public.dealer_customer_contacts(id) on delete set null,
  channel text not null default 'zalo_zbs',
  template_key text not null default 'dealer_order_confirmation_v1',
  payload jsonb not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  message_id text,
  provider_response jsonb,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, channel),
  constraint dealer_customer_order_confirmations_channel_check
    check (channel = 'zalo_zbs'),
  constraint dealer_customer_order_confirmations_template_check
    check (template_key = 'dealer_order_confirmation_v1'),
  constraint dealer_customer_order_confirmations_status_check
    check (status in ('pending', 'processing', 'send_committed', 'sent', 'failed', 'suppressed')),
  constraint dealer_customer_order_confirmations_attempts_check
    check (attempt_count >= 0 and max_attempts between 1 and 10),
  constraint dealer_customer_order_confirmations_payload_check
    check (
      jsonb_typeof(payload) = 'object'
      and payload ?& array[
        'customer_name', 'order_number', 'submitted_at', 'requested_delivery_date',
        'ordered_quantity', 'exchange_quantity', 'makeup_quantity',
        'physical_quantity', 'total_amount_vnd'
      ]
      and length(payload::text) <= 8000
    )
);

create index if not exists dealer_customer_order_confirmations_retry_idx
  on public.dealer_customer_order_confirmations(status, next_attempt_at, created_at)
  where status in ('pending', 'processing');

alter table public.dealer_customer_order_confirmations enable row level security;
revoke all on table public.dealer_customer_order_confirmations from public, anon, authenticated;
grant select, insert, update on table public.dealer_customer_order_confirmations to service_role;

-- Runs inside the authoritative order transaction. The RPC inserts order items one
-- at a time, so this idempotently refreshes the same outbox row until final totals
-- are present. Workers cannot see the row until the source transaction commits.
create or replace function public.queue_dealer_customer_order_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.dealer_orders%rowtype;
  v_enabled boolean := false;
  v_ordered numeric := 0;
  v_exchange numeric := 0;
  v_makeup numeric := 0;
  v_physical numeric := 0;
  v_status text;
  v_error text;
begin
  select lower(trim(value)) in ('true', '1', 'yes', 'enabled')
    into v_enabled
  from public.app_settings
  where key = 'dealer_order_confirmation_enabled';

  if not coalesce(v_enabled, false) then
    return new;
  end if;

  select * into v_order
  from public.dealer_orders
  where id = new.order_id;

  if not found or v_order.status <> 'submitted' then
    return new;
  end if;

  select
    coalesce(sum(coalesce(i.ordered_quantity, i.quantity)), 0),
    coalesce(sum(i.exchange_quantity), 0),
    coalesce(sum(i.makeup_quantity), 0),
    coalesce(sum(coalesce(
      i.physical_quantity,
      coalesce(i.ordered_quantity, i.quantity) + i.exchange_quantity + i.makeup_quantity
    )), 0)
  into v_ordered, v_exchange, v_makeup, v_physical
  from public.dealer_order_items i
  where i.order_id = v_order.id;

  v_status := case when v_order.contact_id is null then 'suppressed' else 'pending' end;
  v_error := case when v_order.contact_id is null then 'order_contact_missing' else null end;

  insert into public.dealer_customer_order_confirmations (
    order_id, contact_id, channel, template_key, payload, status, last_error
  ) values (
    v_order.id,
    v_order.contact_id,
    'zalo_zbs',
    'dealer_order_confirmation_v1',
    jsonb_build_object(
      'customer_name', coalesce(v_order.customer_snapshot->>'name', 'Khách hàng BMQ'),
      'order_number', v_order.order_number,
      'submitted_at', v_order.submitted_at,
      'requested_delivery_date', v_order.requested_delivery_date,
      'ordered_quantity', v_ordered,
      'exchange_quantity', v_exchange,
      'makeup_quantity', v_makeup,
      'physical_quantity', v_physical,
      'total_amount_vnd', v_order.total_amount_vnd
    ),
    v_status,
    v_error
  )
  on conflict (order_id, channel) do update
    set contact_id = excluded.contact_id,
        payload = excluded.payload,
        status = excluded.status,
        last_error = excluded.last_error,
        updated_at = now()
  where public.dealer_customer_order_confirmations.status in ('pending', 'suppressed');

  return new;
end;
$$;

revoke all on function public.queue_dealer_customer_order_confirmation() from public;
revoke all on function public.queue_dealer_customer_order_confirmation() from anon;
revoke all on function public.queue_dealer_customer_order_confirmation() from authenticated;
grant execute on function public.queue_dealer_customer_order_confirmation() to service_role;

drop trigger if exists trg_queue_dealer_customer_order_confirmation on public.dealer_order_items;
create trigger trg_queue_dealer_customer_order_confirmation
after insert on public.dealer_order_items
for each row execute function public.queue_dealer_customer_order_confirmation();

create or replace function public.suppress_non_submitted_dealer_customer_order_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'submitted' and old.status is distinct from new.status then
    update public.dealer_customer_order_confirmations
    set status = 'suppressed',
        locked_at = null,
        last_error = 'order_not_submitted_before_send',
        updated_at = now()
    where order_id = new.id
      and status in ('pending', 'processing');
  end if;
  return new;
end;
$$;

revoke all on function public.suppress_non_submitted_dealer_customer_order_confirmation() from public;
revoke all on function public.suppress_non_submitted_dealer_customer_order_confirmation() from anon;
revoke all on function public.suppress_non_submitted_dealer_customer_order_confirmation() from authenticated;
grant execute on function public.suppress_non_submitted_dealer_customer_order_confirmation() to service_role;

drop trigger if exists trg_suppress_non_submitted_dealer_customer_order_confirmation on public.dealer_orders;
create trigger trg_suppress_non_submitted_dealer_customer_order_confirmation
after update of status on public.dealer_orders
for each row execute function public.suppress_non_submitted_dealer_customer_order_confirmation();

create or replace function public.claim_dealer_customer_order_confirmations(batch_size integer default 10)
returns table (
  id uuid,
  order_id uuid,
  contact_id uuid,
  template_key text,
  payload jsonb,
  attempt_count integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.dealer_customer_order_confirmations n
  set status = 'suppressed',
      locked_at = null,
      last_error = 'order_not_submitted_before_send',
      updated_at = now()
  from public.dealer_orders o
  where o.id = n.order_id
    and o.status <> 'submitted'
    and n.status in ('pending', 'processing');

  return query
  with picked as (
    select n.id
    from public.dealer_customer_order_confirmations n
    join public.dealer_orders o on o.id = n.order_id
    where n.channel = 'zalo_zbs'
      and o.status = 'submitted'
      and n.contact_id is not null
      and n.attempt_count < n.max_attempts
      and n.next_attempt_at <= now()
      and n.status = 'pending'
    order by n.created_at asc
    for update of n skip locked
    limit greatest(1, least(coalesce(batch_size, 10), 50))
  ), claimed as (
    update public.dealer_customer_order_confirmations n
    set status = 'processing',
        attempt_count = n.attempt_count + 1,
        locked_at = now(),
        updated_at = now()
    from picked
    where n.id = picked.id
    returning n.*
  )
  select
    claimed.id,
    claimed.order_id,
    claimed.contact_id,
    claimed.template_key,
    claimed.payload,
    claimed.attempt_count,
    claimed.max_attempts
  from claimed;
end;
$$;

revoke all on function public.claim_dealer_customer_order_confirmations(integer) from public;
revoke all on function public.claim_dealer_customer_order_confirmations(integer) from anon;
revoke all on function public.claim_dealer_customer_order_confirmations(integer) from authenticated;
grant execute on function public.claim_dealer_customer_order_confirmations(integer) to service_role;

create or replace function public.commit_dealer_customer_order_confirmation_send(p_confirmation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  committed boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.dealer_customer_order_confirmations n
  set status = 'send_committed',
      updated_at = now()
  where n.id = p_confirmation_id
    and n.status = 'processing'
    and exists (
      select 1
      from public.dealer_orders o
      where o.id = n.order_id
        and o.status = 'submitted'
    )
  returning true into committed;

  return coalesce(committed, false);
end;
$$;

revoke all on function public.commit_dealer_customer_order_confirmation_send(uuid) from public;
revoke all on function public.commit_dealer_customer_order_confirmation_send(uuid) from anon;
revoke all on function public.commit_dealer_customer_order_confirmation_send(uuid) from authenticated;
grant execute on function public.commit_dealer_customer_order_confirmation_send(uuid) to service_role;

-- Reuse the existing internal worker secret. Provider credentials and the
-- approved template ID remain Edge Function secrets, never database values.
do $schedule$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'dealer-order-confirm-notify-every-minute'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'dealer-order-confirm-notify-every-minute',
    '* * * * *',
    $job$
      select net.http_post(
        url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/dealer-order-confirm-notify',
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-worker-secret', (
            select worker_secret::text
            from public.dealer_notification_worker_config
            where id = 'warehouse-zalo'
          )
        ),
        body := jsonb_build_object('batch_size', 10),
        timeout_milliseconds := 10000
      );
    $job$
  );
end;
$schedule$;
