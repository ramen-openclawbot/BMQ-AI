-- Add two one-per-Vietnam-day warehouse digests to the existing private outbox.

alter table public.dealer_order_notifications
  alter column order_id drop not null;

alter table public.dealer_order_notifications
  add column if not exists notification_type text not null default 'order',
  add column if not exists digest_date date;

alter table public.dealer_order_notifications
  drop constraint if exists dealer_order_notifications_type_check;

alter table public.dealer_order_notifications
  add constraint dealer_order_notifications_type_check check (
    (notification_type = 'order' and order_id is not null and digest_date is null)
    or
    (
      notification_type in ('daily_dealer_digest', 'daily_point_digest')
      and order_id is null
      and digest_date is not null
    )
  );

drop index if exists public.dealer_order_notifications_daily_digest_unique_idx;
create unique index dealer_order_notifications_daily_digest_unique_idx
  on public.dealer_order_notifications (digest_date, channel, notification_type)
  where notification_type in ('daily_dealer_digest', 'daily_point_digest');

-- Queue both summaries in one transaction: either the dealer and point-of-sale
-- messages are both prepared, or neither is. Sent rows are never reset.
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
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_digest_date is null
     or nullif(btrim(p_dealer_message_body), '') is null
     or nullif(btrim(p_point_message_body), '') is null then
    raise exception 'digest date and both message bodies are required' using errcode = '22023';
  end if;

  with upserted as (
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
    ) values
      (
        null,
        'daily_dealer_digest',
        p_digest_date,
        'zalo_gmf',
        'BMQ - Kho Tân Tạo',
        p_dealer_message_body,
        'pending',
        0,
        5,
        now()
      ),
      (
        null,
        'daily_point_digest',
        p_digest_date,
        'zalo_gmf',
        'BMQ - Kho Tân Tạo',
        p_point_message_body,
        'pending',
        0,
        5,
        now()
      )
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

-- Remove the superseded single-message helper if an earlier local migration draft ran.
drop function if exists public.upsert_dealer_warehouse_daily_digest(date, text);

revoke all on function public.upsert_dealer_warehouse_daily_digests(date, text, text) from public;
revoke all on function public.upsert_dealer_warehouse_daily_digests(date, text, text) from anon;
revoke all on function public.upsert_dealer_warehouse_daily_digests(date, text, text) from authenticated;
grant execute on function public.upsert_dealer_warehouse_daily_digests(date, text, text) to service_role;

-- Both daily summaries are claimed before ordinary jobs in the final scan. Older
-- order jobs otherwise retain FIFO ordering. SKIP LOCKED preserves concurrency.
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
  if auth.role() <> 'service_role' then
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
      case when n.notification_type in ('daily_dealer_digest', 'daily_point_digest') then 0 else 1 end,
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
    case when updated.notification_type in ('daily_dealer_digest', 'daily_point_digest') then 0 else 1 end,
    updated.created_at asc,
    updated.notification_type asc;
end;
$$;

revoke all on function public.claim_dealer_order_notifications(integer) from public;
revoke all on function public.claim_dealer_order_notifications(integer) from anon;
revoke all on function public.claim_dealer_order_notifications(integer) from authenticated;
grant execute on function public.claim_dealer_order_notifications(integer) to service_role;
