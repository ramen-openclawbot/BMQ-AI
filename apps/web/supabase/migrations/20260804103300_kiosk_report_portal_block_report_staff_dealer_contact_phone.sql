drop trigger if exists set_kiosk_report_locations_updated_at on public.kiosk_report_locations;
create trigger set_kiosk_report_locations_updated_at
before update on public.kiosk_report_locations
for each row execute function public.set_kiosk_report_updated_at();

drop trigger if exists set_kiosk_report_staff_updated_at on public.kiosk_report_staff;
create trigger set_kiosk_report_staff_updated_at
before update on public.kiosk_report_staff
for each row execute function public.set_kiosk_report_updated_at();

drop trigger if exists set_kiosk_daily_reports_updated_at on public.kiosk_daily_reports;
create trigger set_kiosk_daily_reports_updated_at
before update on public.kiosk_daily_reports
for each row execute function public.set_kiosk_report_updated_at();

drop trigger if exists set_kiosk_daily_report_inventory_updated_at on public.kiosk_daily_report_inventory_rows;
create trigger set_kiosk_daily_report_inventory_updated_at
before update on public.kiosk_daily_report_inventory_rows
for each row execute function public.set_kiosk_report_updated_at();

drop trigger if exists set_kiosk_daily_report_channel_updated_at on public.kiosk_daily_report_channel_rows;
create trigger set_kiosk_daily_report_channel_updated_at
before update on public.kiosk_daily_report_channel_rows
for each row execute function public.set_kiosk_report_updated_at();
