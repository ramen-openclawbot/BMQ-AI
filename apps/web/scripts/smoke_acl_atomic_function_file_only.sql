-- Runtime ACL probe: applying only SECURITY DEFINER function files must fail closed before grant files.
-- psql -v ON_ERROR_STOP=1 -f scripts/smoke_acl_atomic_function_file_only.sql
begin;

drop function if exists public.create_kiosk_report_otp_challenge_atomic(uuid, text, text, timestamp with time zone, text, text, text, uuid, uuid, uuid);
-- Stop-between-files safe SECURITY DEFINER creation: create and revoke browser EXECUTE in one DO transaction.
do $migration$
begin
  execute $sql$
create or replace function public.create_kiosk_report_otp_challenge_atomic(
  p_challenge_id uuid,
  p_phone_normalized text,
  p_otp_hash text,
  p_expires_at timestamptz,
  p_request_ip text,
  p_user_agent text,
  p_actor_type text,
  p_staff_id uuid,
  p_location_id uuid,
  p_delivery_staff_id uuid
)
returns jsonb
language $sql$ || 'plpgsql' || $sql$
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_recent_id uuid;
begin
  if p_challenge_id is null
    or coalesce(p_phone_normalized, '') !~ '^84(3|5|7|8|9)[0-9]{8}$'
    or coalesce(p_otp_hash, '') !~ '^[0-9a-f]{64}$'
    or p_expires_at <= v_now
    or p_expires_at > v_now + interval '15 minutes'
    or p_actor_type not in ('report_staff', 'delivery_staff')
    or (p_actor_type = 'report_staff' and (p_staff_id is null or p_location_id is null or p_delivery_staff_id is not null))
    or (p_actor_type = 'delivery_staff' and (p_delivery_staff_id is null or p_staff_id is not null or p_location_id is not null)) then
    raise exception 'invalid_report_otp_challenge_input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('public.kiosk_report_otp_challenge:' || p_phone_normalized, 0));

  select id
    into v_recent_id
  from public.kiosk_report_otp_challenges
  where phone_normalized = p_phone_normalized
    and created_at >= v_now - interval '60 seconds'
  order by created_at desc, id desc
  limit 1;

  if v_recent_id is not null then
    return jsonb_build_object(
      'status', 'cooldown',
      'challenge_id', v_recent_id,
      'retry_after_seconds', 60
    );
  end if;

  update public.kiosk_report_otp_challenges
  set consumed_at = coalesce(consumed_at, v_now),
      send_status = 'superseded'
  where phone_normalized = p_phone_normalized
    and consumed_at is null;

  insert into public.kiosk_report_otp_challenges (
    id,
    actor_type,
    staff_id,
    delivery_staff_id,
    location_id,
    phone_normalized,
    otp_hash,
    expires_at,
    request_ip,
    user_agent
  ) values (
    p_challenge_id,
    p_actor_type,
    p_staff_id,
    p_delivery_staff_id,
    p_location_id,
    p_phone_normalized,
    p_otp_hash,
    p_expires_at,
    nullif(trim(coalesce(p_request_ip, '')), ''),
    nullif(trim(coalesce(p_user_agent, '')), '')
  );

  return jsonb_build_object(
    'status', 'created',
    'challenge_id', p_challenge_id
  );
end;
$$;
$sql$;
  revoke execute on function public.create_kiosk_report_otp_challenge_atomic(uuid, text, text, timestamptz, text, text, text, uuid, uuid, uuid) from public, anon, authenticated;
end
$migration$;

select 1 / case when not has_function_privilege('public', 'public.create_kiosk_report_otp_challenge_atomic(uuid, text, text, timestamp with time zone, text, text, text, uuid, uuid, uuid)', 'execute') then 1 else 0 end as otp_public_execute_denied_after_function_file_only;
select 1 / case when not has_function_privilege('anon', 'public.create_kiosk_report_otp_challenge_atomic(uuid, text, text, timestamp with time zone, text, text, text, uuid, uuid, uuid)', 'execute') then 1 else 0 end as otp_anon_execute_denied_after_function_file_only;
select 1 / case when not has_function_privilege('authenticated', 'public.create_kiosk_report_otp_challenge_atomic(uuid, text, text, timestamp with time zone, text, text, text, uuid, uuid, uuid)', 'execute') then 1 else 0 end as otp_authenticated_execute_denied_after_function_file_only;

rollback;

begin;

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

select 1 / case when not has_function_privilege('public', 'public.record_mobile_gps_attendance_event(text, uuid, uuid, numeric, numeric, numeric, timestamp with time zone, uuid, text, text, text, numeric, numeric, integer, numeric, text, text, uuid, text, text)', 'execute') then 1 else 0 end as attendance_public_execute_denied_after_function_file_only;
select 1 / case when not has_function_privilege('anon', 'public.record_mobile_gps_attendance_event(text, uuid, uuid, numeric, numeric, numeric, timestamp with time zone, uuid, text, text, text, numeric, numeric, integer, numeric, text, text, uuid, text, text)', 'execute') then 1 else 0 end as attendance_anon_execute_denied_after_function_file_only;
select 1 / case when not has_function_privilege('authenticated', 'public.record_mobile_gps_attendance_event(text, uuid, uuid, numeric, numeric, numeric, timestamp with time zone, uuid, text, text, text, numeric, numeric, integer, numeric, text, text, uuid, text, text)', 'execute') then 1 else 0 end as attendance_authenticated_execute_denied_after_function_file_only;

rollback;
