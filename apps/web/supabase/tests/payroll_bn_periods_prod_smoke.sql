-- Rollback-only smoke for 20261008120000_payroll_bn_periods.sql, runnable on the
-- linked Supabase project (no superuser needed):
--
--   supabase db query --linked -f apps/web/supabase/tests/payroll_bn_periods_prod_smoke.sql
--
-- It creates throwaway auth users / permissions / a SMOKE period inside one
-- transaction and always ends with RAISE EXCEPTION 'SMOKE_RESULT passed=N/M ...',
-- which rolls everything back. Expect passed=33/33 and failures=[].
-- Passed 25/25 on production on 2026-10-08 before the migration was applied
-- (migration + smoke in the same rolled-back transaction).
-- 20261008160000_payroll_bn_issue_reviews.sql appends 8 checks (issue reviews +
-- attendance approval); total 33. It has not been applied to production yet.
begin;

-- ===================== ROLLBACK-ONLY SMOKE (Bếp BN) =====================
insert into auth.users (id, instance_id, aud, role, email) values
 ('a0000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','smoke-owner@bmq.invalid'),
 ('a0000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','smoke-editor@bmq.invalid'),
 ('a0000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','smoke-viewer@bmq.invalid'),
 ('a0000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','smoke-none@bmq.invalid');
insert into public.user_roles (user_id, role) values ('a0000000-0000-4000-8000-000000000001','owner');
insert into public.user_module_permissions (user_id, module_key, can_view, can_edit) values
 ('a0000000-0000-4000-8000-000000000002','payroll',true,true),
 ('a0000000-0000-4000-8000-000000000003','payroll',true,false);
create temp table smoke_log(step text, ok boolean, detail text) on commit drop;
grant all on smoke_log to authenticated, anon;
create temp table smoke_ids(k text primary key, v uuid) on commit drop;
grant all on smoke_ids to authenticated, anon;

-- 1) editor: create period, catalogue, import, duplicate, out-of-period, adjustment, empty reason, lock denied
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare pid uuid; r record; ok boolean;
begin
  insert into public.payroll_bn_periods(period_code, period_name, date_from, date_to, standard_days_by_group, holidays)
  values ('SMOKE.T09','smoke','2026-09-01','2026-09-30','{"Văn phòng":22,"Bếp bánh":26,"Kho BN":26}','["2026-09-01","2026-09-02"]') returning id into pid;
  insert into smoke_ids values ('p', pid);
  insert into smoke_log values ('editor creates period', true, pid::text);
  insert into public.payroll_bn_period_employees(period_id, employee_code, employee_name, group_name, employment_type, monthly_salary, overtime_rate, start_date)
  values (pid,'00025','Smoke VA','Bếp bánh','official',13000000,30000,'2025-01-01');
  insert into smoke_log values ('editor adds employee', true, null);
  select * into r from public.payroll_bn_import_attendance(pid,'smoke.xls',repeat('a',64),
    '[{"employee_code":"00025","work_date":"2026-09-03","check_in":"07:00","check_out":"16:00"},{"employee_code":"00025","work_date":"2026-09-04","check_in":"07:00","check_out":null}]'::jsonb);
  insert into smoke_log values ('import inserts 2 rows', r.inserted_rows = 2 and not r.already_imported, r::text);
  select * into r from public.payroll_bn_import_attendance(pid,'smoke.xls',repeat('a',64),
    '[{"employee_code":"00025","work_date":"2026-09-03"}]'::jsonb);
  insert into smoke_log values ('re-import same sha is idempotent', r.inserted_rows = 0 and r.already_imported, r::text);
  begin
    perform * from public.payroll_bn_import_attendance(pid,'x.xls',repeat('b',64),'[{"employee_code":"00025","work_date":"2026-10-01"}]'::jsonb);
    insert into smoke_log values ('out-of-period rejected', false, 'accepted');
  exception when sqlstate '22023' then insert into smoke_log values ('out-of-period rejected', true, sqlerrm); end;
  begin
    perform * from public.payroll_bn_import_attendance(pid,'y.xls',repeat('c',64),'[{"employee_code":"00025","work_date":"2026-09-05"},{"employee_code":"00025","work_date":"2026-09-05"}]'::jsonb);
    insert into smoke_log values ('duplicate employee/day rejected', false, 'accepted');
  exception when sqlstate '23505' then insert into smoke_log values ('duplicate employee/day rejected', true, sqlerrm); end;
  insert into public.payroll_bn_adjustments(period_id, employee_code, field, old_value, new_value, reason)
  values (pid,'00025','work_days','25','24.5','smoke reason');
  select (actor = 'a0000000-0000-4000-8000-000000000002') into ok from public.payroll_bn_adjustments where period_id = pid;
  insert into smoke_log values ('adjustment stored with actor', ok, null);
  begin
    insert into public.payroll_bn_adjustments(period_id, employee_code, field, new_value, reason) values (pid,'00025','work_days','1','   ');
    insert into smoke_log values ('empty reason rejected', false, 'accepted');
  exception when check_violation then insert into smoke_log values ('empty reason rejected', true, sqlerrm); end;
  begin
    insert into public.payroll_bn_adjustments(period_id, employee_code, field, new_value, reason, actor) values (pid,'00025','work_days','1','spoof','a0000000-0000-4000-8000-000000000001');
    insert into smoke_log values ('actor cannot be spoofed', false, 'accepted');
  exception when insufficient_privilege then insert into smoke_log values ('actor cannot be spoofed', true, sqlerrm); end;
  begin
    update public.payroll_bn_adjustments set reason = 'rewritten' where period_id = pid;
    insert into smoke_log values ('adjustment log is append-only', false, 'updated');
  exception when insufficient_privilege then insert into smoke_log values ('adjustment log is append-only', true, sqlerrm); end;
  begin
    perform public.payroll_bn_set_period_locked(pid);
    insert into smoke_log values ('editor cannot lock (rpc)', false, 'locked');
  exception when insufficient_privilege then insert into smoke_log values ('editor cannot lock (rpc)', true, sqlerrm); end;
  begin
    update public.payroll_bn_periods set status='locked' where id = pid;
    insert into smoke_log values ('editor cannot lock (update)', false, 'locked');
  exception when insufficient_privilege then insert into smoke_log values ('editor cannot lock (update)', true, sqlerrm); end;
end $$;
reset role;

-- 2) viewer: can read, cannot write
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000003","role":"authenticated"}';
do $$
declare pid uuid := (select v from smoke_ids where k='p'); n int;
begin
  select count(*) into n from public.payroll_bn_attendance_rows where period_id = pid;
  insert into smoke_log values ('viewer reads attendance', n = 2, n::text);
  begin
    insert into public.payroll_bn_period_employees(period_id, employee_code, employee_name, group_name, employment_type) values (pid,'X1','x','Kho BN','part_time');
    insert into smoke_log values ('viewer cannot add employee', false, 'accepted');
  exception when insufficient_privilege then insert into smoke_log values ('viewer cannot add employee', true, sqlerrm); end;
  begin
    perform * from public.payroll_bn_import_attendance(pid,'v.xls',repeat('d',64),'[]'::jsonb);
    insert into smoke_log values ('viewer cannot import', false, 'accepted');
  exception when insufficient_privilege then insert into smoke_log values ('viewer cannot import', true, sqlerrm); end;
end $$;
reset role;

-- 3) user without payroll permission sees nothing
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000004","role":"authenticated"}';
do $$
declare n int;
begin
  select count(*) into n from public.payroll_bn_periods;
  insert into smoke_log values ('no-permission user sees 0 periods', n = 0, n::text);
  select count(*) into n from public.payroll_bn_period_employees;
  insert into smoke_log values ('no-permission user sees 0 employees (salary hidden)', n = 0, n::text);
end $$;
reset role;

-- 4) anon cannot execute RPCs or read
set local role anon;
do $$
declare n int;
begin
  begin
    perform * from public.payroll_bn_import_attendance((select v from smoke_ids where k='p'),'a.xls',repeat('e',64),'[]'::jsonb);
    insert into smoke_log values ('anon cannot import', false, 'accepted');
  exception when insufficient_privilege then insert into smoke_log values ('anon cannot import', true, sqlerrm); end;
  begin
    select count(*) into n from public.payroll_bn_periods;
    insert into smoke_log values ('anon reads 0 periods', n = 0, n::text);
  exception when insufficient_privilege then insert into smoke_log values ('anon reads 0 periods', true, sqlerrm); end;
end $$;
reset role;

-- 5) owner locks; every write path blocked afterwards; no unlock
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare pid uuid := (select v from smoke_ids where k='p'); st text;
begin
  perform public.payroll_bn_set_period_locked(pid);
  select status into st from public.payroll_bn_periods where id = pid;
  insert into smoke_log values ('owner locks period', st = 'locked', st);
  begin
    update public.payroll_bn_periods set status='draft' where id = pid;
    insert into smoke_log values ('owner cannot unlock', false, 'unlocked');
  exception when others then insert into smoke_log values ('owner cannot unlock', true, sqlstate||' '||sqlerrm); end;
end $$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare pid uuid := (select v from smoke_ids where k='p');
begin
  begin
    insert into public.payroll_bn_adjustments(period_id, employee_code, field, new_value, reason) values (pid,'00025','work_days','20','late');
    insert into smoke_log values ('locked: adjustment blocked', false, 'accepted');
  exception when sqlstate '55006' then insert into smoke_log values ('locked: adjustment blocked', true, sqlerrm); end;
  begin
    update public.payroll_bn_period_employees set monthly_salary = 1 where period_id = pid;
    insert into smoke_log values ('locked: catalogue edit blocked', false, 'accepted');
  exception when sqlstate '55006' then insert into smoke_log values ('locked: catalogue edit blocked', true, sqlerrm); end;
  begin
    perform * from public.payroll_bn_import_attendance(pid,'z.xls',repeat('f',64),'[]'::jsonb);
    insert into smoke_log values ('locked: import blocked', false, 'accepted');
  exception when sqlstate '55006' then insert into smoke_log values ('locked: import blocked', true, sqlerrm); end;
  begin
    delete from public.payroll_bn_attendance_rows where period_id = pid;
    insert into smoke_log values ('locked: attendance delete blocked', false, 'accepted');
  exception when sqlstate '55006' or insufficient_privilege then insert into smoke_log values ('locked: attendance delete blocked', true, sqlstate||' '||sqlerrm); end;
end $$;
reset role;

-- 6) issue reviews + attendance approval on a fresh unlocked period (editor)
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare
  pid uuid;
  r record;
  ok boolean;
begin
  insert into public.payroll_bn_periods(period_code, period_name, date_from, date_to, standard_days_by_group, holidays)
  values ('SMOKE.T09B','smoke review','2026-09-01','2026-09-30','{"Văn phòng":22,"Bếp bánh":26,"Kho BN":26}','[]') returning id into pid;
  insert into smoke_ids values ('p2', pid);

  insert into public.payroll_bn_issue_reviews(period_id, employee_code, work_date, issue_code, decision, note)
  values (pid,'00025','2026-09-03','missing_check_out','accepted', null);
  insert into public.payroll_bn_issue_reviews(period_id, employee_code, work_date, issue_code, decision, note)
  values (pid,'00025','2026-09-03','missing_check_out','excluded','chốt lương')
  on conflict (period_id, employee_code, work_date, issue_code)
  do update set decision = excluded.decision, note = excluded.note;
  select (decision = 'excluded' and note = 'chốt lương' and actor = 'a0000000-0000-4000-8000-000000000002') into ok
    from public.payroll_bn_issue_reviews
   where period_id = pid and employee_code = '00025' and work_date = '2026-09-03' and issue_code = 'missing_check_out';
  insert into smoke_log values ('editor upserts review with actor', coalesce(ok,false), null);

  begin
    insert into public.payroll_bn_issue_reviews(period_id, employee_code, work_date, issue_code, decision, note)
    values (pid,'00025','2026-09-04','missing_check_out','excluded','   ');
    insert into smoke_log values ('excluded review requires note', false, 'accepted');
  exception when check_violation then insert into smoke_log values ('excluded review requires note', true, sqlerrm); end;

  perform public.payroll_bn_set_attendance_approved(pid, true);
  select (attendance_approved_at is not null and attendance_approved_by = 'a0000000-0000-4000-8000-000000000002') into ok
    from public.payroll_bn_periods where id = pid;
  insert into smoke_log values ('editor approves attendance', coalesce(ok,false), null);

  perform public.payroll_bn_set_attendance_approved(pid, false);
  select (attendance_approved_at is null and attendance_approved_by is null) into ok
    from public.payroll_bn_periods where id = pid;
  insert into smoke_log values ('editor clears attendance approval', coalesce(ok,false), null);

  perform public.payroll_bn_set_attendance_approved(pid, true);
  select * into r from public.payroll_bn_import_attendance(pid,'review.xls',repeat('1',64),
    '[{"employee_code":"00025","work_date":"2026-09-03","check_in":"07:00","check_out":null}]'::jsonb);
  select (attendance_approved_at is null and attendance_approved_by is null) into ok
    from public.payroll_bn_periods where id = pid;
  insert into smoke_log values ('new import clears approval', (coalesce(ok,false) and not r.already_imported), r::text);
end $$;
reset role;

-- 7) viewer cannot write a review
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000003","role":"authenticated"}';
do $$
declare pid uuid := (select v from smoke_ids where k='p2');
begin
  begin
    insert into public.payroll_bn_issue_reviews(period_id, employee_code, work_date, issue_code, decision, note)
    values (pid,'00025','2026-09-05','missing_check_in','accepted', null);
    insert into smoke_log values ('viewer cannot write review', false, 'accepted');
  exception when insufficient_privilege then insert into smoke_log values ('viewer cannot write review', true, sqlerrm); end;
end $$;
reset role;

-- 8) locked period blocks review writes and approval
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare pid uuid := (select v from smoke_ids where k='p2');
begin
  perform public.payroll_bn_set_period_locked(pid);
end $$;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare pid uuid := (select v from smoke_ids where k='p2');
begin
  begin
    insert into public.payroll_bn_issue_reviews(period_id, employee_code, work_date, issue_code, decision, note)
    values (pid,'00025','2026-09-06','missing_check_out','accepted', null);
    insert into smoke_log values ('locked: review write blocked', false, 'accepted');
  exception when sqlstate '55006' then insert into smoke_log values ('locked: review write blocked', true, sqlerrm); end;
  begin
    perform public.payroll_bn_set_attendance_approved(pid, true);
    insert into smoke_log values ('locked: approval blocked', false, 'approved');
  exception when sqlstate '55006' then insert into smoke_log values ('locked: approval blocked', true, sqlerrm); end;
end $$;
reset role;

-- report and roll everything back
do $$
declare fails text; total int; passed int;
begin
  select count(*), count(*) filter (where ok) into total, passed from smoke_log;
  select string_agg(step || ' => ' || coalesce(detail,''), ' | ') into fails from smoke_log where not ok;
  raise exception 'SMOKE_RESULT passed=%/% failures=[%] steps=[%]', passed, total, coalesce(fails,''),
    (select string_agg(step || ':' || ok, '; ') from smoke_log);
end $$;
