-- Rollback-only smoke for 20261009090000_payroll_bn_payslips.sql on the linked project:
--   { echo 'begin;'; cat apps/web/supabase/tests/payroll_bn_payslips_prod_smoke_checks.sql; } > /tmp/s.sql
--   supabase db query --linked -f /tmp/s.sql
-- (before the migration is applied, put the migration between `begin;` and the checks).
-- Always ends with RAISE EXCEPTION 'SMOKE_RESULT passed=N/M failures=[...]', which rolls back.
-- 2026-10-09: passed 19/19 before apply (migration in the same txn) and 19/19 after apply.
-- 20261009120000 (payroll editors manage phones) changes two checks and adds two (21 total).
insert into auth.users (id, instance_id, aud, role, email) values
 ('b0000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','smoke-ps-owner@bmq.invalid'),
 ('b0000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','smoke-ps-editor@bmq.invalid');
insert into public.user_roles (user_id, role) values ('b0000000-0000-4000-8000-000000000001','owner');
insert into auth.users (id, instance_id, aud, role, email) values
 ('b0000000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','smoke-ps-viewer@bmq.invalid');
insert into public.user_module_permissions (user_id, module_key, can_view, can_edit) values
 ('b0000000-0000-4000-8000-000000000002','payroll',true,true),
 ('b0000000-0000-4000-8000-000000000003','payroll',true,false);
create temp table smoke_log(step text, ok boolean, detail text) on commit drop;
grant all on smoke_log to authenticated, anon;
create temp table smoke_ids(k text primary key, v uuid) on commit drop;
grant all on smoke_ids to authenticated, anon;

-- 1) editor (payroll can_edit, not owner): creates the period; cannot touch contacts or publish
set local role authenticated;
set local request.jwt.claims = '{"sub":"b0000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare pid uuid; n int;
begin
  insert into public.payroll_bn_periods(period_code, period_name, date_from, date_to, standard_days_by_group, holidays)
  values ('SMOKE.PS','smoke payslips','2099-09-01','2099-09-30','{"Văn phòng":22,"Bếp bánh":26,"Kho BN":26}','[]') returning id into pid;
  insert into smoke_ids values ('p', pid);
  insert into public.payroll_bn_period_employees(period_id, employee_code, employee_name, group_name, employment_type, monthly_salary)
  values (pid,'SMK01','Smoke A','Bếp bánh','official',8000000);
  -- 20261009120000: payroll editors manage portal phones (publishing stays owner-only).
  insert into public.payroll_bn_employee_contacts(employee_code, phone_normalized) values ('SMK09','84900000009');
  update public.payroll_bn_employee_contacts set active = false where employee_code = 'SMK09';
  select count(*) into n from public.payroll_bn_employee_contacts where employee_code = 'SMK09' and active = false;
  insert into smoke_log values ('editor adds, edits and reads a contact', n = 1, n::text);
  delete from public.payroll_bn_employee_contacts where employee_code = 'SMK09';
  begin
    perform public.payroll_bn_publish_payslips(pid, '[]'::jsonb);
    insert into smoke_log values ('editor cannot publish', false, 'accepted');
  exception when insufficient_privilege then insert into smoke_log values ('editor cannot publish', true, sqlerrm); end;
  begin
    insert into public.payroll_bn_payslips(period_id, employee_code, employee_name, period_name, net_pay, lines)
    values (pid,'SMK01','x','x',1,'[]');
    insert into smoke_log values ('editor cannot insert payslip directly', false, 'accepted');
  exception when insufficient_privilege then insert into smoke_log values ('editor cannot insert payslip directly', true, sqlerrm); end;
end $$;
reset role;

-- 2) owner: contacts, publish rules
set local role authenticated;
set local request.jwt.claims = '{"sub":"b0000000-0000-4000-8000-000000000001","role":"authenticated"}';
do $$
declare pid uuid := (select v from smoke_ids where k='p'); n int;
begin
  insert into public.payroll_bn_employee_contacts(employee_code, phone_normalized) values ('SMK01','84900000001');
  update public.payroll_bn_employee_contacts set active = false where employee_code = 'SMK01';
  select count(*) into n from public.payroll_bn_employee_contacts where employee_code = 'SMK01' and active = false;
  insert into smoke_log values ('owner adds and deactivates contact', n = 1, n::text);
  begin
    insert into public.payroll_bn_employee_contacts(employee_code, phone_normalized) values ('SMK02','84900000001');
    insert into smoke_log values ('phone is unique', false, 'accepted');
  exception when unique_violation then insert into smoke_log values ('phone is unique', true, sqlerrm); end;
  begin
    perform public.payroll_bn_publish_payslips(pid, '[{"employee_code":"SMK01","employee_name":"Smoke A","period_name":"smoke","net_pay":1000,"lines":[]}]'::jsonb);
    insert into smoke_log values ('draft period cannot publish', false, 'accepted');
  exception when sqlstate '55006' then insert into smoke_log values ('draft period cannot publish', true, sqlerrm); end;
  perform public.payroll_bn_set_period_locked(pid);
  begin
    perform public.payroll_bn_publish_payslips(pid, '[{"employee_code":"NOPE","employee_name":"x","period_name":"x","net_pay":1,"lines":[]}]'::jsonb);
    insert into smoke_log values ('unknown employee rejected', false, 'accepted');
  exception when sqlstate '22023' then insert into smoke_log values ('unknown employee rejected', true, sqlerrm); end;
  n := public.payroll_bn_publish_payslips(pid, '[{"employee_code":"SMK01","employee_name":"Smoke A","group_name":"Bếp bánh","period_name":"smoke","date_from":"2099-09-01","date_to":"2099-09-30","net_pay":8000000,"note":"n","lines":[{"key":"gross_pay","label":"Tổng thu nhập","value":8000000,"unit":"vnd"}]}]'::jsonb);
  insert into smoke_log values ('owner publishes locked period', n = 1, n::text);
  n := public.payroll_bn_publish_payslips(pid, '[{"employee_code":"SMK01","employee_name":"Smoke A","period_name":"smoke","net_pay":7000000,"lines":[]}]'::jsonb);
  select count(*) into n from public.payroll_bn_payslips where period_id = pid and net_pay = 7000000;
  insert into smoke_log values ('republish replaces rows', n = 1 and (select count(*) from public.payroll_bn_payslips where period_id = pid) = 1, n::text);
  select count(*) into n from public.payroll_bn_payslips where period_id = pid and published_by = 'b0000000-0000-4000-8000-000000000001';
  insert into smoke_log values ('published_by is the owner', n = 1, n::text);
end $$;
reset role;

-- 3) editor cannot read payslips or contacts
set local role authenticated;
set local request.jwt.claims = '{"sub":"b0000000-0000-4000-8000-000000000002","role":"authenticated"}';
do $$
declare n int;
begin
  select count(*) into n from public.payroll_bn_payslips;
  insert into smoke_log values ('editor sees no payslips', n = 0, n::text);
  select count(*) into n from public.payroll_bn_employee_contacts where employee_code = 'SMK01';
  insert into smoke_log values ('editor sees contacts', n = 1, n::text);
  begin
    perform 1 from public.payroll_bn_payslip_sessions limit 1;
    insert into smoke_log values ('authenticated cannot read sessions', false, 'allowed');
  exception when insufficient_privilege then insert into smoke_log values ('authenticated cannot read sessions', true, sqlerrm); end;
end $$;
reset role;

-- 3b) payroll viewer (can_view only) cannot see or add contacts
set local role authenticated;
set local request.jwt.claims = '{"sub":"b0000000-0000-4000-8000-000000000003","role":"authenticated"}';
do $$
declare n int;
begin
  select count(*) into n from public.payroll_bn_employee_contacts;
  insert into smoke_log values ('viewer sees no contacts', n = 0, n::text);
  begin
    insert into public.payroll_bn_employee_contacts(employee_code, phone_normalized) values ('SMK08','84900000008');
    insert into smoke_log values ('viewer cannot add contact', false, 'accepted');
  exception when insufficient_privilege then insert into smoke_log values ('viewer cannot add contact', true, sqlerrm); end;
end $$;
reset role;

-- 4) anon gets nothing
set local role anon;
do $$
begin
  begin perform 1 from public.payroll_bn_payslips limit 1; insert into smoke_log values ('anon cannot read payslips', false, 'allowed');
  exception when insufficient_privilege then insert into smoke_log values ('anon cannot read payslips', true, sqlerrm); end;
  begin perform 1 from public.payroll_bn_employee_contacts limit 1; insert into smoke_log values ('anon cannot read contacts', false, 'allowed');
  exception when insufficient_privilege then insert into smoke_log values ('anon cannot read contacts', true, sqlerrm); end;
  begin perform 1 from public.payroll_bn_payslip_otp_challenges limit 1; insert into smoke_log values ('anon cannot read otp challenges', false, 'allowed');
  exception when insufficient_privilege then insert into smoke_log values ('anon cannot read otp challenges', true, sqlerrm); end;
  begin perform public.payroll_bn_publish_payslips(gen_random_uuid(), '[]'::jsonb); insert into smoke_log values ('anon cannot publish', false, 'allowed');
  exception when insufficient_privilege then insert into smoke_log values ('anon cannot publish', true, sqlerrm); end;
end $$;
reset role;

-- 5) service_role (Edge Functions) has full access to the portal tables
insert into smoke_log select 'service_role privileges', bool_and(has_table_privilege('service_role', t, 'select,insert,update,delete')), string_agg(t, ',')
  from unnest(array['public.payroll_bn_employee_contacts','public.payroll_bn_payslips','public.payroll_bn_payslip_otp_challenges','public.payroll_bn_payslip_sessions']) t;
insert into smoke_log select 'RLS enabled on 4 tables', count(*) = 4, string_agg(relname, ',')
  from pg_class where relname in ('payroll_bn_employee_contacts','payroll_bn_payslips','payroll_bn_payslip_otp_challenges','payroll_bn_payslip_sessions') and relrowsecurity;

do $$
declare passed int; total int; fails text;
begin
  select count(*) filter (where ok), count(*), coalesce(string_agg(step || ': ' || coalesce(detail,''), ' | ') filter (where not ok), '')
    into passed, total, fails from smoke_log;
  raise exception 'SMOKE_RESULT passed=%/% failures=[%]', passed, total, fails;
end $$;
