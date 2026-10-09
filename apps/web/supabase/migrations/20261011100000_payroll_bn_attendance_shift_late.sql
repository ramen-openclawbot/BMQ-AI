-- ============================================================================
-- Migration: Bếp BN attendance machine columns Ca / Trễ / Sớm (2026-10-11)
--
-- The mission module needs the machine's shift (Ca) and the lateness/early
-- minutes (Trễ / Sớm) that the payroll engine deliberately ignores. This
-- migration only stores them; R1–R9 never read these columns.
--
--   * add payroll_bn_attendance_rows.shift / late_minutes / early_minutes
--     (all nullable: an old upload or a workbook without the columns stays null)
--   * create or replace payroll_bn_import_attendance(...) with the exact same
--     signature, privileges and behaviour, plus storing the three columns
--
-- This migration has NOT been applied to production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Nullable machine columns. Missing column / empty cell → null.
-- ---------------------------------------------------------------------------
alter table public.payroll_bn_attendance_rows
  add column if not exists shift text,
  add column if not exists late_minutes integer,
  add column if not exists early_minutes integer;

comment on column public.payroll_bn_attendance_rows.shift
  is 'Ca máy: HC hoặc V; null khi file không có cột hoặc ô trống. Không dùng cho R1–R9.';
comment on column public.payroll_bn_attendance_rows.late_minutes
  is 'Số phút đi trễ (Trễ); null khi thiếu cột/ô. Không dùng cho R1–R9.';
comment on column public.payroll_bn_attendance_rows.early_minutes
  is 'Số phút về sớm (Sớm); null khi thiếu cột/ô. Không dùng cho R1–R9.';

-- ---------------------------------------------------------------------------
-- 2) Attendance import — identical behaviour, now storing the three columns.
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
    import_id, period_id, employee_code, employee_name, work_date,
    check_in, check_out, department, shift, late_minutes, early_minutes
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
    case when value->>'shift' in ('HC', 'V') then value->>'shift' else null end,
    case
      when nullif(value->>'late_minutes', '') is null then null
      else greatest(0, (value->>'late_minutes')::numeric)::integer
    end,
    case
      when nullif(value->>'early_minutes', '') is null then null
      else greatest(0, (value->>'early_minutes')::numeric)::integer
    end
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
  is 'Idempotent Bếp BN attendance import (unique per period + sha256). Server-side period/lock/date checks; a new import clears any attendance approval. Stores Ca/Trễ/Sớm (nullable) without changing R1–R9.';

-- ---------------------------------------------------------------------------
-- 3) Grants — same as before (create or replace keeps them, but be explicit).
-- ---------------------------------------------------------------------------
revoke all on function public.payroll_bn_import_attendance(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_import_attendance(uuid, text, text, jsonb)
  to authenticated;
