-- Rollback-only smoke for 20261109100000_payroll_bn_gps_attendance.sql.
--
-- Maestro only: the Harness never runs this file against a live database.
-- Run from apps/web after the migration is reviewed/applied:
--   psql -v ON_ERROR_STOP=1 -f scripts/smoke_payroll_bn_gps_attendance.sql
--
-- The file opens one transaction, seeds a throwaway kitchen site (the real
-- kitchen_q7 coordinates stay NULL), test sessions/devices and a service-role
-- JWT claim, then asserts:
--   * inside the radius is accepted (in + out)
--   * outside the radius is rejected
--   * a site with NULL coordinates rejects site_not_configured
--   * the same device used by another employee is device_used_by_other/proxy
--   * check-out before check-in is rejected
--   * update/delete of an event is blocked by the immutable trigger
--   * anon has no EXECUTE on the recording RPC
-- A final rollback leaves no site, gate, device, session or event behind.

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------
insert into public.attendance_geofence_locations(
  id, code, name, location_type, kiosk_location_id,
  latitude, longitude, accepted_radius_m, active
) values (
  gen_random_uuid(), 'task_payroll_bn_gps_site', 'Task Payroll GPS Site', 'kitchen', null,
  10.750000, 106.650000, 50, true
)
on conflict (code) do update
set latitude = excluded.latitude,
    longitude = excluded.longitude,
    accepted_radius_m = excluded.accepted_radius_m,
    active = true;

insert into public.attendance_geofence_locations(
  id, code, name, location_type, kiosk_location_id,
  latitude, longitude, accepted_radius_m, active
) values (
  gen_random_uuid(), 'task_payroll_bn_gps_unconfigured', 'Task Payroll GPS Unconfigured', 'kitchen', null,
  null, null, 50, true
)
on conflict (code) do update
set latitude = null,
    longitude = null,
    accepted_radius_m = 50,
    active = true;

select id as test_site_id
from public.attendance_geofence_locations
where code = 'task_payroll_bn_gps_site' \gset

select id as unconfigured_site_id
from public.attendance_geofence_locations
where code = 'task_payroll_bn_gps_unconfigured' \gset

insert into public.payroll_bn_attendance_gates(employee_code, enabled, geofence_location_id)
values
  ('TASK_GPS_E1', true, :'test_site_id'::uuid),
  ('TASK_GPS_E2', true, :'test_site_id'::uuid),
  ('TASK_GPS_E3', true, :'unconfigured_site_id'::uuid),
  ('TASK_GPS_E4', true, :'test_site_id'::uuid),
  ('TASK_GPS_E5', true, :'test_site_id'::uuid),
  ('TASK_GPS_E6', true, :'test_site_id'::uuid),
  ('TASK_GPS_E7', true, :'test_site_id'::uuid)
on conflict (employee_code) do update
set enabled = excluded.enabled,
    geofence_location_id = excluded.geofence_location_id;

insert into public.payroll_bn_attendance_devices(
  employee_code, device_hash, status, first_seen_at, approved_at
) values
  ('TASK_GPS_E1', repeat('a', 64), 'active', now(), now()),
  ('TASK_GPS_E2', repeat('b', 64), 'active', now(), now()),
  ('TASK_GPS_E3', repeat('c', 64), 'active', now(), now()),
  ('TASK_GPS_E5', repeat('e', 64), 'active', now(), now())
on conflict (employee_code, device_hash) do update
set status = 'active',
    approved_at = now();

insert into public.payroll_bn_payslip_sessions(
  id, token_hash, employee_code, expires_at, device_hash
) values
  (gen_random_uuid(), repeat('1', 64), 'TASK_GPS_E1', now() + interval '1 hour', repeat('a', 64)),
  (gen_random_uuid(), repeat('2', 64), 'TASK_GPS_E2', now() + interval '1 hour', repeat('b', 64)),
  (gen_random_uuid(), repeat('3', 64), 'TASK_GPS_E3', now() + interval '1 hour', repeat('c', 64)),
  (gen_random_uuid(), repeat('4', 64), 'TASK_GPS_E4', now() + interval '1 hour', repeat('a', 64)),
  (gen_random_uuid(), repeat('5', 64), 'TASK_GPS_E5', now() + interval '1 hour', repeat('e', 64)),
  (gen_random_uuid(), repeat('6', 64), 'TASK_GPS_E6', now() + interval '1 hour', repeat('f', 64)),
  (gen_random_uuid(), repeat('7', 64), 'TASK_GPS_E7', now() + interval '1 hour', repeat('9', 64))
on conflict (token_hash) do nothing;

-- TASK_GPS_E7 already has a revoked device, so a new device is not "first".
insert into public.payroll_bn_attendance_devices(employee_code, device_hash, status, first_seen_at)
values ('TASK_GPS_E7', repeat('8', 64), 'revoked', now())
on conflict (employee_code, device_hash) do nothing;

select id as s1 from public.payroll_bn_payslip_sessions where token_hash = repeat('1', 64) \gset
select id as s2 from public.payroll_bn_payslip_sessions where token_hash = repeat('2', 64) \gset
select id as s3 from public.payroll_bn_payslip_sessions where token_hash = repeat('3', 64) \gset
select id as s4 from public.payroll_bn_payslip_sessions where token_hash = repeat('4', 64) \gset
select id as s5 from public.payroll_bn_payslip_sessions where token_hash = repeat('5', 64) \gset
select id as s6 from public.payroll_bn_payslip_sessions where token_hash = repeat('6', 64) \gset
select id as s7 from public.payroll_bn_payslip_sessions where token_hash = repeat('7', 64) \gset

create temp table task_payroll_bn_gps_results(
  key text primary key,
  payload jsonb not null
) on commit drop;

-- The RPC is granted to service_role only; the JWT claim is what the
-- SECURITY DEFINER body checks.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- inside the radius is accepted (check-in)
-- ---------------------------------------------------------------------------
insert into task_payroll_bn_gps_results(key, payload)
select 'accept_inside', public.record_payroll_bn_attendance_event(
  'TASK_GPS_E1', 'in', repeat('a', 64), :'s1'::uuid,
  10.750100, 106.650100, 8, now(), 'TASK_GPS_E1/smoke/checkin.jpg', 'smoke'
);

do $$
declare
  v jsonb;
begin
  select payload into v from task_payroll_bn_gps_results where key = 'accept_inside';
  if v->>'decision' <> 'accepted' then
    raise exception 'accept_inside failed: %', v;
  end if;
  if v->>'reason_code' is not null then
    raise exception 'accept_inside reason should be null: %', v;
  end if;
  if (v->>'distance_m')::numeric > 50 then
    raise exception 'accept_inside distance should be inside the 50m radius: %', v;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- check-out after an accepted check-in is accepted
-- ---------------------------------------------------------------------------
insert into task_payroll_bn_gps_results(key, payload)
select 'accept_out_after_in', public.record_payroll_bn_attendance_event(
  'TASK_GPS_E1', 'out', repeat('a', 64), :'s1'::uuid,
  10.750100, 106.650100, 8, now(), 'TASK_GPS_E1/smoke/checkout.jpg', 'smoke'
);

do $$
declare
  v jsonb;
begin
  select payload into v from task_payroll_bn_gps_results where key = 'accept_out_after_in';
  if v->>'decision' <> 'accepted' then
    raise exception 'accept_out_after_in failed: %', v;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- outside the radius is rejected
-- ---------------------------------------------------------------------------
insert into task_payroll_bn_gps_results(key, payload)
select 'reject_outside', public.record_payroll_bn_attendance_event(
  'TASK_GPS_E2', 'in', repeat('b', 64), :'s2'::uuid,
  10.900000, 106.900000, 8, now(), 'TASK_GPS_E2/smoke/outside.jpg', 'smoke'
);

do $$
declare
  v jsonb;
begin
  select payload into v from task_payroll_bn_gps_results where key = 'reject_outside';
  if v->>'decision' <> 'rejected' or v->>'reason_code' <> 'outside_geofence' then
    raise exception 'reject_outside failed: %', v;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- a site with NULL coordinates rejects site_not_configured
-- ---------------------------------------------------------------------------
insert into task_payroll_bn_gps_results(key, payload)
select 'reject_site_not_configured', public.record_payroll_bn_attendance_event(
  'TASK_GPS_E3', 'in', repeat('c', 64), :'s3'::uuid,
  10.750100, 106.650100, 8, now(), 'TASK_GPS_E3/smoke/unconfigured.jpg', 'smoke'
);

do $$
declare
  v jsonb;
begin
  select payload into v from task_payroll_bn_gps_results where key = 'reject_site_not_configured';
  if v->>'decision' <> 'rejected' or v->>'reason_code' <> 'site_not_configured' then
    raise exception 'reject_site_not_configured failed: %', v;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- the same device used by another employee on the same day is flagged
-- ---------------------------------------------------------------------------
insert into task_payroll_bn_gps_results(key, payload)
select 'device_used_by_other', public.record_payroll_bn_attendance_event(
  'TASK_GPS_E4', 'in', repeat('a', 64), :'s4'::uuid,
  10.750100, 106.650100, 8, now(), 'TASK_GPS_E4/smoke/shared-device.jpg', 'smoke'
);

do $$
declare
  v jsonb;
begin
  select payload into v from task_payroll_bn_gps_results where key = 'device_used_by_other';
  if v->>'decision' <> 'rejected' or v->>'reason_code' <> 'device_used_by_other' then
    raise exception 'device_used_by_other failed: %', v;
  end if;
  if (v->>'suspected_proxy')::boolean is not true then
    raise exception 'device_used_by_other must set suspected_proxy: %', v;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- check-out before check-in is rejected
-- ---------------------------------------------------------------------------
insert into task_payroll_bn_gps_results(key, payload)
select 'out_before_in', public.record_payroll_bn_attendance_event(
  'TASK_GPS_E5', 'out', repeat('e', 64), :'s5'::uuid,
  10.750100, 106.650100, 8, now(), 'TASK_GPS_E5/smoke/out-before-in.jpg', 'smoke'
);

do $$
declare
  v jsonb;
begin
  select payload into v from task_payroll_bn_gps_results where key = 'out_before_in';
  if v->>'decision' <> 'rejected' or v->>'reason_code' <> 'checkout_before_checkin' then
    raise exception 'out_before_in failed: %', v;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- first device is registered automatically; a later device waits (owner 09/11)
-- ---------------------------------------------------------------------------
insert into task_payroll_bn_gps_results(key, payload)
select 'first_device_auto', public.record_payroll_bn_attendance_event(
  'TASK_GPS_E6', 'in', repeat('f', 64), :'s6'::uuid,
  10.750100, 106.650100, 8, now(), 'TASK_GPS_E6/smoke/first-device.jpg', 'smoke'
);

insert into task_payroll_bn_gps_results(key, payload)
select 'later_device_pending', public.record_payroll_bn_attendance_event(
  'TASK_GPS_E7', 'in', repeat('9', 64), :'s7'::uuid,
  10.750100, 106.650100, 8, now(), 'TASK_GPS_E7/smoke/later-device.jpg', 'smoke'
);

do $$
declare
  v jsonb;
begin
  select payload into v from task_payroll_bn_gps_results where key = 'first_device_auto';
  if v->>'decision' <> 'accepted' then
    raise exception 'first_device_auto failed: %', v;
  end if;
  if not exists (
    select 1 from public.payroll_bn_attendance_devices
    where employee_code = 'TASK_GPS_E6' and device_hash = repeat('f', 64) and status = 'active'
  ) then
    raise exception 'first_device_auto did not store an active device';
  end if;

  select payload into v from task_payroll_bn_gps_results where key = 'later_device_pending';
  if v->>'decision' <> 'rejected' or v->>'reason_code' <> 'device_not_approved' then
    raise exception 'later_device_pending failed: %', v;
  end if;
  if not exists (
    select 1 from public.payroll_bn_attendance_devices
    where employee_code = 'TASK_GPS_E7' and device_hash = repeat('9', 64) and status = 'pending'
  ) then
    raise exception 'later_device_pending did not create a pending device';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- the immutable ledger rejects UPDATE and DELETE
-- ---------------------------------------------------------------------------
do $$
declare
  v_event_id uuid;
begin
  select (payload->>'event_id')::uuid into v_event_id
  from task_payroll_bn_gps_results
  where key = 'accept_inside';

  begin
    update public.payroll_bn_attendance_events
    set reject_reason = 'tampered'
    where id = v_event_id;
    raise exception 'events_update_not_blocked';
  exception when sqlstate '45000' then
    null;
  end;

  begin
    delete from public.payroll_bn_attendance_events where id = v_event_id;
    raise exception 'events_delete_not_blocked';
  exception when sqlstate '45000' then
    null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- anon has no EXECUTE on the recording RPC
-- ---------------------------------------------------------------------------
do $$
begin
  if has_function_privilege(
    'anon',
    'public.record_payroll_bn_attendance_event(text,text,text,uuid,numeric,numeric,numeric,timestamptz,text,text)',
    'EXECUTE'
  ) then
    raise exception 'anon_can_execute';
  end if;
end $$;

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;

do $$
begin
  begin
    perform public.record_payroll_bn_attendance_event(
      'TASK_GPS_E1', 'in', repeat('a', 64), null,
      null, null, null, null, null, null
    );
    raise exception 'anon_execute_not_denied';
  exception when insufficient_privilege then
    null;
  end;
end $$;

reset role;

rollback;
