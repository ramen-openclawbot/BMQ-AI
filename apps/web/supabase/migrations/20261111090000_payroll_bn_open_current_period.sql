-- ============================================================================
-- Migration: always have a draft Bếp BN payroll period for the current month
--
-- The catalogue (payroll_bn_period_employees) is per period, and every consumer
-- that reads the latest period (shift eligibility, shift board, missions, the
-- payslip portal) only sees employees that exist in that row set. This
-- migration adds the server-side guarantee:
--
--   * payroll_bn_open_period_internal(date, uuid)  — idempotent worker that
--     creates the month's draft period and copies the catalogue of the latest
--     earlier period (terminated employees are not copied; standard day
--     overrides are not copied). Internal only.
--   * payroll_bn_open_period(date default null)    — manager RPC. Defaults to
--     the current month in Asia/Ho_Chi_Minh; refuses future months and months
--     older than the latest existing period when they have no period yet.
--   * get_payroll_bn_current_period()              — read-only RPC used by the
--     UI to decide whether the "open this month" action is needed.
--   * a daily pg_cron job at 00:05 Vietnam time that calls the internal worker.
--
-- The migration itself creates no period, redefines no consumer and does not
-- change the payroll engine or the attendance import. It has NOT been applied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Internal worker — idempotent per month, safe under concurrency
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_open_period_internal(_month date, _actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- The actor is accepted for audit symmetry with the public RPC. Period rows
  -- have no created_by column, so it is intentionally not stored.
  v_month date;
  v_month_to date;
  v_period_code text;
  v_period_name text;
  v_period_id uuid;
  v_existing_code text;
  v_source public.payroll_bn_periods%rowtype;
  v_copied integer := 0;
begin
  v_month := date_trunc(
    'month',
    coalesce(_month, (now() at time zone 'Asia/Ho_Chi_Minh')::date)
  )::date;
  v_month_to := (v_month + interval '1 month' - interval '1 day')::date;
  v_period_code := 'T' || to_char(v_month, 'MM') || '.' || to_char(v_month, 'YYYY');
  v_period_name := 'Kỳ lương tháng '
    || to_char(v_month, 'MM') || '/' || to_char(v_month, 'YYYY')
    || ' — Bếp BN';

  -- The exact month range already exists: nothing to create or copy.
  select p.id, p.period_code
    into v_period_id, v_existing_code
  from public.payroll_bn_periods p
  where p.date_from = v_month
    and p.date_to = v_month_to
  limit 1;

  if v_period_id is not null then
    return jsonb_build_object(
      'period_id', v_period_id,
      'period_code', v_existing_code,
      'created', false,
      'copied_employees', 0
    );
  end if;

  -- Serialise concurrent openers of the same month, then re-check under the
  -- lock. The key is a fixed, application-wide constant.
  perform pg_advisory_xact_lock(hashtext('payroll_bn_open_period')::bigint);

  select p.id, p.period_code
    into v_period_id, v_existing_code
  from public.payroll_bn_periods p
  where p.date_from = v_month
    and p.date_to = v_month_to
  limit 1;

  if v_period_id is not null then
    return jsonb_build_object(
      'period_id', v_period_id,
      'period_code', v_existing_code,
      'created', false,
      'copied_employees', 0
    );
  end if;

  -- Parameters and rules come from the latest period that starts before this
  -- month. With no earlier period the table defaults apply to the new row.
  select *
    into v_source
  from public.payroll_bn_periods p
  where p.date_from < v_month
  order by p.date_from desc, p.created_at desc
  limit 1;

  begin
    if v_source.id is null then
      insert into public.payroll_bn_periods (
        period_code, period_name, date_from, date_to, status, holidays
      ) values (
        v_period_code, v_period_name, v_month, v_month_to, 'draft', '[]'::jsonb
      )
      returning id into v_period_id;
    else
      insert into public.payroll_bn_periods (
        period_code, period_name, date_from, date_to, status,
        default_standard_days, standard_days_by_group, holidays, rules_config
      ) values (
        v_period_code, v_period_name, v_month, v_month_to, 'draft',
        v_source.default_standard_days,
        v_source.standard_days_by_group,
        '[]'::jsonb,
        v_source.rules_config
      )
      returning id into v_period_id;
    end if;
  exception when unique_violation then
    -- A different opener won the period_code race: return that row untouched.
    select p.id, p.period_code
      into v_period_id, v_existing_code
    from public.payroll_bn_periods p
    where p.period_code = v_period_code
    limit 1;

    return jsonb_build_object(
      'period_id', v_period_id,
      'period_code', coalesce(v_existing_code, v_period_code),
      'created', false,
      'copied_employees', 0
    );
  end;

  -- Copy the catalogue of the same earlier period. Every business column is
  -- kept as-is except standard_days_override, which always starts empty for a
  -- new month. Employees who already left before the new month are skipped.
  if v_source.id is not null then
    insert into public.payroll_bn_period_employees (
      period_id,
      employee_code,
      employee_name,
      group_name,
      employment_type,
      monthly_salary,
      daily_rate,
      hourly_rate,
      overtime_rate,
      allowance,
      standard_days_override,
      start_date,
      end_date
    )
    select
      v_period_id,
      e.employee_code,
      e.employee_name,
      e.group_name,
      e.employment_type,
      e.monthly_salary,
      e.daily_rate,
      e.hourly_rate,
      e.overtime_rate,
      e.allowance,
      null,
      e.start_date,
      e.end_date
    from public.payroll_bn_period_employees e
    where e.period_id = v_source.id
      and (e.end_date is null or e.end_date >= v_month)
    on conflict (period_id, employee_code) do nothing;

    get diagnostics v_copied = row_count;
  end if;

  return jsonb_build_object(
    'period_id', v_period_id,
    'period_code', v_period_code,
    'created', true,
    'copied_employees', v_copied,
    'source_period_code', v_source.period_code
  );
end;
$$;

comment on function public.payroll_bn_open_period_internal(date, uuid)
  is 'Internal idempotent opener for one Bếp BN payroll month: creates a draft period and copies the catalogue of the latest earlier period, skipping employees who left before the month. Advisory-locked; execute is limited to service_role.';

-- ---------------------------------------------------------------------------
-- 2) Public manager RPC — defaults to the current Vietnam month
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_open_period(_month date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_current_month date;
  v_month date;
  v_existing public.payroll_bn_periods%rowtype;
  v_latest_month date;
begin
  if not (
    public.has_role(v_uid, 'owner')
    or public.has_module_permission(v_uid, 'payroll', 'edit')
    or auth.role() = 'service_role'
  ) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  v_current_month := date_trunc(
    'month',
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  )::date;
  v_month := date_trunc(
    'month',
    coalesce(_month, (now() at time zone 'Asia/Ho_Chi_Minh')::date)
  )::date;

  if v_month > v_current_month then
    raise exception 'payroll_bn_period_month_in_future' using errcode = '22023';
  end if;

  -- Any period that starts inside the requested month is returned as-is.
  select *
    into v_existing
  from public.payroll_bn_periods p
  where p.date_from >= v_month
    and p.date_from < (v_month + interval '1 month')::date
  order by p.date_from, p.created_at
  limit 1;

  if v_existing.id is not null then
    return jsonb_build_object(
      'period_id', v_existing.id,
      'period_code', v_existing.period_code,
      'created', false,
      'copied_employees', 0
    );
  end if;

  -- A month older than the latest existing period can no longer be opened
  -- unless it already has a period (handled above).
  select max(date_trunc('month', p.date_from)::date)
    into v_latest_month
  from public.payroll_bn_periods p;

  if v_latest_month is not null and v_month < v_latest_month then
    raise exception 'payroll_bn_period_month_in_past' using errcode = '22023';
  end if;

  return public.payroll_bn_open_period_internal(v_month, v_uid);
end;
$$;

comment on function public.payroll_bn_open_period(date)
  is 'Open (or return) the Bếp BN payroll period of a month, defaulting to the current Asia/Ho_Chi_Minh month. Owner or payroll.edit only; future months and missing months older than the latest period are refused.';

-- ---------------------------------------------------------------------------
-- 3) Read-only current-period probe used by the UI
-- ---------------------------------------------------------------------------
create or replace function public.get_payroll_bn_current_period()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_month date;
  v_period public.payroll_bn_periods%rowtype;
  v_employee_count integer := 0;
  v_latest_code text;
begin
  if not (
    public.has_role(v_uid, 'owner')
    or public.has_module_permission(v_uid, 'payroll', 'edit')
    or auth.role() = 'service_role'
  ) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  v_month := date_trunc(
    'month',
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  )::date;

  select *
    into v_period
  from public.payroll_bn_periods p
  where p.date_from >= v_month
    and p.date_from < (v_month + interval '1 month')::date
  order by p.date_from, p.created_at
  limit 1;

  if v_period.id is not null then
    select count(*)
      into v_employee_count
    from public.payroll_bn_period_employees e
    where e.period_id = v_period.id;
  end if;

  select p.period_code
    into v_latest_code
  from public.payroll_bn_periods p
  order by p.date_from desc, p.created_at desc
  limit 1;

  return jsonb_build_object(
    'month', v_month,
    'period', case
      when v_period.id is null then null
      else jsonb_build_object(
        'id', v_period.id,
        'period_code', v_period.period_code,
        'period_name', v_period.period_name,
        'date_from', v_period.date_from,
        'date_to', v_period.date_to,
        'status', v_period.status,
        'employees', v_employee_count
      )
    end,
    'latest_period_code', v_latest_code
  );
end;
$$;

comment on function public.get_payroll_bn_current_period()
  is 'Read-only Bếp BN probe for the current Asia/Ho_Chi_Minh month: the month, its period (with catalogue size) or null, and the latest period code.';

-- ---------------------------------------------------------------------------
-- 4) Daily automatic open — 00:05 Asia/Ho_Chi_Minh (17:05 UTC)
--    Idempotent: unschedule by name first, then schedule. The migration is a
--    no-op when the pg_cron extension is not installed.
-- ---------------------------------------------------------------------------
do $payroll_bn_open_current_period_cron$
declare
  existing_job_id bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    for existing_job_id in
      select jobid
      from cron.job
      where jobname = 'payroll-bn-open-current-period'
    loop
      perform cron.unschedule(existing_job_id);
    end loop;

    perform cron.schedule(
      'payroll-bn-open-current-period',
      '5 17 * * *',
      $job$
        select public.payroll_bn_open_period_internal(
          (now() at time zone 'Asia/Ho_Chi_Minh')::date,
          null
        );
      $job$
    );
  end if;
end;
$payroll_bn_open_current_period_cron$;

-- ---------------------------------------------------------------------------
-- 5) Grants — internal worker stays private; the two RPCs are logged-in only.
-- ---------------------------------------------------------------------------
revoke all on function public.payroll_bn_open_period_internal(date, uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_open_period_internal(date, uuid)
  to service_role;

revoke all on function public.payroll_bn_open_period(date)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_open_period(date)
  to authenticated, service_role;

revoke all on function public.get_payroll_bn_current_period()
  from public, anon, authenticated;
grant execute on function public.get_payroll_bn_current_period()
  to authenticated, service_role;
