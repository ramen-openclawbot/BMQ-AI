drop trigger if exists prevent_submitted_kiosk_report_update on public.kiosk_daily_reports;
create trigger prevent_submitted_kiosk_report_update
before update or delete on public.kiosk_daily_reports
for each row execute function public.prevent_submitted_kiosk_report_mutation();
