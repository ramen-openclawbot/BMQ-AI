-- ============================================================================
-- Migration: Bếp BN issue reviews + attendance approval (GĐ2, phần không UI)
--
-- Extends 20261008120000_payroll_bn_periods.sql with:
--   * payroll_bn_issue_reviews — one decision per (period, employee, day, issue)
--   * payroll_bn_periods.attendance_approved_at / attendance_approved_by
--   * payroll_bn_set_attendance_approved(...) — approve / clear attendance
--   * create or replace payroll_bn_import_attendance(...) — a new import clears
--     any attendance approval of the period
--
-- This migration has NOT been applied to production. It only adds to the
-- Bếp BN tables created by 20261008120000.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) payroll_bn_issue_reviews — what a human decided about one anomaly
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_issue_reviews (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.payroll_bn_periods(id) on delete cascade,
  employee_code text not null,
  work_date date not null,
  issue_code text not null,
  decision text not null,
  note text,
  actor uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_bn_issue_reviews_decision_check check (decision in ('accepted', 'excluded')),
  -- An excluded row must say why it was dropped.
  constraint payroll_bn_issue_reviews_note_check check (
    decision <> 'excluded' or (note is not null and btrim(note) <> '')
  ),
  constraint payroll_bn_issue_reviews_unique unique (period_id, employee_code, work_date, issue_code)
);

create index if not exists idx_payroll_bn_issue_reviews_period
  on public.payroll_bn_issue_reviews(period_id, employee_code);

drop trigger if exists set_updated_at_payroll_bn_issue_reviews on public.payroll_bn_issue_reviews;
create trigger set_updated_at_payroll_bn_issue_reviews
  before update on public.payroll_bn_issue_reviews
  for each row execute function public.handle_updated_at();

-- A locked period is read-only for reviews too.
drop trigger if exists payroll_bn_guard_locked_period_issue_reviews on public.payroll_bn_issue_reviews;
create trigger payroll_bn_guard_locked_period_issue_reviews
  before insert or update or delete on public.payroll_bn_issue_reviews
  for each row execute function public.payroll_bn_guard_locked_period();

-- ---------------------------------------------------------------------------
-- 2) payroll_bn_periods — attendance approval columns
-- ---------------------------------------------------------------------------
alter table public.payroll_bn_periods
  add column if not exists attendance_approved_at timestamptz,
  add column if not exists attendance_approved_by uuid;

-- ---------------------------------------------------------------------------
-- 3) RLS — read needs payroll view, write needs payroll edit
-- ---------------------------------------------------------------------------
alter table public.payroll_bn_issue_reviews enable row level security;

drop policy if exists payroll_bn_issue_reviews_select on public.payroll_bn_issue_reviews;
create policy payroll_bn_issue_reviews_select on public.payroll_bn_issue_reviews
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

drop policy if exists payroll_bn_issue_reviews_insert on public.payroll_bn_issue_reviews;
create policy payroll_bn_issue_reviews_insert on public.payroll_bn_issue_reviews
  for insert to authenticated
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_issue_reviews_update on public.payroll_bn_issue_reviews;
create policy payroll_bn_issue_reviews_update on public.payroll_bn_issue_reviews
  for update to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

drop policy if exists payroll_bn_issue_reviews_delete on public.payroll_bn_issue_reviews;
create policy payroll_bn_issue_reviews_delete on public.payroll_bn_issue_reviews
  for delete to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

-- ---------------------------------------------------------------------------
-- 4) RPC — approve / clear the attendance of a period (payroll edit or owner)
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_set_attendance_approved(
  _period_id uuid,
  _approved boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_period public.payroll_bn_periods%rowtype;
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

  if _approved then
    update public.payroll_bn_periods
       set attendance_approved_at = now(),
           attendance_approved_by = v_uid
     where id = _period_id;
  else
    update public.payroll_bn_periods
       set attendance_approved_at = null,
           attendance_approved_by = null
     where id = _period_id;
  end if;
end;
$$;

comment on function public.payroll_bn_set_attendance_approved(uuid, boolean)
  is 'Approve or clear the attendance of a Bếp BN period. Payroll edit or owner; a locked period is rejected.';

-- ---------------------------------------------------------------------------
-- 5) Attendance import — identical behaviour, plus clearing the approval
--    whenever a genuinely new file is inserted.
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

  -- A new import invalidates any earlier attendance approval.
  update public.payroll_bn_periods
     set attendance_approved_at = null,
         attendance_approved_by = null
   where id = _period_id;

  return query select v_import_id, v_inserted, false;
end;
$$;

comment on function public.payroll_bn_import_attendance(uuid, text, text, jsonb)
  is 'Idempotent Bếp BN attendance import (unique per period + sha256). Server-side period/lock/date checks; a new import clears any attendance approval.';

-- ---------------------------------------------------------------------------
-- 6) Grants — explicit, because this project has no default grants.
--    actor stays non-settable: insert/update are column-limited.
-- ---------------------------------------------------------------------------
revoke all on public.payroll_bn_issue_reviews from public, anon, authenticated;
grant select, delete on public.payroll_bn_issue_reviews to authenticated;
grant insert (period_id, employee_code, work_date, issue_code, decision, note)
  on public.payroll_bn_issue_reviews to authenticated;
grant update (period_id, employee_code, work_date, issue_code, decision, note)
  on public.payroll_bn_issue_reviews to authenticated;
grant all on public.payroll_bn_issue_reviews to service_role;

revoke all on function public.payroll_bn_set_attendance_approved(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_set_attendance_approved(uuid, boolean)
  to authenticated;
