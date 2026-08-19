-- Validate manual override linkage to immutable GPS evidence when present.

create or replace function public.validate_mobile_gps_attendance_manual_override_insert()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_event public.mobile_gps_attendance_events%rowtype;
begin
  -- gps_event_id intentionally remains nullable: operators may record a manual
  -- attendance exception when no mobile GPS evidence exists. Linked overrides,
  -- however, must point at matching immutable evidence.
  if new.gps_event_id is not null then
    select *
      into v_event
    from public.mobile_gps_attendance_events
    where id = new.gps_event_id;

    if not found
      or new.actor_type is distinct from v_event.actor_type
      or new.work_date is distinct from v_event.work_date
      or new.kiosk_report_staff_id is distinct from v_event.kiosk_report_staff_id
      or new.delivery_staff_id is distinct from v_event.delivery_staff_id then
      raise exception 'mobile_gps_attendance_override_gps_event_mismatch'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;
