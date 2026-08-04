create or replace function public.block_report_staff_dealer_contact_phone()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.active = true and exists (
    select 1
    from public.dealer_customer_contacts dcc
    where dcc.phone_normalized = new.phone_normalized
      and dcc.is_active = true
    limit 1
  ) then
    raise exception 'Phone % is already active for dealer ordering; report staff cannot access dathang.', new.phone_normalized;
  end if;

  return new;
end;
$$;
