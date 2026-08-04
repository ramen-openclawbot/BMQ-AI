drop trigger if exists block_dealer_contact_report_staff_phone on public.dealer_customer_contacts;
create trigger block_dealer_contact_report_staff_phone
before insert or update of phone_normalized, is_active on public.dealer_customer_contacts
for each row execute function public.block_dealer_contact_report_staff_phone();
