create or replace function public.block_report_staff_dealer_contact_phone()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('public.report_actor_phone:' || coalesce(new.phone_normalized, ''), 0));

  if new.active = true and exists (
    select 1
    from public.dealer_customer_contacts dcc
    where dcc.phone_normalized = new.phone_normalized
      and dcc.is_active = true
      and not (new.allow_dual_portal_access = true and dcc.allow_dual_portal_access = true)
    limit 1
  ) then
    raise exception 'Phone % is already active for dealer ordering; report staff cannot access dathang.', new.phone_normalized;
  end if;

  if new.active = true and exists (
    select 1
    from public.delivery_staff ds
    where ds.phone_normalized = new.phone_normalized
      and ds.active = true
    limit 1
  ) then
    raise exception 'Phone % is already active for delivery staff; report staff cannot use delivery access', new.phone_normalized;
  end if;

  return new;
end;
$$;
