-- Rollback-only smoke for 20261109120000_payroll_bn_attendance_consent.sql.
--
-- Maestro only: the Harness never runs this file against a live database.
-- Run from apps/web after the migration is reviewed/applied:
--   psql -v ON_ERROR_STOP=1 -f scripts/smoke_payroll_bn_attendance_consent.sql
--
-- Pure SQL: no psql meta commands. One transaction wraps one DO block that sets
-- the service_role JWT claims and seeds throwaway site/gate/device/session
-- rows, then asserts:
--   * no consent -> consent_required (the rejected event is still logged)
--   * accept -> accepted check-in
--   * withdraw -> consent_required again
--   * a config version bump -> consent_required until re-accept
--   * accepting a non-current version is rejected
--   * update/delete of a consent row is blocked; withdrawn_at may be set once
-- A final rollback leaves no consent/site/gate/device/session/event behind.

begin;

do $$
declare
  v_site_id uuid;
  v_s1 uuid;
  v_s2 uuid;
  v_s3 uuid;
  v_s4 uuid;
  v_s5 uuid;
  v_record jsonb;
  v_accept jsonb;
  v_consent_id uuid;
  v_active_consent_id uuid;
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
    'task_payroll_bn_consent_site',
    'Task Payroll BN Consent Site',
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
    ('TASK_CONSENT_E1'),
    ('TASK_CONSENT_E2'),
    ('TASK_CONSENT_E3'),
    ('TASK_CONSENT_E4'),
    ('TASK_CONSENT_E5')
  ) as employees(employee_code)
  on conflict (employee_code) do update
  set enabled = true,
      geofence_location_id = excluded.geofence_location_id;

  insert into public.payroll_bn_attendance_devices(
    employee_code,
    device_hash,
    status,
    first_seen_at,
    approved_at
  ) values
    ('TASK_CONSENT_E1', repeat('a', 64), 'active', now(), now()),
    ('TASK_CONSENT_E2', repeat('b', 64), 'active', now(), now()),
    ('TASK_CONSENT_E3', repeat('c', 64), 'active', now(), now()),
    ('TASK_CONSENT_E4', repeat('d', 64), 'active', now(), now()),
    ('TASK_CONSENT_E5', repeat('e', 64), 'active', now(), now())
  on conflict (employee_code, device_hash) do update
  set status = 'active',
      approved_at = now();

  insert into public.payroll_bn_payslip_sessions(
    token_hash,
    employee_code,
    expires_at,
    device_hash
  ) values
    (repeat('1', 64), 'TASK_CONSENT_E1', now() + interval '1 hour', repeat('a', 64)),
    (repeat('2', 64), 'TASK_CONSENT_E2', now() + interval '1 hour', repeat('b', 64)),
    (repeat('3', 64), 'TASK_CONSENT_E3', now() + interval '1 hour', repeat('c', 64)),
    (repeat('4', 64), 'TASK_CONSENT_E4', now() + interval '1 hour', repeat('d', 64)),
    (repeat('5', 64), 'TASK_CONSENT_E5', now() + interval '1 hour', repeat('e', 64))
  on conflict (token_hash) do update
  set expires_at = excluded.expires_at,
      revoked_at = null;

  select id into v_s1 from public.payroll_bn_payslip_sessions where token_hash = repeat('1', 64);
  select id into v_s2 from public.payroll_bn_payslip_sessions where token_hash = repeat('2', 64);
  select id into v_s3 from public.payroll_bn_payslip_sessions where token_hash = repeat('3', 64);
  select id into v_s4 from public.payroll_bn_payslip_sessions where token_hash = repeat('4', 64);
  select id into v_s5 from public.payroll_bn_payslip_sessions where token_hash = repeat('5', 64);

  -- Deterministic starting agreement version.
  update public.payroll_bn_attendance_consent_config
  set current_version = '2026-11-09'
  where id is true;

  -- -----------------------------------------------------------------------
  -- 1. No consent -> consent_required, but the attempt is logged.
  -- -----------------------------------------------------------------------
  v_record := public.record_payroll_bn_attendance_event(
    'TASK_CONSENT_E1', 'in', repeat('a', 64), v_s1,
    10.750100, 106.650100, 8, now(), 'TASK_CONSENT_E1/smoke/no-consent.jpg', 'smoke'
  );
  if v_record->>'reason_code' is distinct from 'consent_required' then
    raise exception 'no_consent_not_blocked: %', v_record;
  end if;
  if v_record->>'event_id' is null then
    raise exception 'no_consent_rejection_not_logged: %', v_record;
  end if;

  -- -----------------------------------------------------------------------
  -- 2. Accept the current version -> check-in is accepted.
  -- -----------------------------------------------------------------------
  v_accept := public.accept_payroll_bn_attendance_consent(
    'TASK_CONSENT_E2', '2026-11-09', repeat('b', 64), v_s2, 'smoke'
  );
  if v_accept->'consent'->>'consent_version' is distinct from '2026-11-09' then
    raise exception 'accept_current_failed: %', v_accept;
  end if;

  -- Idempotent: a second accept of the current version creates no new row.
  perform public.accept_payroll_bn_attendance_consent(
    'TASK_CONSENT_E2', '2026-11-09', repeat('b', 64), v_s2, 'smoke'
  );
  if (
    select count(*)
    from public.payroll_bn_attendance_consents
    where employee_code = 'TASK_CONSENT_E2'
      and consent_version = '2026-11-09'
  ) <> 1 then
    raise exception 'accept_not_idempotent';
  end if;

  v_record := public.record_payroll_bn_attendance_event(
    'TASK_CONSENT_E2', 'in', repeat('b', 64), v_s2,
    10.750100, 106.650100, 8, now(), 'TASK_CONSENT_E2/smoke/after-accept.jpg', 'smoke'
  );
  if v_record->>'decision' is distinct from 'accepted' then
    raise exception 'accept_then_checkin_failed: %', v_record;
  end if;

  -- -----------------------------------------------------------------------
  -- 3. Withdraw -> consent_required again.
  -- -----------------------------------------------------------------------
  perform public.accept_payroll_bn_attendance_consent(
    'TASK_CONSENT_E3', '2026-11-09', repeat('c', 64), v_s3, 'smoke'
  );
  v_accept := public.withdraw_payroll_bn_attendance_consent('TASK_CONSENT_E3');
  if (v_accept->>'withdrawn_count')::integer <> 1 then
    raise exception 'withdraw_count_unexpected: %', v_accept;
  end if;

  v_record := public.record_payroll_bn_attendance_event(
    'TASK_CONSENT_E3', 'in', repeat('c', 64), v_s3,
    10.750100, 106.650100, 8, now(), 'TASK_CONSENT_E3/smoke/withdrawn.jpg', 'smoke'
  );
  if v_record->>'reason_code' is distinct from 'consent_required' then
    raise exception 'withdrawn_consent_not_blocked: %', v_record;
  end if;

  -- -----------------------------------------------------------------------
  -- 4. A non-current version accept is rejected.
  -- -----------------------------------------------------------------------
  begin
    perform public.accept_payroll_bn_attendance_consent(
      'TASK_CONSENT_E5', '2026-11-08', repeat('e', 64), v_s5, 'smoke'
    );
    raise exception 'non_current_version_accepted';
  exception when sqlstate '22023' then
    if sqlerrm not like '%consent_version_not_current%' then
      raise exception 'non_current_version_wrong_error: %', sqlerrm;
    end if;
  end;

  -- -----------------------------------------------------------------------
  -- 5. Config version bump -> consent_required until re-accept.
  -- -----------------------------------------------------------------------
  update public.payroll_bn_attendance_consent_config
  set current_version = '2026-11-10'
  where id is true;

  v_record := public.record_payroll_bn_attendance_event(
    'TASK_CONSENT_E4', 'in', repeat('d', 64), v_s4,
    10.750100, 106.650100, 8, now(), 'TASK_CONSENT_E4/smoke/version-bump.jpg', 'smoke'
  );
  if v_record->>'reason_code' is distinct from 'consent_required' then
    raise exception 'version_bump_not_blocked: %', v_record;
  end if;

  v_accept := public.accept_payroll_bn_attendance_consent(
    'TASK_CONSENT_E4', '2026-11-10', repeat('d', 64), v_s4, 'smoke'
  );
  if v_accept->'consent'->>'consent_version' is distinct from '2026-11-10' then
    raise exception 'reaccept_new_version_failed: %', v_accept;
  end if;

  v_record := public.record_payroll_bn_attendance_event(
    'TASK_CONSENT_E4', 'in', repeat('d', 64), v_s4,
    10.750100, 106.650100, 8, now(), 'TASK_CONSENT_E4/smoke/reaccepted.jpg', 'smoke'
  );
  if v_record->>'decision' is distinct from 'accepted' then
    raise exception 'reaccept_then_checkin_failed: %', v_record;
  end if;

  -- -----------------------------------------------------------------------
  -- 6. Consent rows are append-only: update/delete blocked, withdrawn_at once.
  -- -----------------------------------------------------------------------
  select id into v_active_consent_id
  from public.payroll_bn_attendance_consents
  where employee_code = 'TASK_CONSENT_E2'
    and withdrawn_at is null
  order by accepted_at desc
  limit 1;

  begin
    update public.payroll_bn_attendance_consents
    set device_hash = repeat('f', 64)
    where id = v_active_consent_id;
    raise exception 'only_withdrawn_at_not_blocked';
  exception when sqlstate '45000' then
    null;
  end;

  begin
    delete from public.payroll_bn_attendance_consents
    where id = v_active_consent_id;
    raise exception 'delete_blocked';
  exception when sqlstate '45000' then
    null;
  end;

  -- First withdrawal is allowed through the service-role RPC.
  v_accept := public.accept_payroll_bn_attendance_consent(
    'TASK_CONSENT_E5', '2026-11-10', repeat('e', 64), v_s5, 'smoke'
  );
  v_consent_id := (v_accept->'consent'->>'id')::uuid;
  perform public.withdraw_payroll_bn_attendance_consent('TASK_CONSENT_E5');
  if (
    select withdrawn_at
    from public.payroll_bn_attendance_consents
    where id = v_consent_id
  ) is null then
    raise exception 'first_withdrawal_not_recorded';
  end if;

  begin
    update public.payroll_bn_attendance_consents
    set withdrawn_at = now()
    where id = v_consent_id;
    raise exception 'withdrawn_once_not_blocked';
  exception when sqlstate '45000' then
    null;
  end;

  -- Browser roles cannot execute the consent RPCs.
  if has_function_privilege(
    'anon',
    'public.accept_payroll_bn_attendance_consent(text,text,text,uuid,text)',
    'EXECUTE'
  ) then
    raise exception 'anon_can_accept_consent';
  end if;
  if has_function_privilege(
    'anon',
    'public.withdraw_payroll_bn_attendance_consent(text)',
    'EXECUTE'
  ) then
    raise exception 'anon_can_withdraw_consent';
  end if;
end
$$;

rollback;
