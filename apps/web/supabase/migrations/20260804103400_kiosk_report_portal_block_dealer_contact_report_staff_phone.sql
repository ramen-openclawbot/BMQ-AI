drop trigger if exists block_report_staff_dealer_contact_phone on public.kiosk_report_staff;
create trigger block_report_staff_dealer_contact_phone
before insert or update of phone_normalized, active on public.kiosk_report_staff
for each row execute function public.block_report_staff_dealer_contact_phone();
