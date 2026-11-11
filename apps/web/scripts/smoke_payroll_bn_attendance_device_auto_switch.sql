-- Rollback-only smoke for 20261112090000_payroll_bn_attendance_device_auto_switch.sql.
--
-- Maestro only: the Harness never runs this file against a live database.
-- Run from apps/web after the migration is reviewed/applied:
--   psql -v ON_ERROR_STOP=1 -f scripts/smoke_payroll_bn_attendance_device_auto_switch.sql
--
-- Pure SQL: one transaction wraps one DO block that sets the service_role JWT
-- claims and seeds throwaway site/gate/device/session/consent/period rows, then
-- asserts:
--   * the first device auto-activates as 'first' with no change row
--   * a second valid OTP-bound device switches automatically, retires the old
--     device as revoked/replaced, writes exactly one change row and accepts the
--     punch
--   * switching back to the replaced device works again
--   * an expired session never activates a new device
--   * a hash active for another employee is not activated and leaves a pending
--     row
--   * a manager-revoked device is never auto-activated
--   * a browser used by another employee earlier today still rejects as
--     device_used_by_other
--   * manager approval sets activation='manager'
--   * list_payroll_bn_attendance_device_changes returns the switch with the
--     employee name and refuses non-managers
--   * the change ledger rejects update/delete
-- A final rollback leaves no site/gate/device/session/consent/period/event/
-- change row behind.

begin;

do $$
declare
  v_site_id uuid;
  v_period_id uuid;
  v_period_from date;
  v_s1 uuid;
  v_s2 uuid;
  v_s3 uuid;
  v_s4 uuid;
  v_s5 uuid;
  v_s6 uuid;
  v_s7 uuid;
  v_s8 uuid;
  v_manager uuid;
  v_version text;
  v_record jsonb;
  v_changes jsonb;
  v_change_id uuid;
  v_device_id uuid;
  v_activation text;
  v_status text;
  v_revoked_reason text;
  v_approved_by uuid;
  v_from_hash text;
  v_to_hash text;
  v_session_id uuid;
  v_event_id uuid;
  v_count integer;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- -----------------------------------------------------------------------
  -- Throwaway fixtures (rolled back below)
  -- -----------------------------------------------------------------------
  insert into public.attendance_geofence_locations(
    code,
    name,
    location_type,
    kiosk_location_id,
    latitude,
    longitude,
    accepted_radius_m,
    active
  ) values (
    'task_payroll_bn_device_auto_switch_site',
    'Task Payroll BN Device Auto Switch Site',
    'kitchen',
    null,
    10.750000,
    106.650000,
    50,
    true
  )
  on conflict (code) do update
  set latitude = excluded.latitude,
      longitude = excluded.longitude,
      accepted_radius_m = excluded.accepted_radius_m,
      active = true
  returning id into v_site_id;

  insert into public.payroll_bn_attendance_gates(
    employee_code,
    enabled,
    geofence_location_id
  )
  select employee_code, true, v_site_id
  from (values
    ('TASK_DEVICE_SWITCH_E1'),
    ('TASK_DEVICE_SWITCH_E2'),
    ('TASK_DEVICE_SWITCH_E3'),
    ('TASK_DEVICE_SWITCH_E4'),
    ('TASK_DEVICE_SWITCH_E5'),
    ('TASK_DEVICE_SWITCH_E6'),
    ('TASK_DEVICE_SWITCH_E7'),
    ('TASK_DEVICE_SWITCH_E8'),
    ('TASK_DEVICE_SWITCH_E9')
  ) as employees(employee_code)
  on conflict (employee_code) do update
  set enabled = true,
      geofence_location_id = excluded.geofence_location_id;

  -- E2 already switched once (replaced device kept as history).
  -- E3 has an active device but the new browser session is expired.
  -- E4 owns the shared hash that E5 tries to activate.
  -- E6 has a device the manager will revoke.
  -- E7 owns the browser another employee (E8) used earlier today.
  -- E9 has an active device plus a pending device for manager approval.
  insert into public.payroll_bn_attendance_devices(
    employee_code,
    device_hash,
    status,
    first_seen_at,
    approved_at,
    activation,
    revoked_reason
  ) values
    ('TASK_DEVICE_SWITCH_E2', repeat('c', 64), 'active', now(), now(), 'first', null),
    ('TASK_DEVICE_SWITCH_E2', repeat('d', 64), 'revoked', now(), null, null, 'replaced'),
    ('TASK_DEVICE_SWITCH_E3', repeat('e', 64), 'active', now(), now(), 'first', null),
    ('TASK_DEVICE_SWITCH_E4', repeat('1', 64), 'active', now(), now(), 'first', null),
    ('TASK_DEVICE_SWITCH_E6', repeat('2', 64), 'active', now(), now(), 'manager', null),
    ('TASK_DEVICE_SWITCH_E7', repeat('3', 64), 'active', now(), now(), 'first', null),
    ('TASK_DEVICE_SWITCH_E9', repeat('4', 64), 'active', now(), now(), 'first', null),
    ('TASK_DEVICE_SWITCH_E9', repeat('5', 64), 'pending', now(), null, null, null)
  on conflict (employee_code, device_hash) do update
  set status = excluded.status,
      approved_at = excluded.approved_at,
      activation = excluded.activation,
      revoked_reason = excluded.revoked_reason;

  insert into public.payroll_bn_payslip_sessions(
    token_hash,
    employee_code,
    expires_at,
    device_hash
  ) values
    (repeat('6', 64), 'TASK_DEVICE_SWITCH_E1', now() + interval '1 hour', repeat('a', 64)),
    (repeat('7', 64), 'TASK_DEVICE_SWITCH_E1', now() + interval '1 hour', repeat('b', 64)),
    (repeat('8', 64), 'TASK_DEVICE_SWITCH_E2', now() + interval '1 hour', repeat('d', 64)),
    (repeat('9', 64), 'TASK_DEVICE_SWITCH_E3', now() - interval '1 hour', repeat('f', 64)),
    (repeat('0', 64), 'TASK_DEVICE_SWITCH_E5', now() + interval '1 hour', repeat('1', 64)),
    (repeat('a', 64), 'TASK_DEVICE_SWITCH_E6', now() + interval '1 hour', repeat('2', 64)),
    (repeat('b', 64), 'TASK_DEVICE_SWITCH_E7', now() + interval '1 hour', repeat('3', 64)),
    (repeat('c', 64), 'TASK_DEVICE_SWITCH_E8', now() + interval '1 hour', repeat('3', 64))
  on conflict (token_hash) do update
  set employee_code = excluded.employee_code,
      expires_at = excluded.expires_at,
      device_hash = excluded.device_hash,
      revoked_at = null;

  select id into v_s1 from public.payroll_bn_payslip_sessions where token_hash = repeat('6', 64);
  select id into v_s2 from public.payroll_bn_payslip_sessions where token_hash = repeat('7', 64);
  select id into v_s3 from public.payroll_bn_payslip_sessions where token_hash = repeat('8', 64);
  select id into v_s4 from public.payroll_bn_payslip_sessions where token_hash = repeat('9', 64);
  select id into v_s5 from public.payroll_bn_payslip_sessions where token_hash = repeat('0', 64);
  select id into v_s6 from public.payroll_bn_payslip_sessions where token_hash = repeat('a', 64);
  select id into v_s7 from public.payroll_bn_payslip_sessions where token_hash = repeat('b', 64);
  select id into v_s8 from public.payroll_bn_payslip_sessions where token_hash = repeat('c', 64);

  -- The latest payroll period catalogue supplies the manager-facing name.
  select coalesce(max(p.date_from), (now() at time zone 'Asia/Ho_Chi_Minh')::date) + 1
  into v_period_from
  from public.payroll_bn_periods p;

  insert into public.payroll_bn_periods(
    period_code,
    period_name,
    date_from,
    date_to
  ) values (
    'TASK_DEVICE_SWITCH_PERIOD',
    'Task Device Switch Period',
    v_period_from,
    v_period_from + 30
  )
  on conflict (period_code) do update
  set date_from = excluded.date_from,
      date_to = excluded.date_to
  returning id into v_period_id;

  insert into public.payroll_bn_period_employees(
    period_id,
    employee_code,
    employee_name,
    employment_type
  ) values (
    v_period_id,
    'TASK_DEVICE_SWITCH_E1',
    'TASK Device Switch E1',
    'official'
  )
  on conflict (period_id, employee_code) do update
  set employee_name = excluded.employee_name;

  -- Real consent RPC for the current agreement version, so the consent gate
  -- passes without bypassing it.
  select cfg.current_version into v_version
  from public.payroll_bn_attendance_consent_config cfg
  where cfg.id is true;

  perform public.accept_payroll_bn_attendance_consent(
    'TASK_DEVICE_SWITCH_E1', v_version, repeat('a', 64), v_s1, 'smoke'
  );
  perform public.accept_payroll_bn_attendance_consent(
    'TASK_DEVICE_SWITCH_E2', v_version, repeat('d', 64), v_s3, 'smoke'
  );
  perform public.accept_payroll_bn_attendance_consent(
    'TASK_DEVICE_SWITCH_E3', v_version, repeat('f', 64), v_s4, 'smoke'
  );
  perform public.accept_payroll_bn_attendance_consent(
    'TASK_DEVICE_SWITCH_E5', v_version, repeat('1', 64), v_s5, 'smoke'
  );
  perform public.accept_payroll_bn_attendance_consent(
    'TASK_DEVICE_SWITCH_E6', v_version, repeat('2', 64), v_s6, 'smoke'
  );
  perform public.accept_payroll_bn_attendance_consent(
    'TASK_DEVICE_SWITCH_E7', v_version, repeat('3', 64), v_s7, 'smoke'
  );
  perform public.accept_payroll_bn_attendance_consent(
    'TASK_DEVICE_SWITCH_E8', v_version, repeat('3', 64), v_s8, 'smoke'
  );

  -- -----------------------------------------------------------------------
  -- 1. First device auto-activates as 'first' and writes no change row.
  -- -----------------------------------------------------------------------
  v_record := public.record_payroll_bn_attendance_event(
    'TASK_DEVICE_SWITCH_E1', 'in', repeat('a', 64), v_s1,
    10.750100, 106.650100, 8, now(), 'TASK_DEVICE_SWITCH_E1/smoke/first.jpg', 'smoke'
  );
  if v_record->>'decision' is distinct from 'accepted' then
    raise exception 'first_device_not_accepted: %', v_record;
  end if;

  select d.status, d.activation, d.approved_by
  into v_status, v_activation, v_approved_by
  from public.payroll_bn_attendance_devices d
  where d.employee_code = 'TASK_DEVICE_SWITCH_E1'
    and d.device_hash = repeat('a', 64);

  if v_status is distinct from 'active'
     or v_activation is distinct from 'first'
     or v_approved_by is not null then
    raise exception 'first_device_wrong_row: status=%, activation=%, approved_by=%',
      v_status, v_activation, v_approved_by;
  end if;

  if exists (
    select 1 from public.payroll_bn_attendance_device_changes
    where employee_code = 'TASK_DEVICE_SWITCH_E1'
  ) then
    raise exception 'first_device_wrote_change_row';
  end if;

  -- -----------------------------------------------------------------------
  -- 2. A second OTP-bound device switches automatically and is accepted.
  -- -----------------------------------------------------------------------
  v_record := public.record_payroll_bn_attendance_event(
    'TASK_DEVICE_SWITCH_E1', 'out', repeat('b', 64), v_s2,
    10.750100, 106.650100, 8, now(), 'TASK_DEVICE_SWITCH_E1/smoke/second.jpg', 'smoke'
  );
  if v_record->>'decision' is distinct from 'accepted' then
    raise exception 'second_device_not_accepted: %', v_record;
  end if;

  select d.status, d.activation
  into v_status, v_activation
  from public.payroll_bn_attendance_devices d
  where d.employee_code = 'TASK_DEVICE_SWITCH_E1'
    and d.device_hash = repeat('b', 64);
  if v_status is distinct from 'active' or v_activation is distinct from 'otp_switch' then
    raise exception 'second_device_not_activated: status=%, activation=%', v_status, v_activation;
  end if;

  select d.status, d.revoked_reason
  into v_status, v_revoked_reason
  from public.payroll_bn_attendance_devices d
  where d.employee_code = 'TASK_DEVICE_SWITCH_E1'
    and d.device_hash = repeat('a', 64);
  if v_status is distinct from 'revoked' or v_revoked_reason is distinct from 'replaced' then
    raise exception 'old_device_not_replaced: status=%, reason=%', v_status, v_revoked_reason;
  end if;

  select count(*) into v_count
  from public.payroll_bn_attendance_device_changes
  where employee_code = 'TASK_DEVICE_SWITCH_E1';
  if v_count <> 1 then
    raise exception 'second_device_change_count: %', v_count;
  end if;

  select
    ch.from_device_hash,
    ch.to_device_hash,
    ch.session_id,
    ch.event_id
  into v_from_hash, v_to_hash, v_session_id, v_event_id
  from public.payroll_bn_attendance_device_changes ch
  where ch.employee_code = 'TASK_DEVICE_SWITCH_E1';

  if v_from_hash is distinct from repeat('a', 64)
     or v_to_hash is distinct from repeat('b', 64)
     or v_session_id is distinct from v_s2
     or v_event_id is distinct from (v_record->>'event_id')::uuid then
    raise exception 'second_device_change_payload_wrong: %', v_record;
  end if;

  -- -----------------------------------------------------------------------
  -- 3. Switching back to a replaced device works again.
  -- -----------------------------------------------------------------------
  v_record := public.record_payroll_bn_attendance_event(
    'TASK_DEVICE_SWITCH_E2', 'in', repeat('d', 64), v_s3,
    10.750100, 106.650100, 8, now(), 'TASK_DEVICE_SWITCH_E2/smoke/switch-back.jpg', 'smoke'
  );
  if v_record->>'decision' is distinct from 'accepted' then
    raise exception 'switch_back_not_accepted: %', v_record;
  end if;

  select d.status, d.activation
  into v_status, v_activation
  from public.payroll_bn_attendance_devices d
  where d.employee_code = 'TASK_DEVICE_SWITCH_E2'
    and d.device_hash = repeat('d', 64);
  if v_status is distinct from 'active' or v_activation is distinct from 'otp_switch' then
    raise exception 'switch_back_not_activated: status=%, activation=%', v_status, v_activation;
  end if;

  select d.status, d.revoked_reason
  into v_status, v_revoked_reason
  from public.payroll_bn_attendance_devices d
  where d.employee_code = 'TASK_DEVICE_SWITCH_E2'
    and d.device_hash = repeat('c', 64);
  if v_status is distinct from 'revoked' or v_revoked_reason is distinct from 'replaced' then
    raise exception 'switch_back_old_not_replaced: status=%, reason=%', v_status, v_revoked_reason;
  end if;

  if not exists (
    select 1 from public.payroll_bn_attendance_device_changes
    where employee_code = 'TASK_DEVICE_SWITCH_E2'
      and from_device_hash = repeat('c', 64)
      and to_device_hash = repeat('d', 64)
  ) then
    raise exception 'switch_back_change_row_missing';
  end if;

  -- -----------------------------------------------------------------------
  -- 4. An expired session never activates a new device.
  -- -----------------------------------------------------------------------
  v_record := public.record_payroll_bn_attendance_event(
    'TASK_DEVICE_SWITCH_E3', 'in', repeat('f', 64), v_s4,
    10.750100, 106.650100, 8, now(), 'TASK_DEVICE_SWITCH_E3/smoke/expired.jpg', 'smoke'
  );
  if v_record->>'reason_code' is distinct from 'session_invalid' then
    raise exception 'expired_session_not_rejected: %', v_record;
  end if;
  if exists (
    select 1 from public.payroll_bn_attendance_devices
    where employee_code = 'TASK_DEVICE_SWITCH_E3'
      and device_hash = repeat('f', 64)
  ) then
    raise exception 'expired_session_activated_device';
  end if;
  if exists (
    select 1 from public.payroll_bn_attendance_device_changes
    where employee_code = 'TASK_DEVICE_SWITCH_E3'
  ) then
    raise exception 'expired_session_wrote_change_row';
  end if;

  -- -----------------------------------------------------------------------
  -- 5. A hash active for another employee is never auto-activated; the new
  --    browser waits as a pending row.
  -- -----------------------------------------------------------------------
  v_record := public.record_payroll_bn_attendance_event(
    'TASK_DEVICE_SWITCH_E5', 'in', repeat('1', 64), v_s5,
    10.750100, 106.650100, 8, now(), 'TASK_DEVICE_SWITCH_E5/smoke/shared-active.jpg', 'smoke'
  );
  if v_record->>'reason_code' is distinct from 'device_not_approved' then
    raise exception 'shared_active_hash_not_blocked: %', v_record;
  end if;
  if not exists (
    select 1 from public.payroll_bn_attendance_devices
    where employee_code = 'TASK_DEVICE_SWITCH_E5'
      and device_hash = repeat('1', 64)
      and status = 'pending'
  ) then
    raise exception 'shared_active_hash_did_not_leave_pending_row';
  end if;
  if exists (
    select 1 from public.payroll_bn_attendance_devices
    where employee_code = 'TASK_DEVICE_SWITCH_E5'
      and device_hash = repeat('1', 64)
      and status = 'active'
  ) then
    raise exception 'shared_active_hash_activated_for_other_employee';
  end if;

  -- -----------------------------------------------------------------------
  -- 6. A browser used by another employee earlier today is still blocked.
  -- -----------------------------------------------------------------------
  v_record := public.record_payroll_bn_attendance_event(
    'TASK_DEVICE_SWITCH_E7', 'in', repeat('3', 64), v_s7,
    10.750100, 106.650100, 8, now(), 'TASK_DEVICE_SWITCH_E7/smoke/owner.jpg', 'smoke'
  );
  if v_record->>'decision' is distinct from 'accepted' then
    raise exception 'shared_browser_owner_not_accepted: %', v_record;
  end if;

  v_record := public.record_payroll_bn_attendance_event(
    'TASK_DEVICE_SWITCH_E8', 'in', repeat('3', 64), v_s8,
    10.750100, 106.650100, 8, now(), 'TASK_DEVICE_SWITCH_E8/smoke/shared-browser.jpg', 'smoke'
  );
  if v_record->>'reason_code' is distinct from 'device_used_by_other' then
    raise exception 'shared_browser_not_blocked: %', v_record;
  end if;
  if (v_record->>'suspected_proxy')::boolean is not true then
    raise exception 'shared_browser_not_flagged_as_proxy: %', v_record;
  end if;
  if exists (
    select 1 from public.payroll_bn_attendance_devices
    where employee_code = 'TASK_DEVICE_SWITCH_E8'
      and device_hash = repeat('3', 64)
  ) then
    raise exception 'shared_browser_created_device_row';
  end if;

  -- -----------------------------------------------------------------------
  -- 7. A manager-revoked device is never auto-activated again.
  -- -----------------------------------------------------------------------
  select ur.user_id into v_manager
  from public.user_roles ur
  where ur.role = 'owner'
  limit 1;

  if v_manager is null then
    select ump.user_id into v_manager
    from public.user_module_permissions ump
    where ump.module_key = 'payroll'
      and ump.can_edit
    limit 1;
  end if;

  if v_manager is null then
    raise exception 'task_device_switch_smoke_no_manager';
  end if;

  select d.id into v_device_id
  from public.payroll_bn_attendance_devices d
  where d.employee_code = 'TASK_DEVICE_SWITCH_E6'
    and d.device_hash = repeat('2', 64);

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_manager)::text,
    true
  );

  v_record := public.revoke_payroll_bn_attendance_device(v_device_id);
  if v_record->'device'->>'revoked_reason' is distinct from 'manager' then
    raise exception 'manager_revoke_reason_missing: %', v_record;
  end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  v_record := public.record_payroll_bn_attendance_event(
    'TASK_DEVICE_SWITCH_E6', 'in', repeat('2', 64), v_s6,
    10.750100, 106.650100, 8, now(), 'TASK_DEVICE_SWITCH_E6/smoke/manager-revoked.jpg', 'smoke'
  );
  if v_record->>'reason_code' is distinct from 'device_not_approved' then
    raise exception 'manager_revoked_not_blocked: %', v_record;
  end if;

  select d.status, d.revoked_reason
  into v_status, v_revoked_reason
  from public.payroll_bn_attendance_devices d
  where d.employee_code = 'TASK_DEVICE_SWITCH_E6'
    and d.device_hash = repeat('2', 64);
  if v_status is distinct from 'revoked' or v_revoked_reason is distinct from 'manager' then
    raise exception 'manager_revoked_device_changed: status=%, reason=%', v_status, v_revoked_reason;
  end if;
  if exists (
    select 1 from public.payroll_bn_attendance_device_changes
    where employee_code = 'TASK_DEVICE_SWITCH_E6'
  ) then
    raise exception 'manager_revoked_device_wrote_change_row';
  end if;

  -- -----------------------------------------------------------------------
  -- 8. Manager approval sets activation='manager' and retires the old device.
  -- -----------------------------------------------------------------------
  select d.id into v_device_id
  from public.payroll_bn_attendance_devices d
  where d.employee_code = 'TASK_DEVICE_SWITCH_E9'
    and d.device_hash = repeat('5', 64)
    and d.status = 'pending';

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_manager)::text,
    true
  );

  v_record := public.approve_payroll_bn_attendance_device(v_device_id);
  if v_record->'device'->>'activation' is distinct from 'manager'
     or v_record->'device'->>'status' is distinct from 'active'
     or v_record->'device'->>'revoked_reason' is not null then
    raise exception 'manager_approve_provenance_wrong: %', v_record;
  end if;

  select d.status, d.revoked_reason
  into v_status, v_revoked_reason
  from public.payroll_bn_attendance_devices d
  where d.employee_code = 'TASK_DEVICE_SWITCH_E9'
    and d.device_hash = repeat('4', 64);
  if v_status is distinct from 'revoked' or v_revoked_reason is distinct from 'replaced' then
    raise exception 'manager_approve_old_device_wrong: status=%, reason=%', v_status, v_revoked_reason;
  end if;

  -- -----------------------------------------------------------------------
  -- 9. The manager list returns the switch with the employee name.
  -- -----------------------------------------------------------------------
  v_changes := public.list_payroll_bn_attendance_device_changes(null, 50);

  if not exists (
    select 1
    from jsonb_array_elements(v_changes->'changes') c
    where c->>'employee_code' = 'TASK_DEVICE_SWITCH_E1'
      and c->>'employee_name' = 'TASK Device Switch E1'
      and c->>'from_device_hash' = repeat('a', 64)
      and c->>'to_device_hash' = repeat('b', 64)
  ) then
    raise exception 'manager_change_list_missing_switch: %', v_changes;
  end if;

  -- -----------------------------------------------------------------------
  -- 10. Non-manager callers are refused.
  -- -----------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000cc"}',
    true
  );

  begin
    perform public.list_payroll_bn_attendance_device_changes(null, 50);
    raise exception 'non_manager_changes_not_blocked';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    perform public.list_payroll_bn_attendance_devices(null, null);
    raise exception 'non_manager_devices_not_blocked';
  exception when sqlstate '42501' then
    null;
  end;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- -----------------------------------------------------------------------
  -- 11. The change ledger rejects UPDATE and DELETE.
  -- -----------------------------------------------------------------------
  select ch.id into v_change_id
  from public.payroll_bn_attendance_device_changes ch
  where ch.employee_code = 'TASK_DEVICE_SWITCH_E1'
  limit 1;

  begin
    update public.payroll_bn_attendance_device_changes
    set changed_at = now()
    where id = v_change_id;
    raise exception 'changes_update_not_blocked';
  exception when sqlstate '45000' then
    null;
  end;

  begin
    delete from public.payroll_bn_attendance_device_changes
    where id = v_change_id;
    raise exception 'changes_delete_not_blocked';
  exception when sqlstate '45000' then
    null;
  end;

  raise notice 'DEVICE_AUTO_SWITCH_SMOKE_PASS';
end
$$;

rollback;
