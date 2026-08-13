-- Claim exactly one owner-approved daily bread correction for immediate delivery.
-- This intentionally cannot claim ordinary order/digest jobs.
create or replace function public.claim_dealer_order_notification_by_id(p_notification_id uuid)
returns setof public.dealer_order_notifications
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  update public.dealer_order_notifications notification
  set status = 'processing',
      attempt_count = notification.attempt_count + 1,
      locked_at = now(),
      updated_at = now()
  where notification.id = p_notification_id
    and notification.notification_type = 'production_bread_order_correction'
    and notification.status = 'pending'
    and notification.next_attempt_at <= now()
    and coalesce((notification.source_snapshot->>'approved_by_owner')::boolean, false)
  returning notification.*;
end;
$$;

revoke all on function public.claim_dealer_order_notification_by_id(uuid) from public, anon, authenticated;
grant execute on function public.claim_dealer_order_notification_by_id(uuid) to service_role;
