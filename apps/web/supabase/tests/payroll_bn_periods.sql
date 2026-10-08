-- ============================================================================
-- Rollback-only checks for migration 20261008120000_payroll_bn_periods.sql
--
-- Run against a local or shadow database that already has that migration
-- applied (plus the base schema: auth.users, public.user_roles,
-- public.user_module_permissions, public.has_role, public.has_module_permission,
-- public.handle_updated_at):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f apps/web/supabase/tests/payroll_bn_periods.sql
--
-- Everything runs inside BEGIN .. ROLLBACK, so no test data is persisted.
-- The script needs superuser rights for SET session_replication_role, which is
-- only used to seed fixtures without firing the guard triggers.
--
-- Trạng thái môi trường hiện tại: KHÔNG có Postgres local/shadow đang chạy, nên
-- file này CHƯA được thực thi. Khi có DB, chạy đúng lệnh psql ở trên.
-- ============================================================================

begin;

-- Verify the migration objects exist before testing behaviour.
do $$
begin
  if to_regclass('public.payroll_bn_periods') is null
     or to_regclass('public.payroll_bn_period_employees') is null
     or to_regclass('public.payroll_bn_attendance_imports') is null
     or to_regclass('public.payroll_bn_attendance_rows') is null
     or to_regclass('public.payroll_bn_adjustments') is null then
    raise exception 'TEST FAILED: migration objects are not present';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Seed: one locked period, one draft period, plus permission rows for an
-- owner, an editor and a viewer.
-- ---------------------------------------------------------------------------
set local session_replication_role = replica;

insert into public.payroll_bn_periods
  (id, period_code, period_name, date_from, date_to, status, locked_at)
values
  ('11111111-1111-1111-1111-111111111111', 'T08.2026', 'Kỳ đã khoá', '2026-08-01', '2026-08-31', 'locked', now()),
  ('22222222-2222-2222-2222-222222222222', 'T09.2026', 'Kỳ đang mở', '2026-09-01', '2026-09-30', 'draft', null);

insert into public.payroll_bn_period_employees
  (period_id, employee_code, employee_name, group_name, employment_type)
values
  ('11111111-1111-1111-1111-111111111111', 'E1', 'NV 1', 'Bếp bánh', 'official'),
  ('22222222-2222-2222-2222-222222222222', 'E2', 'NV 2', 'Kho BN', 'official');

insert into public.user_roles (user_id, role)
values ('55555555-5555-5555-5555-555555555555', 'owner');

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
values
  ('33333333-3333-3333-3333-333333333333', 'payroll', true, true),
  ('66666666-6666-6666-6666-666666666666', 'payroll', true, false);

set local session_replication_role = origin;

-- ---------------------------------------------------------------------------
-- 1) A locked period rejects new child rows.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.payroll_bn_period_employees
      (period_id, employee_code, employee_name, group_name, employment_type)
    values
      ('11111111-1111-1111-1111-111111111111', 'E9', 'NV 9', 'Bếp bánh', 'official');
    raise exception 'TEST FAILED: locked period accepted a new employee';
  exception
    when sqlstate '55006' then null; -- expected payroll_bn_period_locked
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 2) A draft period still accepts writes, and a viewer cannot write (RLS).
--    Also covers the new allowance / end_date columns.
-- ---------------------------------------------------------------------------
do $$
begin
  insert into public.payroll_bn_period_employees
    (period_id, employee_code, employee_name, group_name, employment_type,
     monthly_salary, hourly_rate, allowance, start_date, end_date)
  values
    ('22222222-2222-2222-2222-222222222222', 'E3', 'NV 3', 'Văn phòng', 'part_time',
     10400000, 50000, 300000, '2026-09-03', '2026-09-30');
exception
  when others then
    raise exception 'TEST FAILED: draft period rejected a write: %', sqlerrm;
end $$;

set local request.jwt.claims = '{"sub":"66666666-6666-6666-6666-666666666666","role":"authenticated"}';
set local role authenticated;
do $$
begin
  begin
    insert into public.payroll_bn_period_employees
      (period_id, employee_code, employee_name, group_name, employment_type)
    values
      ('22222222-2222-2222-2222-222222222222', 'E4', 'NV 4', 'Bếp bánh', 'official');
    raise exception 'TEST FAILED: payroll viewer was allowed to write';
  exception
    when insufficient_privilege then null; -- 42501: RLS requires payroll edit
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 3) Employment type / group constraints and the adjustment field list.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    insert into public.payroll_bn_period_employees
      (period_id, employee_code, employee_name, group_name, employment_type)
    values
      ('22222222-2222-2222-2222-222222222222', 'E90', 'NV 90', 'Bếp bánh', 'office');
    raise exception 'TEST FAILED: removed office employment type was accepted';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.payroll_bn_period_employees
      (period_id, employee_code, employee_name, group_name, employment_type)
    values
      ('22222222-2222-2222-2222-222222222222', 'E91', 'NV 91', 'Bếp', 'official');
    raise exception 'TEST FAILED: unknown group name was accepted';
  exception
    when check_violation then null;
  end;

  insert into public.payroll_bn_adjustments (period_id, employee_code, field, new_value, reason)
  values
    ('22222222-2222-2222-2222-222222222222', 'E3', 'paid_work_days', '22'::jsonb, 'NC tính lương theo phiếu'),
    ('22222222-2222-2222-2222-222222222222', 'E3', 'part_time_hours', '120.5'::jsonb, 'Giờ part-time theo phiếu');

  begin
    insert into public.payroll_bn_adjustments (period_id, employee_code, field, new_value, reason)
    values ('22222222-2222-2222-2222-222222222222', 'E3', 'bogus_field', '1'::jsonb, 'không hợp lệ');
    raise exception 'TEST FAILED: unknown adjustment field was accepted';
  exception
    when check_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 4) Only an owner can lock a period.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;
do $$
begin
  begin
    perform public.payroll_bn_set_period_locked('22222222-2222-2222-2222-222222222222');
    raise exception 'TEST FAILED: non-owner locked the period';
  exception
    when insufficient_privilege then null; -- 42501: owner only
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 5) An unpermitted user is denied by the import RPC.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';
set local role authenticated;
do $$
begin
  begin
    perform count(*) from public.payroll_bn_import_attendance(
      '22222222-2222-2222-2222-222222222222',
      'bang-cong.xlsx',
      repeat('a', 64),
      '[]'::jsonb
    ) r;
    raise exception 'TEST FAILED: unpermitted user imported attendance';
  exception
    when insufficient_privilege then null; -- 42501: payroll edit required
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 6) Idempotent import: the same sha256 is stored once and returns the same id.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;
do $$
declare
  v_first_id uuid;
  v_first_rows integer;
  v_first_dup boolean;
  v_second_id uuid;
  v_second_rows integer;
  v_second_dup boolean;
  v_count integer;
  v_payload jsonb := jsonb_build_array(
    jsonb_build_object('employee_code', 'E2', 'employee_name', 'NV 2', 'work_date', '2026-09-01', 'check_in', '08:00', 'check_out', '17:00'),
    jsonb_build_object('employee_code', 'E2', 'employee_name', 'NV 2', 'work_date', '2026-09-02', 'check_in', '08:00', 'check_out', '17:00')
  );
begin
  select r.import_id, r.inserted_rows, r.already_imported
    into v_first_id, v_first_rows, v_first_dup
  from public.payroll_bn_import_attendance(
    '22222222-2222-2222-2222-222222222222', 'bang-cong.xlsx', repeat('b', 64), v_payload
  ) r;
  if v_first_dup or v_first_rows <> 2 then
    raise exception 'TEST FAILED: first import rows=% dup=%', v_first_rows, v_first_dup;
  end if;

  select r.import_id, r.inserted_rows, r.already_imported
    into v_second_id, v_second_rows, v_second_dup
  from public.payroll_bn_import_attendance(
    '22222222-2222-2222-2222-222222222222', 'bang-cong.xlsx', repeat('b', 64), v_payload
  ) r;
  if not v_second_dup or v_second_rows <> 0 or v_second_id <> v_first_id then
    raise exception 'TEST FAILED: duplicate import rows=% dup=% id_changed=%', v_second_rows, v_second_dup, (v_second_id <> v_first_id);
  end if;

  select count(*) into v_count
  from public.payroll_bn_attendance_imports
  where period_id = '22222222-2222-2222-2222-222222222222' and sha256 = repeat('b', 64);
  if v_count <> 1 then
    raise exception 'TEST FAILED: import rows stored=%', v_count;
  end if;

  select count(*) into v_count
  from public.payroll_bn_attendance_rows
  where period_id = '22222222-2222-2222-2222-222222222222';
  if v_count <> 2 then
    raise exception 'TEST FAILED: attendance rows stored=%', v_count;
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 7) Server-side period checks: out-of-period date and duplicate employee/day.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
set local role authenticated;
do $$
begin
  begin
    perform count(*) from public.payroll_bn_import_attendance(
      '22222222-2222-2222-2222-222222222222', 'ngoai-ky.xlsx', repeat('c', 64),
      jsonb_build_array(jsonb_build_object('employee_code', 'E2', 'work_date', '2026-10-01'))
    ) r;
    raise exception 'TEST FAILED: out-of-period row was accepted';
  exception
    when sqlstate '22023' then null; -- expected date_out_of_period
  end;

  begin
    perform count(*) from public.payroll_bn_import_attendance(
      '22222222-2222-2222-2222-222222222222', 'trung-ngay.xlsx', repeat('d', 64),
      jsonb_build_array(
        jsonb_build_object('employee_code', 'E2', 'work_date', '2026-09-03'),
        jsonb_build_object('employee_code', 'E2', 'work_date', '2026-09-03')
      )
    ) r;
    raise exception 'TEST FAILED: duplicate employee/day in payload was accepted';
  exception
    when sqlstate '23505' then null; -- expected duplicate_employee_day
  end;
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 8) Owner locks the draft period; every write path is blocked; unlocking is
--    impossible (no locked → draft transition) and locking is idempotent.
-- ---------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}';
set local role authenticated;
do $$
declare
  v_locked public.payroll_bn_periods;
  v_again public.payroll_bn_periods;
begin
  v_locked := public.payroll_bn_set_period_locked('22222222-2222-2222-2222-222222222222');
  if v_locked.status <> 'locked' or v_locked.locked_at is null then
    raise exception 'TEST FAILED: owner lock did not set status/locked_at';
  end if;
  -- Idempotent second call.
  v_again := public.payroll_bn_set_period_locked('22222222-2222-2222-2222-222222222222');
  if v_again.status <> 'locked' then
    raise exception 'TEST FAILED: second lock call changed status to %', v_again.status;
  end if;
end $$;
reset role;

do $$
declare
  v_status text;
begin
  select status into v_status from public.payroll_bn_periods
  where id = '22222222-2222-2222-2222-222222222222';
  if v_status <> 'locked' then
    raise exception 'TEST FAILED: period status is % after lock', v_status;
  end if;

  begin
    insert into public.payroll_bn_period_employees
      (period_id, employee_code, employee_name, group_name, employment_type)
    values
      ('22222222-2222-2222-2222-222222222222', 'E5', 'NV 5', 'Bếp bánh', 'official');
    raise exception 'TEST FAILED: locked period accepted a new employee';
  exception
    when sqlstate '55006' then null;
  end;

  begin
    update public.payroll_bn_periods
       set period_name = 'Đổi tên khi đã khoá'
     where id = '22222222-2222-2222-2222-222222222222';
    raise exception 'TEST FAILED: locked period accepted a config update';
  exception
    when sqlstate '55006' then null;
  end;

  -- The removed unlock path must be rejected even for a superuser session.
  begin
    update public.payroll_bn_periods
       set status = 'draft'
     where id = '22222222-2222-2222-2222-222222222222';
    raise exception 'TEST FAILED: locked period was unlocked';
  exception
    when sqlstate '55006' then null;
  end;
end $$;

rollback;
