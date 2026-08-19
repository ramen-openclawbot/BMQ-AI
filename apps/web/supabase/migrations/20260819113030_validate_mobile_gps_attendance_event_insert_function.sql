-- Validate mobile GPS event/session actor consistency at the DB boundary.

create or replace function public.validate_mobile_gps_attendance_event_insert()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_session public.kiosk_report_sessions%rowtype;
begin
  -- Snapshot semantics: validate the event against the session identity captured
  -- at insert time only; later staff/session changes must not invalidate history.
  select *
    into v_session
  from public.kiosk_report_sessions
  where id = new.session_id;

  if not found then
    raise exception 'mobile_gps_attendance_event_session_missing'
      using errcode = '23503';
  end if;

  if new.actor_type is distinct from v_session.actor_type then
    raise exception 'mobile_gps_attendance_event_session_actor_mismatch'
      using errcode = '23514';
  end if;

  if new.actor_type = 'report_staff'
    and new.kiosk_report_staff_id is distinct from v_session.staff_id then
    raise exception 'mobile_gps_attendance_event_session_actor_mismatch'
      using errcode = '23514';
  end if;

  if new.actor_type = 'delivery_staff'
    and new.delivery_staff_id is distinct from v_session.delivery_staff_id then
    raise exception 'mobile_gps_attendance_event_session_actor_mismatch'
      using errcode = '23514';
  end if;

  return new;
end;
$$;
