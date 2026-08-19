-- Task6 executable rollback-only smoke for accepted GPS -> attendance_records sync.
-- Run after prerequisite attendance/report/delivery/GPS migrations through 20260819123000.

begin;

create temp table task6_probe_ids(key text primary key, id uuid not null) on commit drop;
grant select on task6_probe_ids to authenticated, service_role;
grant select, insert, update, delete on table public.attendance_records to authenticated, service_role;


insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values (
  '00000000-0000-4600-8000-000000000701',
  'authenticated',
  'authenticated',
  'task6-attendance-editor@example.invalid',
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
)
on conflict (id) do nothing;

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
values ('00000000-0000-4600-8000-000000000701', 'attendance', true, true)
on conflict (user_id, module_key) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;

insert into public.kiosk_report_locations(id, location_code, location_name, active)
values
  ('00000000-0000-4600-8000-000000000101', 'TASK6_LOC_A', 'Task6 Point A', true),
  ('00000000-0000-4600-8000-000000000102', 'TASK6_LOC_B', 'Task6 Point B', true),
  ('00000000-0000-4600-8000-000000000103', 'TASK6_LOC_C', 'Task6 Point C', true),
  ('00000000-0000-4600-8000-000000000104', 'TASK6_LOC_D', 'Task6 Point D', true)
on conflict do nothing;

insert into public.kiosk_report_staff(id, full_name, phone_raw, phone_normalized, location_id, active)
values
  ('00000000-0000-4600-8000-000000000201', 'Task6 Accepted Report Staff', '0900000201', '84900000201', '00000000-0000-4600-8000-000000000101', true),
  ('00000000-0000-4600-8000-000000000202', 'Task6 Rejected Report Staff', '0900000202', '84900000202', '00000000-0000-4600-8000-000000000102', true),
  ('00000000-0000-4600-8000-000000000203', 'Task6 Locked Report Staff', '0900000203', '84900000203', '00000000-0000-4600-8000-000000000103', true),
  ('00000000-0000-4600-8000-000000000204', 'Task6 Manual Report Staff', '0900000204', '84900000204', '00000000-0000-4600-8000-000000000104', true)
on conflict do nothing;

insert into public.delivery_staff(id, full_name, phone_raw, phone_normalized, active)
values ('00000000-0000-4600-8000-000000000301', 'Task6 Delivery Staff', '0900000301', '84900000301', true)
on conflict do nothing;

insert into public.kiosk_report_sessions(id, staff_id, location_id, token_hash, expires_at, actor_type, delivery_staff_id)
values
  ('00000000-0000-4600-8000-000000000401', '00000000-0000-4600-8000-000000000201', '00000000-0000-4600-8000-000000000101', repeat('a', 64), now() + interval '1 hour', 'report_staff', null),
  ('00000000-0000-4600-8000-000000000402', '00000000-0000-4600-8000-000000000202', '00000000-0000-4600-8000-000000000102', repeat('b', 64), now() + interval '1 hour', 'report_staff', null),
  ('00000000-0000-4600-8000-000000000403', '00000000-0000-4600-8000-000000000203', '00000000-0000-4600-8000-000000000103', repeat('c', 64), now() + interval '1 hour', 'report_staff', null),
  ('00000000-0000-4600-8000-000000000404', '00000000-0000-4600-8000-000000000204', '00000000-0000-4600-8000-000000000104', repeat('d', 64), now() + interval '1 hour', 'report_staff', null),
  ('00000000-0000-4600-8000-000000000405', null, null, repeat('e', 64), now() + interval '1 hour', 'delivery_staff', '00000000-0000-4600-8000-000000000301')
on conflict do nothing;

insert into public.attendance_geofence_locations(id, code, name, location_type, kiosk_location_id, latitude, longitude, accepted_radius_m, active)
values
  ('00000000-0000-4600-8000-000000000501', 'task6_point_a', 'Task6 Point A', 'kiosk', '00000000-0000-4600-8000-000000000101', 10.750000, 106.650000, 20, true),
  ('00000000-0000-4600-8000-000000000502', 'task6_point_b', 'Task6 Point B', 'kiosk', '00000000-0000-4600-8000-000000000102', 10.750000, 106.650000, 20, true),
  ('00000000-0000-4600-8000-000000000503', 'task6_point_c', 'Task6 Point C', 'kiosk', '00000000-0000-4600-8000-000000000103', 10.750000, 106.650000, 20, true),
  ('00000000-0000-4600-8000-000000000504', 'task6_point_d', 'Task6 Point D', 'kiosk', '00000000-0000-4600-8000-000000000104', 10.750000, 106.650000, 20, true),
  ('00000000-0000-4600-8000-000000000505', 'task6_warehouse', 'Task6 Warehouse', 'warehouse', null, 10.750000, 106.650000, 20, true)
on conflict do nothing;

-- accepted_event_creates_attendance_record
DO $$
declare
  v_result jsonb;
  v_event public.mobile_gps_attendance_events%rowtype;
  v_record public.attendance_records%rowtype;
begin
  v_result := public.record_mobile_gps_attendance_event(
    'report_staff', '00000000-0000-4600-8000-000000000201', null,
    10.750001, 106.650001, 7.4, now(), '00000000-0000-4600-8000-000000000501',
    'task6_point_a', 'Task6 Point A', 'kiosk', 10.750000, 106.650000, 20, 3.2,
    'accepted', 'inside_geofence', '00000000-0000-4600-8000-000000000401', repeat('1',64), 'task6 smoke'
  );
  if v_result #>> '{attendance_sync,status}' <> 'synced' then
    raise exception 'accepted_event_creates_attendance_record: expected synced, got %', v_result;
  end if;
  select * into v_event from public.mobile_gps_attendance_events where id = (v_result->>'event_id')::uuid;
  select * into v_record from public.attendance_records where source_event_id = v_event.id;
  raise notice 'trusted_sync_succeeds_with_guard';
  if v_record.id is null
     or v_record.employee_code <> 'KIOSK:00000000-0000-4600-8000-000000000201'
     or v_record.department <> 'Điểm bán'
     or v_record.actual_check_in is distinct from v_event.created_at
     or v_record.actual_check_out is not null
     or v_record.status::text <> 'missing_check_out'
     or v_record.source_type <> 'mobile_gps'
     or v_record.source_actor_type <> 'report_staff'
     or v_record.source_distance_m <> 3
     or v_record.source_accuracy_m <> 7 then
    raise exception 'accepted_event_creates_attendance_record failed: event %, record %', row_to_json(v_event), row_to_json(v_record);
  end if;
  insert into task6_probe_ids values ('accepted_event_id', v_event.id), ('accepted_record_id', v_record.id);
end $$;

-- rejected_event_does_not_create_attendance_record
DO $$
declare
  v_result jsonb;
  v_event_id uuid;
  v_work_date date;
begin
  v_result := public.record_mobile_gps_attendance_event(
    'report_staff', '00000000-0000-4600-8000-000000000202', null,
    10.760000, 106.660000, 8.0, now(), '00000000-0000-4600-8000-000000000502',
    'task6_point_b', 'Task6 Point B', 'kiosk', 10.750000, 106.650000, 20, 200.0,
    'rejected', 'outside_geofence', '00000000-0000-4600-8000-000000000402', null, 'task6 smoke'
  );
  v_event_id := (v_result->>'event_id')::uuid;
  select work_date into v_work_date from public.mobile_gps_attendance_events where id = v_event_id;
  if v_result #>> '{attendance_sync,status}' <> 'skipped_rejected' then
    raise exception 'rejected_event_does_not_create_attendance_record: expected skipped_rejected, got %', v_result;
  end if;
  if exists (select 1 from public.attendance_records where employee_code = 'KIOSK:00000000-0000-4600-8000-000000000202' and work_date = v_work_date)
     or exists (select 1 from public.mobile_gps_attendance_sync_results where gps_event_id = v_event_id) then
    raise exception 'rejected_event_does_not_create_attendance_record failed';
  end if;
end $$;

-- locked_row_skips_and_audits
DO $$
declare
  v_result jsonb;
  v_event_id uuid;
  v_work_date date := (statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_record_before jsonb;
  v_record_after jsonb;
begin
  insert into public.attendance_records(employee_code, employee_name, work_date, actual_check_in, actual_check_out, status, minutes_late, minutes_early_leave, missing_check_in, missing_check_out, notes, locked_by_hr)
  values ('KIOSK:00000000-0000-4600-8000-000000000203', 'Locked Original', v_work_date, timestamptz '2026-08-19 01:00:00+00', timestamptz '2026-08-19 09:00:00+00', 'present', 11, 12, false, false, 'locked sentinel', true);
  select to_jsonb(r) - array['updated_at'] into v_record_before from public.attendance_records r where employee_code = 'KIOSK:00000000-0000-4600-8000-000000000203' and work_date = v_work_date;
  v_result := public.record_mobile_gps_attendance_event(
    'report_staff', '00000000-0000-4600-8000-000000000203', null,
    10.750001, 106.650001, 9, now(), '00000000-0000-4600-8000-000000000503',
    'task6_point_c', 'Task6 Point C', 'kiosk', 10.750000, 106.650000, 20, 4,
    'accepted', 'inside_geofence', '00000000-0000-4600-8000-000000000403', null, 'task6 smoke'
  );
  v_event_id := (v_result->>'event_id')::uuid;
  select to_jsonb(r) - array['updated_at'] into v_record_after from public.attendance_records r where employee_code = 'KIOSK:00000000-0000-4600-8000-000000000203' and work_date = v_work_date;
  if v_result #>> '{attendance_sync,status}' <> 'skipped_locked'
     or v_record_before is distinct from v_record_after
     or not exists (select 1 from public.mobile_gps_attendance_sync_results where gps_event_id = v_event_id and sync_status = 'skipped_locked' and reason_code = 'locked_by_hr') then
    raise exception 'locked_row_skips_and_audits failed: before %, after %, result %', v_record_before, v_record_after, v_result;
  end if;
end $$;

-- preexisting_unlocked_manual_row_minimally_updated
DO $$
declare
  v_shift_id uuid := '00000000-0000-4600-8000-000000000601';
  v_assignment_id uuid := '00000000-0000-4600-8000-000000000602';
  v_result jsonb;
  v_event public.mobile_gps_attendance_events%rowtype;
  v_record public.attendance_records%rowtype;
  v_work_date date := (statement_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  insert into public.attendance_shifts(id, shift_code, shift_name, start_time, end_time, grace_minutes, early_leave_grace_minutes)
  values (v_shift_id, 'TASK6_SHIFT', 'Task6 Shift', time '08:00', time '17:00', 5, 5)
  on conflict do nothing;
  insert into public.attendance_shift_assignments(id, employee_code, employee_name, shift_id, work_date, department, notes)
  values (v_assignment_id, 'KIOSK:00000000-0000-4600-8000-000000000204', 'Manual Assigned', v_shift_id, v_work_date, 'Manual Dept', 'assignment sentinel')
  on conflict do nothing;
  insert into public.attendance_records(employee_code, employee_name, work_date, shift_assignment_id, shift_id, scheduled_start, scheduled_end, actual_check_in, actual_check_out, status, minutes_late, minutes_early_leave, missing_check_in, missing_check_out, notes, locked_by_hr)
  values ('KIOSK:00000000-0000-4600-8000-000000000204', 'Manual Original', v_work_date, v_assignment_id, v_shift_id, timestamptz '2026-08-19 01:00:00+00', timestamptz '2026-08-19 10:00:00+00', timestamptz '2026-08-19 02:22:00+00', timestamptz '2026-08-19 09:33:00+00', 'late_early_leave', 22, 33, true, false, 'manual sentinel notes', false);
  v_result := public.record_mobile_gps_attendance_event(
    'report_staff', '00000000-0000-4600-8000-000000000204', null,
    10.750001, 106.650001, 6, now(), '00000000-0000-4600-8000-000000000504',
    'task6_point_d', 'Task6 Point D', 'kiosk', 10.750000, 106.650000, 20, 5,
    'accepted', 'inside_geofence', '00000000-0000-4600-8000-000000000404', null, 'task6 smoke'
  );
  select * into v_event from public.mobile_gps_attendance_events where id = (v_result->>'event_id')::uuid;
  select * into v_record from public.attendance_records where employee_code = 'KIOSK:00000000-0000-4600-8000-000000000204' and work_date = v_work_date;
  if v_result #>> '{attendance_sync,status}' <> 'synced'
     or v_record.actual_check_in is distinct from v_event.created_at
     or v_record.actual_check_out is distinct from timestamptz '2026-08-19 09:33:00+00'
     or v_record.status::text <> 'late_early_leave'
     or v_record.minutes_late <> 22
     or v_record.minutes_early_leave <> 33
     or v_record.missing_check_in is distinct from true
     or v_record.missing_check_out is distinct from false
     or v_record.shift_assignment_id is distinct from v_assignment_id
     or v_record.shift_id is distinct from v_shift_id
     or v_record.scheduled_start is distinct from timestamptz '2026-08-19 01:00:00+00'
     or v_record.scheduled_end is distinct from timestamptz '2026-08-19 10:00:00+00'
     or v_record.notes <> 'manual sentinel notes'
     or v_record.source_event_id is distinct from v_event.id then
    raise exception 'preexisting_unlocked_manual_row_minimally_updated failed: event %, record %, result %', row_to_json(v_event), row_to_json(v_record), v_result;
  end if;
end $$;

-- delivery_accepted_event_creates_attendance_record
DO $$
declare
  v_result jsonb;
  v_event public.mobile_gps_attendance_events%rowtype;
  v_record public.attendance_records%rowtype;
begin
  v_result := public.record_mobile_gps_attendance_event(
    'delivery_staff', null, '00000000-0000-4600-8000-000000000301',
    10.750001, 106.650001, 10, now(), '00000000-0000-4600-8000-000000000505',
    'task6_warehouse', 'Task6 Warehouse', 'warehouse', 10.750000, 106.650000, 20, 2,
    'accepted', 'inside_geofence', '00000000-0000-4600-8000-000000000405', null, 'task6 smoke'
  );
  select * into v_event from public.mobile_gps_attendance_events where id = (v_result->>'event_id')::uuid;
  select * into v_record from public.attendance_records where source_event_id = v_event.id;
  if v_result #>> '{attendance_sync,status}' <> 'synced'
     or v_record.employee_code <> 'DELIVERY:00000000-0000-4600-8000-000000000301'
     or v_record.department <> 'Giao hàng'
     or v_record.source_actor_type <> 'delivery_staff'
     or v_record.actual_check_in is distinct from v_event.created_at
     or v_record.actual_check_out is not null then
    raise exception 'delivery_accepted_event_creates_attendance_record failed: event %, record %, result %', row_to_json(v_event), row_to_json(v_record), v_result;
  end if;
end $$;

-- duplicate_accepted_idempotent_single_event_single_record + no_checkout_time_invented
DO $$
declare
  v_event_id uuid;
  v_record_id uuid;
  v_result jsonb;
begin
  select id into v_event_id from task6_probe_ids where key = 'accepted_event_id';
  select id into v_record_id from task6_probe_ids where key = 'accepted_record_id';
  v_result := public.sync_mobile_gps_event_to_attendance_record(v_event_id);
  if v_result->>'status' <> 'already_synced' then
    raise exception 'duplicate_accepted_idempotent_single_event_single_record expected already_synced, got %', v_result;
  end if;
  if (select count(*) from public.attendance_records where source_event_id = v_event_id) <> 1
     or (select count(*) from public.mobile_gps_attendance_sync_results where gps_event_id = v_event_id) <> 1
     or exists (select 1 from public.attendance_records where id = v_record_id and actual_check_out is not null) then
    raise exception 'duplicate_accepted_idempotent_single_event_single_record/no_checkout_time_invented failed';
  end if;
end $$;



-- authenticated_attendance_editor_provenance_spoofing_blocked + normal_attendance_edit_update_succeeds + gps_row_delete_rejected_manual_row_delete_allowed
select set_config('request.jwt.claim.sub', '00000000-0000-4600-8000-000000000701', true);
set local role authenticated;
DO $$
declare
  v_accepted_event_id uuid;
  v_accepted_record_id uuid;
  v_manual_record_id uuid;
begin
  select id into v_accepted_event_id from task6_probe_ids where key = 'accepted_event_id';
  perform set_config('attendance_records.trusted_gps_token', gen_random_uuid()::text, true);
  select id into v_accepted_record_id from task6_probe_ids where key = 'accepted_record_id';

  begin
    insert into public.attendance_records_trusted_gps_context(context_token, txid, backend_pid, purpose)
    values (gen_random_uuid(), txid_current(), pg_backend_pid(), 'mobile_gps_attendance_sync');
    raise exception 'authenticated_attendance_editor_provenance_spoofing_blocked context sql forge did not fail';
  exception when insufficient_privilege then
    raise notice 'authenticated_attendance_editor_provenance_spoofing_blocked context sql forge';
  end;

  begin
    insert into public.attendance_records(
      employee_code, employee_name, work_date, status,
      source_type, source_event_id, source_actor_type, source_distance_m, source_accuracy_m
    ) values (
      'TASK6:SPOOF_INSERT', 'Spoof Insert', date '2026-08-19', 'present',
      'mobile_gps', v_accepted_event_id, 'report_staff', 1, 1
    );
    raise exception 'authenticated_attendance_editor_provenance_spoofing_blocked insert did not fail';
  exception when insufficient_privilege then
    raise notice 'authenticated_attendance_editor_provenance_spoofing_blocked insert';
  end;

  insert into public.attendance_records(employee_code, employee_name, work_date, status, notes)
  values ('TASK6:MANUAL_UPDATE', 'Manual Update', date '2026-08-19', 'present', 'manual seed')
  returning id into v_manual_record_id;

  begin
    update public.attendance_records
    set source_type = 'mobile_gps', source_event_id = v_accepted_event_id, source_actor_type = 'report_staff'
    where id = v_manual_record_id;
    raise exception 'authenticated_attendance_editor_provenance_spoofing_blocked update did not fail';
  exception when insufficient_privilege then
    raise notice 'authenticated_attendance_editor_provenance_spoofing_blocked update';
  end;

  begin
    update public.attendance_records
    set source_event_id = null
    where id = v_accepted_record_id;
    raise exception 'authenticated_attendance_editor_provenance_spoofing_blocked detach did not fail';
  exception when insufficient_privilege then
    raise notice 'authenticated_attendance_editor_provenance_spoofing_blocked detach';
  end;

  update public.attendance_records
  set notes = 'normal attendance edit update succeeds'
  where id = v_accepted_record_id;
  if not found then
    raise exception 'normal_attendance_edit_update_succeeds failed';
  end if;
  raise notice 'normal_attendance_edit_update_succeeds';

  begin
    delete from public.attendance_records where id = v_accepted_record_id;
    raise exception 'gps_row_delete_rejected_manual_row_delete_allowed gps delete did not fail';
  exception when insufficient_privilege then
    raise notice 'gps_row_delete_rejected_manual_row_delete_allowed gps blocked';
  end;

  perform set_config('attendance_records.trusted_gps_token', '', true);

  delete from public.attendance_records where id = v_manual_record_id;
  if found then
    raise notice 'gps_row_delete_rejected_manual_row_delete_allowed manual delete allowed';
  else
    raise exception 'gps_row_delete_rejected_manual_row_delete_allowed manual delete failed';
  end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', true);


-- service_role_direct_provenance_spoofing_blocked
set local role service_role;
DO $$
declare
  v_accepted_event_id uuid;
  v_accepted_record_id uuid;
  v_manual_record_id uuid;
begin
  select id into v_accepted_event_id from task6_probe_ids where key = 'accepted_event_id';
  select id into v_accepted_record_id from task6_probe_ids where key = 'accepted_record_id';

  perform set_config('attendance_records.trusted_gps_token', gen_random_uuid()::text, true);

  begin
    insert into public.attendance_records_trusted_gps_context(context_token, txid, backend_pid, purpose)
    values (gen_random_uuid(), txid_current(), pg_backend_pid(), 'mobile_gps_attendance_sync');
    raise exception 'service_role_direct_provenance_spoofing_blocked context sql forge did not fail';
  exception when insufficient_privilege then
    raise notice 'service_role_direct_provenance_spoofing_blocked context sql forge';
  end;

  begin
    insert into public.attendance_records(
      employee_code, employee_name, work_date, status,
      source_type, source_event_id, source_actor_type, source_distance_m, source_accuracy_m
    ) values (
      'TASK6:SERVICE_ROLE_SPOOF', 'Service Role Spoof', date '2026-08-19', 'present',
      'mobile_gps', v_accepted_event_id, 'report_staff', 1, 1
    );
    raise exception 'service_role_direct_provenance_spoofing_blocked insert did not fail';
  exception when insufficient_privilege then
    raise notice 'service_role_direct_provenance_spoofing_blocked insert';
  end;

  insert into public.attendance_records(employee_code, employee_name, work_date, status, notes)
  values ('TASK6:SERVICE_ROLE_MANUAL', 'Service Role Manual', date '2026-08-19', 'present', 'service manual seed')
  returning id into v_manual_record_id;

  begin
    update public.attendance_records
    set source_type = 'mobile_gps', source_event_id = v_accepted_event_id, source_actor_type = 'report_staff'
    where id = v_manual_record_id;
    raise exception 'service_role_direct_provenance_spoofing_blocked update did not fail';
  exception when insufficient_privilege then
    raise notice 'service_role_direct_provenance_spoofing_blocked update';
  end;

  begin
    update public.attendance_records
    set source_event_id = null
    where id = v_accepted_record_id;
    raise exception 'service_role_direct_provenance_spoofing_blocked detach did not fail';
  exception when insufficient_privilege then
    raise notice 'service_role_direct_provenance_spoofing_blocked detach';
  end;

  begin
    delete from public.attendance_records where id = v_accepted_record_id;
    raise exception 'service_role_direct_provenance_spoofing_blocked delete did not fail';
  exception when insufficient_privilege then
    raise notice 'service_role_direct_provenance_spoofing_blocked delete';
  end;

  delete from public.attendance_records where id = v_manual_record_id;
  if not found then
    raise exception 'service_role_direct_provenance_spoofing_blocked manual delete failed';
  end if;

  perform set_config('attendance_records.trusted_gps_token', '', true);
end $$;
reset role;

rollback;

-- rollback_residue_absent
DO $$
begin
  if exists (select 1 from public.mobile_gps_attendance_events where session_id in (
      '00000000-0000-4600-8000-000000000401', '00000000-0000-4600-8000-000000000402',
      '00000000-0000-4600-8000-000000000403', '00000000-0000-4600-8000-000000000404',
      '00000000-0000-4600-8000-000000000405'))
     or exists (select 1 from public.attendance_records where employee_code like 'KIOSK:00000000-0000-4600-8000-00000000020%' or employee_code = 'DELIVERY:00000000-0000-4600-8000-000000000301')
     or exists (select 1 from public.kiosk_report_staff where phone_normalized between '84900000201' and '84900000204')
     or exists (select 1 from public.delivery_staff where phone_normalized = '84900000301') then
    raise exception 'rollback_residue_absent failed';
  end if;
end $$;

select 'task6_mobile_gps_attendance_records_sync_smoke_passed' as result;
