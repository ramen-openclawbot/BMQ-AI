create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table if not exists public.dealer_notification_worker_config (
  id text primary key,
  worker_secret uuid not null default gen_random_uuid(),
  zalo_access_token text,
  zalo_refresh_token text,
  zalo_access_token_expires_at timestamptz,
  zalo_refresh_lock_id uuid,
  zalo_refresh_locked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint dealer_notification_worker_config_id_check
    check (id = 'warehouse-zalo')
);

insert into public.dealer_notification_worker_config (id)
values ('warehouse-zalo')
on conflict (id) do nothing;

alter table public.dealer_notification_worker_config enable row level security;
revoke all on table public.dealer_notification_worker_config from public, anon, authenticated;
grant select, update on table public.dealer_notification_worker_config to service_role;

create or replace function public.claim_zalo_oauth_refresh_lock(p_lock_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_rows integer;
begin
  update public.dealer_notification_worker_config
  set zalo_refresh_lock_id = p_lock_id,
      zalo_refresh_locked_at = now()
  where id = 'warehouse-zalo'
    and (
      zalo_refresh_lock_id is null
      or zalo_refresh_locked_at < now() - interval '2 minutes'
    );
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

create or replace function public.release_zalo_oauth_refresh_lock(p_lock_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.dealer_notification_worker_config
  set zalo_refresh_lock_id = null,
      zalo_refresh_locked_at = null
  where id = 'warehouse-zalo'
    and zalo_refresh_lock_id = p_lock_id;
$$;

revoke all on function public.claim_zalo_oauth_refresh_lock(uuid) from public;
revoke all on function public.claim_zalo_oauth_refresh_lock(uuid) from anon;
revoke all on function public.claim_zalo_oauth_refresh_lock(uuid) from authenticated;
grant execute on function public.claim_zalo_oauth_refresh_lock(uuid) to service_role;

revoke all on function public.release_zalo_oauth_refresh_lock(uuid) from public;
revoke all on function public.release_zalo_oauth_refresh_lock(uuid) from anon;
revoke all on function public.release_zalo_oauth_refresh_lock(uuid) from authenticated;
grant execute on function public.release_zalo_oauth_refresh_lock(uuid) to service_role;

create table if not exists public.dealer_order_notifications (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.dealer_orders(id) on delete cascade,
  channel text not null default 'zalo_gmf',
  group_name text not null,
  message_body text not null,
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
  constraint dealer_order_notifications_channel_check
    check (channel in ('zalo_gmf')),
  constraint dealer_order_notifications_status_check
    check (status in ('pending', 'processing', 'sent', 'failed')),
  constraint dealer_order_notifications_attempts_check
    check (attempt_count >= 0 and max_attempts between 1 and 10),
  constraint dealer_order_notifications_message_check
    check (length(message_body) between 1 and 10000)
);

create index if not exists dealer_order_notifications_retry_idx
  on public.dealer_order_notifications(status, next_attempt_at, created_at)
  where status in ('pending', 'processing');

alter table public.dealer_order_notifications enable row level security;
revoke all on table public.dealer_order_notifications from public, anon, authenticated;
grant select, insert, update on table public.dealer_order_notifications to service_role;

-- No client RLS policies: this outbox is service-role only.
create or replace function public.claim_dealer_order_notifications(batch_size integer default 10)
returns table (
  id uuid,
  order_id uuid,
  channel text,
  group_name text,
  message_body text,
  attempt_count integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select notification.id
    from public.dealer_order_notifications notification
    where notification.channel = 'zalo_gmf'
      and notification.attempt_count < notification.max_attempts
      and notification.next_attempt_at <= now()
      and (
        notification.status = 'pending'
        or (
          notification.status = 'processing'
          and notification.locked_at < now() - interval '15 minutes'
        )
      )
    order by notification.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(batch_size, 10), 50))
  ), claimed as (
    update public.dealer_order_notifications notification
    set status = 'processing',
        attempt_count = notification.attempt_count + 1,
        locked_at = now(),
        updated_at = now()
    from picked
    where notification.id = picked.id
    returning notification.id,
              notification.order_id,
              notification.channel,
              notification.group_name,
              notification.message_body,
              notification.attempt_count,
              notification.max_attempts
  )
  select claimed.id,
         claimed.order_id,
         claimed.channel,
         claimed.group_name,
         claimed.message_body,
         claimed.attempt_count,
         claimed.max_attempts
  from claimed;
end;
$$;

revoke all on function public.claim_dealer_order_notifications(integer) from public;
revoke all on function public.claim_dealer_order_notifications(integer) from anon;
revoke all on function public.claim_dealer_order_notifications(integer) from authenticated;
grant execute on function public.claim_dealer_order_notifications(integer) to service_role;

do $schedule$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid
    from cron.job
    where jobname = 'dealer-warehouse-notify-every-2-minutes'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'dealer-warehouse-notify-every-2-minutes',
    '*/2 * * * *',
    $job$
      select net.http_post(
        url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/dealer-warehouse-notify',
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
