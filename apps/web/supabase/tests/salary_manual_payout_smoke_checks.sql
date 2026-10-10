-- Rollback-only production smoke CHECKS for migration
-- 20261012150000_salary_manual_payout.sql (Lương lẻ — manual salary payout).
--
-- Run as one file: `begin; <migration>; <this file>` (the caller wraps the
-- migration and these checks in a transaction). This file contains CHECKS ONLY
-- and never copies the migration. The final RAISE ends the transaction, so every
-- fixture created here is rolled back. It assumes production has exactly 1 owner
-- and that public.audit_logs exists.
do $$
declare
  v_owner uuid;
  v_staff uuid := gen_random_uuid();
  v_viewer uuid := gen_random_uuid();
  v_editor uuid := gen_random_uuid();
  v_period uuid := gen_random_uuid();
  v_manual uuid;
  v_q7 uuid;
  v_result jsonb;
  v_replay uuid;
  v_count integer;
  v_line_count integer;
  v_ok boolean;
  v_row record;
  v_before text;
  v_after text;
  v_log text := '';
  v_source text;
  v_period_ref uuid;
  v_emp_count integer;
  v_total numeric;
  v_period_name text;
  v_note text;
  v_lines jsonb;
begin
  -- -------------------------------------------------------------------------
  -- 1. Schema, constraints, grants and RPCs exist.
  -- -------------------------------------------------------------------------
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'salary_payouts'
      and column_name = 'source'
      and is_nullable = 'NO'
      and column_default like '%payroll_q7%'
  ) then
    raise exception 'CHECK FAIL: salary_payouts.source is missing/not defaulted';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'salary_payouts'
      and column_name = 'payroll_period_id'
      and is_nullable = 'YES'
  ) then
    raise exception 'CHECK FAIL: salary_payouts.payroll_period_id is still not null';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'salary_payout_lines'
      and column_name = 'note'
  ) then
    raise exception 'CHECK FAIL: salary_payout_lines.note is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.salary_payouts'::regclass
      and conname = 'salary_payouts_source_check'
  ) then
    raise exception 'CHECK FAIL: salary_payouts_source_check is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.salary_payouts'::regclass
      and conname = 'salary_payouts_source_period_check'
  ) then
    raise exception 'CHECK FAIL: salary_payouts_source_period_check is missing';
  end if;

  if has_function_privilege('anon', to_regprocedure('public.create_manual_salary_payout(jsonb,text)'), 'execute') then
    raise exception 'CHECK FAIL: anon can execute create_manual_salary_payout';
  end if;
  if not has_function_privilege('authenticated', to_regprocedure('public.create_manual_salary_payout(jsonb,text)'), 'execute') then
    raise exception 'CHECK FAIL: authenticated cannot execute create_manual_salary_payout';
  end if;
  if not has_function_privilege('service_role', to_regprocedure('public.create_manual_salary_payout(jsonb,text)'), 'execute') then
    raise exception 'CHECK FAIL: service_role cannot execute create_manual_salary_payout';
  end if;
  v_log := v_log || 'schema/constraints/grants ok; ';

  -- -------------------------------------------------------------------------
  -- 2. Fixtures: the existing owner + rollback-only users and a payroll period
  --    for the Q7 regression check.
  -- -------------------------------------------------------------------------
  select user_id into v_owner from public.user_roles where role = 'owner' limit 1;
  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user';
  end if;
  if (select count(*) from public.user_roles where role = 'owner') <> 1 then
    raise exception 'CHECK FAIL: production smoke expects exactly 1 owner';
  end if;

  insert into auth.users (id, instance_id, aud, role, email) values
    (v_staff, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-manual-staff@bmq.invalid'),
    (v_viewer, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-manual-viewer@bmq.invalid'),
    (v_editor, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-manual-editor@bmq.invalid');

  insert into public.user_module_permissions (user_id, module_key, can_view, can_edit) values
    (v_viewer, 'salary_cash', true, false),
    (v_editor, 'salary_cash', true, true);

  insert into public.payroll_bn_periods (
    id, period_code, period_name, date_from, date_to,
    default_standard_days, standard_days_by_group, holidays, rules_config, status
  ) values (
    v_period, 'SMOKE.MANUAL', 'Smoke lương manual', '2099-10-01', '2099-10-31',
    26, '{"Văn phòng":22,"Bếp bánh":26,"Kho BN":26}', '[]', '{}', 'draft'
  );

  insert into public.payroll_bn_payslips (
    period_id, employee_code, employee_name, group_name, period_name,
    date_from, date_to, net_pay, lines, published_by
  ) values
    (v_period, 'SMKM01', 'Smoke Q7 A', 'Bếp bánh', 'Smoke lương manual', '2099-10-01', '2099-10-31', 5000000, '[]', v_owner),
    (v_period, 'SMKM02', 'Smoke Q7 B', 'Bếp bánh', 'Smoke lương manual', '2099-10-01', '2099-10-31', 6000000, '[]', v_owner);

  select md5(string_agg(
    p.employee_code || ':' || p.net_pay::text || ':' || p.published_at::text,
    '|' order by p.employee_code
  )) into v_before
  from public.payroll_bn_payslips p where p.period_id = v_period;
  v_log := v_log || 'fixtures ok; ';

  -- -------------------------------------------------------------------------
  -- 3. Direct writes cannot break the source/period coherence.
  -- -------------------------------------------------------------------------
  perform set_config('role', 'postgres', true);
  v_ok := false;
  begin
    insert into public.salary_payouts (
      payout_number, payroll_period_id, period_name, employee_count, total_amount, status, source
    ) values ('SMOKE-MAN-PERIOD', v_period, 'bad', 1, 1000, 'pending', 'manual');
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'CHECK FAIL: manual with a period was accepted'; end if;

  v_ok := false;
  begin
    insert into public.salary_payouts (
      payout_number, payroll_period_id, period_name, employee_count, total_amount, status, source
    ) values ('SMOKE-Q7-NOPERIOD', null, 'bad', 1, 1000, 'pending', 'payroll_q7');
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'CHECK FAIL: payroll_q7 without a period was accepted'; end if;

  v_ok := false;
  begin
    insert into public.salary_payouts (
      payout_number, payroll_period_id, period_name, employee_count, total_amount, status, source
    ) values ('SMOKE-BAD-SOURCE', v_period, 'bad', 1, 1000, 'pending', 'other');
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'CHECK FAIL: an unknown source was accepted'; end if;
  v_log := v_log || 'source/period constraints enforced; ';

  -- -------------------------------------------------------------------------
  -- 4. Owner creates a manual (Lương lẻ) payout: 2 lines, no period, right
  --    total, LL-01.. codes, one amount-free created event + one audit row.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  v_result := public.create_manual_salary_payout(
    jsonb_build_object(
      'title', 'Lương lẻ ngoài bếp Q7',
      'lines', jsonb_build_array(
        jsonb_build_object('employee_name', 'Lẻ A', 'amount', 1500000, 'note', 'Thử việc'),
        jsonb_build_object('employee_name', 'Lẻ B', 'amount', 2500000)
      )
    ),
    'smoke-manual-create-1'
  );
  v_manual := (v_result->>'payout_id')::uuid;
  if v_result->>'source' <> 'manual' then
    raise exception 'CHECK FAIL: create result source = %', v_result->>'source';
  end if;
  if (v_result->>'payout_number') !~ '^SAL-[0-9]{6}-[0-9]{2,}$' then
    raise exception 'CHECK FAIL: manual payout_number = %', v_result->>'payout_number';
  end if;
  if coalesce((v_result->>'total_amount')::numeric, 0) <> 4000000 then
    raise exception 'CHECK FAIL: manual total = %', v_result->>'total_amount';
  end if;
  if coalesce((v_result->>'employee_count')::int, 0) <> 2 then
    raise exception 'CHECK FAIL: manual employee_count = %', v_result->>'employee_count';
  end if;

  select source, payroll_period_id, total_amount, employee_count, period_name
    into v_source, v_period_ref, v_total, v_emp_count, v_period_name
  from public.salary_payouts where id = v_manual;
  if v_source <> 'manual' then
    raise exception 'CHECK FAIL: stored source = %', v_source;
  end if;
  if v_period_ref is not null then
    raise exception 'CHECK FAIL: manual payout has a payroll_period_id';
  end if;
  if v_total <> 4000000 or v_emp_count <> 2 then
    raise exception 'CHECK FAIL: stored manual header is wrong';
  end if;
  if v_period_name <> 'Lương lẻ ngoài bếp Q7' then
    raise exception 'CHECK FAIL: title was not stored in period_name';
  end if;
  if (select status from public.salary_payouts where id = v_manual) <> 'pending' then
    raise exception 'CHECK FAIL: manual payout is not pending';
  end if;

  select count(*) into v_line_count from public.salary_payout_lines where payout_id = v_manual;
  if v_line_count <> 2 then
    raise exception 'CHECK FAIL: expected 2 manual lines, got %', v_line_count;
  end if;
  select count(*) into v_line_count
  from public.salary_payout_lines
  where payout_id = v_manual and employee_code in ('LL-01', 'LL-02');
  if v_line_count <> 2 then
    raise exception 'CHECK FAIL: generated employee codes are not LL-01/LL-02';
  end if;
  select note into v_note
  from public.salary_payout_lines
  where payout_id = v_manual and employee_name = 'Lẻ A';
  if v_note <> 'Thử việc' then
    raise exception 'CHECK FAIL: manual line note was not stored';
  end if;

  perform set_config('role', 'postgres', true);
  if (select count(*) from public.finance_zalo_notifications
      where event_type = 'salary_payout_created' and entity_id = v_manual) <> 1 then
    raise exception 'CHECK FAIL: expected exactly one manual salary_payout_created row';
  end if;
  if exists (
    select 1 from public.finance_zalo_notifications
    where entity_id = v_manual
      and (
        message_body ~ '[0-9]{1,3}(\.[0-9]{3})+'
        or message_body like '%1500000%' or message_body like '%1.500.000%'
        or message_body like '%2500000%' or message_body like '%2.500.000%'
        or message_body like '%4000000%' or message_body like '%4.000.000%'
      )
  ) then
    raise exception 'CHECK FAIL: a manual outbox message leaks an amount';
  end if;
  if (select count(*) from public.audit_logs
      where action = 'salary_payout_manual_created' and target_id = v_manual) <> 1 then
    raise exception 'CHECK FAIL: expected exactly one manual audit_logs row';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'manual create -> 2 lines + amount-free event + audit; ';

  -- -------------------------------------------------------------------------
  -- 5. Same-key replay returns the same payout and never duplicates rows.
  -- -------------------------------------------------------------------------
  v_replay := v_manual;
  v_result := public.create_manual_salary_payout(
    jsonb_build_object(
      'title', 'Lương lẻ ngoài bếp Q7',
      'lines', jsonb_build_array(
        jsonb_build_object('employee_name', 'Lẻ A', 'amount', 1500000, 'note', 'Thử việc'),
        jsonb_build_object('employee_name', 'Lẻ B', 'amount', 2500000)
      )
    ),
    'smoke-manual-create-1'
  );
  if (v_result->>'payout_id')::uuid <> v_replay then
    raise exception 'CHECK FAIL: manual replay returned a different payout';
  end if;
  if coalesce((v_result->>'replayed')::boolean, false) is not true then
    raise exception 'CHECK FAIL: manual replay did not return replayed=true';
  end if;
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.salary_payout_lines where payout_id = v_manual) <> 2 then
    raise exception 'CHECK FAIL: replay duplicated manual lines';
  end if;
  if (select count(*) from public.finance_zalo_notifications
      where event_type = 'salary_payout_created' and entity_id = v_manual) <> 1 then
    raise exception 'CHECK FAIL: replay enqueued a second manual created row';
  end if;
  if (select count(*) from public.audit_logs
      where action = 'salary_payout_manual_created' and target_id = v_manual) <> 1 then
    raise exception 'CHECK FAIL: replay wrote a second audit row';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'same-key replay idempotent; ';

  -- -------------------------------------------------------------------------
  -- 6. Invalid inputs are rejected.
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.create_manual_salary_payout(
      jsonb_build_object('title', 'Rỗng', 'lines', '[]'::jsonb),
      'smoke-manual-empty'
    );
  exception when others then v_ok := sqlerrm like '%lines_required%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: 0 lines was accepted'; end if;

  v_ok := false;
  begin
    perform public.create_manual_salary_payout(
      jsonb_build_object('title', 'Trống tên', 'lines', jsonb_build_array(
        jsonb_build_object('employee_name', '   ', 'amount', 1000)
      )),
      'smoke-manual-blank-name'
    );
  exception when others then v_ok := sqlerrm like '%employee_name_required%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a blank employee name was accepted'; end if;

  v_ok := false;
  begin
    perform public.create_manual_salary_payout(
      jsonb_build_object('title', 'Tiền 0', 'lines', jsonb_build_array(
        jsonb_build_object('employee_name', 'Lẻ A', 'amount', 0)
      )),
      'smoke-manual-zero'
    );
  exception when others then v_ok := sqlerrm like '%invalid_amount%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: amount 0 was accepted'; end if;

  v_ok := false;
  begin
    perform public.create_manual_salary_payout(
      jsonb_build_object('title', 'Quá hạn mức', 'lines', jsonb_build_array(
        jsonb_build_object('employee_name', 'Lẻ A', 'amount', 200000001)
      )),
      'smoke-manual-over'
    );
  exception when others then v_ok := sqlerrm like '%invalid_amount%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: an over-limit amount was accepted'; end if;

  select jsonb_agg(jsonb_build_object('employee_name', 'Lẻ ' || g, 'amount', 200000000))
    into v_lines
  from generate_series(1, 11) g;
  v_ok := false;
  begin
    perform public.create_manual_salary_payout(
      jsonb_build_object('title', 'Tổng quá lớn', 'lines', v_lines),
      'smoke-manual-total'
    );
  exception when others then v_ok := sqlerrm like '%total_exceeds_limit%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a total above 2,000,000,000 was accepted'; end if;

  v_ok := false;
  begin
    perform public.create_manual_salary_payout(
      jsonb_build_object('title', repeat('x', 121), 'lines', jsonb_build_array(
        jsonb_build_object('employee_name', 'Lẻ A', 'amount', 1000)
      )),
      'smoke-manual-title'
    );
  exception when others then v_ok := sqlerrm like '%invalid_title%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: an over-long title was accepted'; end if;
  v_log := v_log || 'invalid inputs rejected; ';

  -- -------------------------------------------------------------------------
  -- 7. Staff without salary_cash cannot select or create.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  select count(*) into v_count from public.salary_payouts where id = v_manual;
  if v_count <> 0 then
    raise exception 'CHECK FAIL: staff without salary_cash can read the manual payout';
  end if;
  v_ok := false;
  begin
    perform public.create_manual_salary_payout(
      jsonb_build_object('title', 'Staff', 'lines', jsonb_build_array(
        jsonb_build_object('employee_name', 'Lẻ A', 'amount', 1000)
      )),
      'smoke-manual-staff'
    );
  exception when others then v_ok := sqlerrm like '%insufficient_privilege%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: staff without salary_cash could create a manual payout'; end if;

  -- -------------------------------------------------------------------------
  -- 8. salary_cash view reads source/note but cannot create.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_viewer, 'role', 'authenticated')::text, true);
  v_result := public.get_salary_payout(v_manual);
  if v_result->'payout'->>'source' <> 'manual' then
    raise exception 'CHECK FAIL: get_salary_payout source = %', v_result->'payout'->>'source';
  end if;
  if v_result->'payout'->>'payroll_period_id' is not null then
    raise exception 'CHECK FAIL: get_salary_payout returned a manual payroll_period_id';
  end if;
  if jsonb_array_length(v_result->'lines') <> 2 then
    raise exception 'CHECK FAIL: get_salary_payout manual lines <> 2';
  end if;
  if v_result->'lines'->0->>'note' is null then
    raise exception 'CHECK FAIL: get_salary_payout dropped the line note';
  end if;
  v_ok := false;
  begin
    perform public.create_manual_salary_payout(
      jsonb_build_object('title', 'Viewer', 'lines', jsonb_build_array(
        jsonb_build_object('employee_name', 'Lẻ A', 'amount', 1000)
      )),
      'smoke-manual-viewer'
    );
  exception when others then v_ok := sqlerrm like '%insufficient_privilege%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: salary_cash view could create a manual payout'; end if;
  v_log := v_log || 'staff denied, viewer reads source+note; ';

  -- -------------------------------------------------------------------------
  -- 9. Non-owner cannot record the CEO payment; owner -> advanced.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_editor, 'role', 'authenticated')::text, true);
  v_ok := false;
  begin
    perform public.record_salary_payout_ceo_payment(
      v_manual,
      jsonb_build_object(
        'storage_path', 'payment-unc/salary/smoke-manual/ceo.jpg',
        'file_sha256', encode(sha256(convert_to('smoke-manual-ceo-editor', 'UTF8')), 'hex'),
        'ocr_amount', 4000000
      ),
      'smoke-manual-ceo-editor'
    );
  exception when others then v_ok := sqlerrm like '%insufficient_privilege%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a non-owner recorded the manual CEO payment'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_result := public.record_salary_payout_ceo_payment(
    v_manual,
    jsonb_build_object(
      'storage_path', 'payment-unc/salary/smoke-manual/ceo.jpg',
      'file_sha256', encode(sha256(convert_to('smoke-manual-ceo', 'UTF8')), 'hex'),
      'ocr_amount', 4000000
    ),
    'smoke-manual-ceo-1'
  );
  if v_result->>'status' <> 'advanced' then
    raise exception 'CHECK FAIL: manual CEO status = %', v_result->>'status';
  end if;
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.finance_zalo_notifications
      where event_type = 'salary_payout_advanced' and entity_id = v_manual) <> 1 then
    raise exception 'CHECK FAIL: expected exactly one manual salary_payout_advanced row';
  end if;
  if exists (
    select 1 from public.finance_zalo_notifications
    where entity_id = v_manual
      and message_body ~ '[0-9]{1,3}(\.[0-9]{3})+'
  ) then
    raise exception 'CHECK FAIL: a manual advanced outbox message leaks an amount';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'owner -> advanced + one amount-free event; ';

  -- -------------------------------------------------------------------------
  -- 10. Service role inserts the two employee receipts.
  -- -------------------------------------------------------------------------
  perform set_config('role', 'service_role', true);
  insert into public.salary_payout_receipts (
    payout_id, storage_path, file_sha256, ocr_amount, ocr_beneficiary, ocr_reference, status
  ) values
    (v_manual, 'payment-unc/salary/smoke-manual/r1.jpg', encode(sha256(convert_to('smoke-manual-r1', 'UTF8')), 'hex'), 1500000, 'Lẻ A', 'REF1', 'uploaded'),
    (v_manual, 'payment-unc/salary/smoke-manual/r2.jpg', encode(sha256(convert_to('smoke-manual-r2', 'UTF8')), 'hex'), 2500000, 'Lẻ B', 'REF2', 'uploaded');
  perform set_config('role', 'authenticated', true);
  if (select count(*) from public.salary_payout_receipts where payout_id = v_manual) <> 2 then
    raise exception 'CHECK FAIL: service role did not insert 2 manual receipts';
  end if;
  v_log := v_log || 'service-role receipts inserted; ';

  -- -------------------------------------------------------------------------
  -- 11. Matching both lines completes the manual payout + one completed event.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_result := public.submit_salary_payout_matches(
    v_manual,
    jsonb_build_array(
      jsonb_build_object(
        'receipt_id', (select id from public.salary_payout_receipts where payout_id = v_manual and storage_path like '%r1.jpg'),
        'line_id', (select id from public.salary_payout_lines where payout_id = v_manual and employee_code = 'LL-01')
      ),
      jsonb_build_object(
        'receipt_id', (select id from public.salary_payout_receipts where payout_id = v_manual and storage_path like '%r2.jpg'),
        'line_id', (select id from public.salary_payout_lines where payout_id = v_manual and employee_code = 'LL-02')
      )
    ),
    'smoke-manual-match-1'
  );
  if v_result->>'status' <> 'completed' then
    raise exception 'CHECK FAIL: manual match status = %', v_result->>'status';
  end if;
  if (select status from public.salary_payouts where id = v_manual) <> 'completed' then
    raise exception 'CHECK FAIL: manual payout is not completed';
  end if;
  perform set_config('role', 'postgres', true);
  if (select count(*) from public.finance_zalo_notifications
      where event_type = 'salary_payout_completed' and entity_id = v_manual) <> 1 then
    raise exception 'CHECK FAIL: expected exactly one manual salary_payout_completed row';
  end if;
  if exists (
    select 1 from public.finance_zalo_notifications
    where entity_id = v_manual
      and message_body ~ '[0-9]{1,3}(\.[0-9]{3})+'
  ) then
    raise exception 'CHECK FAIL: a manual completed outbox message leaks an amount';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'manual flow completed; ';

  -- -------------------------------------------------------------------------
  -- 12. Q7 regression: a period payout still works, a second one is refused.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_result := public.create_salary_payout(v_period, 'smoke-manual-q7-1');
  v_q7 := (v_result->>'payout_id')::uuid;
  if (select source from public.salary_payouts where id = v_q7) <> 'payroll_q7' then
    raise exception 'CHECK FAIL: Q7 payout source is not payroll_q7';
  end if;
  if (select payroll_period_id from public.salary_payouts where id = v_q7) is distinct from v_period then
    raise exception 'CHECK FAIL: Q7 payout lost its period';
  end if;
  v_ok := false;
  begin
    perform public.create_salary_payout(v_period, 'smoke-manual-q7-2');
  exception when others then v_ok := sqlerrm like '%payout_already_exists%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a second Q7 payout for the period was accepted'; end if;
  v_log := v_log || 'Q7 path + one-payout-per-period preserved; ';

  -- -------------------------------------------------------------------------
  -- 13. payroll_bn untouched.
  -- -------------------------------------------------------------------------
  perform set_config('role', 'postgres', true);
  select md5(string_agg(
    p.employee_code || ':' || p.net_pay::text || ':' || p.published_at::text,
    '|' order by p.employee_code
  )) into v_after
  from public.payroll_bn_payslips p where p.period_id = v_period;
  if v_after is distinct from v_before then
    raise exception 'CHECK FAIL: payroll_bn_payslips changed during the manual flow';
  end if;
  if (select count(*) from public.payroll_bn_period_employees where period_id = v_period) <> 0 then
    raise exception 'CHECK FAIL: the manual flow wrote to payroll_bn_period_employees';
  end if;
  v_log := v_log || 'payroll_bn unchanged; ';

  raise exception 'SMOKE_RESULT PASS: %', v_log;
end $$;
