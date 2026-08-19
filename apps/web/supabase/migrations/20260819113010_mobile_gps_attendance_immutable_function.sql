-- Immutable mobile GPS attendance event trigger function.

create or replace function public.reject_mobile_gps_attendance_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'mobile_gps_attendance_events_are_immutable'
    using errcode = '45000';
end;
$$;
