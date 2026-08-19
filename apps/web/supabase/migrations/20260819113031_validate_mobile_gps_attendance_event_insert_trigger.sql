-- Attach event/session actor consistency validation trigger.

drop trigger if exists mobile_gps_attendance_events_insert_validate on public.mobile_gps_attendance_events;
create trigger mobile_gps_attendance_events_insert_validate
before insert on public.mobile_gps_attendance_events
for each row execute function public.validate_mobile_gps_attendance_event_insert();
