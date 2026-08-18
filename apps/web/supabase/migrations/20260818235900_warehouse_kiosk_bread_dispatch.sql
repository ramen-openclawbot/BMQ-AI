-- Queue one compact, idempotent kiosk bread-dispatch message to Kho Tan Tao
-- at the same 23:59 Asia/Ho_Chi_Minh cutoff as the existing daily summaries.
-- Order quantities come from the existing automatic kiosk forecast. Makeup and
-- exchange evidence remain separate and come from the submitted kiosk report.

alter table public.dealer_order_notifications
  drop constraint if exists dealer_order_notifications_type_check;

alter table public.dealer_order_notifications
  add constraint dealer_order_notifications_type_check check (
    (notification_type = 'order' and order_id is not null and digest_date is null)
    or
    (
      notification_type in (
        'daily_dealer_digest',
        'daily_point_digest',
        'production_bread_order',
        'production_bread_order_correction',
        'warehouse_kiosk_bread_dispatch'
      )
      and order_id is null
      and digest_date is not null
    )
  );

drop index if exists public.dealer_order_notifications_daily_digest_unique_idx;
create unique index dealer_order_notifications_daily_digest_unique_idx
  on public.dealer_order_notifications (digest_date, channel, notification_type)
  where notification_type in (
    'daily_dealer_digest',
    'daily_point_digest',
    'production_bread_order',
    'warehouse_kiosk_bread_dispatch'
  );

create or replace function public.upsert_warehouse_kiosk_bread_dispatch(
  p_order_date date,
  p_message_body text,
  p_source_snapshot jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_order_date is null
     or nullif(btrim(p_message_body), '') is null
     or p_source_snapshot is null
     or p_source_snapshot->>'source' is distinct from 'baocao.banhmique.vn'
     or p_source_snapshot->>'order_date' is distinct from p_order_date::text then
    raise exception 'valid order date, message body, and kiosk source snapshot are required' using errcode = '22023';
  end if;

  insert into public.dealer_order_notifications (
    order_id,
    notification_type,
    digest_date,
    channel,
    group_name,
    message_body,
    source_snapshot,
    status,
    attempt_count,
    max_attempts,
    next_attempt_at
  ) values (
    null,
    'warehouse_kiosk_bread_dispatch',
    p_order_date,
    'zalo_gmf',
    'BMQ - Kho Tân Tạo',
    p_message_body,
    p_source_snapshot,
    'pending',
    0,
    5,
    now()
  )
  on conflict (digest_date, channel, notification_type)
    where notification_type in (
      'daily_dealer_digest',
      'daily_point_digest',
      'production_bread_order',
      'warehouse_kiosk_bread_dispatch'
    )
  do update set
    message_body = excluded.message_body,
    source_snapshot = excluded.source_snapshot,
    status = 'pending',
    attempt_count = 0,
    last_error = null,
    next_attempt_at = now(),
    locked_at = null,
    updated_at = now()
  where public.dealer_order_notifications.status in ('pending', 'failed')
  returning id into v_id;

  if v_id is null then
    select id into v_id
    from public.dealer_order_notifications
    where digest_date = p_order_date
      and channel = 'zalo_gmf'
      and notification_type = 'warehouse_kiosk_bread_dispatch';
  end if;

  return v_id;
end;
$$;

revoke all on function public.upsert_warehouse_kiosk_bread_dispatch(date, text, jsonb) from public;
revoke all on function public.upsert_warehouse_kiosk_bread_dispatch(date, text, jsonb) from anon;
revoke all on function public.upsert_warehouse_kiosk_bread_dispatch(date, text, jsonb) from authenticated;
grant execute on function public.upsert_warehouse_kiosk_bread_dispatch(date, text, jsonb) to service_role;

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
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with selected as (
    select n.id
    from public.dealer_order_notifications n
    where n.channel = 'zalo_gmf'
      and n.attempt_count < n.max_attempts
      and n.next_attempt_at <= now()
      and (
        n.status = 'pending'
        or (
          n.status = 'processing'
          and n.locked_at < now() - interval '15 minutes'
        )
      )
    order by
      case when n.notification_type in (
        'daily_dealer_digest',
        'daily_point_digest',
        'production_bread_order',
        'warehouse_kiosk_bread_dispatch'
      ) then 0 else 1 end,
      n.created_at asc,
      n.notification_type asc
    for update skip locked
    limit greatest(1, least(coalesce(batch_size, 10), 50))
  ), updated as (
    update public.dealer_order_notifications n
    set status = 'processing',
        locked_at = now(),
        attempt_count = n.attempt_count + 1,
        updated_at = now()
    from selected
    where n.id = selected.id
    returning n.*
  )
  select
    updated.id,
    updated.order_id,
    updated.channel,
    updated.group_name,
    updated.message_body,
    updated.attempt_count,
    updated.max_attempts
  from updated
  order by
    case when updated.notification_type in (
      'daily_dealer_digest',
      'daily_point_digest',
      'production_bread_order',
      'warehouse_kiosk_bread_dispatch'
    ) then 0 else 1 end,
    updated.created_at asc,
    updated.notification_type asc;
end;
$$;

revoke all on function public.claim_dealer_order_notifications(integer) from public;
revoke all on function public.claim_dealer_order_notifications(integer) from anon;
revoke all on function public.claim_dealer_order_notifications(integer) from authenticated;
grant execute on function public.claim_dealer_order_notifications(integer) to service_role;
