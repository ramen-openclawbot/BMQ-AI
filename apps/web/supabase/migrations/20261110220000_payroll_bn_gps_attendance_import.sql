-- ============================================================================
-- Migration: Lấy chấm công GPS vào kỳ lương + đối chiếu lịch ca (payroll_bn)
--
-- Phase 3 keeps the payroll engine (R1–R9), issue review and attendance
-- approval untouched. GPS attendance is written into the SAME storage the
-- machine-file upload uses (payroll_bn_attendance_imports /
-- payroll_bn_attendance_rows), so a period may combine a machine file and a
-- GPS pull. Existing rows are never overwritten.
--
--   * payroll_bn_attendance_imports.source = 'machine' | 'gps'
--   * payroll_bn_gps_attendance_rows(...)  — read-only helper
--   * preview_payroll_bn_gps_attendance(...) — manager read-only preview
--   * import_payroll_bn_gps_attendance(...)  — manager import
--   * get_payroll_bn_period_schedule_summary(...) — read-only comparison
--
-- No shift code, employee code, group or date is hard-coded. No paid API and
-- no notification is added. This migration has NOT been applied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Where an import came from (machine file vs GPS pull)
-- ---------------------------------------------------------------------------
alter table public.payroll_bn_attendance_imports
  add column if not exists source text default 'machine';

alter table public.payroll_bn_attendance_imports
  drop constraint if exists payroll_bn_attendance_imports_source_check;
alter table public.payroll_bn_attendance_imports
  add constraint payroll_bn_attendance_imports_source_check
  check (source in ('machine', 'gps'));

comment on column public.payroll_bn_attendance_imports.source is
  'Origin of the import: machine file or GPS pull. NULL/absent reads as machine in the client.';

-- ---------------------------------------------------------------------------
-- 2) Shared role check: owner / payroll.edit / service_role
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_gps_admin_allowed(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or (
      p_uid is not null
      and (
        public.has_role(p_uid, 'owner')
        or public.has_module_permission(p_uid, 'payroll', 'edit')
      )
    );
$$;

-- ---------------------------------------------------------------------------
-- 3) Read-only helper: GPS attendance rows for one period/date range
--
-- check_in  = first accepted 'in' (Vietnam-local time)
-- check_out = last accepted 'out' later than check_in (null when none)
-- late_minutes = minutes after the published registered shift start, reported
--                only when greater than settings.late_grace_minutes; null when
--                the day has no published registered shift.
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_gps_attendance_rows(
  _period_id uuid,
  _from date,
  _to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period public.payroll_bn_periods%rowtype;
  v_from date;
  v_to date;
  v_grace integer := 0;
  v_rows jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
begin
  select * into v_period
  from public.payroll_bn_periods
  where id = _period_id;

  if v_period.id is null then
    raise exception 'payroll_bn_period_not_found' using errcode = 'P0002';
  end if;

  if _from is null or _to is null or _from > _to then
    raise exception 'payroll_bn_gps_range_invalid' using errcode = '22023';
  end if;

  if _to < v_period.date_from or _from > v_period.date_to then
    raise exception 'payroll_bn_gps_range_invalid' using errcode = '22023';
  end if;

  v_from := greatest(_from, v_period.date_from);
  -- Today is never pulled: the day is still running, and because existing
  -- employee-days are never overwritten, an early pull would freeze a day
  -- without its check-out for good. Only finished days (up to yesterday,
  -- Vietnam time) are returned.
  v_to := least(_to, v_period.date_to, (now() at time zone 'Asia/Ho_Chi_Minh')::date - 1);
  if v_from > v_to then
    return jsonb_build_object(
      'period_id', _period_id,
      'from', v_from,
      'to', v_to,
      'rows', '[]'::jsonb,
      'skipped_codes', '[]'::jsonb
    );
  end if;

  select coalesce(late_grace_minutes, 0)
  into v_grace
  from public.payroll_bn_shift_settings
  where id;
  v_grace := coalesce(v_grace, 0);

  with event_days as (
    select e.employee_code, e.work_date
    from public.payroll_bn_attendance_events e
    where e.decision = 'accepted'
      and e.work_date between v_from and v_to
    group by e.employee_code, e.work_date
  ), period_emp as (
    select pe.employee_code, pe.employee_name, pe.group_name
    from public.payroll_bn_period_employees pe
    where pe.period_id = _period_id
  ), matched as (
    select ed.employee_code, ed.work_date, pe.employee_name, pe.group_name
    from event_days ed
    join period_emp pe on pe.employee_code = ed.employee_code
  ), base as (
    select
      m.employee_code,
      m.employee_name,
      m.group_name,
      m.work_date,
      (
        select min(e.server_received_at)
        from public.payroll_bn_attendance_events e
        where e.employee_code = m.employee_code
          and e.work_date = m.work_date
          and e.decision = 'accepted'
          and e.event_kind = 'in'
      ) as check_in_at,
      (
        select max(e.server_received_at)
        from public.payroll_bn_attendance_events e
        where e.employee_code = m.employee_code
          and e.work_date = m.work_date
          and e.decision = 'accepted'
          and e.event_kind = 'out'
      ) as check_out_at
    from matched m
  ), times as (
    select
      b.employee_code,
      b.employee_name,
      b.group_name,
      b.work_date,
      case
        when b.check_in_at is null then null
        else (b.check_in_at at time zone 'Asia/Ho_Chi_Minh')::time
      end as check_in_time,
      case
        when b.check_in_at is not null
         and b.check_out_at is not null
         and b.check_out_at > b.check_in_at
          then (b.check_out_at at time zone 'Asia/Ho_Chi_Minh')::time
        else null
      end as check_out_time
    from base b
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'employee_code', t.employee_code,
        'employee_name', t.employee_name,
        'department', t.group_name,
        'work_date', t.work_date,
        'check_in', t.check_in_time,
        'check_out', t.check_out_time,
        'shift', null,
        'late_minutes',
          case
            when sched.start_time is null or t.check_in_time is null then null
            else
              case
                when greatest(
                  0,
                  floor(extract(epoch from (t.check_in_time - sched.start_time)) / 60)::integer
                ) > v_grace
                  then greatest(
                    0,
                    floor(extract(epoch from (t.check_in_time - sched.start_time)) / 60)::integer
                  )
                else 0
              end
          end,
        'early_minutes', null,
        'scheduled_shift_code', sched.shift_code,
        'scheduled_start',
          case when sched.start_time is null then null else to_char(sched.start_time, 'HH24:MI') end,
        'has_override', exists (
          select 1
          from public.payroll_bn_attendance_day_overrides o
          where o.employee_code = t.employee_code
            and o.work_date = t.work_date
        ),
        'already_in_period', exists (
          select 1
          from public.payroll_bn_attendance_rows r
          where r.period_id = _period_id
            and r.employee_code = t.employee_code
            and r.work_date = t.work_date
        )
      )
      order by t.employee_code, t.work_date
    ),
    '[]'::jsonb
  )
  into v_rows
  from times t
  left join lateral (
    select en.shift_code, st.start_time
    from public.payroll_bn_shift_entries en
    join public.payroll_bn_shift_weeks w on w.week_start = en.week_start
    join public.payroll_bn_shift_types st on st.code = en.shift_code
    where en.employee_code = t.employee_code
      and en.work_date = t.work_date
      and en.state = 'registered'
      and en.shift_code is not null
      and w.status = 'published'
    limit 1
  ) sched on true;

  select coalesce(jsonb_agg(code order by code), '[]'::jsonb)
  into v_skipped
  from (
    select distinct e.employee_code as code
    from public.payroll_bn_attendance_events e
    where e.decision = 'accepted'
      and e.work_date between v_from and v_to
      and not exists (
        select 1
        from public.payroll_bn_period_employees pe
        where pe.period_id = _period_id
          and pe.employee_code = e.employee_code
      )
  ) skipped;

  return jsonb_build_object(
    'period_id', _period_id,
    'from', v_from,
    'to', v_to,
    'rows', v_rows,
    'skipped_codes', v_skipped
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Preview (read-only)
-- ---------------------------------------------------------------------------
create or replace function public.preview_payroll_bn_gps_attendance(
  _period_id uuid,
  _from date,
  _to date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_payload jsonb;
  v_rows jsonb;
  v_row_count integer := 0;
  v_employee_count integer := 0;
  v_missing_out integer := 0;
  v_already integer := 0;
  v_to_insert integer := 0;
begin
  if not public.payroll_bn_gps_admin_allowed(v_uid) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  v_payload := public.payroll_bn_gps_attendance_rows(_period_id, _from, _to);
  v_rows := coalesce(v_payload->'rows', '[]'::jsonb);

  select
    count(*),
    count(distinct r.value->>'employee_code'),
    count(*) filter (
      where nullif(r.value->>'check_in', '') is not null
        and nullif(r.value->>'check_out', '') is null
    ),
    count(*) filter (where coalesce((r.value->>'already_in_period')::boolean, false)),
    count(*) filter (where not coalesce((r.value->>'already_in_period')::boolean, false))
  into v_row_count, v_employee_count, v_missing_out, v_already, v_to_insert
  from jsonb_array_elements(v_rows) r;

  return v_payload || jsonb_build_object(
    'totals', jsonb_build_object(
      'rows', v_row_count,
      'employees', v_employee_count,
      'days_missing_out', v_missing_out,
      'already_in_period', v_already,
      'to_insert', v_to_insert
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Import (writes through the machine-file storage)
-- ---------------------------------------------------------------------------
create or replace function public.import_payroll_bn_gps_attendance(
  _period_id uuid,
  _from date,
  _to date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_period public.payroll_bn_periods%rowtype;
  v_payload jsonb;
  v_rows jsonb;
  v_skipped_codes jsonb;
  v_to_insert jsonb;
  v_from date;
  v_to date;
  v_skipped_existing integer := 0;
  v_canonical text;
  v_sha256 text;
  v_import_id uuid;
  v_existing_id uuid;
  v_inserted integer := 0;
begin
  if not public.payroll_bn_gps_admin_allowed(v_uid) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  select * into v_period
  from public.payroll_bn_periods
  where id = _period_id;

  if v_period.id is null then
    raise exception 'payroll_bn_period_not_found' using errcode = 'P0002';
  end if;

  if v_period.status = 'locked' then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;

  v_payload := public.payroll_bn_gps_attendance_rows(_period_id, _from, _to);
  v_rows := coalesce(v_payload->'rows', '[]'::jsonb);
  v_skipped_codes := coalesce(v_payload->'skipped_codes', '[]'::jsonb);
  v_from := (v_payload->>'from')::date;
  v_to := (v_payload->>'to')::date;

  select coalesce(
    jsonb_agg(value order by value->>'employee_code', value->>'work_date'),
    '[]'::jsonb
  )
  into v_to_insert
  from jsonb_array_elements(v_rows)
  where not coalesce((value->>'already_in_period')::boolean, false);

  select count(*)
  into v_skipped_existing
  from jsonb_array_elements(v_rows)
  where coalesce((value->>'already_in_period')::boolean, false);

  if jsonb_array_length(v_to_insert) = 0 then
    return jsonb_build_object(
      'import_id', null,
      'inserted_rows', 0,
      'skipped_existing', v_skipped_existing,
      'already_imported', false,
      'skipped_codes', v_skipped_codes
    );
  end if;

  select string_agg(
    coalesce(value->>'employee_code', '') || '|'
      || coalesce(value->>'work_date', '') || '|'
      || coalesce(value->>'check_in', '') || '|'
      || coalesce(value->>'check_out', ''),
    E'\n'
    order by value->>'employee_code', value->>'work_date'
  )
  into v_canonical
  from jsonb_array_elements(v_to_insert);

  v_sha256 := encode(sha256(convert_to(coalesce(v_canonical, ''), 'UTF8')), 'hex');

  insert into public.payroll_bn_attendance_imports(
    period_id,
    file_name,
    sha256,
    row_count,
    imported_by,
    source
  ) values (
    _period_id,
    'GPS ' || to_char(v_from, 'DD/MM') || ' – ' || to_char(v_to, 'DD/MM'),
    v_sha256,
    jsonb_array_length(v_to_insert),
    v_uid,
    'gps'
  )
  on conflict (period_id, sha256) do nothing
  returning id into v_import_id;

  if v_import_id is null then
    select id into v_existing_id
    from public.payroll_bn_attendance_imports
    where period_id = _period_id
      and sha256 = v_sha256;

    return jsonb_build_object(
      'import_id', v_existing_id,
      'inserted_rows', 0,
      'skipped_existing', jsonb_array_length(v_rows),
      'already_imported', true,
      'skipped_codes', v_skipped_codes
    );
  end if;

  insert into public.payroll_bn_attendance_rows(
    import_id,
    period_id,
    employee_code,
    employee_name,
    work_date,
    check_in,
    check_out,
    department,
    shift,
    late_minutes,
    early_minutes
  )
  select
    v_import_id,
    _period_id,
    value->>'employee_code',
    nullif(value->>'employee_name', ''),
    (value->>'work_date')::date,
    nullif(value->>'check_in', '')::time,
    nullif(value->>'check_out', '')::time,
    nullif(value->>'department', ''),
    null,
    case
      when nullif(value->>'late_minutes', '') is null then null
      else (value->>'late_minutes')::integer
    end,
    null
  from jsonb_array_elements(v_to_insert)
  on conflict (period_id, employee_code, work_date) do nothing;

  get diagnostics v_inserted = row_count;

  v_skipped_existing := v_skipped_existing + (jsonb_array_length(v_to_insert) - v_inserted);

  update public.payroll_bn_attendance_imports
  set row_count = v_inserted
  where id = v_import_id;

  -- Same rule as the machine-file import: a genuinely new import clears the
  -- attendance approval of the period.
  update public.payroll_bn_periods
  set attendance_approved_at = null,
      attendance_approved_by = null
  where id = _period_id;

  return jsonb_build_object(
    'import_id', v_import_id,
    'inserted_rows', v_inserted,
    'skipped_existing', v_skipped_existing,
    'already_imported', false,
    'skipped_codes', v_skipped_codes
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Read-only attendance vs published schedule comparison
-- ---------------------------------------------------------------------------
create or replace function public.get_payroll_bn_period_schedule_summary(_period_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_period public.payroll_bn_periods%rowtype;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_to date;
  v_grace integer := 0;
  v_covered_from date;
  v_covered_to date;
  v_emp record;
  v_dates date[];
  v_date date;
  v_entry public.payroll_bn_shift_entries%rowtype;
  v_row public.payroll_bn_attendance_rows%rowtype;
  v_start time;
  v_override boolean;
  v_scheduled boolean;
  v_off boolean;
  v_worked boolean;
  v_minutes integer;
  v_details jsonb;
  v_employees jsonb := '[]'::jsonb;
  v_leaves integer;
  v_changes integer;
  v_scheduled_days integer;
  v_off_days integer;
  v_worked_days integer;
  v_worked_scheduled integer;
  v_no_show integer;
  v_unscheduled integer;
  v_late_days integer;
  v_late_minutes integer;
  v_missing_out integer;
  v_total_employees integer := 0;
  v_total_scheduled integer := 0;
  v_total_off integer := 0;
  v_total_worked integer := 0;
  v_total_worked_scheduled integer := 0;
  v_total_no_show integer := 0;
  v_total_unscheduled integer := 0;
  v_total_late_days integer := 0;
  v_total_late_minutes integer := 0;
  v_total_missing_out integer := 0;
  v_total_leaves integer := 0;
  v_total_changes integer := 0;
begin
  if not public.payroll_bn_gps_admin_allowed(v_uid) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  select * into v_period
  from public.payroll_bn_periods
  where id = _period_id;

  if v_period.id is null then
    raise exception 'payroll_bn_period_not_found' using errcode = 'P0002';
  end if;

  v_to := least(v_period.date_to, v_today);

  select coalesce(late_grace_minutes, 0)
  into v_grace
  from public.payroll_bn_shift_settings
  where id;
  v_grace := coalesce(v_grace, 0);

  if v_to >= v_period.date_from then
    select min(d), max(d)
    into v_covered_from, v_covered_to
    from (
      select v_period.date_from + gs.day_offset as d
      from generate_series(0, v_to - v_period.date_from) as gs(day_offset)
    ) dates
    join public.payroll_bn_shift_weeks w
      on w.week_start = public.payroll_bn_shift_week_start(dates.d)
    where w.status = 'published';
  end if;

  for v_emp in
    select pe.employee_code, pe.employee_name, pe.group_name
    from public.payroll_bn_period_employees pe
    where pe.period_id = _period_id
    order by pe.employee_code
  loop
    select array_agg(dates.d order by dates.d)
    into v_dates
    from (
      select v_period.date_from + gs.day_offset as d
      from generate_series(0, v_to - v_period.date_from) as gs(day_offset)
    ) dates
    join public.payroll_bn_shift_weeks w
      on w.week_start = public.payroll_bn_shift_week_start(dates.d)
    where w.status = 'published'
      and not (dates.d = any (coalesce(w.closed_dates, '{}'::date[])))
      and public.payroll_bn_shift_eligible(v_emp.employee_code, w.week_start);

    if v_dates is null or coalesce(array_length(v_dates, 1), 0) = 0 then
      continue;
    end if;

    v_scheduled_days := 0;
    v_off_days := 0;
    v_worked_days := 0;
    v_worked_scheduled := 0;
    v_no_show := 0;
    v_unscheduled := 0;
    v_late_days := 0;
    v_late_minutes := 0;
    v_missing_out := 0;
    v_details := '[]'::jsonb;

    foreach v_date in array v_dates loop
      select * into v_entry
      from public.payroll_bn_shift_entries
      where employee_code = v_emp.employee_code
        and work_date = v_date;

      select * into v_row
      from public.payroll_bn_attendance_rows
      where period_id = _period_id
        and employee_code = v_emp.employee_code
        and work_date = v_date;

      v_override := exists (
        select 1
        from public.payroll_bn_attendance_day_overrides o
        where o.employee_code = v_emp.employee_code
          and o.work_date = v_date
      );

      v_scheduled := v_entry.id is not null
        and v_entry.state = 'registered'
        and v_entry.shift_code is not null;
      v_off := v_entry.id is not null
        and v_entry.state = 'registered'
        and v_entry.shift_code is null;
      v_worked := v_row.id is not null and v_row.check_in is not null;

      v_start := null;
      if v_scheduled then
        select st.start_time
        into v_start
        from public.payroll_bn_shift_types st
        where st.code = v_entry.shift_code;
      end if;

      if v_scheduled then
        v_scheduled_days := v_scheduled_days + 1;
      end if;
      if v_off then
        v_off_days := v_off_days + 1;
      end if;
      if v_worked then
        v_worked_days := v_worked_days + 1;
      end if;
      if v_worked and v_scheduled then
        v_worked_scheduled := v_worked_scheduled + 1;
      end if;

      if v_scheduled and v_date < v_today and not v_worked and not v_override then
        v_no_show := v_no_show + 1;
        v_details := v_details || jsonb_build_array(jsonb_build_object(
          'work_date', v_date,
          'kind', 'no_show',
          'shift_start', case when v_start is null then null else to_char(v_start, 'HH24:MI') end,
          'check_in', null,
          'check_out', null,
          'minutes_late', null
        ));
      end if;

      if v_scheduled and v_worked and v_start is not null then
        v_minutes := greatest(
          0,
          floor(extract(epoch from (v_row.check_in - v_start)) / 60)::integer
        );
        if v_minutes > v_grace then
          v_late_days := v_late_days + 1;
          v_late_minutes := v_late_minutes + v_minutes;
          v_details := v_details || jsonb_build_array(jsonb_build_object(
            'work_date', v_date,
            'kind', 'late',
            'shift_start', to_char(v_start, 'HH24:MI'),
            'check_in', to_char(v_row.check_in, 'HH24:MI:SS'),
            'check_out', case when v_row.check_out is null then null else to_char(v_row.check_out, 'HH24:MI:SS') end,
            'minutes_late', v_minutes
          ));
        end if;
      end if;

      if v_worked and not v_scheduled then
        v_unscheduled := v_unscheduled + 1;
        v_details := v_details || jsonb_build_array(jsonb_build_object(
          'work_date', v_date,
          'kind', 'unscheduled',
          'shift_start', null,
          'check_in', to_char(v_row.check_in, 'HH24:MI:SS'),
          'check_out', case when v_row.check_out is null then null else to_char(v_row.check_out, 'HH24:MI:SS') end,
          'minutes_late', null
        ));
      end if;

      if v_worked and v_row.check_out is null then
        v_missing_out := v_missing_out + 1;
        v_details := v_details || jsonb_build_array(jsonb_build_object(
          'work_date', v_date,
          'kind', 'missing_out',
          'shift_start', case when v_start is null then null else to_char(v_start, 'HH24:MI') end,
          'check_in', to_char(v_row.check_in, 'HH24:MI:SS'),
          'check_out', null,
          'minutes_late', null
        ));
      end if;
    end loop;

    select
      count(*) filter (where kind = 'leave'),
      count(*) filter (where kind = 'change')
    into v_leaves, v_changes
    from public.payroll_bn_shift_requests r
    where r.employee_code = v_emp.employee_code
      and r.state = 'approved'
      and r.work_date = any (v_dates);

    v_employees := v_employees || jsonb_build_array(jsonb_build_object(
      'employee_code', v_emp.employee_code,
      'employee_name', v_emp.employee_name,
      'group_name', v_emp.group_name,
      'scheduled_days', v_scheduled_days,
      'off_days', v_off_days,
      'worked_days', v_worked_days,
      'worked_scheduled', v_worked_scheduled,
      'no_show_days', v_no_show,
      'unscheduled_days', v_unscheduled,
      'late_days', v_late_days,
      'late_minutes_total', v_late_minutes,
      'missing_out_days', v_missing_out,
      'approved_leaves', v_leaves,
      'approved_changes', v_changes,
      'details', v_details
    ));

    v_total_employees := v_total_employees + 1;
    v_total_scheduled := v_total_scheduled + v_scheduled_days;
    v_total_off := v_total_off + v_off_days;
    v_total_worked := v_total_worked + v_worked_days;
    v_total_worked_scheduled := v_total_worked_scheduled + v_worked_scheduled;
    v_total_no_show := v_total_no_show + v_no_show;
    v_total_unscheduled := v_total_unscheduled + v_unscheduled;
    v_total_late_days := v_total_late_days + v_late_days;
    v_total_late_minutes := v_total_late_minutes + v_late_minutes;
    v_total_missing_out := v_total_missing_out + v_missing_out;
    v_total_leaves := v_total_leaves + v_leaves;
    v_total_changes := v_total_changes + v_changes;
  end loop;

  return jsonb_build_object(
    'period_id', _period_id,
    'date_from', v_period.date_from,
    'date_to', v_period.date_to,
    'covered_from', v_covered_from,
    'covered_to', v_covered_to,
    'employees', v_employees,
    'totals', jsonb_build_object(
      'employees', v_total_employees,
      'scheduled_days', v_total_scheduled,
      'off_days', v_total_off,
      'worked_days', v_total_worked,
      'worked_scheduled', v_total_worked_scheduled,
      'no_show_days', v_total_no_show,
      'unscheduled_days', v_total_unscheduled,
      'late_days', v_total_late_days,
      'late_minutes_total', v_total_late_minutes,
      'missing_out_days', v_total_missing_out,
      'approved_leaves', v_total_leaves,
      'approved_changes', v_total_changes
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Grants
-- ---------------------------------------------------------------------------
revoke all on function public.payroll_bn_gps_admin_allowed(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_gps_admin_allowed(uuid)
  to service_role;

revoke all on function public.payroll_bn_gps_attendance_rows(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_gps_attendance_rows(uuid, date, date)
  to service_role;

revoke all on function public.preview_payroll_bn_gps_attendance(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.preview_payroll_bn_gps_attendance(uuid, date, date)
  to authenticated, service_role;

revoke all on function public.import_payroll_bn_gps_attendance(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.import_payroll_bn_gps_attendance(uuid, date, date)
  to authenticated, service_role;

revoke all on function public.get_payroll_bn_period_schedule_summary(uuid)
  from public, anon, authenticated;
grant execute on function public.get_payroll_bn_period_schedule_summary(uuid)
  to authenticated, service_role;

comment on function public.payroll_bn_gps_attendance_rows(uuid, date, date) is
  'Read-only GPS rows for a period/date range: first accepted in, last accepted out, published-shift late minutes. Non-period codes are returned in skipped_codes.';
comment on function public.preview_payroll_bn_gps_attendance(uuid, date, date) is
  'Read-only manager preview of a GPS attendance pull with totals. Never writes.';
comment on function public.import_payroll_bn_gps_attendance(uuid, date, date) is
  'Manager import of GPS attendance into payroll_bn_attendance_imports/rows. Skips existing employee-days, one gps import per canonical hash, clears attendance approval like a machine import.';
comment on function public.get_payroll_bn_period_schedule_summary(uuid) is
  'Read-only per-employee comparison of attendance rows against published shift weeks: scheduled/off/worked/no_show/unscheduled/late/missing_out/approved requests.';
