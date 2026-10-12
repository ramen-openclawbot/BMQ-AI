-- Rollback-only production smoke CHECKS for migration
-- 20261029140000_salary_payout_create_exclusions.sql.
--
-- Run as one file: `begin; <migration>; <this file>` (the caller wraps the
-- migration and these checks in a transaction). This file contains CHECKS ONLY
-- and never copies the migration. The final RAISE ends the transaction, so every
-- fixture created here is rolled back. It assumes production has exactly 1 owner.
do $$
declare
  v_owner uuid;
  v_staff uuid := gen_random_uuid();
  v_period uuid := gen_random_uuid();
  v_period2 uuid := gen_random_uuid();
  v_payout uuid;
  v_payout2 uuid;
  v_result jsonb;
  v_count integer;
  v_total numeric;
  v_codes text;
  v_ok boolean;
  v_log text := '';
begin
  -- -------------------------------------------------------------------------
  -- 1. Schema / grants / RLS / RPC signatures.
  -- -------------------------------------------------------------------------
  if not exists (
    select 1 from pg_class
    where oid = 'public.salary_payout_exclusions'::regclass and relrowsecurity
  ) then
    raise exception 'CHECK FAIL: RLS off or missing salary_payout_exclusions';
  end if;

  if not has_table_privilege('authenticated', 'public.salary_payout_exclusions', 'select')
     or has_table_privilege('authenticated', 'public.salary_payout_exclusions', 'insert')
     or has_table_privilege('authenticated', 'public.salary_payout_exclusions', 'update')
     or has_table_privilege('authenticated', 'public.salary_payout_exclusions', 'delete') then
    raise exception 'CHECK FAIL: salary_payout_exclusions grants are not select-only for authenticated';
  end if;
  if has_table_privilege('anon', 'public.salary_payout_exclusions', 'select') then
    raise exception 'CHECK FAIL: anon can read salary_payout_exclusions';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.salary_payout_exclusions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%char_length(reason)%'
  ) then
    raise exception 'CHECK FAIL: salary_payout_exclusions reason check missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.salary_payout_exclusions'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) like '%(payout_id, employee_code)%'
  ) then
    raise exception 'CHECK FAIL: salary_payout_exclusions unique(payout_id, employee_code) missing';
  end if;

  if to_regprocedure('public.create_salary_payout(uuid,text)') is not null then
    raise exception 'CHECK FAIL: the old 2-argument create_salary_payout still exists';
  end if;
  if to_regprocedure('public.create_salary_payout(uuid,text,jsonb)') is null then
    raise exception 'CHECK FAIL: create_salary_payout(uuid,text,jsonb) missing';
  end if;
  if to_regprocedure('public.list_salary_payout_period_lines(uuid)') is null then
    raise exception 'CHECK FAIL: list_salary_payout_period_lines(uuid) missing';
  end if;

  if not has_function_privilege('authenticated', 'public.create_salary_payout(uuid,text,jsonb)', 'execute')
     or has_function_privilege('anon', 'public.create_salary_payout(uuid,text,jsonb)', 'execute') then
    raise exception 'CHECK FAIL: create_salary_payout grants are wrong';
  end if;
  if not has_function_privilege('authenticated', 'public.list_salary_payout_period_lines(uuid)', 'execute')
     or has_function_privilege('anon', 'public.list_salary_payout_period_lines(uuid)', 'execute') then
    raise exception 'CHECK FAIL: list_salary_payout_period_lines grants are wrong';
  end if;
  v_log := v_log || 'schema/grants/rls/signatures ok; ';

  -- -------------------------------------------------------------------------
  -- 2. Fixtures: one existing owner, a rollback-only staff user and two
  --    rollback-only periods with published payslips (net_pay > 0).
  -- -------------------------------------------------------------------------
  select user_id into v_owner from public.user_roles where role = 'owner' limit 1;
  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user';
  end if;
  if (select count(*) from public.user_roles where role = 'owner') <> 1 then
    raise exception 'CHECK FAIL: production smoke expects exactly 1 owner';
  end if;

  insert into auth.users (id, instance_id, aud, role, email) values
    (v_staff, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-sal-excl-staff@bmq.invalid');

  insert into public.payroll_bn_periods (
    id, period_code, period_name, date_from, date_to,
    default_standard_days, standard_days_by_group, holidays, rules_config, status
  ) values
    (v_period, 'SMOKE.EXC1', 'Smoke bỏ nhân viên 1', '2099-09-01', '2099-09-30',
     26, '{"Văn phòng":22,"Bếp bánh":26,"Kho BN":26}', '[]', '{}', 'draft'),
    (v_period2, 'SMOKE.EXC2', 'Smoke bỏ nhân viên 2', '2099-10-01', '2099-10-31',
     26, '{"Văn phòng":22,"Bếp bánh":26,"Kho BN":26}', '[]', '{}', 'draft');

  insert into public.payroll_bn_payslips (
    period_id, employee_code, employee_name, group_name, period_name,
    date_from, date_to, net_pay, lines, published_by
  ) values
    (v_period, 'SMK01', 'Smoke A', 'Bếp bánh', 'Smoke bỏ nhân viên 1', '2099-09-01', '2099-09-30', 5000000, '[]', v_owner),
    (v_period, 'SMK02', 'Smoke B', 'Bếp bánh', 'Smoke bỏ nhân viên 1', '2099-09-01', '2099-09-30', 6000000, '[]', v_owner),
    (v_period, 'SMK03', 'Smoke C', 'Bếp bánh', 'Smoke bỏ nhân viên 1', '2099-09-01', '2099-09-30', 7000000, '[]', v_owner),
    (v_period2, 'SMK11', 'Smoke K', 'Bếp bánh', 'Smoke bỏ nhân viên 2', '2099-10-01', '2099-10-31', 4000000, '[]', v_owner),
    (v_period2, 'SMK12', 'Smoke L', 'Bếp bánh', 'Smoke bỏ nhân viên 2', '2099-10-01', '2099-10-31', 5000000, '[]', v_owner);
  v_log := v_log || 'fixtures ok; ';

  -- -------------------------------------------------------------------------
  -- 3. Owner lists one period's lines (ordered by employee_code).
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*), coalesce(sum(net_pay), 0)
    into v_count, v_total
  from public.list_salary_payout_period_lines(v_period);
  if v_count <> 3 or v_total <> 18000000 then
    raise exception 'CHECK FAIL: list lines count=% total=%', v_count, v_total;
  end if;
  select string_agg(employee_code, ',' order by employee_code)
    into v_codes
  from public.list_salary_payout_period_lines(v_period);
  if v_codes <> 'SMK01,SMK02,SMK03' then
    raise exception 'CHECK FAIL: list lines codes=%', v_codes;
  end if;
  v_log := v_log || 'owner lists 3 lines; ';

  -- -------------------------------------------------------------------------
  -- 4. Create excluding one employee: count/total cover the rest, the
  --    exclusion row is snapshotted, and get_salary_payout keeps its keys.
  -- -------------------------------------------------------------------------
  v_result := public.create_salary_payout(
    v_period,
    'smoke-sal-excl-1',
    jsonb_build_array(jsonb_build_object('employee_code', 'SMK02', 'reason', 'Nghỉ phép'))
  );
  v_payout := (v_result->>'payout_id')::uuid;
  if coalesce((v_result->>'employee_count')::int, 0) <> 2 then
    raise exception 'CHECK FAIL: excluded create employee_count = %', v_result->>'employee_count';
  end if;
  if coalesce((v_result->>'total_amount')::numeric, 0) <> 12000000 then
    raise exception 'CHECK FAIL: excluded create total_amount = %', v_result->>'total_amount';
  end if;
  if (select count(*) from public.salary_payout_lines where payout_id = v_payout) <> 2 then
    raise exception 'CHECK FAIL: expected 2 salary lines after excluding one employee';
  end if;
  if exists (
    select 1 from public.salary_payout_lines
    where payout_id = v_payout and employee_code = 'SMK02'
  ) then
    raise exception 'CHECK FAIL: the excluded employee still has a payout line';
  end if;
  if (select count(*) from public.salary_payout_exclusions where payout_id = v_payout) <> 1 then
    raise exception 'CHECK FAIL: expected exactly 1 exclusion row';
  end if;
  if (select reason from public.salary_payout_exclusions where payout_id = v_payout and employee_code = 'SMK02')
     <> 'Nghỉ phép' then
    raise exception 'CHECK FAIL: the exclusion reason was not stored';
  end if;
  if (select net_pay from public.salary_payout_exclusions where payout_id = v_payout and employee_code = 'SMK02')
     <> 6000000 then
    raise exception 'CHECK FAIL: the exclusion net_pay was not snapshotted';
  end if;

  v_result := public.get_salary_payout(v_payout);
  if not (
    v_result ? 'payout' and v_result ? 'lines' and v_result ? 'receipts'
    and v_result ? 'attachments' and v_result ? 'exclusions'
  ) then
    raise exception 'CHECK FAIL: get_salary_payout is missing an existing key or exclusions';
  end if;
  if jsonb_array_length(v_result->'exclusions') <> 1
     or (v_result->'exclusions'->0->>'employee_code') <> 'SMK02'
     or (v_result->'exclusions'->0->>'reason') <> 'Nghỉ phép' then
    raise exception 'CHECK FAIL: get_salary_payout exclusions = %', v_result->'exclusions';
  end if;

  perform set_config('role', 'postgres', true);
  if (select count(*) from public.finance_zalo_notifications
      where event_type = 'salary_payout_created' and entity_id = v_payout) <> 1 then
    raise exception 'CHECK FAIL: expected exactly one salary_payout_created row';
  end if;
  if not exists (
    select 1 from public.finance_zalo_notifications
    where event_type = 'salary_payout_created' and entity_id = v_payout
      and message_body like '%Số nhân viên: 2%'
  ) then
    raise exception 'CHECK FAIL: the Zalo message count is not the non-excluded count';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'exclude one -> 2 lines/total + exclusion + keys; ';

  -- -------------------------------------------------------------------------
  -- 5. A missing reason is rejected (reason_required).
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.create_salary_payout(
      v_period2,
      'smoke-sal-excl-reason',
      jsonb_build_array(jsonb_build_object('employee_code', 'SMK11'))
    );
  exception when others then
    v_ok := sqlerrm like '%reason_required%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a missing exclusion reason was accepted'; end if;
  v_log := v_log || 'missing reason rejected; ';

  -- -------------------------------------------------------------------------
  -- 6. An unknown employee code is rejected (unknown_employee_code).
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.create_salary_payout(
      v_period2,
      'smoke-sal-excl-unknown',
      jsonb_build_array(jsonb_build_object('employee_code', 'NOPE', 'reason', 'Không có'))
    );
  exception when others then
    v_ok := sqlerrm like '%unknown_employee_code%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: an unknown employee code was accepted'; end if;
  v_log := v_log || 'unknown code rejected; ';

  -- -------------------------------------------------------------------------
  -- 7. Excluding everyone is rejected (no_employees_left).
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.create_salary_payout(
      v_period2,
      'smoke-sal-excl-all',
      jsonb_build_array(
        jsonb_build_object('employee_code', 'SMK11', 'reason', 'Nghỉ phép'),
        jsonb_build_object('employee_code', 'SMK12', 'reason', 'Nghỉ phép')
      )
    );
  exception when others then
    v_ok := sqlerrm like '%no_employees_left%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: excluding everyone was accepted'; end if;
  v_log := v_log || 'excluding everyone rejected; ';

  -- -------------------------------------------------------------------------
  -- 8. A call without the third argument still works, with no exclusions.
  -- -------------------------------------------------------------------------
  v_result := public.create_salary_payout(v_period2, 'smoke-sal-no-excl');
  v_payout2 := (v_result->>'payout_id')::uuid;
  if coalesce((v_result->>'employee_count')::int, 0) <> 2
     or coalesce((v_result->>'total_amount')::numeric, 0) <> 9000000 then
    raise exception 'CHECK FAIL: 2-argument create changed: %', v_result;
  end if;
  if (select count(*) from public.salary_payout_exclusions where payout_id = v_payout2) <> 0 then
    raise exception 'CHECK FAIL: a 2-argument create wrote exclusions';
  end if;
  v_log := v_log || '2-argument create unchanged; ';

  -- -------------------------------------------------------------------------
  -- 9. A user without salary_cash is denied on both functions.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  v_ok := false;
  begin
    select count(*) into v_count from public.list_salary_payout_period_lines(v_period);
  exception when others then
    v_ok := sqlerrm like '%insufficient_privilege%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: staff without salary_cash listed period lines'; end if;

  v_ok := false;
  begin
    perform public.create_salary_payout(v_period2, 'smoke-sal-excl-staff', '[]'::jsonb);
  exception when others then
    v_ok := sqlerrm like '%insufficient_privilege%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: staff without salary_cash created a payout'; end if;
  v_log := v_log || 'staff denied on both functions; ';

  raise exception 'SMOKE_RESULT PASS: %', v_log;
end $$;
