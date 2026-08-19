-- Explicit ACLs for the Task3 service-role-only attendance event insert RPC.

revoke all on function public.record_mobile_gps_attendance_event(
  text,
  uuid,
  uuid,
  numeric,
  numeric,
  numeric,
  timestamptz,
  uuid,
  text,
  text,
  text,
  numeric,
  numeric,
  integer,
  numeric,
  text,
  text,
  uuid,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.record_mobile_gps_attendance_event(
  text,
  uuid,
  uuid,
  numeric,
  numeric,
  numeric,
  timestamptz,
  uuid,
  text,
  text,
  text,
  numeric,
  numeric,
  integer,
  numeric,
  text,
  text,
  uuid,
  text,
  text
) to service_role;
