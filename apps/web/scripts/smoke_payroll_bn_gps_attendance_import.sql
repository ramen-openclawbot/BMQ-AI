-- Rollback-only smoke for 20261110220000_payroll_bn_gps_attendance_import.sql.
--
-- Maestro only: the Harness never runs this file against a live database.
-- Run from apps/web after the migration is reviewed/applied:
--   psql -v ON_ERROR_STOP=1 -f scripts/smoke_payroll_bn_gps_attendance_import.sql
--
-- Pure SQL: one transaction wraps one DO block. It sets service_role JWT claims,
-- seeds throwaway periods/employees/config (all codes prefixed TASK, group
-- TASK_SMOKE_GROUP) and asserts:
--   * preview is read-only and its totals match;
--   * import writes one gps import + rows with Vietnam-local first-in/last-out;
--   * an existing machine row is skipped and never overwritten;
--   * a second identical pull inserts nothing;
--   * an outside-period code is reported in skipped_codes and not inserted;
--   * late_minutes uses the published shift start + grace, null without a shift;
--   * locked period and non-manager callers are refused;
--   * the schedule summary returns the expected per-employee counts;
--   * payroll_bn_import_attendance still works for another date afterwards;
--   * notice GPS_IMPORT_SMOKE_PASS.
-- A final rollback leaves no fixture and restores the group check constraint.

begin;

do $$
declare
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_period_from date := v_today - 10;
  v_period_to date := v_today + 10;
  v_from date := v_today - 3;
  v_to date := v_today;
  v_week date;
  v_period_id uuid;
  v_eligible_period_id uuid;
  v_machine_import_id uuid;
  v_manager uuid;
  v_preview jsonb;
  v_import jsonb;
  v_import2 jsonb;
  v_summary jsonb;
  v_employee jsonb;
  v_before integer;
  v_after integer;
  v_count integer;
  v_d1 date := v_today - 2;
  v_d2 date := v_today - 1;
  v_d3 date := v_today - 3;
  v_entry public.payroll_bn_attendance_rows%rowtype;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- -----------------------------------------------------------------------
  -- Throwaway configuration. The TASK group is outside the production group
  -- check; the constraint is restored by the final rollback.
  -- -----------------------------------------------------------------------
  alter table public.payroll_bn_period_employees
    drop constraint if exists payroll_bn_period_employees_group_check;

  insert into public.payroll_bn_shift_types(code, label, start_time, end_time, sort, active)
  values
    ('TASK_GPS_SANG', 'Ca sáng GPS smoke', '08:00', '12:00', 1, true),
    ('TASK_GPS_CHIEU', 'Ca chiều GPS smoke', '13:00', '17:00', 2, true)
  on conflict (code) do update
  set label = excluded.label,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      sort = excluded.sort,
      active = excluded.active;

  delete from public.payroll_bn_shift_quotas
  where shift_code in ('TASK_GPS_SANG', 'TASK_GPS_CHIEU');

  insert into public.payroll_bn_shift_quotas(shift_code, iso_dow, needed, quota_group)
  values
    ('TASK_GPS_SANG', null, 10, null),
    ('TASK_GPS_CHIEU', null, 10, null);

  perform public.upsert_payroll_bn_shift_config(jsonb_build_object(
    'settings', jsonb_build_object(
      'eligible_groups', jsonb_build_array('TASK_SMOKE_GROUP'),
      'open_iso_dow', 1,
      'deadline_iso_dow', 7,
      'deadline_time', '23:59',
      'max_off_per_day', 5,
      'min_staff_per_day', 1,
      'min_off_days_per_week', 1,
      'late_grace_minutes', 5
    )
  ));

  insert into public.payroll_bn_periods(
    period_code, period_name, date_from, date_to, default_standard_days
  ) values (
    'TASK-GPS-SMOKE',
    'Task GPS smoke',
    v_period_from,
    v_period_to,
    26
  ) returning id into v_period_id;

  -- A far-future latest period makes the same employees shift-eligible.
  insert into public.payroll_bn_periods(
    period_code, period_name, date_from, date_to, default_standard_days
  ) values (
    'TASK-GPS-SMOKE-ELIGIBLE',
    'Task GPS smoke eligible',
    v_today + 3650,
    v_today + 3680,
    26
  ) returning id into v_eligible_period_id;

  insert into public.payroll_bn_period_employees(
    period_id, employee_code, employee_name, group_name, employment_type, end_date
  ) values
    (v_period_id, 'TASK_GPS_E1', 'Task GPS E1', 'TASK_SMOKE_GROUP', 'official', null),
    (v_period_id, 'TASK_GPS_E2', 'Task GPS E2', 'TASK_SMOKE_GROUP', 'official', null),
    (v_period_id, 'TASK_GPS_E3', 'Task GPS E3', 'TASK_SMOKE_GROUP', 'official', null),
    (v_period_id, 'TASK_GPS_E4', 'Task GPS E4', 'TASK_SMOKE_GROUP', 'official', null),
    (v_period_id, 'TASK_GPS_E5', 'Task GPS E5', 'TASK_SMOKE_GROUP', 'official', null),
    (v_period_id, 'TASK_GPS_E6', 'Task GPS E6', 'TASK_SMOKE_GROUP', 'official', null),
    (v_period_id, 'TASK_GPS_E7', 'Task GPS E7', 'TASK_SMOKE_GROUP', 'official', null),
    (v_period_id, 'TASK_GPS_E8', 'Task GPS E8', 'TASK_SMOKE_GROUP', 'official', null),
    (v_eligible_period_id, 'TASK_GPS_E1', 'Task GPS E1', 'TASK_SMOKE_GROUP', 'official', null),
    (v_eligible_period_id, 'TASK_GPS_E2', 'Task GPS E2', 'TASK_SMOKE_GROUP', 'official', null),
    (v_eligible_period_id, 'TASK_GPS_E3', 'Task GPS E3', 'TASK_SMOKE_GROUP', 'official', null),
    (v_eligible_period_id, 'TASK_GPS_E4', 'Task GPS E4', 'TASK_SMOKE_GROUP', 'official', null),
    (v_eligible_period_id, 'TASK_GPS_E5', 'Task GPS E5', 'TASK_SMOKE_GROUP', 'official', null),
    (v_eligible_period_id, 'TASK_GPS_E6', 'Task GPS E6', 'TASK_SMOKE_GROUP', 'official', null),
    (v_eligible_period_id, 'TASK_GPS_E7', 'Task GPS E7', 'TASK_SMOKE_GROUP', 'official', null),
    (v_eligible_period_id, 'TASK_GPS_E8', 'Task GPS E8', 'TASK_SMOKE_GROUP', 'official', null);

  -- Each shift date inserts its published week row first.
  foreach v_week in array array[
    public.payroll_bn_shift_week_start(v_d3),
    public.payroll_bn_shift_week_start(v_d2),
    public.payroll_bn_shift_week_start(v_d1),
    public.payroll_bn_shift_week_start(v_today)
  ] loop
    insert into public.payroll_bn_shift_weeks(week_start, status, published_at)
    values (v_week, 'published', now())
    on conflict (week_start) do update
    set status = 'published',
        published_at = excluded.published_at;
  end loop;

  insert into public.payroll_bn_shift_entries(
    week_start, employee_code, work_date, shift_code, state, source
  ) values
    (public.payroll_bn_shift_week_start(v_d1), 'TASK_GPS_E1', v_d1, 'TASK_GPS_SANG', 'registered', 'employee'),
    (public.payroll_bn_shift_week_start(v_d1), 'TASK_GPS_E2', v_d1, 'TASK_GPS_SANG', 'registered', 'employee'),
    (public.payroll_bn_shift_week_start(v_d1), 'TASK_GPS_E5', v_d1, 'TASK_GPS_SANG', 'registered', 'employee'),
    (public.payroll_bn_shift_week_start(v_d1), 'TASK_GPS_E6', v_d1, null, 'registered', 'manager'),
    (public.payroll_bn_shift_week_start(v_d1), 'TASK_GPS_E7', v_d1, 'TASK_GPS_CHIEU', 'registered', 'employee'),
    (public.payroll_bn_shift_week_start(v_d2), 'TASK_GPS_E4', v_d2, 'TASK_GPS_SANG', 'registered', 'employee');

  insert into public.payroll_bn_shift_requests(
    week_start, work_date, employee_code, kind, from_shift_code, to_shift_code,
    reason, state, decided_at
  ) values
    (public.payroll_bn_shift_week_start(v_d1), v_d1, 'TASK_GPS_E6', 'leave', 'TASK_GPS_SANG', null,
     'Nghỉ có duyệt smoke', 'approved', now()),
    (public.payroll_bn_shift_week_start(v_d1), v_d1, 'TASK_GPS_E7', 'change', 'TASK_GPS_SANG', 'TASK_GPS_CHIEU',
     'Đổi ca smoke', 'approved', now());

  -- GPS events (accepted in/out). The helper takes first-in / last-out in ICT.
  insert into public.payroll_bn_attendance_events(
    employee_code, event_kind, work_date, server_received_at, decision
  ) values
    ('TASK_GPS_E1', 'in', v_d1, (v_d1 + time '08:10') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_GPS_E1', 'out', v_d1, (v_d1 + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_GPS_E2', 'in', v_d1, (v_d1 + time '07:55') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_GPS_E2', 'out', v_d1, (v_d1 + time '17:05') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_GPS_E3', 'in', v_d2, (v_d2 + time '08:05') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_GPS_E3', 'out', v_d2, (v_d2 + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_GPS_E4', 'in', v_d2, (v_d2 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_GPS_E7', 'in', v_d1, (v_d1 + time '13:10') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_GPS_E7', 'out', v_d1, (v_d1 + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_GPS_E8', 'in', v_d1, (v_d1 + time '09:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_GPS_E8', 'out', v_d1, (v_d1 + time '18:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_GPS_OUTSIDE', 'in', v_d1, (v_d1 + time '08:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted'),
    ('TASK_GPS_OUTSIDE', 'out', v_d1, (v_d1 + time '17:00') at time zone 'Asia/Ho_Chi_Minh', 'accepted');

  -- A machine row already exists for E8: the GPS pull must never overwrite it.
  insert into public.payroll_bn_attendance_imports(
    period_id, file_name, sha256, row_count, source
  ) values (
    v_period_id, 'TASK_MACHINE.xlsx', repeat('a', 64), 1, 'machine'
  ) returning id into v_machine_import_id;

  insert into public.payroll_bn_attendance_rows(
    import_id, period_id, employee_code, employee_name, work_date,
    check_in, check_out, department, shift, late_minutes, early_minutes
  ) values (
    v_machine_import_id, v_period_id, 'TASK_GPS_E8', 'Task GPS E8', v_d1,
    time '09:00', time '18:00', 'TASK_SMOKE_GROUP', null, null, null
  );

  -- -----------------------------------------------------------------------
  -- Preview is read-only and totals match.
  -- -----------------------------------------------------------------------
  select count(*) into v_before
  from public.payroll_bn_attendance_rows
  where period_id = v_period_id;

  v_preview := public.preview_payroll_bn_gps_attendance(v_period_id, v_from, v_to);

  select count(*) into v_after
  from public.payroll_bn_attendance_rows
  where period_id = v_period_id;

  if v_after <> v_before then
    raise exception 'preview_wrote_rows: % -> %', v_before, v_after;
  end if;
  if (v_preview->'totals'->>'rows')::integer <> 6 then
    raise exception 'preview_rows_unexpected: %', v_preview->'totals';
  end if;
  if (v_preview->'totals'->>'employees')::integer <> 6 then
    raise exception 'preview_employees_unexpected: %', v_preview->'totals';
  end if;
  if (v_preview->'totals'->>'days_missing_out')::integer <> 1 then
    raise exception 'preview_missing_out_unexpected: %', v_preview->'totals';
  end if;
  if (v_preview->'totals'->>'already_in_period')::integer <> 1 then
    raise exception 'preview_already_unexpected: %', v_preview->'totals';
  end if;
  if (v_preview->'totals'->>'to_insert')::integer <> 5 then
    raise exception 'preview_to_insert_unexpected: %', v_preview->'totals';
  end if;
  if not ((v_preview->'skipped_codes') ? 'TASK_GPS_OUTSIDE') then
    raise exception 'preview_skipped_code_missing: %', v_preview->'skipped_codes';
  end if;

  -- -----------------------------------------------------------------------
  -- Import writes one gps import and only rows that were not already present.
  -- -----------------------------------------------------------------------
  v_import := public.import_payroll_bn_gps_attendance(v_period_id, v_from, v_to);

  if (v_import->>'already_imported')::boolean is not false then
    raise exception 'import_already_flag_unexpected: %', v_import;
  end if;
  if (v_import->>'inserted_rows')::integer <> 5 then
    raise exception 'import_inserted_unexpected: %', v_import;
  end if;
  if (v_import->>'skipped_existing')::integer <> 1 then
    raise exception 'import_skipped_unexpected: %', v_import;
  end if;
  if not ((v_import->'skipped_codes') ? 'TASK_GPS_OUTSIDE') then
    raise exception 'import_skipped_code_missing: %', v_import->'skipped_codes';
  end if;

  select count(*) into v_count
  from public.payroll_bn_attendance_imports
  where period_id = v_period_id
    and source = 'gps';
  if v_count <> 1 then
    raise exception 'gps_import_count_unexpected: %', v_count;
  end if;

  select * into v_entry
  from public.payroll_bn_attendance_rows
  where period_id = v_period_id
    and employee_code = 'TASK_GPS_E2'
    and work_date = v_d1;
  if v_entry.check_in is distinct from time '07:55'
     or v_entry.check_out is distinct from time '17:05' then
    raise exception 'first_in_last_out_unexpected: %', v_entry;
  end if;

  select * into v_entry
  from public.payroll_bn_attendance_rows
  where period_id = v_period_id
    and employee_code = 'TASK_GPS_E1'
    and work_date = v_d1;
  if v_entry.late_minutes is distinct from 10 then
    raise exception 'late_minutes_unexpected: %', v_entry;
  end if;

  select * into v_entry
  from public.payroll_bn_attendance_rows
  where period_id = v_period_id
    and employee_code = 'TASK_GPS_E3'
    and work_date = v_d2;
  if v_entry.late_minutes is not null then
    raise exception 'late_without_shift_not_null: %', v_entry;
  end if;

  select * into v_entry
  from public.payroll_bn_attendance_rows
  where period_id = v_period_id
    and employee_code = 'TASK_GPS_E4'
    and work_date = v_d2;
  if v_entry.check_out is not null or v_entry.late_minutes is distinct from 0 then
    raise exception 'missing_out_row_unexpected: %', v_entry;
  end if;

  select * into v_entry
  from public.payroll_bn_attendance_rows
  where period_id = v_period_id
    and employee_code = 'TASK_GPS_E8'
    and work_date = v_d1;
  if v_entry.import_id is distinct from v_machine_import_id
     or v_entry.check_in is distinct from time '09:00'
     or v_entry.check_out is distinct from time '18:00' then
    raise exception 'machine_row_overwritten: %', v_entry;
  end if;

  if exists (
    select 1
    from public.payroll_bn_attendance_rows
    where period_id = v_period_id
      and employee_code = 'TASK_GPS_OUTSIDE'
  ) then
    raise exception 'outside_code_inserted';
  end if;

  -- Second identical pull: all rows already exist, nothing new.
  select count(*) into v_before
  from public.payroll_bn_attendance_rows
  where period_id = v_period_id;

  v_import2 := public.import_payroll_bn_gps_attendance(v_period_id, v_from, v_to);

  select count(*) into v_after
  from public.payroll_bn_attendance_rows
  where period_id = v_period_id;

  if v_after <> v_before then
    raise exception 'second_import_inserted_rows: % -> %', v_before, v_after;
  end if;
  if (v_import2->>'inserted_rows')::integer <> 0 then
    raise exception 'second_import_not_empty: %', v_import2;
  end if;

  select count(*) into v_count
  from public.payroll_bn_attendance_imports
  where period_id = v_period_id
    and source = 'gps';
  if v_count <> 1 then
    raise exception 'second_import_created_import: %', v_count;
  end if;

  -- -----------------------------------------------------------------------
  -- Schedule summary for the fixtures.
  -- -----------------------------------------------------------------------
  v_summary := public.get_payroll_bn_period_schedule_summary(v_period_id);

  if (v_summary->>'covered_from') is null or (v_summary->>'covered_to') is null then
    raise exception 'summary_covered_range_missing: %', v_summary;
  end if;

  select value into v_employee
  from jsonb_array_elements(v_summary->'employees')
  where value->>'employee_code' = 'TASK_GPS_E1';
  if v_employee is null
     or (v_employee->>'scheduled_days')::integer <> 1
     or (v_employee->>'worked_days')::integer <> 1
     or (v_employee->>'worked_scheduled')::integer <> 1
     or (v_employee->>'late_days')::integer <> 1
     or (v_employee->>'late_minutes_total')::integer <> 10
     or (v_employee->>'no_show_days')::integer <> 0 then
    raise exception 'summary_e1_unexpected: %', v_employee;
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_employee->'details') d
    where d->>'kind' = 'late'
  ) then
    raise exception 'summary_e1_late_detail_missing: %', v_employee;
  end if;

  select value into v_employee
  from jsonb_array_elements(v_summary->'employees')
  where value->>'employee_code' = 'TASK_GPS_E3';
  if v_employee is null
     or (v_employee->>'worked_days')::integer <> 1
     or (v_employee->>'unscheduled_days')::integer <> 1 then
    raise exception 'summary_e3_unexpected: %', v_employee;
  end if;

  select value into v_employee
  from jsonb_array_elements(v_summary->'employees')
  where value->>'employee_code' = 'TASK_GPS_E4';
  if v_employee is null
     or (v_employee->>'scheduled_days')::integer <> 1
     or (v_employee->>'missing_out_days')::integer <> 1 then
    raise exception 'summary_e4_unexpected: %', v_employee;
  end if;

  select value into v_employee
  from jsonb_array_elements(v_summary->'employees')
  where value->>'employee_code' = 'TASK_GPS_E5';
  if v_employee is null
     or (v_employee->>'scheduled_days')::integer <> 1
     or (v_employee->>'no_show_days')::integer <> 1 then
    raise exception 'summary_e5_unexpected: %', v_employee;
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_employee->'details') d
    where d->>'kind' = 'no_show'
  ) then
    raise exception 'summary_e5_no_show_detail_missing: %', v_employee;
  end if;

  select value into v_employee
  from jsonb_array_elements(v_summary->'employees')
  where value->>'employee_code' = 'TASK_GPS_E6';
  if v_employee is null
     or (v_employee->>'off_days')::integer <> 1
     or (v_employee->>'approved_leaves')::integer <> 1
     or (v_employee->>'no_show_days')::integer <> 0 then
    raise exception 'summary_e6_unexpected: %', v_employee;
  end if;

  select value into v_employee
  from jsonb_array_elements(v_summary->'employees')
  where value->>'employee_code' = 'TASK_GPS_E7';
  if v_employee is null
     or (v_employee->>'approved_changes')::integer <> 1
     or (v_employee->>'late_days')::integer <> 1 then
    raise exception 'summary_e7_unexpected: %', v_employee;
  end if;

  -- -----------------------------------------------------------------------
  -- Non-manager caller is refused by the role helper.
  -- -----------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000bb"}',
    true
  );
  begin
    perform public.preview_payroll_bn_gps_attendance(v_period_id, v_from, v_to);
    raise exception 'non_manager_not_blocked';
  exception when sqlstate '42501' then
    if sqlerrm not like '%insufficient_privilege%' then
      raise exception 'non_manager_wrong_error: %', sqlerrm;
    end if;
  end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- -----------------------------------------------------------------------
  -- The existing machine-file import still works for another date.
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
    raise exception 'task_gps_smoke_no_manager';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_manager)::text,
    true
  );

  perform public.payroll_bn_import_attendance(
    v_period_id,
    'TASK_MACHINE_2.xlsx',
    repeat('b', 64),
    jsonb_build_array(jsonb_build_object(
      'employee_code', 'TASK_GPS_E2',
      'employee_name', 'Task GPS E2',
      'work_date', v_d3,
      'check_in', '08:00',
      'check_out', '17:00',
      'department', 'TASK_SMOKE_GROUP'
    ))
  );

  if not exists (
    select 1
    from public.payroll_bn_attendance_rows
    where period_id = v_period_id
      and employee_code = 'TASK_GPS_E2'
      and work_date = v_d3
  ) then
    raise exception 'machine_import_still_broken';
  end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- -----------------------------------------------------------------------
  -- Locked period refused.
  -- -----------------------------------------------------------------------
  update public.payroll_bn_periods
  set status = 'locked'
  where id = v_period_id;

  begin
    perform public.import_payroll_bn_gps_attendance(v_period_id, v_from, v_to);
    raise exception 'locked_period_not_blocked';
  exception when sqlstate '55006' then
    if sqlerrm not like '%payroll_bn_period_locked%' then
      raise exception 'locked_period_wrong_error: %', sqlerrm;
    end if;
  end;

  raise notice 'GPS_IMPORT_SMOKE_PASS';
end;
$$;

rollback;
