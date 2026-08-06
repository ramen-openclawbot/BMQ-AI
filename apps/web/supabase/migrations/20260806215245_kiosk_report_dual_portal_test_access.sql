-- Explicit, paired opt-in for controlled test phones that need both public portals.
-- The default remains false, so ordinary report staff and dealer contacts stay mutually exclusive.

alter table public.kiosk_report_staff
  add column if not exists allow_dual_portal_access boolean not null default false;

alter table public.dealer_customer_contacts
  add column if not exists allow_dual_portal_access boolean not null default false;

comment on column public.kiosk_report_staff.allow_dual_portal_access is
  'Controlled test-only opt-in; the matching dealer contact must also opt in.';

comment on column public.dealer_customer_contacts.allow_dual_portal_access is
  'Controlled test-only opt-in; the matching kiosk report staff row must also opt in.';

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
      and not (new.allow_dual_portal_access = true and dcc.allow_dual_portal_access = true)
    limit 1
  ) then
    raise exception 'Phone % is already active for dealer ordering; report staff cannot access dathang.', new.phone_normalized;
  end if;

  return new;
end;
$$;

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
      and not (new.allow_dual_portal_access = true and krs.allow_dual_portal_access = true)
    limit 1
  ) then
    raise exception 'Phone % is already active for kiosk reports; report staff cannot order at dathang.', new.phone_normalized;
  end if;

  return new;
end;
$$;

drop trigger if exists block_report_staff_dealer_contact_phone
  on public.kiosk_report_staff;
create trigger block_report_staff_dealer_contact_phone
before insert or update of phone_normalized, active, allow_dual_portal_access
on public.kiosk_report_staff
for each row execute function public.block_report_staff_dealer_contact_phone();

drop trigger if exists block_dealer_contact_report_staff_phone
  on public.dealer_customer_contacts;
create trigger block_dealer_contact_report_staff_phone
before insert or update of phone_normalized, is_active, allow_dual_portal_access
on public.dealer_customer_contacts
for each row execute function public.block_dealer_contact_report_staff_phone();
