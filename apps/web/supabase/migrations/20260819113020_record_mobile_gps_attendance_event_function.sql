-- Stop-between-files safe SECURITY DEFINER creation: create and revoke browser EXECUTE in one DO transaction.
do $migration$
begin
  execute $sql$
-- Service-role-only narrow insert RPC for Task4 attendance decision boundary.

-- Drop the legacy client-supplied work_date overload if this migration is re-run
-- after an earlier local Task3 draft.
drop function if exists public.record_mobile_gps_attendance_event(
  text,
  uuid,
  uuid,
  date,
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
);

drop function if exists public.record_mobile_gps_attendance_event(
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
);

create or replace function public.record_mobile_gps_attendance_event(
  p_actor_type text,
  p_kiosk_report_staff_id uuid,
  p_delivery_staff_id uuid,
  p_device_latitude numeric,
  p_device_longitude numeric,
  p_device_accuracy_m numeric,
  p_device_captured_at timestamptz,
  p_geofence_location_id uuid,
  p_geofence_code text,
  p_geofence_name text,
  p_geofence_location_type text,
  p_geofence_latitude numeric,
  p_geofence_longitude numeric,
  p_geofence_radius_m integer,
  p_distance_m numeric,
  p_decision text,
  p_reason_code text,
  p_session_id uuid,
  p_request_ip_hash text,
  p_request_user_agent text
)
returns jsonb
language $sql$ || 'plpgsql' || $sql$
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_event_timestamp timestamptz := statement_timestamp();
  v_user_agent text;
  v_sync_result jsonb := jsonb_build_object('status', 'not_attempted');
begin
  v_user_agent := nullif(left(btrim(coalesce(p_request_user_agent, '')), 240), '');

  insert into public.mobile_gps_attendance_events(
    actor_type,
    kiosk_report_staff_id,
    delivery_staff_id,
    work_date,
    device_latitude,
    device_longitude,
    device_accuracy_m,
    device_captured_at,
    geofence_location_id,
    geofence_code,
    geofence_name,
    geofence_location_type,
    geofence_latitude,
    geofence_longitude,
    geofence_radius_m,
    distance_m,
    decision,
    reason_code,
    session_id,
    request_ip_hash,
    request_user_agent,
    created_at
  ) values (
    p_actor_type,
    p_kiosk_report_staff_id,
    p_delivery_staff_id,
    (v_event_timestamp at time zone 'Asia/Ho_Chi_Minh')::date,
    p_device_latitude,
    p_device_longitude,
    p_device_accuracy_m,
    p_device_captured_at,
    p_geofence_location_id,
    p_geofence_code,
    p_geofence_name,
    p_geofence_location_type,
    p_geofence_latitude,
    p_geofence_longitude,
    p_geofence_radius_m,
    p_distance_m,
    p_decision,
    p_reason_code,
    p_session_id,
    nullif(btrim(coalesce(p_request_ip_hash, '')), ''),
    v_user_agent,
    v_event_timestamp
  )
  returning id into v_event_id;

  if p_decision = 'accepted' then
    v_sync_result := public.sync_mobile_gps_event_to_attendance_record(v_event_id);
  else
    v_sync_result := jsonb_build_object('status', 'skipped_rejected', 'gps_event_id', v_event_id);
  end if;

  return jsonb_build_object(
    'event_id', v_event_id,
    'attendance_sync', v_sync_result
  );
end;
$$;
$sql$;
  revoke execute on function public.record_mobile_gps_attendance_event(text, uuid, uuid, numeric, numeric, numeric, timestamptz, uuid, text, text, text, numeric, numeric, integer, numeric, text, text, uuid, text, text) from public, anon, authenticated;
end
$migration$;
