-- Rollback-only smoke for 20261111090000_payroll_bn_open_current_period.sql.
--
-- Maestro only: the Harness never runs this file against a live database.
-- Run from apps/web after the migration is reviewed/applied:
--   psql -v ON_ERROR_STOP=1 -f scripts/smoke_payroll_bn_open_current_period.sql
--
-- Pure SQL: one transaction wraps one DO block. It sets service_role JWT claims,
-- works relative to the real periods already in production and asserts:
--   * the latest earlier period is the catalogue/config source;
--   * payroll_bn_open_period(null) creates the current month draft period with
--     the T#MM.YYYY code, the "Kỳ lương tháng MM/YYYY — Bếp BN" name and the
--     first/last day of the month;
--   * standard-days config/rules are copied, holidays are reset to [];
--   * copied_employees equals the source rows whose end_date is null or not
--     before the new month; a TASK employee terminated before the month is not
--     copied, and standard_days_override is null on every copied row;
--   * salaries/rates and names are copied unchanged;
--   * a second call returns created=false and adds no period or employee row;
--   * a future month is refused and a non-manager authenticated caller is
--     refused;
--   * get_payroll_bn_current_period returns the new period;
--   * payroll_bn_shift_eligible stays true for a catalogue employee of an
--     eligible group (groups read from payroll_bn_shift_settings, no literal);
--   * notice OPEN_PERIOD_SMOKE_PASS.
--
-- BRANCH: when the current month already has a period, public open must return
-- it unchanged. The same catalogue assertions are then exercised through
-- payroll_bn_open_period_internal on a throwaway TASK-only month pair (documented
-- below), because get_payroll_bn_current_period can only describe the real
-- current month.
--
-- A final rollback leaves no fixture and restores the group check constraint.

begin;

do $$
declare
  v_month date := date_trunc('month', (now() at time zone 'Asia/Ho_Chi_Minh')::date)::date;
  v_month_to date;
  v_month_code text;
  v_month_name text;
  v_latest_before public.payroll_bn_periods%rowtype;
  v_existing_month public.payroll_bn_periods%rowtype;
  v_source public.payroll_bn_periods%rowtype;
  v_opened public.payroll_bn_periods%rowtype;
  v_task_source public.payroll_bn_periods%rowtype;
  v_result jsonb;
  v_result2 jsonb;
  v_current jsonb;
  v_expected integer;
  v_rows_before integer;
  v_rows_after integer;
  v_periods_before integer;
  v_periods_after integer;
  v_latest_period_id uuid;
  v_eligible_code text;
  v_eligible_group text;
  v_group text := 'TASK_OPEN_GROUP';
  v_terminated_code text;
  v_task_month date;
  v_task_prev date;
  v_task_code text;
  v_task_month_to date;
  v_task_counter integer := 0;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  v_month_to := (v_month + interval '1 month' - interval '1 day')::date;
  v_month_code := 'T' || to_char(v_month, 'MM') || '.' || to_char(v_month, 'YYYY');
  v_month_name := 'Kỳ lương tháng '
    || to_char(v_month, 'MM') || '/' || to_char(v_month, 'YYYY')
    || ' — Bếp BN';

  -- Throwaway group for the terminated fixture; restored by the final rollback.
  alter table public.payroll_bn_period_employees
    drop constraint if exists payroll_bn_period_employees_group_check;

  -- The latest real period that starts before the current month is the
  -- catalogue/config source the internal worker must choose.
  select *
    into v_latest_before
  from public.payroll_bn_periods p
  where p.date_from < v_month
  order by p.date_from desc, p.created_at desc
  limit 1;

  select *
    into v_existing_month
  from public.payroll_bn_periods p
  where p.date_from >= v_month
    and p.date_from < (v_month + interval '1 month')::date
  order by p.date_from, p.created_at
  limit 1;

  if v_existing_month.id is null then
    -- =====================================================================
    -- MAIN BRANCH: current month is missing; use the real latest period.
    -- =====================================================================
    if v_latest_before.id is not null then
      v_source := v_latest_before;
    else
      -- No earlier real period (fresh database): seed one TASK-only source.
      insert into public.payroll_bn_periods (
        period_code, period_name, date_from, date_to, status,
        default_standard_days, standard_days_by_group, holidays, rules_config
      ) values (
        'TASK_OPEN_SOURCE',
        'Task open source',
        (v_month - interval '1 month')::date,
        (v_month - interval '1 day')::date,
        'draft',
        27.5,
        jsonb_build_object(v_group, 27.5),
        '[]'::jsonb,
        jsonb_build_object('task', true)
      )
      returning * into v_source;

      insert into public.payroll_bn_period_employees (
        period_id, employee_code, employee_name, group_name, employment_type,
        monthly_salary, daily_rate, hourly_rate, overtime_rate, allowance,
        standard_days_override, start_date, end_date
      ) values
        (v_source.id, 'TASK_OPEN_E1', 'Task Open E1', v_group, 'official',
         9000000, 400000, 50000, 60000, 300000, 9, v_source.date_from, null),
        (v_source.id, 'TASK_OPEN_E2', 'Task Open E2', v_group, 'official',
         8000000, 350000, 45000, 55000, 200000, 8, v_source.date_from,
         (v_month - interval '1 day')::date),
        (v_source.id, 'TASK_OPEN_E3', 'Task Open E3', v_group, 'official',
         7000000, 300000, 40000, 50000, 100000, 7, v_source.date_from, v_month),
        (v_source.id, 'TASK_OPEN_E4', 'Task Open E4', v_group, 'part_time',
         null, null, 60000, 70000, 50000, 6, v_source.date_from, null);
    end if;

    -- A TASK employee who already left before the new month must be skipped.
    v_terminated_code := 'TASK_OPEN_TERMINATED_'
      || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS');
    alter table public.payroll_bn_period_employees
      disable trigger payroll_bn_guard_locked_period_employees;
    insert into public.payroll_bn_period_employees (
      period_id, employee_code, employee_name, group_name, employment_type,
      monthly_salary, daily_rate, hourly_rate, overtime_rate, allowance,
      standard_days_override, start_date, end_date
    ) values (
      v_source.id, v_terminated_code, 'Task Open Terminated', v_group, 'official',
      1000000, 50000, 10000, 20000, 100000, 5, v_source.date_from,
      (v_month - interval '1 day')::date
    )
    on conflict (period_id, employee_code) do nothing;
    alter table public.payroll_bn_period_employees
      enable trigger payroll_bn_guard_locked_period_employees;

    select count(*)
      into v_expected
    from public.payroll_bn_period_employees e
    where e.period_id = v_source.id
      and (e.end_date is null or e.end_date >= v_month);

    select count(*) into v_periods_before from public.payroll_bn_periods;
    v_result := public.payroll_bn_open_period(null);
    select count(*) into v_periods_after from public.payroll_bn_periods;

    if v_result->>'created' is distinct from 'true' then
      raise exception 'open_period_not_created: %', v_result;
    end if;
    if v_result->>'period_id' is null then
      raise exception 'open_period_missing_id: %', v_result;
    end if;
    if v_result->>'period_code' is distinct from v_month_code then
      raise exception 'open_period_code_unexpected: % <> %', v_result->>'period_code', v_month_code;
    end if;
    if v_result->>'source_period_code' is distinct from v_source.period_code then
      raise exception 'open_period_source_unexpected: % <> %',
        v_result->>'source_period_code', v_source.period_code;
    end if;
    if coalesce((v_result->>'copied_employees')::integer, -1) <> v_expected then
      raise exception 'open_period_copied_unexpected: % <> %',
        v_result->>'copied_employees', v_expected;
    end if;
    if v_periods_after <> v_periods_before + 1 then
      raise exception 'open_period_extra_periods: % -> %', v_periods_before, v_periods_after;
    end if;

    select *
      into v_opened
    from public.payroll_bn_periods p
    where p.id = (v_result->>'period_id')::uuid;

    if v_opened.period_name is distinct from v_month_name
       or v_opened.date_from is distinct from v_month
       or v_opened.date_to is distinct from v_month_to
       or v_opened.status is distinct from 'draft'
       or v_opened.holidays is distinct from '[]'::jsonb then
      raise exception 'open_period_row_unexpected: %', v_opened;
    end if;

    if v_opened.default_standard_days is distinct from v_source.default_standard_days
       or v_opened.standard_days_by_group is distinct from v_source.standard_days_by_group
       or v_opened.rules_config is distinct from v_source.rules_config then
      raise exception 'open_period_config_not_copied: % / %', v_opened, v_source;
    end if;

    if exists (
      select 1
      from public.payroll_bn_period_employees e
      where e.period_id = v_opened.id
        and e.standard_days_override is not null
    ) then
      raise exception 'standard_days_override_copied';
    end if;

    if exists (
      select 1
      from public.payroll_bn_period_employees e
      where e.period_id = v_opened.id
        and e.employee_code = v_terminated_code
    ) then
      raise exception 'terminated_employee_copied: %', v_terminated_code;
    end if;

    if exists (
      select 1
      from public.payroll_bn_period_employees n
      join public.payroll_bn_period_employees s
        on s.period_id = v_source.id
       and s.employee_code = n.employee_code
      where n.period_id = v_opened.id
        and (
          n.employee_name is distinct from s.employee_name
          or n.group_name is distinct from s.group_name
          or n.employment_type is distinct from s.employment_type
          or n.monthly_salary is distinct from s.monthly_salary
          or n.daily_rate is distinct from s.daily_rate
          or n.hourly_rate is distinct from s.hourly_rate
          or n.overtime_rate is distinct from s.overtime_rate
          or n.allowance is distinct from s.allowance
          or n.start_date is distinct from s.start_date
          or n.end_date is distinct from s.end_date
        )
    ) then
      raise exception 'copied_catalogue_values_changed';
    end if;

    -- Second call is idempotent and adds no catalogue rows.
    select count(*)
      into v_rows_before
    from public.payroll_bn_period_employees e
    where e.period_id = v_opened.id;

    v_result2 := public.payroll_bn_open_period(null);

    select count(*)
      into v_rows_after
    from public.payroll_bn_period_employees e
    where e.period_id = v_opened.id;

    if v_result2->>'created' is distinct from 'false'
       or v_result2->>'period_id' is distinct from v_opened.id::text then
      raise exception 'second_open_not_idempotent: %', v_result2;
    end if;
    if v_rows_after <> v_rows_before then
      raise exception 'second_open_added_rows: % -> %', v_rows_before, v_rows_after;
    end if;

    -- The read-only probe must describe exactly this new period.
    v_current := public.get_payroll_bn_current_period();
    if v_current->>'month' is distinct from v_month::text then
      raise exception 'current_period_month_unexpected: %', v_current;
    end if;
    if v_current->'period'->>'id' is distinct from v_opened.id::text then
      raise exception 'current_period_id_unexpected: %', v_current;
    end if;
    if v_current->'period'->>'status' is distinct from 'draft' then
      raise exception 'current_period_status_unexpected: %', v_current;
    end if;
    if v_current->>'latest_period_code' is null then
      raise exception 'current_period_latest_code_missing: %', v_current;
    end if;
  else
    -- =====================================================================
    -- BRANCH: the current month already has a period. Public open must return
    -- it untouched, then the same catalogue assertions run through the internal
    -- worker on a TASK-only month pair so no real period is modified.
    -- =====================================================================
    select count(*) into v_periods_before from public.payroll_bn_periods;
    select count(*)
      into v_rows_before
    from public.payroll_bn_period_employees e
    where e.period_id = v_existing_month.id;

    v_result := public.payroll_bn_open_period(null);

    select count(*) into v_periods_after from public.payroll_bn_periods;
    select count(*)
      into v_rows_after
    from public.payroll_bn_period_employees e
    where e.period_id = v_existing_month.id;

    if v_result->>'created' is distinct from 'false' then
      raise exception 'existing_month_created_again: %', v_result;
    end if;
    if v_result->>'period_id' is distinct from v_existing_month.id::text then
      raise exception 'existing_month_id_unexpected: %', v_result;
    end if;
    if v_periods_after <> v_periods_before or v_rows_after <> v_rows_before then
      raise exception 'existing_month_wrote_rows: periods % -> %, rows % -> %',
        v_periods_before, v_periods_after, v_rows_before, v_rows_after;
    end if;

    -- Find a target month (and its previous month) with no real period, so the
    -- TASK-only scenario cannot touch or collide with production data.
    v_task_month := (date_trunc('month', v_month) - interval '240 months')::date;
    loop
      v_task_counter := v_task_counter + 1;
      exit when v_task_counter > 2400;

      v_task_prev := (v_task_month - interval '1 month')::date;
      v_task_code := 'T' || to_char(v_task_month, 'MM') || '.' || to_char(v_task_month, 'YYYY');

      exit when not exists (
        select 1 from public.payroll_bn_periods p
        where p.period_code = v_task_code
           or (p.date_from >= v_task_month
               and p.date_from < (v_task_month + interval '1 month')::date)
           or (p.date_from >= v_task_prev and p.date_from < v_task_month)
      );

      v_task_month := (v_task_month - interval '1 month')::date;
    end loop;

    if v_task_counter > 2400 then
      raise exception 'task_open_month_not_found';
    end if;

    v_task_month_to := (v_task_month + interval '1 month' - interval '1 day')::date;

    insert into public.payroll_bn_periods (
      period_code, period_name, date_from, date_to, status,
      default_standard_days, standard_days_by_group, holidays, rules_config
    ) values (
      'TASK_OPEN_SOURCE',
      'Task open source',
      v_task_prev,
      (v_task_month - interval '1 day')::date,
      'draft',
      27.5,
      jsonb_build_object(v_group, 27.5),
      '[]'::jsonb,
      jsonb_build_object('task', true)
    )
    returning * into v_task_source;

    insert into public.payroll_bn_period_employees (
      period_id, employee_code, employee_name, group_name, employment_type,
      monthly_salary, daily_rate, hourly_rate, overtime_rate, allowance,
      standard_days_override, start_date, end_date
    ) values
      (v_task_source.id, 'TASK_OPEN_E1', 'Task Open E1', v_group, 'official',
       9000000, 400000, 50000, 60000, 300000, 9, v_task_prev, null),
      -- Ends before the new month: must not be copied.
      (v_task_source.id, 'TASK_OPEN_E2', 'Task Open E2', v_group, 'official',
       8000000, 350000, 45000, 55000, 200000, 8, v_task_prev,
       (v_task_month - interval '1 day')::date),
      (v_task_source.id, 'TASK_OPEN_E3', 'Task Open E3', v_group, 'official',
       7000000, 300000, 40000, 50000, 100000, 7, v_task_prev, v_task_month),
      (v_task_source.id, 'TASK_OPEN_E4', 'Task Open E4', v_group, 'part_time',
       null, null, 60000, 70000, 50000, 6, v_task_prev, null);

    v_result := public.payroll_bn_open_period_internal(v_task_month, null);

    if v_result->>'created' is distinct from 'true' then
      raise exception 'task_open_not_created: %', v_result;
    end if;
    if v_result->>'period_code' is distinct from v_task_code then
      raise exception 'task_open_code_unexpected: % <> %', v_result->>'period_code', v_task_code;
    end if;
    if v_result->>'source_period_code' is distinct from v_task_source.period_code then
      raise exception 'task_open_source_unexpected: %', v_result;
    end if;
    if coalesce((v_result->>'copied_employees')::integer, -1) <> 3 then
      raise exception 'task_open_copied_unexpected: %', v_result;
    end if;

    select *
      into v_opened
    from public.payroll_bn_periods p
    where p.id = (v_result->>'period_id')::uuid;

    if v_opened.period_name is distinct from (
         'Kỳ lương tháng ' || to_char(v_task_month, 'MM') || '/'
         || to_char(v_task_month, 'YYYY') || ' — Bếp BN')
       or v_opened.date_from is distinct from v_task_month
       or v_opened.date_to is distinct from v_task_month_to
       or v_opened.status is distinct from 'draft'
       or v_opened.holidays is distinct from '[]'::jsonb then
      raise exception 'task_open_row_unexpected: %', v_opened;
    end if;

    if v_opened.default_standard_days is distinct from v_task_source.default_standard_days
       or v_opened.standard_days_by_group is distinct from v_task_source.standard_days_by_group
       or v_opened.rules_config is distinct from v_task_source.rules_config then
      raise exception 'task_open_config_not_copied: % / %', v_opened, v_task_source;
    end if;

    if (select count(*)
        from public.payroll_bn_period_employees e
        where e.period_id = v_opened.id) <> 3 then
      raise exception 'task_open_employee_count_unexpected';
    end if;
    if exists (
      select 1 from public.payroll_bn_period_employees e
      where e.period_id = v_opened.id
        and e.employee_code = 'TASK_OPEN_E2'
    ) then
      raise exception 'task_terminated_employee_copied';
    end if;
    if exists (
      select 1 from public.payroll_bn_period_employees e
      where e.period_id = v_opened.id
        and e.standard_days_override is not null
    ) then
      raise exception 'task_standard_days_override_copied';
    end if;
    if exists (
      select 1
      from public.payroll_bn_period_employees n
      join public.payroll_bn_period_employees s
        on s.period_id = v_task_source.id
       and s.employee_code = n.employee_code
      where n.period_id = v_opened.id
        and (
          n.monthly_salary is distinct from s.monthly_salary
          or n.daily_rate is distinct from s.daily_rate
          or n.hourly_rate is distinct from s.hourly_rate
          or n.overtime_rate is distinct from s.overtime_rate
          or n.allowance is distinct from s.allowance
        )
    ) then
      raise exception 'task_copied_values_changed';
    end if;

    select count(*)
      into v_rows_before
    from public.payroll_bn_period_employees e
    where e.period_id = v_opened.id;

    v_result2 := public.payroll_bn_open_period_internal(v_task_month, null);

    select count(*)
      into v_rows_after
    from public.payroll_bn_period_employees e
    where e.period_id = v_opened.id;

    if v_result2->>'created' is distinct from 'false'
       or v_result2->>'period_id' is distinct from v_opened.id::text then
      raise exception 'task_second_open_not_idempotent: %', v_result2;
    end if;
    if v_rows_after <> v_rows_before then
      raise exception 'task_second_open_added_rows: % -> %', v_rows_before, v_rows_after;
    end if;

    -- The probe keeps describing the real current month, not the TASK month.
    v_current := public.get_payroll_bn_current_period();
    if v_current->>'month' is distinct from v_month::text then
      raise exception 'branch_current_month_unexpected: %', v_current;
    end if;
    if v_current->'period'->>'id' is distinct from v_existing_month.id::text then
      raise exception 'branch_current_period_unexpected: %', v_current;
    end if;
  end if;

  -- =======================================================================
  -- Common checks: future month and non-manager caller are refused.
  -- =======================================================================
  begin
    perform public.payroll_bn_open_period((v_month + interval '1 month')::date);
    raise exception 'future_month_not_blocked';
  exception when sqlstate '22023' then
    if sqlerrm not like '%payroll_bn_period_month_in_future%' then
      raise exception 'future_month_wrong_error: %', sqlerrm;
    end if;
  end;

  perform set_config(
    'request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000bb"}',
    true
  );
  begin
    perform public.payroll_bn_open_period(null);
    raise exception 'non_manager_not_blocked';
  exception when sqlstate '42501' then
    if sqlerrm not like '%insufficient_privilege%' then
      raise exception 'non_manager_wrong_error: %', sqlerrm;
    end if;
  end;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- =======================================================================
  -- Shift eligibility still sees the catalogue of the latest period. The
  -- eligible group list is read from payroll_bn_shift_settings.
  -- =======================================================================
  select p.id
    into v_latest_period_id
  from public.payroll_bn_periods p
  order by p.date_from desc, p.created_at desc
  limit 1;

  if v_latest_period_id is null then
    raise exception 'open_period_smoke_no_period';
  end if;

  select e.employee_code
    into v_eligible_code
  from public.payroll_bn_period_employees e
  where e.period_id = v_latest_period_id
    and exists (
      select 1
      from public.payroll_bn_shift_settings s
      where s.id
        and e.group_name = any(s.eligible_groups)
    )
  limit 1;

  if v_eligible_code is null then
    select (s.eligible_groups)[1]
      into v_eligible_group
    from public.payroll_bn_shift_settings s
    where s.id;

    if v_eligible_group is null then
      v_eligible_group := v_group;
      update public.payroll_bn_shift_settings
         set eligible_groups = array[v_group]
       where id;
    end if;

    v_eligible_code := 'TASK_OPEN_ELIGIBLE';
    alter table public.payroll_bn_period_employees
      disable trigger payroll_bn_guard_locked_period_employees;
    insert into public.payroll_bn_period_employees (
      period_id, employee_code, employee_name, group_name, employment_type,
      monthly_salary, standard_days_override, start_date, end_date
    ) values (
      v_latest_period_id, v_eligible_code, 'Task Open Eligible',
      v_eligible_group, 'official', 5000000, null, null, null
    )
    on conflict (period_id, employee_code) do nothing;
    alter table public.payroll_bn_period_employees
      enable trigger payroll_bn_guard_locked_period_employees;
  end if;

  if not public.payroll_bn_shift_eligible(v_eligible_code, null) then
    raise exception 'shift_eligible_false_for_copied_employee: %', v_eligible_code;
  end if;

  raise notice 'OPEN_PERIOD_SMOKE_PASS';
end;
$$;

rollback;
