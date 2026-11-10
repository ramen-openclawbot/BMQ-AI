-- Rollback-only smoke for 20261110200000_payroll_bn_shift_requests.sql.
--
-- Maestro only: the Harness never runs this file against a live database.
-- Run from apps/web after the migration is reviewed/applied:
--   psql -v ON_ERROR_STOP=1 -f scripts/smoke_payroll_bn_shift_requests.sql
--
-- Pure SQL: one transaction wraps one DO block. It sets service_role JWT
-- claims, seeds a throwaway period/employees/config (all codes prefixed TASK,
-- group TASK_SMOKE_GROUP) and asserts:
--   * a request on an open, pre-deadline week is refused (use registration);
--   * leave + change happy paths on a published week;
--   * duplicate pending, past date, closed date, no-shift and same-shift errors;
--   * employee cancel (idempotent);
--   * approve leave updates the entry + returns a min-staff warning;
--   * approve change updates the entry;
--   * stale snapshot stays pending;
--   * reject keeps the entry;
--   * non-manager manager RPC and non-service_role employee RPC are refused;
--   * attendance flags return no_show, late, unscheduled and missing_out;
--   * payroll_mission_progress still runs;
--   * request events are written;
--   * extra_employee_codes is untouched;
--   * notice SHIFT_REQ_SMOKE_PASS.
-- A final rollback leaves no fixture and restores the group check constraint.

begin;

do $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_current_week date := public.payroll_bn_shift_week_start(v_today);
  v_week date := v_current_week + 7;
  v_open_week date := v_week + 7;
  v_past_week date := v_current_week - 7;
  v_period_id uuid;
  v_extra_before text[];
  v_extra_after text[];
  v_result jsonb;
  v_board jsonb;
  v_flags jsonb;
  v_request public.payroll_bn_shift_requests%rowtype;
  v_entry public.payroll_bn_shift_entries%rowtype;
  v_request_id uuid;
  v_kinds text[];
  v_d0 date;
  v_d1 date;
  v_d2 date;
  v_d3 date;
  v_d4 date;
  v_d5 date;
  v_d6 date;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  select extra_employee_codes into v_extra_before
  from public.payroll_bn_shift_settings
  where id;

  -- -----------------------------------------------------------------------
  -- Throwaway configuration. The TASK group is not in the production group
  -- check; the constraint is restored by the final rollback.
  -- -----------------------------------------------------------------------
  alter table public.payroll_bn_period_employees
    drop constraint if exists payroll_bn_period_employees_group_check;

  insert into public.payroll_bn_shift_types(code, label, start_time, end_time, sort, active)
  values
    ('TASK_REQ_SANG', 'Ca sáng smoke', '08:00', '12:00', 1, true),
    ('TASK_REQ_CHIEU', 'Ca chiều smoke', '13:00', '17:00', 2, true),
    ('TASK_REQ_TOI', 'Ca tối smoke', '18:00', '22:00', 3, true)
  on conflict (code) do update
  set label = excluded.label,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      sort = excluded.sort,
      active = excluded.active;

  delete from public.payroll_bn_shift_quotas
  where shift_code in ('TASK_REQ_SANG', 'TASK_REQ_CHIEU', 'TASK_REQ_TOI');

  insert into public.payroll_bn_shift_quotas(shift_code, iso_dow, needed, quota_group)
  values
    ('TASK_REQ_SANG', null, 5, null),
    -- Needed 0 makes the approved change below exceed the quota, so the
    -- decision payload must include an over-quota warning.
    ('TASK_REQ_CHIEU', null, 0, null),
    ('TASK_REQ_TOI', null, 5, null);

  v_result := public.upsert_payroll_bn_shift_config(jsonb_build_object(
    'settings', jsonb_build_object(
      'eligible_groups', jsonb_build_array('TASK_SMOKE_GROUP'),
      'open_iso_dow', 1,
      'deadline_iso_dow', 7,
      'deadline_time', '23:59',
      'max_off_per_day', 2,
      -- Deliberately high so the leave-approval min-staff warning is
      -- deterministic regardless of other rows in the smoke database.
      'min_staff_per_day', 999,
      'min_off_days_per_week', 1,
      'late_grace_minutes', 0
    )
  ));

  select extra_employee_codes into v_extra_after
  from public.payroll_bn_shift_settings
  where id;
  if v_extra_after is distinct from v_extra_before then
    raise exception 'extra_employee_codes_changed: % -> %', v_extra_before, v_extra_after;
  end if;

  -- A far-future latest period makes these employees the eligible roster.
  insert into public.payroll_bn_periods(
    period_code, period_name, date_from, date_to, default_standard_days
  ) values (
    'TASK-SHIFT-REQ-SMOKE',
    'Task shift request smoke',
    v_week + 3650,
    v_week + 3680,
    26
  ) returning id into v_period_id;

  insert into public.payroll_bn_period_employees(
    period_id, employee_code, employee_name, group_name, employment_type, end_date
  ) values
    (v_period_id, 'TASK_REQ_E1', 'Task Request E1', 'TASK_SMOKE_GROUP', 'official', null),
    (v_period_id, 'TASK_REQ_E2', 'Task Request E2', 'TASK_SMOKE_GROUP', 'official', null),
    (v_period_id, 'TASK_REQ_E3', 'Task Request E3', 'TASK_SMOKE_GROUP', 'official', null),
    (v_period_id, 'TASK_REQ_E4', 'Task Request E4', 'TASK_SMOKE_GROUP', 'official', null),
    (v_period_id, 'TASK_REQ_E5', 'Task Request E5', 'TASK_SMOKE_GROUP', 'official', null),
    (v_period_id, 'TASK_REQ_E6', 'Task Request E6', 'TASK_SMOKE_GROUP', 'official', null);

  -- -----------------------------------------------------------------------
  -- Week rows are always inserted first, using week_start(date).
  -- -----------------------------------------------------------------------
  insert into public.payroll_bn_shift_weeks(week_start, status, published_at)
  values
    (v_week, 'published', now()),
    (v_open_week, 'open', null),
    (v_past_week, 'published', now())
  on conflict (week_start) do update
  set status = excluded.status,
      published_at = excluded.published_at;

  v_d0 := public.payroll_bn_shift_week_start(v_week) + 0;
  v_d1 := public.payroll_bn_shift_week_start(v_week) + 1;
  v_d2 := public.payroll_bn_shift_week_start(v_week) + 2;
  v_d3 := public.payroll_bn_shift_week_start(v_week) + 3;
  v_d4 := public.payroll_bn_shift_week_start(v_week) + 4;
  v_d5 := public.payroll_bn_shift_week_start(v_week) + 5;
  v_d6 := public.payroll_bn_shift_week_start(v_week) + 6;

  insert into public.payroll_bn_shift_entries(
    week_start, employee_code, work_date, shift_code, state, source
  ) values
    (public.payroll_bn_shift_week_start(v_d0), 'TASK_REQ_E1', v_d0, 'TASK_REQ_SANG', 'registered', 'employee'),
    (public.payroll_bn_shift_week_start(v_d1), 'TASK_REQ_E2', v_d1, 'TASK_REQ_SANG', 'registered', 'employee'),
    (public.payroll_bn_shift_week_start(v_d2), 'TASK_REQ_E3', v_d2, 'TASK_REQ_SANG', 'registered', 'employee'),
    (public.payroll_bn_shift_week_start(v_d3), 'TASK_REQ_E4', v_d3, 'TASK_REQ_SANG', 'registered', 'employee'),
    (public.payroll_bn_shift_week_start(v_d4), 'TASK_REQ_E5', v_d4, 'TASK_REQ_SANG', 'registered', 'employee'),
    (public.payroll_bn_shift_week_start(v_d5), 'TASK_REQ_E6', v_d5, 'TASK_REQ_SANG', 'registered', 'employee');

  -- -----------------------------------------------------------------------
  -- Before the deadline on an open week -> use the registration instead.
  -- -----------------------------------------------------------------------
  begin
    perform public.submit_payroll_bn_shift_request(
      'TASK_REQ_E1',
      public.payroll_bn_shift_week_start(v_open_week) + 0,
      'leave',
      null,
      'Việc nhà'
    );
    raise exception 'open_week_not_blocked';
  exception when sqlstate '22023' then
    if sqlerrm not like '%shift_request_use_registration%' then
      raise exception 'open_week_wrong_error: %', sqlerrm;
    end if;
  end;

  -- Past date on a published week.
  begin
    perform public.submit_payroll_bn_shift_request(
      'TASK_REQ_E1',
      v_today - 1,
      'leave',
      null,
      'Việc nhà'
    );
    raise exception 'past_date_not_blocked';
  exception when sqlstate '22023' then
    if sqlerrm not like '%shift_request_past_date%' then
      raise exception 'past_date_wrong_error: %', sqlerrm;
    end if;
  end;

  -- Closed date on the published request week.
  update public.payroll_bn_shift_weeks
  set closed_dates = array[v_d6]
  where week_start = v_week;

  begin
    perform public.submit_payroll_bn_shift_request(
      'TASK_REQ_E1',
      v_d6,
      'change',
      'TASK_REQ_CHIEU',
      'Đổi ca'
    );
    raise exception 'closed_date_not_blocked';
  exception when sqlstate '22023' then
    if sqlerrm not like '%shift_request_closed_date%' then
      raise exception 'closed_date_wrong_error: %', sqlerrm;
    end if;
  end;

  update public.payroll_bn_shift_weeks
  set closed_dates = '{}'::date[]
  where week_start = v_week;

  -- Leave on a day without a registered shift.
  begin
    perform public.submit_payroll_bn_shift_request(
      'TASK_REQ_E5',
      v_d5,
      'leave',
      null,
      'Việc nhà'
    );
    raise exception 'no_shift_not_blocked';
  exception when sqlstate '22023' then
    if sqlerrm not like '%shift_request_no_shift%' then
      raise exception 'no_shift_wrong_error: %', sqlerrm;
    end if;
  end;

  -- Change to the current shift.
  begin
    perform public.submit_payroll_bn_shift_request(
      'TASK_REQ_E5',
      v_d4,
      'change',
      'TASK_REQ_SANG',
      'Đổi ca'
    );
    raise exception 'same_shift_not_blocked';
  exception when sqlstate '22023' then
    if sqlerrm not like '%shift_request_same_shift%' then
      raise exception 'same_shift_wrong_error: %', sqlerrm;
    end if;
  end;

  -- -----------------------------------------------------------------------
  -- Leave happy path + approval warnings.
  -- -----------------------------------------------------------------------
  v_result := public.submit_payroll_bn_shift_request(
    'TASK_REQ_E1',
    v_d0,
    'leave',
    null,
    'Việc gia đình'
  );
  v_request_id := (v_result->'request'->>'id')::uuid;
  if (v_result->'request'->>'state') is distinct from 'pending' then
    raise exception 'leave_request_not_pending: %', v_result;
  end if;
  if (v_result->'request'->>'from_shift_code') is distinct from 'TASK_REQ_SANG' then
    raise exception 'leave_from_snapshot_wrong: %', v_result;
  end if;

  v_result := public.decide_payroll_bn_shift_request(
    v_request_id,
    true,
    'Duyệt nghỉ'
  );
  if (v_result->'request'->>'state') is distinct from 'approved' then
    raise exception 'leave_not_approved: %', v_result;
  end if;
  if coalesce((v_result->'warnings'->>'below_min_staff')::boolean, false) is not true then
    raise exception 'leave_min_staff_warning_missing: %', v_result->'warnings';
  end if;

  select * into v_entry
  from public.payroll_bn_shift_entries
  where employee_code = 'TASK_REQ_E1'
    and work_date = v_d0;
  if v_entry.shift_code is not null
     or v_entry.state is distinct from 'registered'
     or v_entry.source is distinct from 'manager' then
    raise exception 'leave_entry_not_day_off: %', v_entry;
  end if;

  -- -----------------------------------------------------------------------
  -- Duplicate pending for the same employee/day.
  -- -----------------------------------------------------------------------
  perform public.submit_payroll_bn_shift_request(
    'TASK_REQ_E2',
    v_d1,
    'change',
    'TASK_REQ_CHIEU',
    'Đổi ca'
  );
  begin
    perform public.submit_payroll_bn_shift_request(
      'TASK_REQ_E2',
      v_d1,
      'change',
      'TASK_REQ_TOI',
      'Đổi ca lần hai'
    );
    raise exception 'duplicate_not_blocked';
  exception when sqlstate '22023' then
    if sqlerrm not like '%shift_request_duplicate%' then
      raise exception 'duplicate_wrong_error: %', sqlerrm;
    end if;
  end;

  -- -----------------------------------------------------------------------
  -- Cancel is owner-only while pending and idempotent.
  -- -----------------------------------------------------------------------
  v_result := public.submit_payroll_bn_shift_request(
    'TASK_REQ_E3',
    v_d2,
    'leave',
    null,
    'Việc nhà'
  );
  v_request_id := (v_result->'request'->>'id')::uuid;

  v_result := public.cancel_payroll_bn_shift_request('TASK_REQ_E3', v_request_id);
  if (v_result->'request'->>'state') is distinct from 'cancelled' then
    raise exception 'cancel_not_stored: %', v_result;
  end if;

  v_result := public.cancel_payroll_bn_shift_request('TASK_REQ_E3', v_request_id);
  if (v_result->'request'->>'state') is distinct from 'cancelled' then
    raise exception 'cancel_not_idempotent: %', v_result;
  end if;

  -- -----------------------------------------------------------------------
  -- Change happy path.
  -- -----------------------------------------------------------------------
  v_result := public.submit_payroll_bn_shift_request(
    'TASK_REQ_E4',
    v_d3,
    'change',
    'TASK_REQ_CHIEU',
    'Đổi ca'
  );
  v_request_id := (v_result->'request'->>'id')::uuid;

  v_result := public.decide_payroll_bn_shift_request(
    v_request_id,
    true,
    'Duyệt đổi ca'
  );
  if (v_result->'request'->>'state') is distinct from 'approved' then
    raise exception 'change_not_approved: %', v_result;
  end if;
  if jsonb_array_length(coalesce(v_result->'warnings'->'over_needed', '[]'::jsonb)) < 1 then
    raise exception 'change_over_quota_warning_missing: %', v_result->'warnings';
  end if;

  select * into v_entry
  from public.payroll_bn_shift_entries
  where employee_code = 'TASK_REQ_E4'
    and work_date = v_d3;
  if v_entry.shift_code is distinct from 'TASK_REQ_CHIEU'
     or v_entry.state is distinct from 'registered'
     or v_entry.source is distinct from 'manager' then
    raise exception 'change_entry_not_applied: %', v_entry;
  end if;

  -- -----------------------------------------------------------------------
  -- Reject keeps the entry.
  -- -----------------------------------------------------------------------
  v_result := public.submit_payroll_bn_shift_request(
    'TASK_REQ_E5',
    v_d4,
    'change',
    'TASK_REQ_CHIEU',
    'Đổi ca'
  );
  v_request_id := (v_result->'request'->>'id')::uuid;

  v_result := public.decide_payroll_bn_shift_request(
    v_request_id,
    false,
    'Không duyệt'
  );
  if (v_result->'request'->>'state') is distinct from 'rejected' then
    raise exception 'reject_not_stored: %', v_result;
  end if;

  select * into v_entry
  from public.payroll_bn_shift_entries
  where employee_code = 'TASK_REQ_E5'
    and work_date = v_d4;
  if v_entry.shift_code is distinct from 'TASK_REQ_SANG' then
    raise exception 'reject_changed_entry: %', v_entry;
  end if;

  -- -----------------------------------------------------------------------
  -- Stale snapshot stays pending.
  -- -----------------------------------------------------------------------
  v_result := public.submit_payroll_bn_shift_request(
    'TASK_REQ_E6',
    v_d5,
    'change',
    'TASK_REQ_CHIEU',
    'Đổi ca'
  );
  v_request_id := (v_result->'request'->>'id')::uuid;

  update public.payroll_bn_shift_entries
  set shift_code = 'TASK_REQ_TOI',
      state = 'registered',
      source = 'manager'
  where employee_code = 'TASK_REQ_E6'
    and work_date = v_d5;

  begin
    perform public.decide_payroll_bn_shift_request(
      v_request_id,
      true,
      'Duyệt đổi ca'
    );
    raise exception 'stale_not_blocked';
  exception when sqlstate '22023' then
    if sqlerrm not like '%shift_request_stale%' then
      raise exception 'stale_wrong_error: %', sqlerrm;
    end if;
  end;

  select * into v_request
  from public.payroll_bn_shift_requests
  where id = v_request_id;
  if v_request.state is distinct from 'pending' then
    raise exception 'stale_request_left_pending_state: %', v_request;
  end if;

  -- -----------------------------------------------------------------------
  -- Board pending count + manager list impact.
  -- -----------------------------------------------------------------------
  v_board := public.get_payroll_bn_shift_board(v_week);
  if not (v_board ? 'pending_requests') then
    raise exception 'board_pending_requests_missing: %', v_board;
  end if;
  if (v_board->>'pending_requests')::integer < 1 then
    raise exception 'board_pending_requests_unexpected: %', v_board->'pending_requests';
  end if;

  v_result := public.list_payroll_bn_shift_requests(v_week, 'pending');
  if jsonb_array_length(v_result->'requests') < 1 then
    raise exception 'manager_request_list_empty: %', v_result;
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(v_result->'requests') r
    where r->>'employee_code' = 'TASK_REQ_E2'
      and coalesce(r->>'employee_name', '') <> ''
      and r ? 'impact'
      and (r->'impact') ? 'coverage'
      and (r->'impact') ? 'warnings'
  ) then
    raise exception 'manager_request_impact_missing: %', v_result;
  end if;

  -- -----------------------------------------------------------------------
  -- Non-manager authenticated caller is refused by the role helper.
  -- -----------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000aa"}',
    true
  );
  begin
    perform public.list_payroll_bn_shift_requests(v_week, null);
    raise exception 'non_manager_not_blocked';
  exception when sqlstate '42501' then
    if sqlerrm not like '%payroll_shift_forbidden%' then
      raise exception 'non_manager_wrong_error: %', sqlerrm;
    end if;
  end;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- -----------------------------------------------------------------------
  -- The employee request RPC is not executable by the authenticated role.
  -- -----------------------------------------------------------------------
  begin
    execute 'set local role authenticated';
    perform public.submit_payroll_bn_shift_request(
      'TASK_REQ_E1',
      v_d0,
      'leave',
      null,
      'Việc nhà'
    );
    raise exception 'non_service_role_not_blocked';
  exception when insufficient_privilege then
    null;
  end;
  execute 'reset role';

  -- -----------------------------------------------------------------------
  -- Attendance flags from a published past week.
  -- -----------------------------------------------------------------------
  insert into public.payroll_bn_shift_weeks(week_start, status, published_at)
  values (v_past_week, 'published', now())
  on conflict (week_start) do update
  set status = 'published',
      published_at = excluded.published_at;

  insert into public.payroll_bn_shift_entries(
    week_start, employee_code, work_date, shift_code, state, source
  ) values
    (public.payroll_bn_shift_week_start(v_past_week + 0), 'TASK_REQ_E1', v_past_week + 0, 'TASK_REQ_SANG', 'registered', 'employee'),
    (public.payroll_bn_shift_week_start(v_past_week + 1), 'TASK_REQ_E2', v_past_week + 1, 'TASK_REQ_SANG', 'registered', 'employee'),
    (public.payroll_bn_shift_week_start(v_past_week + 3), 'TASK_REQ_E4', v_past_week + 3, 'TASK_REQ_SANG', 'registered', 'employee');

  insert into public.payroll_bn_attendance_events(
    employee_code, event_kind, work_date, server_received_at, decision
  ) values
    -- late: 08:10 against an 08:00 start, 0 grace.
    ('TASK_REQ_E2', 'in', v_past_week + 1, ((v_past_week + 1) + time '08:10') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_REQ_E2', 'out', v_past_week + 1, ((v_past_week + 1) + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    -- unscheduled: check-in on a day with no registered shift.
    ('TASK_REQ_E3', 'in', v_past_week + 2, ((v_past_week + 2) + time '08:05') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_REQ_E3', 'out', v_past_week + 2, ((v_past_week + 2) + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    -- missing_out: check-in, no check-out.
    ('TASK_REQ_E4', 'in', v_past_week + 3, ((v_past_week + 3) + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted');
  -- TASK_REQ_E1 has a registered shift and no event -> no_show.

  v_flags := public.get_payroll_bn_shift_attendance_flags(v_past_week);

  select array_agg(distinct f->>'kind')
  into v_kinds
  from jsonb_array_elements(v_flags->'flags') f;

  if v_kinds is null
     or not (v_kinds @> array['no_show', 'late', 'unscheduled', 'missing_out']) then
    raise exception 'attendance_flag_kinds_unexpected: %', v_flags;
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(v_flags->'flags') f
    where f->>'kind' = 'late'
      and (f->>'minutes_late')::integer = 10
  ) then
    raise exception 'late_minutes_unexpected: %', v_flags;
  end if;

  -- -----------------------------------------------------------------------
  -- Mission progress still runs.
  -- -----------------------------------------------------------------------
  v_result := public.payroll_mission_progress(gen_random_uuid());
  if jsonb_typeof(v_result) is distinct from 'array' then
    raise exception 'mission_progress_broken: %', v_result;
  end if;

  -- -----------------------------------------------------------------------
  -- Audit events for submit/approve/reject/cancel.
  -- -----------------------------------------------------------------------
  if not exists (
    select 1 from public.payroll_bn_shift_events
    where week_start = v_week and action = 'request_submitted'
  ) then
    raise exception 'request_submit_not_audited';
  end if;
  if not exists (
    select 1 from public.payroll_bn_shift_events
    where week_start = v_week and action = 'request_approved'
  ) then
    raise exception 'request_approve_not_audited';
  end if;
  if not exists (
    select 1 from public.payroll_bn_shift_events
    where week_start = v_week and action = 'request_rejected'
  ) then
    raise exception 'request_reject_not_audited';
  end if;
  if not exists (
    select 1 from public.payroll_bn_shift_events
    where week_start = v_week and action = 'request_cancelled'
  ) then
    raise exception 'request_cancel_not_audited';
  end if;

  raise notice 'SHIFT_REQ_SMOKE_PASS';
end;
$$;

rollback;
