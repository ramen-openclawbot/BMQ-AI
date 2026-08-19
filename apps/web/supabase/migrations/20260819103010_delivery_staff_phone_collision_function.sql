create or replace function public.block_delivery_staff_active_phone_collision()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('public.report_actor_phone:' || coalesce(new.phone_normalized, ''), 0));

  if new.active = true and exists (
    select 1
    from public.kiosk_report_staff krs
    where krs.phone_normalized = new.phone_normalized
      and krs.active = true
    limit 1
  ) then
    raise exception 'Phone % is already active for kiosk reports; delivery staff cannot use report-staff access', new.phone_normalized;
  end if;

  if new.active = true and exists (
    select 1
    from public.dealer_customer_contacts dcc
    where dcc.phone_normalized = new.phone_normalized
      and dcc.is_active = true
    limit 1
  ) then
    raise exception 'Phone % is already active for dealer ordering; delivery staff cannot use dealer access', new.phone_normalized;
  end if;

  return new;
end;
$$;
