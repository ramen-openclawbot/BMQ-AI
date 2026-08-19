create or replace function public.block_dealer_contact_report_staff_phone()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('public.report_actor_phone:' || coalesce(new.phone_normalized, ''), 0));

  if new.is_active = true and exists (
    select 1
    from public.kiosk_report_staff krs
    where krs.phone_normalized = new.phone_normalized
      and krs.active = true
      and not (new.allow_dual_portal_access = true and krs.allow_dual_portal_access = true)
    limit 1
  ) then
    raise exception 'Phone % is already active for kiosk reports; report staff cannot order at dathang.', new.phone_normalized;
  end if;

  if new.is_active = true and exists (
    select 1
    from public.delivery_staff ds
    where ds.phone_normalized = new.phone_normalized
      and ds.active = true
    limit 1
  ) then
    raise exception 'Phone % is already active for delivery staff; dealer contact cannot use delivery access', new.phone_normalized;
  end if;

  return new;
end;
$$;
