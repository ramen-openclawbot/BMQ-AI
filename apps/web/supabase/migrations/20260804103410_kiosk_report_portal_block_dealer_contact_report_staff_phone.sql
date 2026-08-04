create or replace function public.block_dealer_contact_report_staff_phone()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_active = true and exists (
    select 1
    from public.kiosk_report_staff krs
    where krs.phone_normalized = new.phone_normalized
      and krs.active = true
    limit 1
  ) then
    raise exception 'Phone % is already active for kiosk reports; report staff cannot order at dathang.', new.phone_normalized;
  end if;

  return new;
end;
$$;
