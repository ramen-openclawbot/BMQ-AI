-- ============================================================================
-- Migration: Đăng ký ca Bếp bánh theo tuần — giai đoạn 1 (payroll_bn)
--
-- Adds a data-driven weekly schedule for payroll_bn employees in the eligible
-- groups (default 'Bếp bánh'):
--   * payroll_bn_shift_types      — code/label/start/end/sort/active
--   * payroll_bn_shift_quotas     — needed headcount per shift (or quota group)
--   * payroll_bn_shift_settings   — eligible groups, open/deadline, limits
--   * payroll_bn_shift_weeks      — one row per Monday week, open|published
--   * payroll_bn_shift_entries    — one shift or one day off per employee/day
--   * payroll_bn_shift_events     — append-only audit of every schedule write
--
-- Every shift-specific value (types, needed headcount, opening day, deadline,
-- limits) lives in data. Only the settings singleton is seeded: no shift type
-- and no quota is seeded by this migration.
--
-- Employee RPCs are service_role only (they are called by the payslip-shifts
-- Edge Function after the psp_ session + device-binding check). Manager RPCs
-- use the existing owner / payroll.edit helper. This migration has NOT been
-- applied to production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Shift catalogue + quotas
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_shift_types (
  code text primary key check (length(btrim(code)) > 0),
  label text,
  start_time time not null,
  end_time time,
  sort integer not null default 0,
  active boolean not null default true
);

comment on table public.payroll_bn_shift_types is
  'Data-driven shift catalogue. start_time is the punctual cutoff of a work date that registers this shift.';

create table if not exists public.payroll_bn_shift_quotas (
  id uuid primary key default gen_random_uuid(),
  shift_code text not null references public.payroll_bn_shift_types(code) on delete cascade,
  iso_dow integer check (iso_dow between 1 and 7),
  needed integer not null default 0 check (needed >= 0),
  quota_group text,
  constraint payroll_bn_shift_quotas_group_not_blank
    check (quota_group is null or length(btrim(quota_group)) > 0),
  constraint payroll_bn_shift_quotas_unique unique (shift_code, iso_dow)
);

create index if not exists payroll_bn_shift_quotas_group_idx
  on public.payroll_bn_shift_quotas(quota_group, iso_dow);

-- The table-level unique allows several NULL iso_dow rows; keep exactly one
-- "every day" quota per shift.
create unique index if not exists payroll_bn_shift_quotas_everyday_unique
  on public.payroll_bn_shift_quotas(shift_code)
  where iso_dow is null;

comment on table public.payroll_bn_shift_quotas is
  'Needed headcount per shift and ISO weekday (NULL = every day). Several shift codes may share one needed number through quota_group.';

-- ---------------------------------------------------------------------------
-- 2) Weekly settings singleton (only this row is seeded)
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_shift_settings (
  id boolean primary key default true check (id),
  eligible_groups text[] not null default '{Bếp bánh}'::text[],
  -- Extra employee codes that may register even when they are not in the
  -- latest period roster (for example the owner's test account). Data only.
  extra_employee_codes text[] not null default '{}'::text[],
  open_iso_dow integer not null default 2 check (open_iso_dow between 1 and 7),
  deadline_iso_dow integer not null default 6 check (deadline_iso_dow between 1 and 7),
  deadline_time time not null default '12:00',
  max_off_per_day integer not null default 2 check (max_off_per_day >= 0),
  min_staff_per_day integer not null default 5 check (min_staff_per_day >= 0),
  min_off_days_per_week integer not null default 1 check (min_off_days_per_week >= 0)
);

insert into public.payroll_bn_shift_settings(id)
values (true)
on conflict (id) do nothing;

comment on table public.payroll_bn_shift_settings is
  'Singleton weekly-shift configuration. No shift type or quota is seeded here.';

-- ---------------------------------------------------------------------------
-- 3) Week board + one entry per employee/work date
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_shift_weeks (
  week_start date primary key
    check (extract(isodow from week_start) = 1),
  status text not null default 'open'
    check (status in ('open', 'published')),
  closed_dates date[] not null default '{}'::date[],
  published_at timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at_payroll_bn_shift_weeks
  on public.payroll_bn_shift_weeks;
create trigger set_updated_at_payroll_bn_shift_weeks
before update on public.payroll_bn_shift_weeks
for each row execute function public.handle_updated_at();

create table if not exists public.payroll_bn_shift_entries (
  id uuid primary key default gen_random_uuid(),
  week_start date not null references public.payroll_bn_shift_weeks(week_start) on delete cascade,
  employee_code text not null check (length(btrim(employee_code)) > 0),
  work_date date not null,
  shift_code text references public.payroll_bn_shift_types(code) on delete restrict,
  state text not null default 'registered'
    check (state in ('registered', 'waitlist')),
  source text not null default 'employee'
    check (source in ('employee', 'manager', 'carried')),
  previous_shift_code text,
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (employee_code, work_date),
  constraint payroll_bn_shift_entries_week_check
    check (work_date >= week_start and work_date < week_start + 7)
);

create index if not exists payroll_bn_shift_entries_week_idx
  on public.payroll_bn_shift_entries(week_start, work_date, shift_code);
create index if not exists payroll_bn_shift_entries_employee_idx
  on public.payroll_bn_shift_entries(employee_code, work_date);

drop trigger if exists set_updated_at_payroll_bn_shift_entries
  on public.payroll_bn_shift_entries;
create trigger set_updated_at_payroll_bn_shift_entries
before update on public.payroll_bn_shift_entries
for each row execute function public.handle_updated_at();

comment on table public.payroll_bn_shift_entries is
  'One choice per employee/work date: a shift_code or NULL for a day off. waitlist rows never count as coverage.';

-- ---------------------------------------------------------------------------
-- 4) Append-only audit
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_shift_events (
  id uuid primary key default gen_random_uuid(),
  week_start date,
  employee_code text,
  work_date date,
  action text not null check (length(btrim(action)) > 0),
  actor_id uuid default auth.uid() references auth.users(id) on delete set null,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists payroll_bn_shift_events_week_idx
  on public.payroll_bn_shift_events(week_start, created_at desc);
create index if not exists payroll_bn_shift_events_employee_idx
  on public.payroll_bn_shift_events(employee_code, created_at desc);

create or replace function public.reject_payroll_bn_shift_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'payroll_bn_shift_events_are_append_only'
    using errcode = '45000';
end;
$$;

drop trigger if exists payroll_bn_shift_events_append_only
  on public.payroll_bn_shift_events;
create trigger payroll_bn_shift_events_append_only
before update or delete on public.payroll_bn_shift_events
for each row execute function public.reject_payroll_bn_shift_event_mutation();

create or replace function public.audit_payroll_bn_shift_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_action text;
begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;

  if tg_table_name = 'payroll_bn_shift_entries' then
    v_action := 'entry_' || lower(tg_op);
    insert into public.payroll_bn_shift_events(
      week_start,
      employee_code,
      work_date,
      action,
      actor_id,
      payload
    ) values (
      (v_row->>'week_start')::date,
      v_row->>'employee_code',
      (v_row->>'work_date')::date,
      v_action,
      auth.uid(),
      jsonb_build_object(
        'before', case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
        'after', case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
      )
    );
  else
    v_action := 'week_' || lower(tg_op);
    insert into public.payroll_bn_shift_events(
      week_start,
      employee_code,
      work_date,
      action,
      actor_id,
      payload
    ) values (
      (v_row->>'week_start')::date,
      null,
      null,
      v_action,
      auth.uid(),
      jsonb_build_object(
        'before', case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
        'after', case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
      )
    );
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists audit_payroll_bn_shift_entry_changes
  on public.payroll_bn_shift_entries;
create trigger audit_payroll_bn_shift_entry_changes
after insert or update or delete on public.payroll_bn_shift_entries
for each row execute function public.audit_payroll_bn_shift_change();

drop trigger if exists audit_payroll_bn_shift_week_changes
  on public.payroll_bn_shift_weeks;
create trigger audit_payroll_bn_shift_week_changes
after insert or update or delete on public.payroll_bn_shift_weeks
for each row execute function public.audit_payroll_bn_shift_change();

comment on table public.payroll_bn_shift_events is
  'Append-only audit history for shift entry and week writes. Rows can never be updated or deleted.';

-- ---------------------------------------------------------------------------
-- 5) Shared helpers
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_shift_week_start(p_date date)
returns date
language sql
immutable
set search_path = public
as $$
  select case
    when p_date is null then null
    else p_date - (extract(isodow from p_date)::integer - 1)
  end;
$$;

create or replace function public.payroll_bn_shift_opens_at(p_week_start date)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings public.payroll_bn_shift_settings%rowtype;
  v_open_date date;
begin
  select * into v_settings
  from public.payroll_bn_shift_settings
  where id;

  if p_week_start is null or v_settings.id is null then
    return null;
  end if;

  -- The opening day belongs to the week BEFORE the target week.
  v_open_date := p_week_start - 7 + (v_settings.open_iso_dow - 1);
  return (v_open_date + time '00:00') at time zone 'Asia/Ho_Chi_Minh';
end;
$$;

create or replace function public.payroll_bn_shift_deadline(p_week_start date)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings public.payroll_bn_shift_settings%rowtype;
  v_deadline_date date;
begin
  select * into v_settings
  from public.payroll_bn_shift_settings
  where id;

  if p_week_start is null or v_settings.id is null then
    return null;
  end if;

  -- The deadline day also belongs to the week BEFORE the target week.
  v_deadline_date := p_week_start - 7 + (v_settings.deadline_iso_dow - 1);
  return (v_deadline_date + v_settings.deadline_time) at time zone 'Asia/Ho_Chi_Minh';
end;
$$;

create or replace function public.payroll_bn_shift_eligible(
  p_employee_code text,
  p_week_start date default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with latest_period as (
    select p.id
    from public.payroll_bn_periods p
    order by p.date_from desc, p.created_at desc
    limit 1
  )
  select coalesce((
    select coalesce(e.group_name = any(s.eligible_groups), false)
      and (p_week_start is null or e.end_date is null or e.end_date >= p_week_start)
    from latest_period lp
    join public.payroll_bn_period_employees e on e.period_id = lp.id
    cross join public.payroll_bn_shift_settings s
    where e.employee_code = btrim(coalesce(p_employee_code, ''))
      and s.id
  ), false)
  or exists (
    select 1
    from public.payroll_bn_shift_settings s
    where s.id
      and btrim(coalesce(p_employee_code, '')) <> ''
      and btrim(coalesce(p_employee_code, '')) = any(s.extra_employee_codes)
  );
$$;

create or replace function public.payroll_bn_shift_coverage(p_week_start date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings public.payroll_bn_shift_settings%rowtype;
  v_date date;
  v_iso integer;
  v_dates jsonb := '[]'::jsonb;
  v_shifts jsonb;
  v_groups jsonb;
  v_group record;
  v_type record;
  v_needed integer;
  v_group_name text;
  v_registered integer;
  v_group_registered integer;
  v_group_needed integer;
  v_off_count integer;
  v_total_staff integer;
begin
  select * into v_settings
  from public.payroll_bn_shift_settings
  where id;

  if p_week_start is null then
    return jsonb_build_object('week_start', null, 'dates', '[]'::jsonb);
  end if;

  for v_day_offset in 0..6 loop
    v_date := p_week_start + v_day_offset;
    v_iso := extract(isodow from v_date)::integer;
    v_shifts := '[]'::jsonb;
    v_groups := '[]'::jsonb;

    for v_type in
      select t.code
      from public.payroll_bn_shift_types t
      where t.active
      order by t.sort, t.code
    loop
      v_needed := 0;
      v_group_name := null;

      select q.needed, q.quota_group
      into v_needed, v_group_name
      from public.payroll_bn_shift_quotas q
      where q.shift_code = v_type.code
        and (q.iso_dow = v_iso or q.iso_dow is null)
      order by q.iso_dow nulls last
      limit 1;

      v_needed := coalesce(v_needed, 0);

      select count(*)
      into v_registered
      from public.payroll_bn_shift_entries en
      where en.week_start = p_week_start
        and en.work_date = v_date
        and en.shift_code = v_type.code
        and en.state = 'registered';

      -- Shifts that share a quota group are full / short together: the
      -- group's registered total is compared with the group's needed number.
      v_group_registered := v_registered;
      v_group_needed := v_needed;
      if v_group_name is not null then
        select coalesce(max(q.needed), 0)
        into v_group_needed
        from public.payroll_bn_shift_quotas q
        join public.payroll_bn_shift_types t on t.code = q.shift_code and t.active
        where q.quota_group = v_group_name
          and (q.iso_dow = v_iso or q.iso_dow is null);

        select count(*)
        into v_group_registered
        from public.payroll_bn_shift_entries en
        where en.week_start = p_week_start
          and en.work_date = v_date
          and en.state = 'registered'
          and en.shift_code in (
            select q.shift_code
            from public.payroll_bn_shift_quotas q
            where q.quota_group = v_group_name
              and (q.iso_dow = v_iso or q.iso_dow is null)
          );
      end if;

      v_shifts := v_shifts || jsonb_build_array(jsonb_build_object(
        'code', v_type.code,
        'shift_code', v_type.code,
        'registered', v_registered,
        'needed', v_needed,
        'quota_group', v_group_name,
        'full', v_group_registered >= v_group_needed,
        'need_more', v_group_needed > v_group_registered
      ));
    end loop;

    for v_group in
      select distinct q.quota_group
      from public.payroll_bn_shift_quotas q
      join public.payroll_bn_shift_types t on t.code = q.shift_code
      where t.active
        and q.quota_group is not null
        and (q.iso_dow = v_iso or q.iso_dow is null)
      order by q.quota_group
    loop
      select coalesce(max(q.needed), 0)
      into v_needed
      from public.payroll_bn_shift_quotas q
      join public.payroll_bn_shift_types t on t.code = q.shift_code
      where t.active
        and q.quota_group = v_group.quota_group
        and (q.iso_dow = v_iso or q.iso_dow is null);

      select count(distinct en.employee_code)
      into v_registered
      from public.payroll_bn_shift_entries en
      join public.payroll_bn_shift_quotas q on q.shift_code = en.shift_code
      join public.payroll_bn_shift_types t on t.code = q.shift_code
      where en.week_start = p_week_start
        and en.work_date = v_date
        and en.state = 'registered'
        and en.shift_code is not null
        and t.active
        and q.quota_group = v_group.quota_group
        and (q.iso_dow = v_iso or q.iso_dow is null);

      v_groups := v_groups || jsonb_build_array(jsonb_build_object(
        'quota_group', v_group.quota_group,
        'registered', v_registered,
        'needed', v_needed,
        'full', v_registered >= v_needed
      ));
    end loop;

    select
      count(*) filter (where en.shift_code is null),
      count(*) filter (where en.shift_code is not null)
    into v_off_count, v_total_staff
    from public.payroll_bn_shift_entries en
    where en.week_start = p_week_start
      and en.work_date = v_date
      and en.state = 'registered';

    v_dates := v_dates || jsonb_build_array(jsonb_build_object(
      'work_date', v_date,
      'shifts', v_shifts,
      'quota_groups', v_groups,
      'off_count', coalesce(v_off_count, 0),
      'total_staff', coalesce(v_total_staff, 0)
    ));
  end loop;

  return jsonb_build_object(
    'week_start', p_week_start,
    'dates', v_dates,
    'settings', jsonb_build_object(
      'max_off_per_day', coalesce(v_settings.max_off_per_day, 2),
      'min_staff_per_day', coalesce(v_settings.min_staff_per_day, 5)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Employee RPCs (service_role only; the Edge Function authenticates first)
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
    'current_week', v_current
  );
end;
$$;

create or replace function public.submit_payroll_bn_shift_registration(
  p_employee_code text,
  p_week_start date,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_employee text := btrim(coalesce(p_employee_code, ''));
  v_week date;
  v_settings public.payroll_bn_shift_settings%rowtype;
  v_week_row public.payroll_bn_shift_weeks%rowtype;
  v_status text;
  v_closed_dates date[];
  v_elem jsonb;
  v_date date;
  v_shift text;
  v_seen date[] := '{}'::date[];
  v_valid jsonb := '[]'::jsonb;
  v_result jsonb := '[]'::jsonb;
  v_expected integer := 0;
  v_off_days integer := 0;
  v_count integer;
  v_needed integer;
  v_group text;
  v_state text;
  v_iso integer;
begin
  if v_employee = '' or p_week_start is null then
    raise exception 'shift_employee_required' using errcode = '22023';
  end if;

  v_week := public.payroll_bn_shift_week_start(p_week_start);

  -- Serialise every submit for one week: two employees racing for the last
  -- slot are evaluated one after the other, so only one can be registered.
  perform pg_advisory_xact_lock(
    hashtextextended('payroll_bn_shift_week:' || v_week::text, 0)
  );

  if not public.payroll_bn_shift_eligible(v_employee, v_week) then
    raise exception 'shift_not_eligible' using errcode = '22023';
  end if;

  select * into v_settings
  from public.payroll_bn_shift_settings
  where id;

  select * into v_week_row
  from public.payroll_bn_shift_weeks
  where week_start = v_week
  for update;

  v_status := coalesce(v_week_row.status, 'open');
  v_closed_dates := coalesce(v_week_row.closed_dates, '{}'::date[]);

  if v_status <> 'open'
     or now() < public.payroll_bn_shift_opens_at(v_week)
     or now() > public.payroll_bn_shift_deadline(v_week) then
    raise exception 'shift_registration_closed' using errcode = '22023';
  end if;

  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'shift_incomplete_week' using errcode = '22023';
  end if;

  for v_elem in select value from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'shift_incomplete_week' using errcode = '22023';
    end if;

    begin
      v_date := (v_elem->>'work_date')::date;
    exception when others then
      raise exception 'shift_incomplete_week' using errcode = '22023';
    end;

    if v_date is null or v_date < v_week or v_date > v_week + 6 then
      raise exception 'shift_incomplete_week' using errcode = '22023';
    end if;

    -- Closed dates are ignored/removed, even when a client still sends them.
    if v_date = any(v_closed_dates) then
      continue;
    end if;

    if v_date = any(v_seen) then
      raise exception 'shift_incomplete_week' using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_date);

    v_shift := nullif(btrim(coalesce(v_elem->>'shift_code', '')), '');
    if v_shift is null then
      v_off_days := v_off_days + 1;
    elsif not exists (
      select 1
      from public.payroll_bn_shift_types t
      where t.code = v_shift
        and t.active
    ) then
      raise exception 'shift_invalid_shift' using errcode = '22023';
    end if;

    v_valid := v_valid || jsonb_build_array(jsonb_build_object(
      'work_date', v_date,
      'shift_code', v_shift
    ));
  end loop;

  select count(*)
  into v_expected
  from generate_series(0, 6) as day_offset
  where (v_week + day_offset) <> all (v_closed_dates);

  if coalesce(array_length(v_seen, 1), 0) <> v_expected then
    raise exception 'shift_incomplete_week' using errcode = '22023';
  end if;

  if v_off_days < coalesce(v_settings.min_off_days_per_week, 1) then
    raise exception 'shift_day_off_required' using errcode = '22023';
  end if;

  -- Resolve waitlist state against other employees only: this employee's own
  -- previous rows are about to be replaced.
  for v_elem in select value from jsonb_array_elements(v_valid) loop
    v_date := (v_elem->>'work_date')::date;
    v_shift := nullif(btrim(coalesce(v_elem->>'shift_code', '')), '');
    v_iso := extract(isodow from v_date)::integer;

    if v_shift is null then
      select count(*)
      into v_count
      from public.payroll_bn_shift_entries en
      where en.week_start = v_week
        and en.work_date = v_date
        and en.state = 'registered'
        and en.shift_code is null
        and en.employee_code <> v_employee;

      v_state := case
        when v_count >= coalesce(v_settings.max_off_per_day, 2) then 'waitlist'
        else 'registered'
      end;
    else
      v_needed := null;
      v_group := null;

      select q.needed, q.quota_group
      into v_needed, v_group
      from public.payroll_bn_shift_quotas q
      join public.payroll_bn_shift_types t on t.code = q.shift_code
      where q.shift_code = v_shift
        and t.active
        and (q.iso_dow = v_iso or q.iso_dow is null)
      order by q.iso_dow nulls last
      limit 1;

      if v_needed is null then
        v_state := 'waitlist';
      elsif v_group is null then
        select count(*)
        into v_count
        from public.payroll_bn_shift_entries en
        where en.week_start = v_week
          and en.work_date = v_date
          and en.state = 'registered'
          and en.shift_code = v_shift
          and en.employee_code <> v_employee;

        v_state := case when v_count >= v_needed then 'waitlist' else 'registered' end;
      else
        select count(distinct en.employee_code)
        into v_count
        from public.payroll_bn_shift_entries en
        join public.payroll_bn_shift_quotas q on q.shift_code = en.shift_code
        join public.payroll_bn_shift_types t on t.code = q.shift_code
        where en.week_start = v_week
          and en.work_date = v_date
          and en.state = 'registered'
          and en.shift_code is not null
          and en.employee_code <> v_employee
          and t.active
          and q.quota_group = v_group
          and (q.iso_dow = v_iso or q.iso_dow is null);

        select coalesce(max(q.needed), 0)
        into v_needed
        from public.payroll_bn_shift_quotas q
        join public.payroll_bn_shift_types t on t.code = q.shift_code
        where t.active
          and q.quota_group = v_group
          and (q.iso_dow = v_iso or q.iso_dow is null);

        v_state := case when v_count >= v_needed then 'waitlist' else 'registered' end;
      end if;
    end if;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'work_date', v_date,
      'shift_code', v_shift,
      'state', v_state
    ));
  end loop;

  insert into public.payroll_bn_shift_weeks(week_start, status)
  values (v_week, 'open')
  on conflict (week_start) do nothing;

  delete from public.payroll_bn_shift_entries
  where employee_code = v_employee
    and week_start = v_week;

  for v_elem in select value from jsonb_array_elements(v_result) loop
    insert into public.payroll_bn_shift_entries(
      week_start,
      employee_code,
      work_date,
      shift_code,
      state,
      source,
      previous_shift_code,
      updated_by
    ) values (
      v_week,
      v_employee,
      (v_elem->>'work_date')::date,
      nullif(btrim(coalesce(v_elem->>'shift_code', '')), ''),
      v_elem->>'state',
      'employee',
      null,
      v_uid
    );
  end loop;

  return public.get_payroll_bn_shift_week(v_employee, v_week);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Manager RPCs (owner or payroll.edit)
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

create or replace function public.set_payroll_bn_shift_entry(
  p_week_start date,
  p_employee_code text,
  p_work_date date,
  p_shift_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_week date := public.payroll_bn_shift_week_start(p_week_start);
  v_employee text := btrim(coalesce(p_employee_code, ''));
  v_shift text := nullif(btrim(coalesce(p_shift_code, '')), '');
  v_entry public.payroll_bn_shift_entries%rowtype;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_shift_forbidden' using errcode = '42501';
  end if;

  if v_week is null or p_work_date is null
     or p_work_date < v_week or p_work_date > v_week + 6 then
    raise exception 'payroll_shift_invalid_date' using errcode = '22023';
  end if;

  if v_employee = '' then
    raise exception 'shift_employee_required' using errcode = '22023';
  end if;

  if not public.payroll_bn_shift_eligible(v_employee, v_week) then
    raise exception 'shift_not_eligible' using errcode = '22023';
  end if;

  if v_shift is not null and not exists (
    select 1
    from public.payroll_bn_shift_types t
    where t.code = v_shift
      and t.active
  ) then
    raise exception 'shift_invalid_shift' using errcode = '22023';
  end if;

  insert into public.payroll_bn_shift_weeks(week_start, status)
  values (v_week, 'open')
  on conflict (week_start) do nothing;

  insert into public.payroll_bn_shift_entries as entry(
    week_start,
    employee_code,
    work_date,
    shift_code,
    state,
    source,
    previous_shift_code,
    updated_by
  ) values (
    v_week,
    v_employee,
    p_work_date,
    v_shift,
    'registered',
    'manager',
    null,
    v_uid
  )
  on conflict (employee_code, work_date) do update
  set week_start = excluded.week_start,
      shift_code = excluded.shift_code,
      state = 'registered',
      source = 'manager',
      previous_shift_code = case
        when entry.source = 'employee'
             and entry.shift_code is distinct from excluded.shift_code
          then entry.shift_code
        else entry.previous_shift_code
      end,
      updated_by = v_uid
  returning * into v_entry;

  return jsonb_build_object('entry', to_jsonb(v_entry));
end;
$$;

create or replace function public.publish_payroll_bn_shift_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_week date := public.payroll_bn_shift_week_start(p_week_start);
  v_week_row public.payroll_bn_shift_weeks%rowtype;
  v_closed_dates date[];
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_shift_forbidden' using errcode = '42501';
  end if;

  if v_week is null then
    raise exception 'payroll_shift_week_required' using errcode = '22023';
  end if;

  insert into public.payroll_bn_shift_weeks(week_start, status)
  values (v_week, 'open')
  on conflict (week_start) do nothing;

  select * into v_week_row
  from public.payroll_bn_shift_weeks
  where week_start = v_week
  for update;

  v_closed_dates := coalesce(v_week_row.closed_dates, '{}'::date[]);

  -- Carry the previous week's registered entries for eligible employees who
  -- still have no entry for this week. Nothing is auto-promoted: existing
  -- waitlist rows stay waitlist for the manager to resolve.
  insert into public.payroll_bn_shift_entries(
    week_start,
    employee_code,
    work_date,
    shift_code,
    state,
    source,
    previous_shift_code,
    updated_by
  )
  select
    v_week,
    prev.employee_code,
    prev.work_date + 7,
    prev.shift_code,
    'registered',
    'carried',
    null,
    v_uid
  from public.payroll_bn_shift_entries prev
  where prev.week_start = v_week - 7
    and prev.state = 'registered'
    and prev.work_date + 7 between v_week and v_week + 6
    and (prev.work_date + 7) <> all (v_closed_dates)
    and public.payroll_bn_shift_eligible(prev.employee_code, v_week)
    and not exists (
      select 1
      from public.payroll_bn_shift_entries current_entry
      where current_entry.employee_code = prev.employee_code
        and current_entry.week_start = v_week
    )
  on conflict (employee_code, work_date) do nothing;

  update public.payroll_bn_shift_weeks
  set status = 'published',
      published_at = now(),
      published_by = v_uid
  where week_start = v_week
  returning * into v_week_row;

  return jsonb_build_object('week', to_jsonb(v_week_row));
end;
$$;

create or replace function public.reopen_payroll_bn_shift_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_week date := public.payroll_bn_shift_week_start(p_week_start);
  v_week_row public.payroll_bn_shift_weeks%rowtype;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_shift_forbidden' using errcode = '42501';
  end if;

  if v_week is null then
    raise exception 'payroll_shift_week_required' using errcode = '22023';
  end if;

  insert into public.payroll_bn_shift_weeks(week_start, status)
  values (v_week, 'open')
  on conflict (week_start) do nothing;

  update public.payroll_bn_shift_weeks
  set status = 'open',
      published_at = null,
      published_by = null
  where week_start = v_week
  returning * into v_week_row;

  return jsonb_build_object('week', to_jsonb(v_week_row));
end;
$$;

create or replace function public.set_payroll_bn_shift_closed_dates(
  p_week_start date,
  p_dates date[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_week date := public.payroll_bn_shift_week_start(p_week_start);
  v_dates date[];
  v_week_row public.payroll_bn_shift_weeks%rowtype;
begin
  if not public.payroll_mission_admin_allowed(v_uid) then
    raise exception 'payroll_shift_forbidden' using errcode = '42501';
  end if;

  if v_week is null then
    raise exception 'payroll_shift_week_required' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct d order by d), '{}'::date[])
  into v_dates
  from unnest(coalesce(p_dates, '{}'::date[])) as d
  where d >= v_week
    and d <= v_week + 6;

  insert into public.payroll_bn_shift_weeks(week_start, status)
  values (v_week, 'open')
  on conflict (week_start) do nothing;

  update public.payroll_bn_shift_weeks
  set closed_dates = coalesce(v_dates, '{}'::date[])
  where week_start = v_week
  returning * into v_week_row;

  return jsonb_build_object('week', to_jsonb(v_week_row));
end;
$$;

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

    v_time_text := coalesce(nullif(btrim(coalesce(v_settings->>'deadline_time', '')), ''), to_char(v_settings_row.deadline_time, 'HH24:MI'));
    if v_time_text !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'payroll_shift_settings_invalid_deadline_time' using errcode = '22023';
    end if;
    v_deadline_time := v_time_text::time;

    v_max_off := coalesce((v_settings->>'max_off_per_day')::integer, v_settings_row.max_off_per_day);
    v_min_staff := coalesce((v_settings->>'min_staff_per_day')::integer, v_settings_row.min_staff_per_day);
    v_min_off := coalesce((v_settings->>'min_off_days_per_week')::integer, v_settings_row.min_off_days_per_week);
    if v_max_off < 0 or v_min_staff < 0 or v_min_off < 0 then
      raise exception 'payroll_shift_settings_negative_limit' using errcode = '22023';
    end if;

    update public.payroll_bn_shift_settings
    set eligible_groups = coalesce(v_groups, '{}'::text[]),
        open_iso_dow = v_open,
        deadline_iso_dow = v_deadline,
        deadline_time = v_deadline_time,
        max_off_per_day = v_max_off,
        min_staff_per_day = v_min_staff,
        min_off_days_per_week = v_min_off
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
-- 8) Punctual link: per-work-date cutoff from this employee's registered shift
--
-- Identical to 20261110150000 except the on-time test is per work date:
--   scheduled start_time of the date's registered shift (when any)
--   -> offer.shift_start -> employee shift start -> item params.cutoff -> 07:00
-- The reported detail.cutoff remains the fallback cutoff and scheduled_days
-- counts the checked-in days that used a schedule entry.
-- ---------------------------------------------------------------------------
create or replace function public.payroll_mission_progress(p_offer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_offer public.payroll_mission_offers%rowtype;
  v_campaign public.payroll_mission_campaigns%rowtype;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_from date;
  v_to date;
  v_days_with_in integer := 0;
  v_days_complete integer := 0;
  v_days_missing_out integer := 0;
  v_on_time integer := 0;
  v_scheduled_days integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_kind text;
  v_params jsonb;
  v_min_days integer;
  v_grace_minutes integer;
  v_cutoff time;
  v_cutoff_text text;
  v_met boolean;
begin
  select * into v_offer
  from public.payroll_mission_offers
  where id = p_offer_id;

  if v_offer.id is null then
    return '[]'::jsonb;
  end if;

  select * into v_campaign
  from public.payroll_mission_campaigns
  where id = v_offer.campaign_id;

  if v_campaign.id is null then
    return '[]'::jsonb;
  end if;

  -- A campaign can only count attendance from the day the employee accepted
  -- the offer, never before. The window also stops at today in Vietnam.
  v_from := greatest(
    v_campaign.starts_on,
    case
      when v_offer.status = 'accepted' and v_offer.responded_at is not null
        then (v_offer.responded_at at time zone 'Asia/Ho_Chi_Minh')::date
      else v_campaign.starts_on
    end
  );
  v_to := least(v_campaign.ends_on, v_today);

  if v_to >= v_from then
    with accepted_in as (
      select distinct on (e.work_date)
        e.work_date
      from public.payroll_bn_attendance_events e
      where e.employee_code = v_offer.employee_code
        and e.decision = 'accepted'
        and e.event_kind = 'in'
        and e.work_date between v_from and v_to
      order by e.work_date, e.server_received_at asc
    ), accepted_out as (
      select distinct e.work_date
      from public.payroll_bn_attendance_events e
      where e.employee_code = v_offer.employee_code
        and e.decision = 'accepted'
        and e.event_kind = 'out'
        and e.work_date between v_from and v_to
    )
    select
      count(*),
      count(*) filter (where o.work_date is not null),
      count(*) filter (where o.work_date is null)
    into v_days_with_in, v_days_complete, v_days_missing_out
    from accepted_in i
    left join accepted_out o using (work_date);
  end if;

  for v_item in select value from jsonb_array_elements(v_campaign.items) loop
    v_kind := v_item->>'kind';
    v_params := coalesce(v_item->'params', '{}'::jsonb);

    v_min_days := case
      when coalesce(v_params->>'min_days', '') ~ '^[0-9]+$'
        then (v_params->>'min_days')::integer
      else 1
    end;

    v_grace_minutes := case
      when coalesce(v_params->>'grace_minutes', '') ~ '^[0-9]+$'
        then (v_params->>'grace_minutes')::integer
      else 0
    end;

    if v_offer.shift_start is not null then
      v_cutoff := v_offer.shift_start;
    else
      select s.shift_start
      into v_cutoff
      from public.payroll_bn_employee_shifts s
      where s.employee_code = v_offer.employee_code;

      if v_cutoff is null then
        v_cutoff_text := nullif(btrim(coalesce(v_params->>'cutoff', '')), '');
        if v_cutoff_text is null then
          v_cutoff := time '07:00';
        elsif v_cutoff_text ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
          v_cutoff := v_cutoff_text::time;
        else
          v_cutoff := time '07:00';
        end if;
      end if;
    end if;

    v_on_time := 0;
    v_scheduled_days := 0;
    if v_to >= v_from then
      select
        count(*) filter (
          where d.local_in_time <= coalesce(scheduled.start_time, v_cutoff)
            + make_interval(mins => v_grace_minutes)
        ),
        count(*) filter (where scheduled.start_time is not null)
      into v_on_time, v_scheduled_days
      from (
        select distinct on (e.work_date)
          e.work_date,
          (e.server_received_at at time zone 'Asia/Ho_Chi_Minh')::time as local_in_time
        from public.payroll_bn_attendance_events e
        where e.employee_code = v_offer.employee_code
          and e.decision = 'accepted'
          and e.event_kind = 'in'
          and e.work_date between v_from and v_to
        order by e.work_date, e.server_received_at asc
      ) d
      left join lateral (
        select st.start_time
        from public.payroll_bn_shift_entries en
        join public.payroll_bn_shift_types st on st.code = en.shift_code
        where en.employee_code = v_offer.employee_code
          and en.work_date = d.work_date
          and en.shift_code is not null
          and en.state = 'registered'
        limit 1
      ) scheduled on true;
    end if;

    if v_kind = 'attendance_regular' then
      v_met := v_days_with_in >= v_min_days and v_days_missing_out = 0;
    elsif v_kind = 'punctual' then
      v_met := v_days_with_in >= 1 and v_on_time = v_days_with_in;
    else
      v_met := false;
    end if;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'key', v_item->>'key',
      'kind', v_kind,
      'met', v_met,
      'detail', jsonb_build_object(
        'days_with_in', v_days_with_in,
        'days_complete', v_days_complete,
        'days_missing_out', v_days_missing_out,
        'on_time_days', v_on_time,
        'scheduled_days', v_scheduled_days,
        'min_days', v_min_days,
        'grace_minutes', v_grace_minutes,
        'cutoff', to_char(v_cutoff, 'HH24:MI'),
        'window_from', v_from,
        'window_to', v_to
      )
    ));
  end loop;

  return v_items;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9) Grants: no browser table access; RPC-only access
-- ---------------------------------------------------------------------------
revoke all on function public.payroll_mission_progress(uuid)
  from public, anon, authenticated;
grant execute on function public.payroll_mission_progress(uuid)
  to service_role;

alter table public.payroll_bn_shift_types enable row level security;
alter table public.payroll_bn_shift_quotas enable row level security;
alter table public.payroll_bn_shift_settings enable row level security;
alter table public.payroll_bn_shift_weeks enable row level security;
alter table public.payroll_bn_shift_entries enable row level security;
alter table public.payroll_bn_shift_events enable row level security;

revoke all on table public.payroll_bn_shift_types from public, anon, authenticated;
revoke all on table public.payroll_bn_shift_quotas from public, anon, authenticated;
revoke all on table public.payroll_bn_shift_settings from public, anon, authenticated;
revoke all on table public.payroll_bn_shift_weeks from public, anon, authenticated;
revoke all on table public.payroll_bn_shift_entries from public, anon, authenticated;
revoke all on table public.payroll_bn_shift_events from public, anon, authenticated;

grant all on table public.payroll_bn_shift_types to service_role;
grant all on table public.payroll_bn_shift_quotas to service_role;
grant all on table public.payroll_bn_shift_settings to service_role;
grant all on table public.payroll_bn_shift_weeks to service_role;
grant all on table public.payroll_bn_shift_entries to service_role;
grant all on table public.payroll_bn_shift_events to service_role;

revoke all on function public.reject_payroll_bn_shift_event_mutation()
  from public, anon, authenticated;
revoke all on function public.audit_payroll_bn_shift_change()
  from public, anon, authenticated;

revoke all on function public.payroll_bn_shift_week_start(date)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_shift_week_start(date)
  to service_role;

revoke all on function public.payroll_bn_shift_opens_at(date)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_shift_opens_at(date)
  to service_role;

revoke all on function public.payroll_bn_shift_deadline(date)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_shift_deadline(date)
  to service_role;

revoke all on function public.payroll_bn_shift_eligible(text, date)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_shift_eligible(text, date)
  to service_role;

revoke all on function public.payroll_bn_shift_coverage(date)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_shift_coverage(date)
  to service_role;

-- Employee RPCs: service_role only.
revoke all on function public.get_payroll_bn_shift_week(text, date)
  from public, anon, authenticated;
grant execute on function public.get_payroll_bn_shift_week(text, date)
  to service_role;

revoke all on function public.submit_payroll_bn_shift_registration(text, date, jsonb)
  from public, anon, authenticated;
grant execute on function public.submit_payroll_bn_shift_registration(text, date, jsonb)
  to service_role;

-- Manager RPCs: authenticated (owner/payroll.edit inside) + service_role.
revoke all on function public.get_payroll_bn_shift_board(date)
  from public, anon, authenticated;
grant execute on function public.get_payroll_bn_shift_board(date)
  to authenticated, service_role;

revoke all on function public.set_payroll_bn_shift_entry(date, text, date, text)
  from public, anon, authenticated;
grant execute on function public.set_payroll_bn_shift_entry(date, text, date, text)
  to authenticated, service_role;

revoke all on function public.publish_payroll_bn_shift_week(date)
  from public, anon, authenticated;
grant execute on function public.publish_payroll_bn_shift_week(date)
  to authenticated, service_role;

revoke all on function public.reopen_payroll_bn_shift_week(date)
  from public, anon, authenticated;
grant execute on function public.reopen_payroll_bn_shift_week(date)
  to authenticated, service_role;

revoke all on function public.set_payroll_bn_shift_closed_dates(date, date[])
  from public, anon, authenticated;
grant execute on function public.set_payroll_bn_shift_closed_dates(date, date[])
  to authenticated, service_role;

revoke all on function public.upsert_payroll_bn_shift_config(jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_payroll_bn_shift_config(jsonb)
  to authenticated, service_role;

comment on function public.get_payroll_bn_shift_week(text, date) is
  'Employee week payload: own entry only, active shift types, coverage, previous-week suggestion and this week read-only. service_role only.';
comment on function public.submit_payroll_bn_shift_registration(text, date, jsonb) is
  'Replaces one employee''s week choices. Advisory-locked per week; closed dates ignored; full shifts/off days stored as waitlist. service_role only.';
comment on function public.get_payroll_bn_shift_board(date) is
  'Manager week board: settings/types/quotas, eligible employees, coverage, warnings and carried suggestions.';
comment on function public.publish_payroll_bn_shift_week(date) is
  'Publishes a week and stores previous-week suggestions for still-unregistered employees as source carried. Never promotes waitlist rows.';
comment on function public.payroll_mission_progress(uuid) is
  'Provisional per-item mission progress from payroll_bn_attendance_events, starting at the accepted date. Punctual cutoff per work date: registered shift start, else offer shift_start, employee shift start, item params.cutoff, 07:00. The manager review is final.';
