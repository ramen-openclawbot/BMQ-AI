-- ============================================================================
-- Migration: Đổi ca / nghỉ đột xuất / cờ lệch lịch — giai đoạn 2 (payroll_bn)
--
-- On top of 20261110180000_payroll_bn_shift_schedule.sql (already applied in
-- production, never edited here):
--   * payroll_bn_shift_requests — employee change/leave requests + decisions
--   * late_grace_minutes on payroll_bn_shift_settings (data-driven)
--   * employee RPCs: submit/cancel a request, extended week payload
--   * manager RPCs: list/decide requests, attendance-vs-schedule flags
--   * extended board/config/employee payloads without removing existing keys
--
-- Everything remains data-driven: no shift code, employee code, group or date
-- is hard-coded. No Zalo/notification/paid API. Requests are audited through
-- payroll_bn_shift_events (append-only).
--
-- Employee RPCs stay service_role only (called by payslip-shifts after the psp_
-- session + device check). Manager RPCs are authenticated-only and re-check the
-- owner / payroll.edit role inside. This migration has NOT been applied.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Late grace is configuration, not code
-- ---------------------------------------------------------------------------
alter table public.payroll_bn_shift_settings
  add column if not exists late_grace_minutes integer not null default 0;

alter table public.payroll_bn_shift_settings
  drop constraint if exists payroll_bn_shift_settings_late_grace_check;
alter table public.payroll_bn_shift_settings
  add constraint payroll_bn_shift_settings_late_grace_check
  check (late_grace_minutes between 0 and 120);

comment on column public.payroll_bn_shift_settings.late_grace_minutes is
  'Minutes after a registered shift start that still count as on time for attendance flags. 0..120.';

-- ---------------------------------------------------------------------------
-- 2) Employee change/leave requests
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_shift_requests (
  id uuid primary key default gen_random_uuid(),
  week_start date not null references public.payroll_bn_shift_weeks(week_start) on delete cascade,
  work_date date not null,
  employee_code text not null check (length(btrim(employee_code)) > 0),
  kind text not null check (kind in ('change', 'leave')),
  -- Snapshot of the entry at submit time; NULL means the employee had a day off.
  from_shift_code text,
  to_shift_code text references public.payroll_bn_shift_types(code) on delete restrict,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  state text not null default 'pending'
    check (state in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_bn_shift_requests_week_check
    check (work_date >= week_start and work_date < week_start + 7),
  constraint payroll_bn_shift_requests_kind_shift_check check (
    (kind = 'change' and to_shift_code is not null)
    or (kind = 'leave' and to_shift_code is null)
  )
);

-- A single pending request per employee/work date; decided history is kept.
create unique index if not exists payroll_bn_shift_requests_one_pending
  on public.payroll_bn_shift_requests(employee_code, work_date)
  where state = 'pending';

create index if not exists payroll_bn_shift_requests_week_state_idx
  on public.payroll_bn_shift_requests(week_start, state);

create index if not exists payroll_bn_shift_requests_employee_idx
  on public.payroll_bn_shift_requests(employee_code, work_date desc);

drop trigger if exists set_updated_at_payroll_bn_shift_requests
  on public.payroll_bn_shift_requests;
create trigger set_updated_at_payroll_bn_shift_requests
before update on public.payroll_bn_shift_requests
for each row execute function public.handle_updated_at();

comment on table public.payroll_bn_shift_requests is
  'Employee change/leave request for one scheduled day. from_shift_code is the entry snapshot at submit; to_shift_code is required for change and null for leave.';

-- ---------------------------------------------------------------------------
-- 3) Shared helpers
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_shift_employee_name(p_employee_code text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select e.employee_name
    from (
      select p.id
      from public.payroll_bn_periods p
      order by p.date_from desc, p.created_at desc
      limit 1
    ) lp
    join public.payroll_bn_period_employees e on e.period_id = lp.id
    where e.employee_code = btrim(coalesce(p_employee_code, ''))
  ), btrim(coalesce(p_employee_code, '')));
$$;

create or replace function public.payroll_bn_shift_date_warnings(p_day jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings public.payroll_bn_shift_settings%rowtype;
  v_below_needed jsonb;
  v_below_groups jsonb;
  v_over_needed jsonb;
  v_over_groups jsonb;
  v_total integer := 0;
  v_off integer := 0;
  v_min_staff integer;
  v_max_off integer;
begin
  select * into v_settings
  from public.payroll_bn_shift_settings
  where id;

  v_min_staff := coalesce(v_settings.min_staff_per_day, 5);
  v_max_off := coalesce(v_settings.max_off_per_day, 2);

  if p_day is null then
    return jsonb_build_object(
      'below_needed', '[]'::jsonb,
      'below_quota_group', '[]'::jsonb,
      'over_needed', '[]'::jsonb,
      'over_quota_group', '[]'::jsonb,
      'below_min_staff', false,
      'off_above_max', false,
      'min_staff_per_day', v_min_staff,
      'max_off_per_day', v_max_off,
      'has_warning', false
    );
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', s.value->>'code',
        'shift_code', coalesce(s.value->>'shift_code', s.value->>'code'),
        'registered', (s.value->>'registered')::integer,
        'needed', (s.value->>'needed')::integer
      )
      order by s.value->>'code'
    ),
    '[]'::jsonb
  )
  into v_below_needed
  from jsonb_array_elements(coalesce(p_day->'shifts', '[]'::jsonb)) s
  where coalesce((s.value->>'need_more')::boolean, false)
    -- Shifts sharing a quota group are judged by the group lists below.
    and nullif(s.value->>'quota_group', '') is null;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'quota_group', g.value->>'quota_group',
        'registered', (g.value->>'registered')::integer,
        'needed', (g.value->>'needed')::integer
      )
      order by g.value->>'quota_group'
    ),
    '[]'::jsonb
  )
  into v_below_groups
  from jsonb_array_elements(coalesce(p_day->'quota_groups', '[]'::jsonb)) g
  where (g.value->>'needed')::integer > (g.value->>'registered')::integer;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', s.value->>'code',
        'shift_code', coalesce(s.value->>'shift_code', s.value->>'code'),
        'registered', (s.value->>'registered')::integer,
        'needed', (s.value->>'needed')::integer
      )
      order by s.value->>'code'
    ),
    '[]'::jsonb
  )
  into v_over_needed
  from jsonb_array_elements(coalesce(p_day->'shifts', '[]'::jsonb)) s
  where (s.value->>'registered')::integer > (s.value->>'needed')::integer
    and nullif(s.value->>'quota_group', '') is null;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'quota_group', g.value->>'quota_group',
        'registered', (g.value->>'registered')::integer,
        'needed', (g.value->>'needed')::integer
      )
      order by g.value->>'quota_group'
    ),
    '[]'::jsonb
  )
  into v_over_groups
  from jsonb_array_elements(coalesce(p_day->'quota_groups', '[]'::jsonb)) g
  where (g.value->>'registered')::integer > (g.value->>'needed')::integer;

  v_total := coalesce((p_day->>'total_staff')::integer, 0);
  v_off := coalesce((p_day->>'off_count')::integer, 0);

  return jsonb_build_object(
    'below_needed', v_below_needed,
    'below_quota_group', v_below_groups,
    'over_needed', v_over_needed,
    'over_quota_group', v_over_groups,
    'below_min_staff', v_total < v_min_staff,
    'off_above_max', v_off > v_max_off,
    'min_staff_per_day', v_min_staff,
    'max_off_per_day', v_max_off,
    'has_warning',
      jsonb_array_length(v_below_needed) > 0
      or jsonb_array_length(v_below_groups) > 0
      or jsonb_array_length(v_over_needed) > 0
      or jsonb_array_length(v_over_groups) > 0
      or v_total < v_min_staff
      or v_off > v_max_off
  );
end;
$$;

/**
 * Coverage of one date if a request were approved. The current registered
 * entry (if any) is removed and the requested outcome is added; waitlist rows
 * do not count. Returns {coverage, warnings}. Used by the manager list so the
 * UI can warn before deciding.
 */
create or replace function public.payroll_bn_shift_request_impact(
  p_week_start date,
  p_work_date date,
  p_employee_code text,
  p_kind text,
  p_to_shift_code text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cov jsonb;
  v_day jsonb;
  v_current public.payroll_bn_shift_entries%rowtype;
  v_from text;
  v_from_registered boolean := false;
  v_from_group text;
  v_to_group text;
  v_shifts jsonb := '[]'::jsonb;
  v_groups jsonb := '[]'::jsonb;
  v_shift jsonb;
  v_group jsonb;
  v_group_name text;
  v_code text;
  v_registered integer;
  v_needed integer;
  v_total integer;
  v_off integer;
begin
  v_cov := public.payroll_bn_shift_coverage(p_week_start);
  v_day := (
    select value
    from jsonb_array_elements(coalesce(v_cov->'dates', '[]'::jsonb))
    where value->>'work_date' = p_work_date::text
    limit 1
  );

  if v_day is null then
    return null;
  end if;

  select * into v_current
  from public.payroll_bn_shift_entries
  where employee_code = p_employee_code
    and work_date = p_work_date;

  v_from := v_current.shift_code;
  v_from_registered := v_current.id is not null and v_current.state = 'registered';

  v_from_group := null;
  if v_from is not null then
    select q.quota_group
    into v_from_group
    from public.payroll_bn_shift_quotas q
    where q.shift_code = v_from
      and q.quota_group is not null
    order by q.iso_dow nulls last
    limit 1;
  end if;

  v_to_group := null;
  if p_kind = 'change' and p_to_shift_code is not null then
    select q.quota_group
    into v_to_group
    from public.payroll_bn_shift_quotas q
    where q.shift_code = p_to_shift_code
      and q.quota_group is not null
    order by q.iso_dow nulls last
    limit 1;
  end if;

  v_total := coalesce((v_day->>'total_staff')::integer, 0);
  v_off := coalesce((v_day->>'off_count')::integer, 0);

  if v_from_registered then
    if v_from is null then
      v_off := v_off - 1;
    else
      v_total := v_total - 1;
    end if;
  end if;

  if p_kind = 'leave' then
    v_off := v_off + 1;
  elsif p_kind = 'change' then
    v_total := v_total + 1;
  end if;

  for v_shift in
    select value from jsonb_array_elements(coalesce(v_day->'shifts', '[]'::jsonb))
  loop
    v_code := v_shift->>'code';
    v_registered := coalesce((v_shift->>'registered')::integer, 0);
    v_needed := coalesce((v_shift->>'needed')::integer, 0);

    if v_from_registered and v_from = v_code then
      v_registered := v_registered - 1;
    end if;
    if p_kind = 'change' and p_to_shift_code = v_code then
      v_registered := v_registered + 1;
    end if;

    v_shifts := v_shifts || jsonb_build_array(jsonb_build_object(
      'code', v_code,
      'shift_code', coalesce(v_shift->>'shift_code', v_code),
      'registered', v_registered,
      'needed', v_needed,
      'quota_group', v_shift->>'quota_group',
      'full', v_registered >= v_needed,
      'need_more', v_needed > v_registered
    ));
  end loop;

  for v_group in
    select value from jsonb_array_elements(coalesce(v_day->'quota_groups', '[]'::jsonb))
  loop
    v_group_name := v_group->>'quota_group';
    v_registered := coalesce((v_group->>'registered')::integer, 0);
    v_needed := coalesce((v_group->>'needed')::integer, 0);

    if v_from_registered and v_from_group = v_group_name then
      v_registered := v_registered - 1;
    end if;
    if p_kind = 'change' and v_to_group = v_group_name then
      v_registered := v_registered + 1;
    end if;

    v_groups := v_groups || jsonb_build_array(jsonb_build_object(
      'quota_group', v_group_name,
      'registered', v_registered,
      'needed', v_needed,
      'full', v_registered >= v_needed
    ));
  end loop;

  v_day := jsonb_build_object(
    'work_date', p_work_date,
    'shifts', v_shifts,
    'quota_groups', v_groups,
    'off_count', v_off,
    'total_staff', v_total
  );

  return jsonb_build_object(
    'coverage', v_day,
    'warnings', public.payroll_bn_shift_date_warnings(v_day)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Employee RPCs (service_role only)
-- ---------------------------------------------------------------------------
create or replace function public.submit_payroll_bn_shift_request(
  p_employee_code text,
  p_work_date date,
  p_kind text,
  p_to_shift_code text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_employee text := btrim(coalesce(p_employee_code, ''));
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_to text := nullif(btrim(coalesce(p_to_shift_code, '')), '');
  v_week date;
  v_week_row public.payroll_bn_shift_weeks%rowtype;
  v_status text;
  v_deadline timestamptz;
  v_entry public.payroll_bn_shift_entries%rowtype;
  v_request public.payroll_bn_shift_requests%rowtype;
  v_cov jsonb;
  v_day jsonb;
begin
  if v_employee = '' then
    raise exception 'shift_employee_required' using errcode = '22023';
  end if;
  if p_work_date is null then
    raise exception 'shift_request_work_date_required' using errcode = '22023';
  end if;
  if v_kind not in ('change', 'leave') then
    raise exception 'shift_request_invalid_kind' using errcode = '22023';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'shift_request_reason_required' using errcode = '22023';
  end if;

  v_week := public.payroll_bn_shift_week_start(p_work_date);
  if v_week is null then
    raise exception 'shift_request_work_date_required' using errcode = '22023';
  end if;

  if not public.payroll_bn_shift_eligible(v_employee, v_week) then
    raise exception 'shift_not_eligible' using errcode = '22023';
  end if;

  select * into v_week_row
  from public.payroll_bn_shift_weeks
  where week_start = v_week;

  v_status := coalesce(v_week_row.status, 'open');
  v_deadline := public.payroll_bn_shift_deadline(v_week);

  -- Before the registration deadline (and while the week is still open) the
  -- employee edits the registration instead of creating a request.
  if v_status <> 'published' and (v_deadline is null or now() <= v_deadline) then
    raise exception 'shift_request_use_registration' using errcode = '22023';
  end if;

  if p_work_date < (now() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'shift_request_past_date' using errcode = '22023';
  end if;

  if p_work_date = any (coalesce(v_week_row.closed_dates, '{}'::date[])) then
    raise exception 'shift_request_closed_date' using errcode = '22023';
  end if;

  select * into v_entry
  from public.payroll_bn_shift_entries
  where employee_code = v_employee
    and work_date = p_work_date;

  if v_kind = 'leave' then
    if v_entry.id is null
       or v_entry.shift_code is null
       or v_entry.state <> 'registered' then
      raise exception 'shift_request_no_shift' using errcode = '22023';
    end if;
    v_to := null;
  else
    if v_to is null or not exists (
      select 1
      from public.payroll_bn_shift_types t
      where t.code = v_to
        and t.active
    ) then
      raise exception 'shift_invalid_shift' using errcode = '22023';
    end if;
    if v_to is not distinct from v_entry.shift_code then
      raise exception 'shift_request_same_shift' using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1
    from public.payroll_bn_shift_requests r
    where r.employee_code = v_employee
      and r.work_date = p_work_date
      and r.state = 'pending'
  ) then
    raise exception 'shift_request_duplicate' using errcode = '22023';
  end if;

  insert into public.payroll_bn_shift_weeks(week_start, status)
  values (v_week, 'open')
  on conflict (week_start) do nothing;

  begin
    insert into public.payroll_bn_shift_requests(
      week_start,
      work_date,
      employee_code,
      kind,
      from_shift_code,
      to_shift_code,
      reason,
      state
    ) values (
      v_week,
      p_work_date,
      v_employee,
      v_kind,
      v_entry.shift_code,
      v_to,
      v_reason,
      'pending'
    )
    returning * into v_request;
  exception when unique_violation then
    raise exception 'shift_request_duplicate' using errcode = '22023';
  end;

  insert into public.payroll_bn_shift_events(
    week_start,
    employee_code,
    work_date,
    action,
    actor_id,
    payload
  ) values (
    v_week,
    v_employee,
    p_work_date,
    'request_submitted',
    v_uid,
    jsonb_build_object('request', to_jsonb(v_request))
  );

  v_cov := public.payroll_bn_shift_coverage(v_week);
  v_day := (
    select value
    from jsonb_array_elements(coalesce(v_cov->'dates', '[]'::jsonb))
    where value->>'work_date' = p_work_date::text
    limit 1
  );

  return jsonb_build_object(
    'request', to_jsonb(v_request),
    'coverage', v_day
  );
end;
$$;

create or replace function public.cancel_payroll_bn_shift_request(
  p_employee_code text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_employee text := btrim(coalesce(p_employee_code, ''));
  v_request public.payroll_bn_shift_requests%rowtype;
begin
  if v_employee = '' then
    raise exception 'shift_employee_required' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'shift_request_not_found' using errcode = '42501';
  end if;

  select * into v_request
  from public.payroll_bn_shift_requests
  where id = p_request_id
  for update;

  if v_request.id is null or v_request.employee_code <> v_employee then
    raise exception 'shift_request_not_found' using errcode = '42501';
  end if;

  if v_request.state = 'cancelled' then
    return jsonb_build_object('request', to_jsonb(v_request));
  end if;

  if v_request.state <> 'pending' then
    raise exception 'shift_request_not_pending' using errcode = '22023';
  end if;

  update public.payroll_bn_shift_requests
  set state = 'cancelled',
      decided_by = v_uid,
      decided_at = now()
  where id = v_request.id
  returning * into v_request;

  insert into public.payroll_bn_shift_events(
    week_start,
    employee_code,
    work_date,
    action,
    actor_id,
    payload
  ) values (
    v_request.week_start,
    v_request.employee_code,
    v_request.work_date,
    'request_cancelled',
    v_uid,
    jsonb_build_object('request', to_jsonb(v_request))
  );

  return jsonb_build_object('request', to_jsonb(v_request));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Employee week payload: add requests + can_request, keep every old key
-- ---------------------------------------------------------------------------
create or replace function public.get_payroll_bn_shift_week(
  p_employee_code text,
  p_week_start date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee text := btrim(coalesce(p_employee_code, ''));
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_current_week date;
  v_week date;
  v_settings public.payroll_bn_shift_settings%rowtype;
  v_week_row public.payroll_bn_shift_weeks%rowtype;
  v_eligible boolean;
  v_status text;
  v_opens_at timestamptz;
  v_deadline timestamptz;
  v_can_edit boolean;
  v_can_request boolean;
  v_closed_dates date[];
  v_shift_types jsonb;
  v_days jsonb := '[]'::jsonb;
  v_coverage jsonb;
  v_date_cov jsonb;
  v_date date;
  v_entry public.payroll_bn_shift_entries%rowtype;
  v_my jsonb;
  v_suggestion jsonb;
  v_current jsonb := '[]'::jsonb;
  v_requests jsonb := '[]'::jsonb;
  v_entry_count integer := 0;
begin
  if v_employee = '' then
    raise exception 'shift_employee_required' using errcode = '22023';
  end if;

  v_current_week := public.payroll_bn_shift_week_start(v_today);
  v_week := coalesce(
    public.payroll_bn_shift_week_start(p_week_start),
    v_current_week + 7
  );

  select * into v_settings
  from public.payroll_bn_shift_settings
  where id;

  v_eligible := public.payroll_bn_shift_eligible(v_employee, v_week);
  v_opens_at := public.payroll_bn_shift_opens_at(v_week);
  v_deadline := public.payroll_bn_shift_deadline(v_week);

  select * into v_week_row
  from public.payroll_bn_shift_weeks
  where week_start = v_week;

  v_status := coalesce(v_week_row.status, 'open');
  v_closed_dates := coalesce(v_week_row.closed_dates, '{}'::date[]);
  v_can_edit := v_eligible
    and v_status = 'open'
    and v_opens_at is not null
    and v_deadline is not null
    and now() >= v_opens_at
    and now() <= v_deadline;

  v_can_request := v_eligible
    and (v_status = 'published' or (v_deadline is not null and now() > v_deadline))
    and (v_week + 6) >= v_today;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', t.code,
        'label', t.label,
        'start_time', to_char(t.start_time, 'HH24:MI'),
        'end_time', case when t.end_time is null then null else to_char(t.end_time, 'HH24:MI') end,
        'sort', t.sort,
        'active', t.active
      )
      order by t.sort, t.code
    ),
    '[]'::jsonb
  )
  into v_shift_types
  from public.payroll_bn_shift_types t
  where t.active;

  v_coverage := public.payroll_bn_shift_coverage(v_week);

  for v_day_offset in 0..6 loop
    v_date := v_week + v_day_offset;
    v_date_cov := (
      select value
      from jsonb_array_elements(v_coverage->'dates')
      where value->>'work_date' = v_date::text
      limit 1
    );

    select * into v_entry
    from public.payroll_bn_shift_entries
    where employee_code = v_employee
      and work_date = v_date;

    v_my := case
      when v_entry.id is null then null
      else jsonb_build_object(
        'shift_code', v_entry.shift_code,
        'state', v_entry.state,
        'source', v_entry.source,
        'previous_shift_code', v_entry.previous_shift_code
      )
    end;

    v_days := v_days || jsonb_build_array(jsonb_build_object(
      'work_date', v_date,
      'closed', v_date = any(v_closed_dates),
      'my', v_my,
      'shifts', coalesce(v_date_cov->'shifts', '[]'::jsonb),
      'quota_groups', coalesce(v_date_cov->'quota_groups', '[]'::jsonb),
      'off_count', coalesce((v_date_cov->>'off_count')::integer, 0),
      'off_full', coalesce((v_date_cov->>'off_count')::integer, 0)
        >= coalesce(v_settings.max_off_per_day, 2),
      'total_staff', coalesce((v_date_cov->>'total_staff')::integer, 0)
    ));
  end loop;

  select count(*)
  into v_entry_count
  from public.payroll_bn_shift_entries
  where employee_code = v_employee
    and week_start = v_week;

  v_suggestion := null;
  if v_entry_count = 0 then
    select jsonb_agg(
      jsonb_build_object(
        'work_date', en.work_date + 7,
        'shift_code', en.shift_code,
        'state', en.state
      )
      order by en.work_date
    )
    into v_suggestion
    from public.payroll_bn_shift_entries en
    where en.employee_code = v_employee
      and en.week_start = v_week - 7
      and en.state = 'registered';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'work_date', en.work_date,
        'shift_code', en.shift_code,
        'state', en.state,
        'source', en.source
      )
      order by en.work_date
    ),
    '[]'::jsonb
  )
  into v_current
  from public.payroll_bn_shift_entries en
  where en.employee_code = v_employee
    and en.week_start = v_current_week;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'work_date', r.work_date,
        'kind', r.kind,
        'from_shift_code', r.from_shift_code,
        'to_shift_code', r.to_shift_code,
        'reason', r.reason,
        'state', r.state,
        'decision_note', r.decision_note,
        'created_at', r.created_at,
        'decided_at', r.decided_at
      )
      order by r.created_at desc, r.id
    ),
    '[]'::jsonb
  )
  into v_requests
  from public.payroll_bn_shift_requests r
  where r.employee_code = v_employee
    and r.week_start = v_week;

  return jsonb_build_object(
    'eligible', v_eligible,
    'week', jsonb_build_object(
      'week_start', v_week,
      'status', v_status,
      'opens_at', v_opens_at,
      'deadline', v_deadline,
      'can_edit', v_can_edit,
      'closed_dates', to_jsonb(v_closed_dates)
    ),
    'shift_types', v_shift_types,
    'days', v_days,
    'suggestion', v_suggestion,
    'current_week', v_current,
    'requests', v_requests,
    'can_request', v_can_request
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Manager board: add pending_requests, keep every old key
-- ---------------------------------------------------------------------------
create or replace function public.get_payroll_bn_shift_board(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_week date := public.payroll_bn_shift_week_start(p_week_start);
  v_settings public.payroll_bn_shift_settings%rowtype;
  v_week_row public.payroll_bn_shift_weeks%rowtype;
  v_shift_types jsonb;
  v_quotas jsonb;
  v_coverage jsonb;
  v_employees jsonb := '[]'::jsonb;
  v_entries jsonb;
  v_suggestions jsonb;
  v_employee record;
  v_entry_count integer;
  v_unregistered jsonb := '[]'::jsonb;
  v_below_needed jsonb;
  v_below_min_staff jsonb;
  v_off_above_max jsonb;
  v_total integer := 0;
  v_registered integer := 0;
  v_waitlist integer := 0;
  v_off integer := 0;
  v_pending_requests integer := 0;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_shift_forbidden' using errcode = '42501';
  end if;

  if v_week is null then
    raise exception 'payroll_shift_week_required' using errcode = '22023';
  end if;

  select * into v_settings
  from public.payroll_bn_shift_settings
  where id;

  select * into v_week_row
  from public.payroll_bn_shift_weeks
  where week_start = v_week;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', t.code,
        'label', t.label,
        'start_time', to_char(t.start_time, 'HH24:MI'),
        'end_time', case when t.end_time is null then null else to_char(t.end_time, 'HH24:MI') end,
        'sort', t.sort,
        'active', t.active
      )
      order by t.sort, t.code
    ),
    '[]'::jsonb
  )
  into v_shift_types
  from public.payroll_bn_shift_types t
  where t.active;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'shift_code', q.shift_code,
        'iso_dow', q.iso_dow,
        'needed', q.needed,
        'quota_group', q.quota_group
      )
      order by q.shift_code, q.iso_dow nulls first
    ),
    '[]'::jsonb
  )
  into v_quotas
  from public.payroll_bn_shift_quotas q;

  v_coverage := public.payroll_bn_shift_coverage(v_week);

  for v_employee in
    with latest_period as (
      select p.id
      from public.payroll_bn_periods p
      order by p.date_from desc, p.created_at desc
      limit 1
    )
    select r.employee_code, r.employee_name, r.employment_type, r.group_name
    from (
      select e.employee_code, e.employee_name, e.employment_type, e.group_name
      from latest_period lp
      join public.payroll_bn_period_employees e on e.period_id = lp.id
      where coalesce(e.group_name = any(v_settings.eligible_groups), false)
        and (e.end_date is null or e.end_date >= v_week)
      union all
      select x.code, x.code, 'official', null
      from unnest(v_settings.extra_employee_codes) as x(code)
      where not exists (
        select 1
        from latest_period lp
        join public.payroll_bn_period_employees e on e.period_id = lp.id
        where e.employee_code = x.code
      )
    ) r
    order by r.employee_code
  loop
    select count(*)
    into v_entry_count
    from public.payroll_bn_shift_entries en
    where en.employee_code = v_employee.employee_code
      and en.week_start = v_week;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'work_date', en.work_date,
          'shift_code', en.shift_code,
          'state', en.state,
          'source', en.source,
          'previous_shift_code', en.previous_shift_code
        )
        order by en.work_date
      ),
      '[]'::jsonb
    )
    into v_entries
    from public.payroll_bn_shift_entries en
    where en.employee_code = v_employee.employee_code
      and en.week_start = v_week;

    if v_entry_count = 0 then
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'work_date', en.work_date + 7,
            'shift_code', en.shift_code,
            'state', en.state,
            'carried', true
          )
          order by en.work_date
        ),
        '[]'::jsonb
      )
      into v_suggestions
      from public.payroll_bn_shift_entries en
      where en.employee_code = v_employee.employee_code
        and en.week_start = v_week - 7
        and en.state = 'registered';

      v_unregistered := v_unregistered || to_jsonb(v_employee.employee_code);
    else
      v_suggestions := '[]'::jsonb;
    end if;

    v_employees := v_employees || jsonb_build_array(jsonb_build_object(
      'employee_code', v_employee.employee_code,
      'employee_name', v_employee.employee_name,
      'employment_type', v_employee.employment_type,
      'group_name', v_employee.group_name,
      'has_entries', v_entry_count > 0,
      'entries', v_entries,
      'suggestions', v_suggestions
    ));
  end loop;

  select
    count(*),
    count(*) filter (where state = 'registered'),
    count(*) filter (where state = 'waitlist'),
    count(*) filter (where shift_code is null)
  into v_total, v_registered, v_waitlist, v_off
  from public.payroll_bn_shift_entries
  where week_start = v_week;

  select count(*)
  into v_pending_requests
  from public.payroll_bn_shift_requests
  where week_start = v_week
    and state = 'pending';

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'work_date', d.value->>'work_date',
        'code', s.value->>'code',
        'shift_code', s.value->>'shift_code',
        'registered', (s.value->>'registered')::integer,
        'needed', (s.value->>'needed')::integer
      )
      order by d.value->>'work_date', s.value->>'code'
    ),
    '[]'::jsonb
  )
  into v_below_needed
  from jsonb_array_elements(v_coverage->'dates') d
  cross join lateral jsonb_array_elements(d.value->'shifts') s
  where coalesce((s.value->>'need_more')::boolean, false);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'work_date', d.value->>'work_date',
        'total_staff', (d.value->>'total_staff')::integer,
        'min_staff_per_day', coalesce(v_settings.min_staff_per_day, 5)
      )
      order by d.value->>'work_date'
    ),
    '[]'::jsonb
  )
  into v_below_min_staff
  from jsonb_array_elements(v_coverage->'dates') d
  where (d.value->>'total_staff')::integer < coalesce(v_settings.min_staff_per_day, 5);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'work_date', d.value->>'work_date',
        'off_count', (d.value->>'off_count')::integer,
        'max_off_per_day', coalesce(v_settings.max_off_per_day, 2)
      )
      order by d.value->>'work_date'
    ),
    '[]'::jsonb
  )
  into v_off_above_max
  from jsonb_array_elements(v_coverage->'dates') d
  where (d.value->>'off_count')::integer > coalesce(v_settings.max_off_per_day, 2);

  return jsonb_build_object(
    'week_start', v_week,
    'settings', to_jsonb(v_settings),
    'shift_types', v_shift_types,
    'quotas', v_quotas,
    'week', case when v_week_row.week_start is null then null else to_jsonb(v_week_row) end,
    'coverage', v_coverage,
    'employees', v_employees,
    'pending_requests', v_pending_requests,
    'totals', jsonb_build_object(
      'employees', jsonb_array_length(v_employees),
      'entries', v_total,
      'registered', v_registered,
      'waitlist', v_waitlist,
      'off_days', v_off,
      'unregistered', jsonb_array_length(v_unregistered)
    ),
    'warnings', jsonb_build_object(
      'below_needed', v_below_needed,
      'below_min_staff', v_below_min_staff,
      'off_above_max', v_off_above_max,
      'unregistered', v_unregistered
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Config: accept settings.late_grace_minutes; never touch extra_employee_codes
-- ---------------------------------------------------------------------------
create or replace function public.upsert_payroll_bn_shift_config(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_settings_row public.payroll_bn_shift_settings%rowtype;
  v_types jsonb;
  v_quotas jsonb;
  v_settings jsonb;
  v_elem jsonb;
  v_code text;
  v_codes text[] := '{}'::text[];
  v_seen text[] := '{}'::text[];
  v_time_text text;
  v_end_text text;
  v_iso integer;
  v_needed integer;
  v_group text;
  v_key text;
  v_groups text[];
  v_open integer;
  v_deadline integer;
  v_deadline_time time;
  v_max_off integer;
  v_min_staff integer;
  v_min_off integer;
  v_late_grace integer;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_shift_forbidden' using errcode = '42501';
  end if;

  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'payroll_shift_config_required' using errcode = '22023';
  end if;

  select * into v_settings_row
  from public.payroll_bn_shift_settings
  where id
  for update;

  if p ? 'shift_types' then
    v_types := p->'shift_types';
    if v_types is null or jsonb_typeof(v_types) <> 'array' then
      raise exception 'payroll_shift_types_must_be_array' using errcode = '22023';
    end if;

    v_codes := '{}'::text[];
    for v_elem in select value from jsonb_array_elements(v_types) loop
      if jsonb_typeof(v_elem) <> 'object' then
        raise exception 'payroll_shift_type_must_be_object' using errcode = '22023';
      end if;

      v_code := btrim(coalesce(v_elem->>'code', ''));
      if v_code = '' then
        raise exception 'payroll_shift_type_code_required' using errcode = '22023';
      end if;
      if v_code = any(v_codes) then
        raise exception 'payroll_shift_type_duplicate_code: %', v_code using errcode = '22023';
      end if;
      v_codes := array_append(v_codes, v_code);

      v_time_text := btrim(coalesce(v_elem->>'start_time', ''));
      if v_time_text !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception 'payroll_shift_type_invalid_start_time: %', v_code using errcode = '22023';
      end if;

      v_end_text := nullif(btrim(coalesce(v_elem->>'end_time', '')), '');
      if v_end_text is not null
         and v_end_text !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception 'payroll_shift_type_invalid_end_time: %', v_code using errcode = '22023';
      end if;
    end loop;

    for v_elem in select value from jsonb_array_elements(v_types) loop
      insert into public.payroll_bn_shift_types(
        code,
        label,
        start_time,
        end_time,
        sort,
        active
      ) values (
        btrim(v_elem->>'code'),
        nullif(btrim(coalesce(v_elem->>'label', '')), ''),
        (btrim(v_elem->>'start_time'))::time,
        nullif(btrim(coalesce(v_elem->>'end_time', '')), '')::time,
        coalesce((v_elem->>'sort')::integer, 0),
        coalesce((v_elem->>'active')::boolean, true)
      )
      on conflict (code) do update
      set label = excluded.label,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          sort = excluded.sort,
          active = excluded.active;
    end loop;

    delete from public.payroll_bn_shift_types t
    where t.code <> all (v_codes)
      and not exists (
        select 1
        from public.payroll_bn_shift_entries en
        where en.shift_code = t.code
      )
      and not exists (
        select 1
        from public.payroll_bn_shift_requests r
        where r.to_shift_code = t.code
      );

    if exists (
      select 1
      from public.payroll_bn_shift_types t
      where t.code <> all (v_codes)
    ) then
      raise exception 'payroll_shift_type_in_use' using errcode = '22023';
    end if;
  end if;

  if p ? 'quotas' then
    v_quotas := p->'quotas';
    if v_quotas is null or jsonb_typeof(v_quotas) <> 'array' then
      raise exception 'payroll_shift_quotas_must_be_array' using errcode = '22023';
    end if;

    v_seen := '{}'::text[];
    for v_elem in select value from jsonb_array_elements(v_quotas) loop
      if jsonb_typeof(v_elem) <> 'object' then
        raise exception 'payroll_shift_quota_must_be_object' using errcode = '22023';
      end if;

      v_code := btrim(coalesce(v_elem->>'shift_code', ''));
      if not exists (
        select 1 from public.payroll_bn_shift_types t where t.code = v_code
      ) then
        raise exception 'payroll_shift_quota_unknown_shift: %', v_code using errcode = '22023';
      end if;

      v_iso := nullif(btrim(coalesce(v_elem->>'iso_dow', '')), '')::integer;
      if v_iso is not null and (v_iso < 1 or v_iso > 7) then
        raise exception 'payroll_shift_quota_invalid_iso_dow' using errcode = '22023';
      end if;

      v_needed := coalesce((v_elem->>'needed')::integer, 0);
      if v_needed < 0 then
        raise exception 'payroll_shift_quota_negative_needed' using errcode = '22023';
      end if;

      v_key := v_code || ':' || coalesce(v_iso::text, '*');
      if v_key = any(v_seen) then
        raise exception 'payroll_shift_quota_duplicate: %', v_key using errcode = '22023';
      end if;
      v_seen := array_append(v_seen, v_key);
    end loop;

    delete from public.payroll_bn_shift_quotas;

    for v_elem in select value from jsonb_array_elements(v_quotas) loop
      insert into public.payroll_bn_shift_quotas(
        shift_code,
        iso_dow,
        needed,
        quota_group
      ) values (
        btrim(v_elem->>'shift_code'),
        nullif(btrim(coalesce(v_elem->>'iso_dow', '')), '')::integer,
        coalesce((v_elem->>'needed')::integer, 0),
        nullif(btrim(coalesce(v_elem->>'quota_group', '')), '')
      );
    end loop;
  end if;

  if p ? 'settings' then
    v_settings := p->'settings';
    if v_settings is null or jsonb_typeof(v_settings) <> 'object' then
      raise exception 'payroll_shift_settings_must_be_object' using errcode = '22023';
    end if;

    if v_settings ? 'eligible_groups' then
      if jsonb_typeof(v_settings->'eligible_groups') <> 'array' then
        raise exception 'payroll_shift_eligible_groups_must_be_array' using errcode = '22023';
      end if;
      v_groups := array(
        select btrim(value)
        from jsonb_array_elements_text(v_settings->'eligible_groups') as value
        where btrim(value) <> ''
      );
    else
      v_groups := v_settings_row.eligible_groups;
    end if;

    v_open := coalesce((v_settings->>'open_iso_dow')::integer, v_settings_row.open_iso_dow);
    v_deadline := coalesce((v_settings->>'deadline_iso_dow')::integer, v_settings_row.deadline_iso_dow);
    if v_open < 1 or v_open > 7 or v_deadline < 1 or v_deadline > 7 then
      raise exception 'payroll_shift_settings_invalid_iso_dow' using errcode = '22023';
    end if;

    v_time_text := coalesce(
      nullif(btrim(coalesce(v_settings->>'deadline_time', '')), ''),
      to_char(v_settings_row.deadline_time, 'HH24:MI')
    );
    if v_time_text !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'payroll_shift_settings_invalid_deadline_time' using errcode = '22023';
    end if;
    v_deadline_time := v_time_text::time;

    v_max_off := coalesce((v_settings->>'max_off_per_day')::integer, v_settings_row.max_off_per_day);
    v_min_staff := coalesce((v_settings->>'min_staff_per_day')::integer, v_settings_row.min_staff_per_day);
    v_min_off := coalesce((v_settings->>'min_off_days_per_week')::integer, v_settings_row.min_off_days_per_week);
    v_late_grace := coalesce(
      (v_settings->>'late_grace_minutes')::integer,
      v_settings_row.late_grace_minutes,
      0
    );

    if v_max_off < 0 or v_min_staff < 0 or v_min_off < 0 then
      raise exception 'payroll_shift_settings_negative_limit' using errcode = '22023';
    end if;
    if v_late_grace < 0 or v_late_grace > 120 then
      raise exception 'payroll_shift_settings_invalid_late_grace' using errcode = '22023';
    end if;

    -- extra_employee_codes is intentionally not part of this UPDATE.
    update public.payroll_bn_shift_settings
    set eligible_groups = coalesce(v_groups, '{}'::text[]),
        open_iso_dow = v_open,
        deadline_iso_dow = v_deadline,
        deadline_time = v_deadline_time,
        max_off_per_day = v_max_off,
        min_staff_per_day = v_min_staff,
        min_off_days_per_week = v_min_off,
        late_grace_minutes = v_late_grace
    where id;
  end if;

  return jsonb_build_object(
    'settings', (
      select to_jsonb(s)
      from public.payroll_bn_shift_settings s
      where s.id
    ),
    'shift_types', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.sort, t.code), '[]'::jsonb)
      from public.payroll_bn_shift_types t
    ),
    'quotas', (
      select coalesce(
        jsonb_agg(to_jsonb(q) order by q.shift_code, q.iso_dow nulls first),
        '[]'::jsonb
      )
      from public.payroll_bn_shift_quotas q
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) Manager request list with proposed coverage impact
-- ---------------------------------------------------------------------------
create or replace function public.list_payroll_bn_shift_requests(
  p_week_start date,
  p_state text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_week date := public.payroll_bn_shift_week_start(p_week_start);
  v_state text := nullif(lower(btrim(coalesce(p_state, ''))), '');
  v_requests jsonb := '[]'::jsonb;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_shift_forbidden' using errcode = '42501';
  end if;

  if v_week is null then
    raise exception 'payroll_shift_week_required' using errcode = '22023';
  end if;

  if v_state is not null
     and v_state not in ('pending', 'approved', 'rejected', 'cancelled') then
    raise exception 'shift_request_invalid_state' using errcode = '22023';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'week_start', r.week_start,
        'work_date', r.work_date,
        'employee_code', r.employee_code,
        'employee_name', public.payroll_bn_shift_employee_name(r.employee_code),
        'kind', r.kind,
        'from_shift_code', r.from_shift_code,
        'to_shift_code', r.to_shift_code,
        'reason', r.reason,
        'state', r.state,
        'decision_note', r.decision_note,
        'decided_by', r.decided_by,
        'decided_at', r.decided_at,
        'created_at', r.created_at,
        'updated_at', r.updated_at,
        'current_shift_code', cur.shift_code,
        'current_state', cur.state,
        'current_source', cur.source,
        'impact', public.payroll_bn_shift_request_impact(
          r.week_start,
          r.work_date,
          r.employee_code,
          r.kind,
          r.to_shift_code
        )
      )
      order by r.created_at desc, r.id
    ),
    '[]'::jsonb
  )
  into v_requests
  from public.payroll_bn_shift_requests r
  left join public.payroll_bn_shift_entries cur
    on cur.employee_code = r.employee_code
   and cur.work_date = r.work_date
  where r.week_start = v_week
    and (v_state is null or r.state = v_state);

  return jsonb_build_object(
    'week_start', v_week,
    'state', v_state,
    'requests', v_requests
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9) Manager decision: apply the entry immediately, never reopen the week
-- ---------------------------------------------------------------------------
create or replace function public.decide_payroll_bn_shift_request(
  p_request_id uuid,
  p_approve boolean,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_approve boolean := coalesce(p_approve, false);
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_request public.payroll_bn_shift_requests%rowtype;
  v_entry public.payroll_bn_shift_entries%rowtype;
  v_cov jsonb;
  v_day jsonb;
  v_warnings jsonb;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_shift_forbidden' using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'shift_request_not_found' using errcode = 'P0002';
  end if;

  if v_note is not null and length(v_note) > 1000 then
    raise exception 'shift_request_note_too_long' using errcode = '22023';
  end if;

  select * into v_request
  from public.payroll_bn_shift_requests
  where id = p_request_id
  for update;

  if v_request.id is null then
    raise exception 'shift_request_not_found' using errcode = 'P0002';
  end if;

  if v_request.state <> 'pending' then
    raise exception 'shift_request_not_pending' using errcode = '22023';
  end if;

  if v_approve then
    select * into v_entry
    from public.payroll_bn_shift_entries
    where employee_code = v_request.employee_code
      and work_date = v_request.work_date;

    -- The employee (or a manager) may have changed the cell while the request
    -- was pending. The request stays pending until the manager resolves it.
    if (v_entry.id is null and v_request.from_shift_code is not null)
       or (v_entry.id is not null
           and v_entry.shift_code is distinct from v_request.from_shift_code) then
      raise exception 'shift_request_stale' using errcode = '22023';
    end if;

    perform public.set_payroll_bn_shift_entry(
      v_request.week_start,
      v_request.employee_code,
      v_request.work_date,
      case when v_request.kind = 'leave' then null else v_request.to_shift_code end
    );

    update public.payroll_bn_shift_requests
    set state = 'approved',
        decided_by = v_uid,
        decided_at = now(),
        decision_note = v_note
    where id = v_request.id
    returning * into v_request;
  else
    update public.payroll_bn_shift_requests
    set state = 'rejected',
        decided_by = v_uid,
        decided_at = now(),
        decision_note = v_note
    where id = v_request.id
    returning * into v_request;
  end if;

  v_cov := public.payroll_bn_shift_coverage(v_request.week_start);
  v_day := (
    select value
    from jsonb_array_elements(coalesce(v_cov->'dates', '[]'::jsonb))
    where value->>'work_date' = v_request.work_date::text
    limit 1
  );
  v_warnings := public.payroll_bn_shift_date_warnings(v_day);

  insert into public.payroll_bn_shift_events(
    week_start,
    employee_code,
    work_date,
    action,
    actor_id,
    payload
  ) values (
    v_request.week_start,
    v_request.employee_code,
    v_request.work_date,
    case when v_approve then 'request_approved' else 'request_rejected' end,
    v_uid,
    jsonb_build_object(
      'request', to_jsonb(v_request),
      'warnings', v_warnings
    )
  );

  return jsonb_build_object(
    'request', to_jsonb(v_request),
    'coverage', v_day,
    'warnings', v_warnings
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 10) Attendance-vs-schedule flags (read-only)
--
-- Choice for payroll_bn_attendance_day_overrides: a manager-approved day
-- override suppresses every flag for that employee/date. The override means
-- "this incomplete day is accepted", so it must not be reported as no_show,
-- late, unscheduled or missing_out. Closed dates are also skipped.
-- ---------------------------------------------------------------------------
create or replace function public.get_payroll_bn_shift_attendance_flags(
  p_week_start date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_week date := public.payroll_bn_shift_week_start(p_week_start);
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_week_row public.payroll_bn_shift_weeks%rowtype;
  v_settings public.payroll_bn_shift_settings%rowtype;
  v_closed_dates date[] := '{}'::date[];
  v_grace integer := 0;
  v_flags jsonb := '[]'::jsonb;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_shift_forbidden' using errcode = '42501';
  end if;

  if v_week is null then
    raise exception 'payroll_shift_week_required' using errcode = '22023';
  end if;

  select * into v_week_row
  from public.payroll_bn_shift_weeks
  where week_start = v_week;

  if v_week_row.week_start is null or v_week_row.status <> 'published' then
    return jsonb_build_object('week_start', v_week, 'flags', '[]'::jsonb);
  end if;

  select * into v_settings
  from public.payroll_bn_shift_settings
  where id;

  v_closed_dates := coalesce(v_week_row.closed_dates, '{}'::date[]);
  v_grace := coalesce(v_settings.late_grace_minutes, 0);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'employee_code', f.employee_code,
        'name', f.employee_name,
        'work_date', f.work_date,
        'shift_code', f.shift_code,
        'shift_start', f.shift_start,
        'kind', f.kind,
        'check_in_at', f.check_in_at,
        'check_out_at', f.check_out_at,
        'minutes_late', f.minutes_late
      )
      order by f.work_date, f.employee_code, f.kind
    ),
    '[]'::jsonb
  )
  into v_flags
  from (
    with keys as (
      select en.employee_code, en.work_date
      from public.payroll_bn_shift_entries en
      where en.week_start = v_week
        and en.state = 'registered'
        and en.shift_code is not null
        and en.work_date <= v_today
      union
      select e.employee_code, e.work_date
      from public.payroll_bn_attendance_events e
      where e.decision = 'accepted'
        and e.work_date between v_week and least(v_week + 6, v_today)
        -- Only staff who take part in shift scheduling; other groups using
        -- GPS attendance must not show up as "unscheduled".
        and public.payroll_bn_shift_eligible(e.employee_code, v_week)
    ), base as (
      select
        k.employee_code,
        k.work_date,
        en.shift_code,
        st.start_time,
        (
          select e.server_received_at
          from public.payroll_bn_attendance_events e
          where e.employee_code = k.employee_code
            and e.work_date = k.work_date
            and e.decision = 'accepted'
            and e.event_kind = 'in'
          order by e.server_received_at asc
          limit 1
        ) as check_in_at,
        (
          select e.server_received_at
          from public.payroll_bn_attendance_events e
          where e.employee_code = k.employee_code
            and e.work_date = k.work_date
            and e.decision = 'accepted'
            and e.event_kind = 'out'
          order by e.server_received_at asc
          limit 1
        ) as check_out_at,
        (
          select (e.server_received_at at time zone 'Asia/Ho_Chi_Minh')::time
          from public.payroll_bn_attendance_events e
          where e.employee_code = k.employee_code
            and e.work_date = k.work_date
            and e.decision = 'accepted'
            and e.event_kind = 'in'
          order by e.server_received_at asc
          limit 1
        ) as check_in_time,
        exists (
          select 1
          from public.payroll_bn_attendance_day_overrides o
          where o.employee_code = k.employee_code
            and o.work_date = k.work_date
        ) as has_override,
        exists (
          select 1
          from public.payroll_bn_shift_requests r
          where r.employee_code = k.employee_code
            and r.work_date = k.work_date
            and r.kind = 'leave'
            and r.state = 'approved'
        ) as has_leave,
        (k.work_date = any (v_closed_dates)) as is_closed
      from keys k
      left join public.payroll_bn_shift_entries en
        on en.employee_code = k.employee_code
       and en.work_date = k.work_date
       and en.state = 'registered'
      left join public.payroll_bn_shift_types st on st.code = en.shift_code
    )
    select
      b.employee_code,
      public.payroll_bn_shift_employee_name(b.employee_code) as employee_name,
      b.work_date,
      b.shift_code,
      case when b.start_time is null then null else to_char(b.start_time, 'HH24:MI') end as shift_start,
      'no_show'::text as kind,
      b.check_in_at,
      b.check_out_at,
      null::integer as minutes_late
    from base b
    where b.shift_code is not null
      and b.work_date < v_today
      and b.check_in_at is null
      and not b.has_leave
      and not b.has_override
      and not b.is_closed

    union all

    select
      b.employee_code,
      public.payroll_bn_shift_employee_name(b.employee_code),
      b.work_date,
      b.shift_code,
      to_char(b.start_time, 'HH24:MI'),
      'late'::text,
      b.check_in_at,
      b.check_out_at,
      greatest(
        0,
        floor(extract(epoch from (b.check_in_time - b.start_time)) / 60)::integer
      )
    from base b
    where b.shift_code is not null
      and b.check_in_at is not null
      and b.check_in_time > b.start_time + make_interval(mins => v_grace)
      and not b.has_override
      and not b.is_closed

    union all

    select
      b.employee_code,
      public.payroll_bn_shift_employee_name(b.employee_code),
      b.work_date,
      null::text,
      null::text,
      'unscheduled'::text,
      b.check_in_at,
      b.check_out_at,
      null::integer
    from base b
    where b.shift_code is null
      and b.check_in_at is not null
      and not b.has_override
      and not b.is_closed

    union all

    select
      b.employee_code,
      public.payroll_bn_shift_employee_name(b.employee_code),
      b.work_date,
      b.shift_code,
      case when b.start_time is null then null else to_char(b.start_time, 'HH24:MI') end,
      'missing_out'::text,
      b.check_in_at,
      b.check_out_at,
      null::integer
    from base b
    where b.check_in_at is not null
      and b.check_out_at is null
      and b.work_date < v_today
      and not b.has_override
      and not b.is_closed
  ) f;

  return jsonb_build_object('week_start', v_week, 'flags', v_flags);
end;
$$;

-- ---------------------------------------------------------------------------
-- 11) RLS + grants
-- ---------------------------------------------------------------------------
alter table public.payroll_bn_shift_requests enable row level security;

revoke all on table public.payroll_bn_shift_requests
  from public, anon, authenticated;
grant all on table public.payroll_bn_shift_requests to service_role;

revoke all on function public.payroll_bn_shift_employee_name(text)
  from public, anon, authenticated;
revoke all on function public.payroll_bn_shift_date_warnings(jsonb)
  from public, anon, authenticated;
revoke all on function public.payroll_bn_shift_request_impact(date, date, text, text, text)
  from public, anon, authenticated;

revoke all on function public.submit_payroll_bn_shift_request(text, date, text, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_payroll_bn_shift_request(text, date, text, text, text)
  to service_role;

revoke all on function public.cancel_payroll_bn_shift_request(text, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_payroll_bn_shift_request(text, uuid)
  to service_role;

revoke all on function public.get_payroll_bn_shift_week(text, date)
  from public, anon, authenticated;
grant execute on function public.get_payroll_bn_shift_week(text, date)
  to service_role;

-- Manager RPCs: authenticated only (no service_role, no anon).
revoke all on function public.list_payroll_bn_shift_requests(date, text)
  from public, anon, authenticated;
grant execute on function public.list_payroll_bn_shift_requests(date, text)
  to authenticated;

revoke all on function public.decide_payroll_bn_shift_request(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.decide_payroll_bn_shift_request(uuid, boolean, text)
  to authenticated;

revoke all on function public.get_payroll_bn_shift_attendance_flags(date)
  from public, anon, authenticated;
grant execute on function public.get_payroll_bn_shift_attendance_flags(date)
  to authenticated;

revoke all on function public.get_payroll_bn_shift_board(date)
  from public, anon, authenticated;
grant execute on function public.get_payroll_bn_shift_board(date)
  to authenticated, service_role;

revoke all on function public.upsert_payroll_bn_shift_config(jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_payroll_bn_shift_config(jsonb)
  to authenticated, service_role;

comment on function public.submit_payroll_bn_shift_request(text, date, text, text, text) is
  'Employee change/leave request after the week is published or its deadline passed. service_role only. Error codes: shift_request_use_registration, shift_request_past_date, shift_request_closed_date, shift_request_no_shift, shift_request_duplicate, shift_request_same_shift.';
comment on function public.cancel_payroll_bn_shift_request(text, uuid) is
  'Owner-only cancel while pending; idempotent on already-cancelled. service_role only.';
comment on function public.list_payroll_bn_shift_requests(date, text) is
  'Manager request list with employee name, current entry and proposed coverage impact. Authenticated owner/payroll.edit only.';
comment on function public.decide_payroll_bn_shift_request(uuid, boolean, text) is
  'Approve/reject a pending request immediately on a published week. Approve re-checks the from_shift_code snapshot and returns coverage warnings.';
comment on function public.get_payroll_bn_shift_attendance_flags(date) is
  'Published-week attendance-vs-schedule flags: no_show, late, unscheduled, missing_out. Manager-approved day overrides and closed dates are skipped.';
