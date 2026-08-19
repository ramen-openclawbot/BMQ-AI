-- Attach immutable ledger trigger after the parser-safe trigger function migration.

drop trigger if exists mobile_gps_attendance_events_immutable on public.mobile_gps_attendance_events;
create trigger mobile_gps_attendance_events_immutable
before update or delete on public.mobile_gps_attendance_events
for each row execute function public.reject_mobile_gps_attendance_event_mutation();
