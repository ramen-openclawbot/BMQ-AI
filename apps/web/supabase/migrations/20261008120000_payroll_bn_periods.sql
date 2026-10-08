-- ============================================================================
-- Migration: Bếp BN payroll periods (GĐ1, phần không giao diện)
--
-- Adds a self-contained period model for the Bếp BN payroll:
--   * payroll_bn_periods              — tham số kỳ (NC chuẩn theo nhóm, ngày lễ,
--                                       cấu hình quy tắc, trạng thái draft/locked)
--   * payroll_bn_period_employees     — danh mục nhân viên theo kỳ
--   * payroll_bn_attendance_imports   — file chấm công đã nhập, dedupe theo sha256
--   * payroll_bn_attendance_rows      — dữ liệu chấm công đã chuẩn hoá
--   * payroll_bn_adjustments          — nhật ký điều chỉnh (actor, cũ/mới, lý do)
--
-- This migration does NOT touch payroll_runs / payroll_lines / attendance_*.
-- It has not been applied to production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) payroll_bn_periods — per-period parameters and lock state
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_periods (
  id uuid primary key default gen_random_uuid(),
  period_code text not null unique,
  period_name text not null,
  date_from date not null,
  date_to date not null,
  default_standard_days numeric(6,2) not null default 26,
  standard_days_by_group jsonb not null default '{}'::jsonb,
  holidays jsonb not null default '[]'::jsonb,
  rules_config jsonb not null default '{}'::jsonb,
  status text not null default 'draft',
  locked_at timestamptz,
  locked_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_bn_periods_status_check check (status in ('draft', 'locked')),
  constraint payroll_bn_periods_range_check check (date_to >= date_from),
  constraint payroll_bn_periods_standard_days_check check (default_standard_days >= 0),
  constraint payroll_bn_periods_groups_object_check check (jsonb_typeof(standard_days_by_group) = 'object'),
  constraint payroll_bn_periods_holidays_array_check check (jsonb_typeof(holidays) = 'array'),
  constraint payroll_bn_periods_rules_object_check check (jsonb_typeof(rules_config) = 'object')
);

create index if not exists idx_payroll_bn_periods_status
  on public.payroll_bn_periods(status, date_from);

-- ---------------------------------------------------------------------------
-- 2) payroll_bn_period_employees — employee catalogue for the period
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_period_employees (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.payroll_bn_periods(id) on delete cascade,
  employee_code text not null,
  employee_name text not null,
  group_name text,
  employment_type text not null,
  monthly_salary numeric(15,2),
  daily_rate numeric(15,2),
  hourly_rate numeric(15,2),
  overtime_rate numeric(15,2),
  allowance numeric(15,2),
  standard_days_override numeric(6,2),
  start_date date,
  end_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_bn_period_employees_type_check
    check (employment_type in ('official', 'part_time')),
  constraint payroll_bn_period_employees_group_check
    check (group_name in ('Văn phòng', 'Bếp bánh', 'Kho BN')),
  constraint payroll_bn_period_employees_unique unique (period_id, employee_code)
);

create index if not exists idx_payroll_bn_period_employees_period
  on public.payroll_bn_period_employees(period_id);

-- ---------------------------------------------------------------------------
-- 3) payroll_bn_attendance_imports — one row per distinct file per period
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_attendance_imports (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.payroll_bn_periods(id) on delete cascade,
  file_name text not null,
  sha256 text not null,
  row_count integer not null default 0,
  imported_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz not null default now(),
  constraint payroll_bn_attendance_imports_sha256_check check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint payroll_bn_attendance_imports_unique unique (period_id, sha256)
);

create index if not exists idx_payroll_bn_attendance_imports_period
  on public.payroll_bn_attendance_imports(period_id);

-- ---------------------------------------------------------------------------
-- 4) payroll_bn_attendance_rows — normalised machine rows
--    (max one row per employee per day per period; no machine-computed totals)
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_attendance_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.payroll_bn_attendance_imports(id) on delete cascade,
  period_id uuid not null references public.payroll_bn_periods(id) on delete cascade,
  employee_code text not null,
  employee_name text,
  work_date date not null,
  check_in time,
  check_out time,
  department text,
  created_at timestamptz not null default now(),
  constraint payroll_bn_attendance_rows_unique unique (period_id, employee_code, work_date)
);

create index if not exists idx_payroll_bn_attendance_rows_period
  on public.payroll_bn_attendance_rows(period_id, employee_code);
create index if not exists idx_payroll_bn_attendance_rows_import
  on public.payroll_bn_attendance_rows(import_id);

-- ---------------------------------------------------------------------------
-- 5) payroll_bn_adjustments — append-only audit log of manual corrections
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_adjustments (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.payroll_bn_periods(id) on delete cascade,
  employee_code text not null,
  field text not null,
  old_value jsonb,
  new_value jsonb,
  reason text not null,
  actor uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint payroll_bn_adjustments_field_check
    check (field in (
      'work_days',
      'paid_work_days',
      'part_time_hours',
      'overtime_hours',
      'exclude_overtime',
      'exclude_holiday',
      'net_pay'
    )),
  constraint payroll_bn_adjustments_reason_check check (btrim(reason) <> '')
);

create index if not exists idx_payroll_bn_adjustments_period
  on public.payroll_bn_adjustments(period_id, employee_code);

-- ---------------------------------------------------------------------------
-- 6) updated_at triggers
-- ---------------------------------------------------------------------------
drop trigger if exists set_updated_at_payroll_bn_periods on public.payroll_bn_periods;
create trigger set_updated_at_payroll_bn_periods
  before update on public.payroll_bn_periods
  for each row execute function public.handle_updated_at();

drop trigger if exists set_updated_at_payroll_bn_period_employees on public.payroll_bn_period_employees;
create trigger set_updated_at_payroll_bn_period_employees
  before update on public.payroll_bn_period_employees
  for each row execute function public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- 7) Lock guard — a locked period is read-only, and only an owner can lock it
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_period_is_locked(_period_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.payroll_bn_periods p
    where p.id = _period_id
      and p.status = 'locked'
  );
$$;

-- Blocks INSERT/UPDATE/DELETE on any child table once its period is locked.
create or replace function public.payroll_bn_guard_locked_period()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_id uuid;
begin
  if tg_op = 'DELETE' then
    v_period_id := old.period_id;
  else
    v_period_id := new.period_id;
  end if;

  if v_period_id is not null and public.payroll_bn_period_is_locked(v_period_id) then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists payroll_bn_guard_locked_period_employees on public.payroll_bn_period_employees;
create trigger payroll_bn_guard_locked_period_employees
  before insert or update or delete on public.payroll_bn_period_employees
  for each row execute function public.payroll_bn_guard_locked_period();

drop trigger if exists payroll_bn_guard_locked_period_imports on public.payroll_bn_attendance_imports;
create trigger payroll_bn_guard_locked_period_imports
  before insert or update or delete on public.payroll_bn_attendance_imports
  for each row execute function public.payroll_bn_guard_locked_period();

drop trigger if exists payroll_bn_guard_locked_period_rows on public.payroll_bn_attendance_rows;
create trigger payroll_bn_guard_locked_period_rows
  before insert or update or delete on public.payroll_bn_attendance_rows
  for each row execute function public.payroll_bn_guard_locked_period();

drop trigger if exists payroll_bn_guard_locked_period_adjustments on public.payroll_bn_adjustments;
create trigger payroll_bn_guard_locked_period_adjustments
  before insert or update or delete on public.payroll_bn_adjustments
  for each row execute function public.payroll_bn_guard_locked_period();

-- On the period row itself: a locked period is immutable and can never go back
-- to draft (no unlock path), and only an owner may lock it.
create or replace function public.payroll_bn_guard_period_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_privileged boolean;
begin
  v_privileged := public.has_role(auth.uid(), 'owner') or auth.role() = 'service_role';

  if tg_op = 'DELETE' then
    if old.status = 'locked' then
      raise exception 'payroll_bn_period_locked' using errcode = '55006';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'locked' and not v_privileged then
      raise exception 'payroll_bn_lock_owner_only' using errcode = '42501';
    end if;
    return new;
  end if;

  -- Unlocking is disabled for everyone, including owners.
  if old.status = 'locked' and new.status = 'draft' then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;

  if new.status is distinct from old.status then
    if not v_privileged then
      raise exception 'payroll_bn_lock_owner_only' using errcode = '42501';
    end if;
    if new.status = 'locked' then
      new.locked_at := now();
      new.locked_by := auth.uid();
    end if;
  elsif old.status = 'locked' then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;

  return new;
end;
$$;

drop trigger if exists payroll_bn_guard_period_lock on public.payroll_bn_periods;
create trigger payroll_bn_guard_period_lock
  before insert or update or delete on public.payroll_bn_periods
  for each row execute function public.payroll_bn_guard_period_lock();

-- ---------------------------------------------------------------------------
-- 8) RLS — read needs payroll view, write needs payroll edit, lock needs owner
-- ---------------------------------------------------------------------------
alter table public.payroll_bn_periods enable row level security;
alter table public.payroll_bn_period_employees enable row level security;
alter table public.payroll_bn_attendance_imports enable row level security;
alter table public.payroll_bn_attendance_rows enable row level security;
alter table public.payroll_bn_adjustments enable row level security;

-- periods
drop policy if exists payroll_bn_periods_select on public.payroll_bn_periods;
create policy payroll_bn_periods_select on public.payroll_bn_periods
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

drop policy if exists payroll_bn_periods_insert on public.payroll_bn_periods;
create policy payroll_bn_periods_insert on public.payroll_bn_periods
  for insert to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_periods_update on public.payroll_bn_periods;
create policy payroll_bn_periods_update on public.payroll_bn_periods
  for update to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_periods_delete on public.payroll_bn_periods;
create policy payroll_bn_periods_delete on public.payroll_bn_periods
  for delete to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

-- period employees
drop policy if exists payroll_bn_period_employees_select on public.payroll_bn_period_employees;
create policy payroll_bn_period_employees_select on public.payroll_bn_period_employees
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

drop policy if exists payroll_bn_period_employees_insert on public.payroll_bn_period_employees;
create policy payroll_bn_period_employees_insert on public.payroll_bn_period_employees
  for insert to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_period_employees_update on public.payroll_bn_period_employees;
create policy payroll_bn_period_employees_update on public.payroll_bn_period_employees
  for update to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_period_employees_delete on public.payroll_bn_period_employees;
create policy payroll_bn_period_employees_delete on public.payroll_bn_period_employees
  for delete to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

-- attendance imports
drop policy if exists payroll_bn_attendance_imports_select on public.payroll_bn_attendance_imports;
create policy payroll_bn_attendance_imports_select on public.payroll_bn_attendance_imports
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

drop policy if exists payroll_bn_attendance_imports_insert on public.payroll_bn_attendance_imports;
create policy payroll_bn_attendance_imports_insert on public.payroll_bn_attendance_imports
  for insert to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_attendance_imports_update on public.payroll_bn_attendance_imports;
create policy payroll_bn_attendance_imports_update on public.payroll_bn_attendance_imports
  for update to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_attendance_imports_delete on public.payroll_bn_attendance_imports;
create policy payroll_bn_attendance_imports_delete on public.payroll_bn_attendance_imports
  for delete to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

-- attendance rows
drop policy if exists payroll_bn_attendance_rows_select on public.payroll_bn_attendance_rows;
create policy payroll_bn_attendance_rows_select on public.payroll_bn_attendance_rows
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

drop policy if exists payroll_bn_attendance_rows_insert on public.payroll_bn_attendance_rows;
create policy payroll_bn_attendance_rows_insert on public.payroll_bn_attendance_rows
  for insert to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_attendance_rows_update on public.payroll_bn_attendance_rows;
create policy payroll_bn_attendance_rows_update on public.payroll_bn_attendance_rows
  for update to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_attendance_rows_delete on public.payroll_bn_attendance_rows;
create policy payroll_bn_attendance_rows_delete on public.payroll_bn_attendance_rows
  for delete to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

-- adjustments
drop policy if exists payroll_bn_adjustments_select on public.payroll_bn_adjustments;
create policy payroll_bn_adjustments_select on public.payroll_bn_adjustments
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

drop policy if exists payroll_bn_adjustments_insert on public.payroll_bn_adjustments;
create policy payroll_bn_adjustments_insert on public.payroll_bn_adjustments
  for insert to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_adjustments_update on public.payroll_bn_adjustments;
create policy payroll_bn_adjustments_update on public.payroll_bn_adjustments
  for update to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_adjustments_delete on public.payroll_bn_adjustments;
create policy payroll_bn_adjustments_delete on public.payroll_bn_adjustments
  for delete to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

-- ---------------------------------------------------------------------------
-- 9) RPC — idempotent attendance import with server-side period checks
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_import_attendance(
  _period_id uuid,
  _file_name text,
  _sha256 text,
  _rows jsonb
)
returns table(import_id uuid, inserted_rows integer, already_imported boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_period public.payroll_bn_periods%rowtype;
  v_import_id uuid;
  v_inserted integer := 0;
begin
  if not (
    public.has_role(v_uid, 'owner')
    or public.has_module_permission(v_uid, 'payroll', 'edit')
  ) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  select * into v_period from public.payroll_bn_periods where id = _period_id;
  if v_period.id is null then
    raise exception 'payroll_bn_period_not_found' using errcode = 'P0002';
  end if;
  if v_period.status = 'locked' then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;
  if _sha256 is null or _sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'payroll_bn_invalid_sha256' using errcode = '22023';
  end if;
  if _rows is null or jsonb_typeof(_rows) <> 'array' then
    raise exception 'payroll_bn_invalid_rows' using errcode = '22023';
  end if;

  -- Required keys and server-side period range check.
  if exists (
    select 1
    from jsonb_array_elements(_rows) as r(value)
    where nullif(value->>'employee_code', '') is null
       or nullif(value->>'work_date', '') is null
       or (value->>'work_date')::date < v_period.date_from
       or (value->>'work_date')::date > v_period.date_to
  ) then
    raise exception 'payroll_bn_date_out_of_period_or_missing_key' using errcode = '22023';
  end if;

  -- At most one row per employee per day inside the payload.
  if exists (
    select 1
    from (
      select value->>'employee_code' as employee_code,
             (value->>'work_date')::date as work_date
      from jsonb_array_elements(_rows) as r(value)
      group by 1, 2
      having count(*) > 1
    ) duplicates
  ) then
    raise exception 'payroll_bn_duplicate_employee_day' using errcode = '23505';
  end if;

  insert into public.payroll_bn_attendance_imports(period_id, file_name, sha256, row_count, imported_by)
  values (_period_id, _file_name, _sha256, jsonb_array_length(_rows), v_uid)
  on conflict (period_id, sha256) do nothing
  returning id into v_import_id;

  if v_import_id is null then
    select id into v_import_id
    from public.payroll_bn_attendance_imports
    where period_id = _period_id and sha256 = _sha256;
    return query select v_import_id, 0, true;
    return;
  end if;

  insert into public.payroll_bn_attendance_rows(
    import_id, period_id, employee_code, employee_name, work_date, check_in, check_out, department
  )
  select
    v_import_id,
    _period_id,
    value->>'employee_code',
    nullif(value->>'employee_name', ''),
    (value->>'work_date')::date,
    nullif(value->>'check_in', '')::time,
    nullif(value->>'check_out', '')::time,
    nullif(value->>'department', '')
  from jsonb_array_elements(_rows) as r(value);

  get diagnostics v_inserted = row_count;
  return query select v_import_id, v_inserted, false;
end;
$$;

comment on function public.payroll_bn_import_attendance(uuid, text, text, jsonb)
  is 'Idempotent Bếp BN attendance import (unique per period + sha256). Server-side period/lock/date checks; no machine-computed totals are stored.';

-- ---------------------------------------------------------------------------
-- 10) RPC — lock a period (owner only; unlocking is not supported)
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_set_period_locked(_period_id uuid)
returns public.payroll_bn_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_period public.payroll_bn_periods%rowtype;
begin
  if not (public.has_role(v_uid, 'owner') or auth.role() = 'service_role') then
    raise exception 'insufficient_privilege: owner required' using errcode = '42501';
  end if;

  select * into v_period from public.payroll_bn_periods where id = _period_id;
  if v_period.id is null then
    raise exception 'payroll_bn_period_not_found' using errcode = 'P0002';
  end if;
  if v_period.status = 'locked' then
    return v_period; -- idempotent, and the trigger forbids unlocking anyway
  end if;

  update public.payroll_bn_periods
     set status = 'locked'
   where id = _period_id
  returning * into v_period;

  return v_period;
end;
$$;

comment on function public.payroll_bn_set_period_locked(uuid)
  is 'Lock a Bếp BN payroll period. Owner only; there is no unlock path and locking makes the period read-only via trigger.';

-- ---------------------------------------------------------------------------
-- 11) Grants — keep internal guard functions private
-- ---------------------------------------------------------------------------
revoke all on function public.payroll_bn_period_is_locked(uuid) from public, anon, authenticated;
revoke all on function public.payroll_bn_guard_locked_period() from public, anon, authenticated;
revoke all on function public.payroll_bn_guard_period_lock() from public, anon, authenticated;

revoke all on function public.payroll_bn_import_attendance(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.payroll_bn_import_attendance(uuid, text, text, jsonb) to authenticated;

revoke all on function public.payroll_bn_set_period_locked(uuid) from public, anon, authenticated;
grant execute on function public.payroll_bn_set_period_locked(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 12) Table privileges — this project does not grant new tables by default.
--     RLS above still decides which rows a role may touch.
--     Attendance is written only through payroll_bn_import_attendance, and the
--     adjustment log is append-only with the actor taken from auth.uid().
-- ---------------------------------------------------------------------------
revoke all on public.payroll_bn_periods from public, anon, authenticated;
revoke all on public.payroll_bn_period_employees from public, anon, authenticated;
revoke all on public.payroll_bn_attendance_imports from public, anon, authenticated;
revoke all on public.payroll_bn_attendance_rows from public, anon, authenticated;
revoke all on public.payroll_bn_adjustments from public, anon, authenticated;

grant select, insert, update, delete on public.payroll_bn_periods to authenticated;
grant select, insert, update, delete on public.payroll_bn_period_employees to authenticated;
grant select on public.payroll_bn_attendance_imports to authenticated;
grant select on public.payroll_bn_attendance_rows to authenticated;
grant select on public.payroll_bn_adjustments to authenticated;
grant insert (period_id, employee_code, field, old_value, new_value, reason)
  on public.payroll_bn_adjustments to authenticated;

grant all on public.payroll_bn_periods to service_role;
grant all on public.payroll_bn_period_employees to service_role;
grant all on public.payroll_bn_attendance_imports to service_role;
grant all on public.payroll_bn_attendance_rows to service_role;
grant all on public.payroll_bn_adjustments to service_role;
