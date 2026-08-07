-- Temporarily pause the Kho Tan Tao point-of-sale digest while kiosk staff
-- build a reliable submitted inventory history. Dealer digests stay enabled;
-- kiosk report collection and submitted history are not changed.

alter table public.dealer_notification_worker_config
  add column if not exists daily_point_digest_enabled boolean not null default false;

comment on column public.dealer_notification_worker_config.daily_point_digest_enabled is
  'Operational kill switch for daily_point_digest. Keep false during kiosk inventory learning.';

update public.dealer_notification_worker_config
set daily_point_digest_enabled = false
where id = 'warehouse-zalo';

create or replace function public.upsert_dealer_warehouse_daily_digests(
  p_digest_date date,
  p_dealer_message_body text,
  p_point_message_body text
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
  result_ids uuid[];
  v_point_digest_enabled boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(daily_point_digest_enabled, false)
    into v_point_digest_enabled
  from public.dealer_notification_worker_config
  where id = 'warehouse-zalo';

  if p_digest_date is null
     or nullif(btrim(p_dealer_message_body), '') is null
     or (v_point_digest_enabled and nullif(btrim(p_point_message_body), '') is null) then
    raise exception 'digest date and enabled message bodies are required' using errcode = '22023';
  end if;

  with digest_candidates as (
    select
      'daily_dealer_digest'::text as notification_type,
      p_dealer_message_body as message_body
    union all
    select
      'daily_point_digest'::text,
      p_point_message_body
    where v_point_digest_enabled
  ), upserted as (
    insert into public.dealer_order_notifications (
      order_id,
      notification_type,
      digest_date,
      channel,
      group_name,
      message_body,
      status,
      attempt_count,
      max_attempts,
      next_attempt_at
    )
    select
      null,
      candidate.notification_type,
      p_digest_date,
      'zalo_gmf',
      'BMQ - Kho Tân Tạo',
      candidate.message_body,
      'pending',
      0,
      5,
      now()
    from digest_candidates candidate
    on conflict (digest_date, channel, notification_type)
      where notification_type in ('daily_dealer_digest', 'daily_point_digest')
    do update set
      message_body = excluded.message_body,
      status = 'pending',
      attempt_count = 0,
      last_error = null,
      next_attempt_at = now(),
      locked_at = null,
      updated_at = now()
    where dealer_order_notifications.status in ('pending', 'failed')
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[])
    into result_ids
  from upserted;

  return result_ids;
end;
$$;

revoke all on function public.upsert_dealer_warehouse_daily_digests(date, text, text) from public;
revoke all on function public.upsert_dealer_warehouse_daily_digests(date, text, text) from anon;
revoke all on function public.upsert_dealer_warehouse_daily_digests(date, text, text) from authenticated;
grant execute on function public.upsert_dealer_warehouse_daily_digests(date, text, text) to service_role;

-- Retain audit rows but make every unsent point digest terminal so the worker
-- cannot pick it up after this migration. Sent evidence remains immutable.
update public.dealer_order_notifications
set status = 'failed',
    last_error = 'paused_for_kiosk_inventory_learning',
    locked_at = null,
    next_attempt_at = now(),
    updated_at = now()
where notification_type = 'daily_point_digest'
  and status in ('pending', 'processing');
