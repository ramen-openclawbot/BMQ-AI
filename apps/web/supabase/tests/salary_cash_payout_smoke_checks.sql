-- Rollback-only production smoke CHECKS for migration
-- 20261012120000_salary_cash_payout.sql.
--
-- Run as one file: `begin; <migration>; <this file>` (the caller wraps the
-- migration and these checks in a transaction). This file contains CHECKS ONLY
-- and never copies the migration. The final RAISE ends the transaction, so every
-- fixture created here is rolled back. It assumes production has exactly 1 owner.
do $$
declare
  v_owner uuid;
  v_staff uuid := gen_random_uuid();
  v_viewer uuid := gen_random_uuid();
  v_editor uuid := gen_random_uuid();
  v_period uuid := gen_random_uuid();
  v_payout uuid;
  v_result jsonb;
  v_prior uuid;
  v_count integer;
  v_status text;
  v_ok boolean;
  v_row record;
  v_before text;
  v_after text;
  v_log text := '';
begin
  -- -------------------------------------------------------------------------
  -- 1. Schema / grants / RLS / RPCs exist.
  -- -------------------------------------------------------------------------
  for v_row in
    select unnest(array[
      'salary_payouts', 'salary_payout_lines', 'salary_payout_receipts',
      'salary_payout_idempotency'
    ]) as table_name
  loop
    if not exists (
      select 1 from pg_class
      where oid = ('public.' || v_row.table_name)::regclass and relrowsecurity
    ) then
      raise exception 'CHECK FAIL: RLS off or missing %', v_row.table_name;
    end if;
  end loop;

  if not has_table_privilege('authenticated', 'public.salary_payouts', 'select')
     or has_table_privilege('authenticated', 'public.salary_payouts', 'insert')
     or has_table_privilege('authenticated', 'public.salary_payouts', 'update')
     or has_table_privilege('authenticated', 'public.salary_payouts', 'delete') then
    raise exception 'CHECK FAIL: salary_payouts grants are not select-only for authenticated';
  end if;
  if has_table_privilege('authenticated', 'public.salary_payout_idempotency', 'select') then
    raise exception 'CHECK FAIL: authenticated can read the salary idempotency ledger';
  end if;
  if has_table_privilege('anon', 'public.salary_payouts', 'select')
     or has_table_privilege('anon', 'public.salary_payout_lines', 'select')
     or has_table_privilege('anon', 'public.salary_payout_receipts', 'select') then
    raise exception 'CHECK FAIL: anon can read salary payout tables';
  end if;

  for v_row in
    select unnest(array[
      'create_salary_payout(uuid,text)',
      'get_salary_payout(uuid)',
      'record_salary_payout_ceo_payment(uuid,jsonb,text)',
      'submit_salary_payout_matches(uuid,jsonb,text)',
      'discard_salary_payout_receipt(uuid)',
      'cancel_salary_payout(uuid)'
    ]) as signature
  loop
    if has_function_privilege('anon', to_regprocedure('public.' || v_row.signature), 'execute') then
      raise exception 'CHECK FAIL: anon can execute %', v_row.signature;
    end if;
    if not has_function_privilege('authenticated', to_regprocedure('public.' || v_row.signature), 'execute') then
      raise exception 'CHECK FAIL: authenticated cannot execute %', v_row.signature;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_zalo_notifications'::regclass
      and conname = 'finance_zalo_notifications_event_type_check'
      and pg_get_constraintdef(oid) like '%salary_payout_created%'
      and pg_get_constraintdef(oid) like '%salary_payout_advanced%'
      and pg_get_constraintdef(oid) like '%salary_payout_completed%'
  ) then
    raise exception 'CHECK FAIL: finance_zalo_notifications event check misses the salary events';
  end if;
  v_log := v_log || 'schema/grants/rls/rpcs ok; ';

  -- -------------------------------------------------------------------------
  -- 2. Fixtures: one existing owner + a rollback-only payroll_bn period with
  --    3 published payslips (net_pay > 0).
  -- -------------------------------------------------------------------------
  select user_id into v_owner from public.user_roles where role = 'owner' limit 1;
  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user';
  end if;
  if (select count(*) from public.user_roles where role = 'owner') <> 1 then
    raise exception 'CHECK FAIL: production smoke expects exactly 1 owner';
  end if;

  insert into auth.users (id, instance_id, aud, role, email) values
    (v_staff, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-sal-staff@bmq.invalid'),
    (v_viewer, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-sal-viewer@bmq.invalid'),
    (v_editor, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-sal-editor@bmq.invalid');

  insert into public.user_module_permissions (user_id, module_key, can_view, can_edit) values
    (v_viewer, 'salary_cash', true, false),
    (v_editor, 'salary_cash', true, true);

  insert into public.payroll_bn_periods (
    id, period_code, period_name, date_from, date_to,
    default_standard_days, standard_days_by_group, holidays, rules_config, status
  ) values (
    v_period, 'SMOKE.SAL', 'Smoke lương tháng 09', '2099-09-01', '2099-09-30',
    26, '{"Văn phòng":22,"Bếp bánh":26,"Kho BN":26}', '[]', '{}', 'draft'
  );

  insert into public.payroll_bn_payslips (
    period_id, employee_code, employee_name, group_name, period_name,
    date_from, date_to, net_pay, lines, published_by
  ) values
    (v_period, 'SMK01', 'Smoke A', 'Bếp bánh', 'Smoke lương tháng 09', '2099-09-01', '2099-09-30', 5000000, '[]', v_owner),
    (v_period, 'SMK02', 'Smoke B', 'Bếp bánh', 'Smoke lương tháng 09', '2099-09-01', '2099-09-30', 6000000, '[]', v_owner),
    (v_period, 'SMK03', 'Smoke C', 'Bếp bánh', 'Smoke lương tháng 09', '2099-09-01', '2099-09-30', 7000000, '[]', v_owner);

  -- payroll_bn fingerprint before any salary RPC runs.
  select md5(string_agg(
    p.employee_code || ':' || p.net_pay::text || ':' || p.published_at::text,
    '|' order by p.employee_code
  )) into v_before
  from public.payroll_bn_payslips p where p.period_id = v_period;
  v_log := v_log || 'fixtures ok; ';

  -- -------------------------------------------------------------------------
  -- 3. Owner creates the payout: 3 lines + one created event without amounts.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  v_result := public.create_salary_payout(v_period, 'smoke-salary-create-1');
  v_payout := (v_result->>'payout_id')::uuid;
  if coalesce((v_result->>'employee_count')::int, 0) <> 3 then
    raise exception 'CHECK FAIL: create employee_count = %', v_result->>'employee_count';
  end if;
  if (v_result->>'payout_number') !~ '^SAL-[0-9]{6}-[0-9]{2,}$' then
    raise exception 'CHECK FAIL: create payout_number = %', v_result->>'payout_number';
  end if;
  if (select count(*) from public.salary_payout_lines where payout_id = v_payout) <> 3 then
    raise exception 'CHECK FAIL: expected 3 salary lines';
  end if;
  if (select status from public.salary_payouts where id = v_payout) <> 'pending' then
    raise exception 'CHECK FAIL: new payout is not pending';
  end if;
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.finance_zalo_notifications
      where event_type = 'salary_payout_created' and entity_id = v_payout) <> 1 then
    raise exception 'CHECK FAIL: expected exactly one salary_payout_created row';
  end if;
  if exists (
    select 1 from public.finance_zalo_notifications
    where entity_id = v_payout and message_body ~ '[0-9]{1,3}(\.[0-9]{3})+'
  ) then
    raise exception 'CHECK FAIL: a salary outbox message contains an amount';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'create -> 3 lines + one amount-free created event; ';

  -- -------------------------------------------------------------------------
  -- 4. Same-key replay returns the same payout; a second payout is refused.
  -- -------------------------------------------------------------------------
  v_prior := v_payout;
  v_result := public.create_salary_payout(v_period, 'smoke-salary-create-1');
  if (v_result->>'payout_id')::uuid <> v_prior then
    raise exception 'CHECK FAIL: replay returned a different payout';
  end if;
  if coalesce((v_result->>'replayed')::boolean, false) is not true then
    raise exception 'CHECK FAIL: replay did not return replayed=true';
  end if;
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.finance_zalo_notifications
      where event_type = 'salary_payout_created' and entity_id = v_payout) <> 1 then
    raise exception 'CHECK FAIL: replay enqueued a second created row';
  end if;
  perform set_config('role', 'authenticated', true);

  v_ok := false;
  begin
    perform public.create_salary_payout(v_period, 'smoke-salary-create-2');
  exception when others then
    v_ok := sqlerrm like '%payout_already_exists%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a second payout for the period was accepted'; end if;
  v_log := v_log || 'replay + duplicate-period refused; ';

  -- -------------------------------------------------------------------------
  -- 5. staff without salary_cash cannot select or create.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.salary_payouts where id = v_payout;
  if v_count <> 0 then
    raise exception 'CHECK FAIL: staff without salary_cash can read the payout';
  end if;
  v_ok := false;
  begin
    perform public.create_salary_payout(v_period, 'smoke-salary-staff-create');
  exception when others then
    v_ok := sqlerrm like '%insufficient_privilege%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: staff without salary_cash could create a payout'; end if;
  v_log := v_log || 'staff denied read+create; ';

  -- -------------------------------------------------------------------------
  -- 6. salary_cash view user reads but cannot create.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_viewer, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.salary_payouts where id = v_payout;
  if v_count <> 1 then
    raise exception 'CHECK FAIL: salary_cash view user cannot read the payout';
  end if;
  v_result := public.get_salary_payout(v_payout);
  if (v_result->'payout'->>'id')::uuid <> v_payout then
    raise exception 'CHECK FAIL: get_salary_payout returned the wrong payout';
  end if;
  if jsonb_array_length(v_result->'lines') <> 3 then
    raise exception 'CHECK FAIL: get_salary_payout lines <> 3';
  end if;
  v_ok := false;
  begin
    perform public.create_salary_payout(v_period, 'smoke-salary-viewer-create');
  exception when others then
    v_ok := sqlerrm like '%insufficient_privilege%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: salary_cash view user could create a payout'; end if;
  v_log := v_log || 'view reads, cannot create; ';

  -- -------------------------------------------------------------------------
  -- 7. Non-owner cannot record the CEO payment.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_editor, 'role', 'authenticated')::text, true);
  v_ok := false;
  begin
    perform public.record_salary_payout_ceo_payment(
      v_payout,
      jsonb_build_object(
        'storage_path', 'payment-unc/salary/smoke/ceo.jpg',
        'file_sha256', encode(sha256(convert_to('smoke-salary-ceo', 'UTF8')), 'hex'),
        'ocr_amount', 18000000
      ),
      'smoke-salary-ceo-editor'
    );
  exception when others then
    v_ok := sqlerrm like '%insufficient_privilege%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a non-owner recorded the CEO payment'; end if;
  v_log := v_log || 'non-owner CEO record denied; ';

  -- -------------------------------------------------------------------------
  -- 8. Owner records the CEO payment -> advanced + one event.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_result := public.record_salary_payout_ceo_payment(
    v_payout,
    jsonb_build_object(
      'storage_path', 'payment-unc/salary/smoke/ceo.jpg',
      'file_sha256', encode(sha256(convert_to('smoke-salary-ceo', 'UTF8')), 'hex'),
      'ocr_amount', 18000000
    ),
    'smoke-salary-ceo-1'
  );
  if v_result->>'status' <> 'advanced' then
    raise exception 'CHECK FAIL: CEO record status = %', v_result->>'status';
  end if;
  if (select status from public.salary_payouts where id = v_payout) <> 'advanced' then
    raise exception 'CHECK FAIL: payout did not move to advanced';
  end if;
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.finance_zalo_notifications
      where event_type = 'salary_payout_advanced' and entity_id = v_payout) <> 1 then
    raise exception 'CHECK FAIL: expected exactly one salary_payout_advanced row';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'owner -> advanced + one event; ';

  -- -------------------------------------------------------------------------
  -- 9. Employee receipts are inserted as the service role (edge-function path).
  -- -------------------------------------------------------------------------
  perform set_config('role', 'service_role', true);
  insert into public.salary_payout_receipts (
    payout_id, storage_path, file_sha256, ocr_amount, ocr_beneficiary, ocr_reference, status
  ) values
    (v_payout, 'payment-unc/salary/smoke/r1.jpg', encode(sha256(convert_to('smoke-sal-r1', 'UTF8')), 'hex'), 5000000, 'Smoke A', 'REF1', 'uploaded'),
    (v_payout, 'payment-unc/salary/smoke/r2.jpg', encode(sha256(convert_to('smoke-sal-r2', 'UTF8')), 'hex'), 6000000, 'Smoke B', 'REF2', 'uploaded'),
    (v_payout, 'payment-unc/salary/smoke/r3.jpg', encode(sha256(convert_to('smoke-sal-r3', 'UTF8')), 'hex'), 7000000, 'Smoke C', 'REF3', 'uploaded'),
    (v_payout, 'payment-unc/salary/smoke/r-bad.jpg', encode(sha256(convert_to('smoke-sal-rbad', 'UTF8')), 'hex'), 4999999, 'Smoke A', 'REFBAD', 'uploaded');
  perform set_config('role', 'authenticated', true);
  if (select count(*) from public.salary_payout_receipts where payout_id = v_payout) <> 4 then
    raise exception 'CHECK FAIL: service role did not insert 4 receipts';
  end if;
  v_log := v_log || 'service-role receipts inserted; ';

  -- -------------------------------------------------------------------------
  -- 10. Wrong-amount match is rejected.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_ok := false;
  begin
    perform public.submit_salary_payout_matches(
      v_payout,
      jsonb_build_array(jsonb_build_object(
        'receipt_id', (select id from public.salary_payout_receipts where payout_id = v_payout and storage_path like '%r-bad.jpg'),
        'line_id', (select id from public.salary_payout_lines where payout_id = v_payout and employee_code = 'SMK01')
      )),
      'smoke-salary-match-bad'
    );
  exception when others then
    v_ok := sqlerrm like '%amount_mismatch%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a wrong-amount match was accepted'; end if;
  if (select count(*) from public.salary_payout_lines where payout_id = v_payout and matched_at is not null) <> 0 then
    raise exception 'CHECK FAIL: a rejected match partially wrote a line';
  end if;
  v_log := v_log || 'wrong amount rejected; ';

  -- -------------------------------------------------------------------------
  -- 11. Matching every line completes the payout + one completed event.
  -- -------------------------------------------------------------------------
  v_result := public.submit_salary_payout_matches(
    v_payout,
    jsonb_build_array(
      jsonb_build_object(
        'receipt_id', (select id from public.salary_payout_receipts where payout_id = v_payout and storage_path like '%r1.jpg'),
        'line_id', (select id from public.salary_payout_lines where payout_id = v_payout and employee_code = 'SMK01')
      ),
      jsonb_build_object(
        'receipt_id', (select id from public.salary_payout_receipts where payout_id = v_payout and storage_path like '%r2.jpg'),
        'line_id', (select id from public.salary_payout_lines where payout_id = v_payout and employee_code = 'SMK02')
      ),
      jsonb_build_object(
        'receipt_id', (select id from public.salary_payout_receipts where payout_id = v_payout and storage_path like '%r3.jpg'),
        'line_id', (select id from public.salary_payout_lines where payout_id = v_payout and employee_code = 'SMK03')
      )
    ),
    'smoke-salary-match-1'
  );
  if v_result->>'status' <> 'completed' then
    raise exception 'CHECK FAIL: match status = %', v_result->>'status';
  end if;
  if (select count(*) from public.salary_payout_lines where payout_id = v_payout and matched_at is not null) <> 3 then
    raise exception 'CHECK FAIL: not every salary line is matched';
  end if;
  if (select status from public.salary_payouts where id = v_payout) <> 'completed' then
    raise exception 'CHECK FAIL: payout is not completed';
  end if;
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.finance_zalo_notifications
      where event_type = 'salary_payout_completed' and entity_id = v_payout) <> 1 then
    raise exception 'CHECK FAIL: expected exactly one salary_payout_completed row';
  end if;

  -- -------------------------------------------------------------------------
  -- 12. No outbox message for this payout contains a net-pay amount, and the
  --     payroll_bn data fingerprint is unchanged.
  -- -------------------------------------------------------------------------
  if exists (
    select 1 from public.finance_zalo_notifications n
    where n.entity_id = v_payout
      and (
        n.message_body ~ '[0-9]{1,3}(\.[0-9]{3})+'
        or n.message_body like '%5000000%'
        or n.message_body like '%5.000.000%'
        or n.message_body like '%6000000%'
        or n.message_body like '%6.000.000%'
        or n.message_body like '%7000000%'
        or n.message_body like '%7.000.000%'
      )
  ) then
    raise exception 'CHECK FAIL: an outbox message leaks a net-pay amount';
  end if;

  select md5(string_agg(
    p.employee_code || ':' || p.net_pay::text || ':' || p.published_at::text,
    '|' order by p.employee_code
  )) into v_after
  from public.payroll_bn_payslips p where p.period_id = v_period;
  if v_after is distinct from v_before then
    raise exception 'CHECK FAIL: payroll_bn_payslips changed during the salary flow';
  end if;
  if (select count(*) from public.payroll_bn_period_employees where period_id = v_period) <> 0 then
    raise exception 'CHECK FAIL: the salary flow wrote to payroll_bn_period_employees';
  end if;
  v_log := v_log || 'no amount leaked, payroll_bn unchanged; ';

  raise exception 'SMOKE_RESULT PASS: %', v_log;
end $$;
