drop trigger if exists revoke_active_report_sessions_for_staff on public.kiosk_report_staff;
create trigger revoke_active_report_sessions_for_staff
after update of location_id, active, phone_normalized on public.kiosk_report_staff
for each row execute function public.revoke_active_report_sessions_for_staff();
