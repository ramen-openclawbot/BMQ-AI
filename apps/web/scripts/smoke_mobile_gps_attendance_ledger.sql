-- Executable rollback smoke for Task3 mobile GPS attendance ledger.
-- Usage after applying Task3 migrations to a disposable DB:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/smoke_mobile_gps_attendance_ledger.sql

begin;

insert into public.kiosk_report_locations(id, location_code, location_name, address, active)
values ('10000000-0000-0000-0000-000000000001', 'SMOKE-KIOSK', 'Smoke Kiosk', 'Smoke Address', true)
on conflict (id) do nothing;

insert into public.kiosk_report_staff(id, full_name, phone_raw, phone_normalized, location_id, active)
values ('10000000-0000-0000-0000-000000000002', 'Smoke Report Staff', '0900000001', '84900000001', '10000000-0000-0000-0000-000000000001', true)
on conflict (id) do nothing;

insert into public.delivery_staff(id, full_name, phone_raw, phone_normalized, monthly_salary_vnd, active)
values ('10000000-0000-0000-0000-000000000003', 'Smoke Delivery Staff', '0900000002', '84900000002', 0, true)
on conflict (id) do nothing;

insert into public.attendance_geofence_locations(
  id, code, name, location_type, kiosk_location_id, latitude, longitude, accepted_radius_m, active
) values (
  '10000000-0000-0000-0000-000000000004', 'smoke_geofence', 'Smoke Geofence', 'kiosk', '10000000-0000-0000-0000-000000000001', 10.750000, 106.660000, 20, true
)
on conflict (id) do nothing;

insert into public.kiosk_report_sessions(id, actor_type, staff_id, delivery_staff_id, location_id, token_hash, expires_at, last_seen_at)
values (
  '10000000-0000-0000-0000-000000000005', 'report_staff', '10000000-0000-0000-0000-000000000002', null, '10000000-0000-0000-0000-000000000001', repeat('a', 64), now() + interval '1 hour', now()
)
on conflict (id) do nothing;

insert into public.kiosk_report_sessions(id, actor_type, staff_id, delivery_staff_id, location_id, token_hash, expires_at, last_seen_at)
values (
  '10000000-0000-0000-0000-000000000015', 'delivery_staff', null, '10000000-0000-0000-0000-000000000003', null, repeat('b', 64), now() + interval '1 hour', now()
)
on conflict (id) do nothing;

-- actor_shape_rejects_two_staff_ids
DO $$
begin
  begin
    insert into public.mobile_gps_attendance_events(
      actor_type, kiosk_report_staff_id, delivery_staff_id, work_date,
      device_latitude, device_longitude, device_accuracy_m, device_captured_at,
      geofence_location_id, geofence_code, geofence_name, geofence_location_type,
      geofence_latitude, geofence_longitude, geofence_radius_m, distance_m,
      decision, reason_code, session_id, request_ip_hash, request_user_agent
    ) values (
      'report_staff', '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003', ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
      10.750000, 106.660000, 5, now(),
      '10000000-0000-0000-0000-000000000004', 'smoke_geofence', 'Smoke Geofence', 'kiosk',
      10.750000, 106.660000, 20, 0,
      'rejected', 'actor_shape_probe', '10000000-0000-0000-0000-000000000005', repeat('1', 64), 'Smoke UA'
    );
    raise exception 'actor_shape_rejects_two_staff_ids did not fail';
  exception when check_violation then
    raise notice 'actor_shape_rejects_two_staff_ids';
  end;
end;
$$;

-- invalid_coordinates_rejected
DO $$
begin
  begin
    insert into public.mobile_gps_attendance_events(
      actor_type, kiosk_report_staff_id, work_date,
      device_latitude, device_longitude, device_accuracy_m, device_captured_at,
      geofence_location_id, geofence_code, geofence_name, geofence_location_type,
      geofence_latitude, geofence_longitude, geofence_radius_m, distance_m,
      decision, reason_code, session_id
    ) values (
      'report_staff', '10000000-0000-0000-0000-000000000002', ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
      91, 106.660000, 5, now(),
      '10000000-0000-0000-0000-000000000004', 'smoke_geofence', 'Smoke Geofence', 'kiosk',
      10.750000, 106.660000, 20, 0,
      'rejected', 'invalid_coordinate_probe', '10000000-0000-0000-0000-000000000005'
    );
    raise exception 'invalid_coordinates_rejected did not fail';
  exception when check_violation then
    raise notice 'invalid_coordinates_rejected';
  end;
end;
$$;

-- service_role_rpc_insert_allowed
select public.record_mobile_gps_attendance_event(
  'report_staff', '10000000-0000-0000-0000-000000000002', null,
  10.750000, 106.660000, 5, now(),
  '10000000-0000-0000-0000-000000000004', 'smoke_geofence', 'Smoke Geofence', 'kiosk',
  10.750000, 106.660000, 20, 0,
  'accepted', 'inside_geofence', '10000000-0000-0000-0000-000000000005', repeat('2', 64), 'Smoke UA'
) as service_role_rpc_insert_allowed;

-- one_accepted_per_actor_day
DO $$
begin
  begin
    perform public.record_mobile_gps_attendance_event(
      'report_staff', '10000000-0000-0000-0000-000000000002', null,
      10.750001, 106.660001, 5, now(),
      '10000000-0000-0000-0000-000000000004', 'smoke_geofence', 'Smoke Geofence', 'kiosk',
      10.750000, 106.660000, 20, 1,
      'accepted', 'inside_geofence', '10000000-0000-0000-0000-000000000005', repeat('3', 64), 'Smoke UA'
    );
    raise exception 'one_accepted_per_actor_day did not fail';
  exception when unique_violation then
    raise notice 'one_accepted_per_actor_day';
  end;
end;
$$;

-- rejected_attempts_are_unlimited
select public.record_mobile_gps_attendance_event(
  'report_staff', '10000000-0000-0000-0000-000000000002', null,
  10.760000, 106.660000, 5, now(),
  '10000000-0000-0000-0000-000000000004', 'smoke_geofence', 'Smoke Geofence', 'kiosk',
  10.750000, 106.660000, 20, 1110,
  'rejected', 'outside_geofence', '10000000-0000-0000-0000-000000000005', repeat('4', 64), 'Smoke UA'
) as rejected_attempt_one;
select public.record_mobile_gps_attendance_event(
  'report_staff', '10000000-0000-0000-0000-000000000002', null,
  10.770000, 106.660000, 5, now(),
  '10000000-0000-0000-0000-000000000004', 'smoke_geofence', 'Smoke Geofence', 'kiosk',
  10.750000, 106.660000, 20, 2220,
  'rejected', 'outside_geofence', '10000000-0000-0000-0000-000000000005', repeat('5', 64), 'Smoke UA'
) as rejected_attempt_two;
select 1 / case when count(*) >= 2 then 1 else 0 end as rejected_attempts_are_unlimited
from public.mobile_gps_attendance_events
where decision = 'rejected'
  and kiosk_report_staff_id = '10000000-0000-0000-0000-000000000002'
  and work_date = ((now() at time zone 'Asia/Ho_Chi_Minh')::date);

-- ledger_update_rejected
DO $$
begin
  begin
    update public.mobile_gps_attendance_events set reason_code = 'tampered' where decision = 'accepted';
    raise exception 'ledger_update_rejected did not fail';
  exception when sqlstate '45000' then
    raise notice 'ledger_update_rejected';
  end;
end;
$$;

-- ledger_delete_rejected
DO $$
begin
  begin
    delete from public.mobile_gps_attendance_events where decision = 'accepted';
    raise exception 'ledger_delete_rejected did not fail';
  exception when sqlstate '45000' then
    raise notice 'ledger_delete_rejected';
  end;
end;
$$;

-- direct_browser_dml_denied
select 1 / case when not has_table_privilege('authenticated', 'public.mobile_gps_attendance_events', 'insert') then 1 else 0 end as direct_browser_dml_denied;

-- service-role must not have direct ledger DML, but must retain SELECT + RPC EXECUTE.
select
  has_table_privilege('service_role', 'public.mobile_gps_attendance_events', 'insert') as svc_insert,
  has_table_privilege('service_role', 'public.mobile_gps_attendance_events', 'update') as svc_update,
  has_table_privilege('service_role', 'public.mobile_gps_attendance_events', 'delete') as svc_delete,
  has_function_privilege(
    'service_role',
    'public.record_mobile_gps_attendance_event(text, uuid, uuid, numeric, numeric, numeric, timestamptz, uuid, text, text, text, numeric, numeric, integer, numeric, text, text, uuid, text, text)',
    'execute'
  ) as svc_exec;
select 1 / case when not has_table_privilege('service_role', 'public.mobile_gps_attendance_events', 'insert') then 1 else 0 end as svc_insert_false;
select 1 / case when not has_table_privilege('service_role', 'public.mobile_gps_attendance_events', 'update') then 1 else 0 end as svc_update_false;
select 1 / case when not has_table_privilege('service_role', 'public.mobile_gps_attendance_events', 'delete') then 1 else 0 end as svc_delete_false;
select 1 / case when has_function_privilege(
  'service_role',
  'public.record_mobile_gps_attendance_event(text, uuid, uuid, numeric, numeric, numeric, timestamptz, uuid, text, text, text, numeric, numeric, integer, numeric, text, text, uuid, text, text)',
  'execute'
) then 1 else 0 end as svc_exec_true;

-- event_session_actor_mismatch_rejected
DO $$
begin
  begin
    insert into public.mobile_gps_attendance_events(
      actor_type, delivery_staff_id, work_date,
      device_latitude, device_longitude, device_accuracy_m, device_captured_at,
      geofence_location_id, geofence_code, geofence_name, geofence_location_type,
      geofence_latitude, geofence_longitude, geofence_radius_m, distance_m,
      decision, reason_code, session_id, created_at
    ) values (
      'delivery_staff', '10000000-0000-0000-0000-000000000003', ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
      10.750000, 106.660000, 5, now(),
      '10000000-0000-0000-0000-000000000004', 'smoke_geofence', 'Smoke Geofence', 'kiosk',
      10.750000, 106.660000, 20, 0,
      'rejected', 'session_actor_probe', '10000000-0000-0000-0000-000000000005', now()
    );
    raise exception 'event_session_actor_mismatch_rejected did not fail';
  exception when check_violation then
    raise notice 'event_session_actor_mismatch_rejected';
  end;
end;
$$;

-- event_session_delivery_id_mismatch_rejected
DO $$
begin
  begin
    insert into public.mobile_gps_attendance_events(
      actor_type, delivery_staff_id, work_date,
      device_latitude, device_longitude, device_accuracy_m, device_captured_at,
      geofence_location_id, geofence_code, geofence_name, geofence_location_type,
      geofence_latitude, geofence_longitude, geofence_radius_m, distance_m,
      decision, reason_code, session_id, created_at
    ) values (
      'delivery_staff', '10000000-0000-0000-0000-000000000008', ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
      10.750000, 106.660000, 5, now(),
      '10000000-0000-0000-0000-000000000004', 'smoke_geofence', 'Smoke Geofence', 'kiosk',
      10.750000, 106.660000, 20, 0,
      'rejected', 'session_delivery_probe', '10000000-0000-0000-0000-000000000015', now()
    );
    raise exception 'event_session_delivery_id_mismatch_rejected did not fail';
  exception when foreign_key_violation or check_violation then
    raise notice 'event_session_delivery_id_mismatch_rejected';
  end;
end;
$$;

-- event_work_date_uses_vietnam_midnight_boundary
insert into public.mobile_gps_attendance_events(
  actor_type, delivery_staff_id, work_date,
  device_latitude, device_longitude, device_accuracy_m, device_captured_at,
  geofence_location_id, geofence_code, geofence_name, geofence_location_type,
  geofence_latitude, geofence_longitude, geofence_radius_m, distance_m,
  decision, reason_code, session_id, created_at
) values (
  'delivery_staff', '10000000-0000-0000-0000-000000000003', date '2026-08-20',
  10.750000, 106.660000, 5, timestamptz '2026-08-19 16:59:59+00',
  '10000000-0000-0000-0000-000000000004', 'smoke_geofence', 'Smoke Geofence', 'kiosk',
  10.750000, 106.660000, 20, 0,
  'rejected', 'vn_midnight_probe', '10000000-0000-0000-0000-000000000015', timestamptz '2026-08-19 17:00:00+00'
);
select 1 / case when exists (
  select 1 from public.mobile_gps_attendance_events
  where reason_code = 'vn_midnight_probe'
    and work_date = date '2026-08-20'
) then 1 else 0 end as event_work_date_uses_vietnam_midnight_boundary;

-- event_work_date_rejects_created_at_mismatch
DO $$
begin
  begin
    insert into public.mobile_gps_attendance_events(
      actor_type, delivery_staff_id, work_date,
      device_latitude, device_longitude, device_accuracy_m, device_captured_at,
      geofence_location_id, geofence_code, geofence_name, geofence_location_type,
      geofence_latitude, geofence_longitude, geofence_radius_m, distance_m,
      decision, reason_code, session_id, created_at
    ) values (
      'delivery_staff', '10000000-0000-0000-0000-000000000003', date '2026-08-19',
      10.750000, 106.660000, 5, timestamptz '2026-08-19 17:00:00+00',
      '10000000-0000-0000-0000-000000000004', 'smoke_geofence', 'Smoke Geofence', 'kiosk',
      10.750000, 106.660000, 20, 0,
      'rejected', 'vn_mismatch_probe', '10000000-0000-0000-0000-000000000015', timestamptz '2026-08-19 17:00:00+00'
    );
    raise exception 'event_work_date_rejects_created_at_mismatch did not fail';
  exception when check_violation then
    raise notice 'event_work_date_rejects_created_at_mismatch';
  end;
end;
$$;

create or replace function pg_temp.mobile_gps_override_probe(p_created_by uuid)
returns text
language plpgsql
security invoker
as $$
begin
  insert into public.mobile_gps_attendance_manual_overrides(
    gps_event_id, actor_type, kiosk_report_staff_id, work_date, override_decision, reason_code, reason_note, created_by
  ) values (
    null,
    'report_staff',
    '10000000-0000-0000-0000-000000000002',
    ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
    'accepted',
    'manager_override',
    'Smoke manager approved attendance override.',
    p_created_by
  );
  return 'inserted';
exception
  when insufficient_privilege or check_violation or not_null_violation then
    return sqlstate;
end;
$$;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values (
  '10000000-0000-0000-0000-000000000006',
  'authenticated',
  'authenticated',
  'mobile-gps-override-smoke@example.invalid',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
)
on conflict (id) do nothing;

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
values ('10000000-0000-0000-0000-000000000006', 'attendance', true, true)
on conflict (user_id, module_key) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;

-- manual_override_unauthenticated_actor_rejected
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select 1 / case when pg_temp.mobile_gps_override_probe(null) <> 'inserted' then 1 else 0 end
  as manual_override_unauthenticated_actor_rejected;
reset role;

-- manual_override_spoofed_actor_rejected
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000006', true);
set local role authenticated;
select 1 / case when pg_temp.mobile_gps_override_probe('10000000-0000-0000-0000-000000000007') <> 'inserted' then 1 else 0 end
  as manual_override_spoofed_actor_rejected;
reset role;

-- manual_override_auth_actor_succeeds
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000006', true);
set local role authenticated;
select 1 / case when pg_temp.mobile_gps_override_probe('10000000-0000-0000-0000-000000000006') = 'inserted' then 1 else 0 end
  as manual_override_auth_actor_succeeds;
reset role;

-- manual_override_gps_event_actor_mismatch_rejected
DO $$
begin
  begin
    insert into public.mobile_gps_attendance_manual_overrides(
      gps_event_id, actor_type, delivery_staff_id, work_date, override_decision, reason_code, reason_note, created_by
    ) values (
      (select id from public.mobile_gps_attendance_events where reason_code = 'inside_geofence' and decision = 'accepted' limit 1),
      'delivery_staff',
      '10000000-0000-0000-0000-000000000003',
      ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
      'accepted',
      'manager_override',
      'Smoke mismatched actor override should fail.',
      '10000000-0000-0000-0000-000000000006'
    );
    raise exception 'manual_override_gps_event_actor_mismatch_rejected did not fail';
  exception when check_violation then
    raise notice 'manual_override_gps_event_actor_mismatch_rejected';
  end;
end;
$$;

-- manual_override_gps_event_work_date_mismatch_rejected
DO $$
begin
  begin
    insert into public.mobile_gps_attendance_manual_overrides(
      gps_event_id, actor_type, kiosk_report_staff_id, work_date, override_decision, reason_code, reason_note, created_by
    ) values (
      (select id from public.mobile_gps_attendance_events where reason_code = 'inside_geofence' and decision = 'accepted' limit 1),
      'report_staff',
      '10000000-0000-0000-0000-000000000002',
      date '2026-01-01',
      'accepted',
      'manager_override',
      'Smoke mismatched date override should fail.',
      '10000000-0000-0000-0000-000000000006'
    );
    raise exception 'manual_override_gps_event_work_date_mismatch_rejected did not fail';
  exception when check_violation then
    raise notice 'manual_override_gps_event_work_date_mismatch_rejected';
  end;
end;
$$;

-- duplicate_report_staff_override_rejected
DO $$
begin
  begin
    insert into public.mobile_gps_attendance_manual_overrides(
      actor_type, kiosk_report_staff_id, work_date, override_decision, reason_code, reason_note, created_by
    ) values (
      'report_staff',
      '10000000-0000-0000-0000-000000000002',
      ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
      'excused',
      'manager_override',
      'Smoke duplicate report staff override should fail.',
      '10000000-0000-0000-0000-000000000006'
    );
    raise exception 'duplicate_report_staff_override_rejected did not fail';
  exception when unique_violation then
    raise notice 'duplicate_report_staff_override_rejected';
  end;
end;
$$;

insert into public.mobile_gps_attendance_manual_overrides(
  actor_type, delivery_staff_id, work_date, override_decision, reason_code, reason_note, created_by
) values (
  'delivery_staff',
  '10000000-0000-0000-0000-000000000003',
  date '2026-08-20',
  'accepted',
  'manager_override',
  'Smoke first delivery staff override.',
  '10000000-0000-0000-0000-000000000006'
);

-- duplicate_delivery_staff_override_rejected
DO $$
begin
  begin
    insert into public.mobile_gps_attendance_manual_overrides(
      actor_type, delivery_staff_id, work_date, override_decision, reason_code, reason_note, created_by
    ) values (
      'delivery_staff',
      '10000000-0000-0000-0000-000000000003',
      date '2026-08-20',
      'excused',
      'manager_override',
      'Smoke duplicate delivery staff override should fail.',
      '10000000-0000-0000-0000-000000000006'
    );
    raise exception 'duplicate_delivery_staff_override_rejected did not fail';
  exception when unique_violation then
    raise notice 'duplicate_delivery_staff_override_rejected';
  end;
end;
$$;

-- coordinate_detail_view_privacy_allowlist
select 1 / case when not exists (
  select 1
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'mobile_gps_attendance_event_coordinate_details'
    and column_name in ('request_ip_hash', 'request_user_agent')
) then 1 else 0 end as coordinate_detail_view_privacy_allowlist;

-- manual_override_does_not_mutate_gps_evidence
select 1 / case when exists (select 1 from public.mobile_gps_attendance_events where decision = 'rejected' and reason_code = 'outside_geofence') then 1 else 0 end
  as manual_override_does_not_mutate_gps_evidence;

rollback;
