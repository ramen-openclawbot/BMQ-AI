-- Rollback-only production smoke CHECKS for migration
-- 20261012100000_cash_settlement_flow.sql.
--
-- Run as one file: `begin; <migration>; <this file>` (the caller wraps the
-- migration and these checks in a transaction). This file contains CHECKS ONLY
-- and never copies the migration. The final RAISE ends the transaction, so every
-- fixture created here is rolled back. It assumes production has exactly 1 owner.
do $$
declare
  v_owner uuid;
  v_staff uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_cash_pr uuid := gen_random_uuid();
  v_bank_pr uuid := gen_random_uuid();
  v_item_a uuid;
  v_item_b uuid;
  v_r1 uuid := gen_random_uuid();
  v_r2 uuid := gen_random_uuid();
  v_r3 uuid := gen_random_uuid();
  v_r4 uuid := gen_random_uuid();
  v_r_foreign uuid := gen_random_uuid();
  v_sha_evidence_cash text;
  v_sha_evidence_bank text;
  v_result jsonb;
  v_count integer;
  v_status text;
  v_ok boolean;
  v_row record;
  v_log text := '';
begin
  -- -------------------------------------------------------------------------
  -- 1. Old CEO cash-expense objects are gone.
  -- -------------------------------------------------------------------------
  if to_regclass('public.ceo_cash_expense_drafts') is not null then
    raise exception 'CHECK FAIL: ceo_cash_expense_drafts still exists';
  end if;
  if exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('record_ceo_cash_expense', 'discard_ceo_cash_expense_draft')
  ) then
    raise exception 'CHECK FAIL: an old CEO cash RPC still exists';
  end if;
  v_log := v_log || 'old CEO objects gone; ';

  -- -------------------------------------------------------------------------
  -- 2. New columns / tables / grants / RLS / event check.
  -- -------------------------------------------------------------------------
  for v_row in
    select unnest(array[
      'cash_settlement_status', 'cash_settled_at', 'cash_settled_by'
    ]) as column_name
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'payment_requests'
        and column_name = v_row.column_name
    ) then
      raise exception 'CHECK FAIL: payment_requests.% missing', v_row.column_name;
    end if;
  end loop;

  for v_row in
    select unnest(array[
      'payment_request_attachments', 'payment_cash_receipts',
      'payment_cash_settlement_idempotency'
    ]) as table_name
  loop
    if not exists (
      select 1 from pg_class
      where oid = ('public.' || v_row.table_name)::regclass and relrowsecurity
    ) then
      raise exception 'CHECK FAIL: RLS off on %', v_row.table_name;
    end if;
  end loop;

  if not has_table_privilege('authenticated', 'public.payment_request_attachments', 'select') then
    raise exception 'CHECK FAIL: no authenticated select on payment_request_attachments';
  end if;
  if not has_table_privilege('authenticated', 'public.payment_request_attachments', 'insert') then
    raise exception 'CHECK FAIL: no authenticated insert on payment_request_attachments';
  end if;
  if not has_table_privilege('authenticated', 'public.payment_cash_receipts', 'select') then
    raise exception 'CHECK FAIL: no authenticated select on payment_cash_receipts';
  end if;
  if has_table_privilege('authenticated', 'public.payment_cash_receipts', 'insert') then
    raise exception 'CHECK FAIL: authenticated can insert payment_cash_receipts directly';
  end if;
  if has_table_privilege('authenticated', 'public.payment_cash_settlement_idempotency', 'select') then
    raise exception 'CHECK FAIL: authenticated can read the settlement idempotency ledger';
  end if;
  if has_table_privilege('anon', 'public.payment_request_attachments', 'select')
     or has_table_privilege('anon', 'public.payment_cash_receipts', 'select') then
    raise exception 'CHECK FAIL: anon can read cash-settlement tables';
  end if;

  if has_function_privilege('anon', to_regprocedure('public.submit_cash_settlement(uuid,jsonb,text)'), 'execute')
     or has_function_privilege('anon', to_regprocedure('public.discard_cash_receipt(uuid)'), 'execute')
     or has_function_privilege('anon', to_regprocedure('public.get_cash_settlement(uuid)'), 'execute') then
    raise exception 'CHECK FAIL: anon can execute a cash-settlement RPC';
  end if;
  if not has_function_privilege('authenticated', to_regprocedure('public.submit_cash_settlement(uuid,jsonb,text)'), 'execute')
     or not has_function_privilege('authenticated', to_regprocedure('public.discard_cash_receipt(uuid)'), 'execute')
     or not has_function_privilege('authenticated', to_regprocedure('public.get_cash_settlement(uuid)'), 'execute') then
    raise exception 'CHECK FAIL: authenticated cannot execute a cash-settlement RPC';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.finance_zalo_notifications'::regclass
      and conname = 'finance_zalo_notifications_event_type_check'
      and pg_get_constraintdef(oid) like '%payment_cash_advanced%'
      and pg_get_constraintdef(oid) like '%payment_cash_settled%'
  ) then
    raise exception 'CHECK FAIL: finance_zalo_notifications event check misses the cash events';
  end if;
  v_log := v_log || 'columns/tables/grants/rls/events ok; ';

  -- -------------------------------------------------------------------------
  -- 3. Fixtures (rollback only).
  -- -------------------------------------------------------------------------
  select user_id into v_owner from public.user_roles where role = 'owner' limit 1;
  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user';
  end if;
  if (select count(*) from public.user_roles where role = 'owner') <> 1 then
    raise exception 'CHECK FAIL: production smoke expects exactly 1 owner';
  end if;

  insert into public.payment_requests (
    id, request_number, title, description, total_amount,
    status, delivery_status, payment_status, payment_method, created_by
  ) values (
    v_cash_pr, 'SMOKE-CASH-' || left(v_cash_pr::text, 8), 'Smoke cash advance', 'Smoke',
    500000, 'pending', 'pending', 'unpaid', 'cash', v_staff
  );

  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values (
    v_cash_pr, 'Nước', 1, 'lần', 252000, 252000, 'none', 'OTHER'
  ) returning id into v_item_a;

  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values (
    v_cash_pr, 'Ly', 1, 'lần', 248000, 248000, 'none', 'OTHER'
  ) returning id into v_item_b;

  insert into public.payment_requests (
    id, request_number, title, description, total_amount,
    status, delivery_status, payment_status, payment_method, created_by
  ) values (
    v_bank_pr, 'SMOKE-BANK-' || left(v_bank_pr::text, 8), 'Smoke bank transfer', 'Smoke',
    100000, 'pending', 'pending', 'unpaid', 'bank_transfer', v_staff
  );

  -- Server-side OCR drafts consumed by approve_payment_requests_with_unc.
  v_sha_evidence_cash := encode(sha256(convert_to('smoke-cash-evidence', 'UTF8')), 'hex');
  v_sha_evidence_bank := encode(sha256(convert_to('smoke-bank-evidence', 'UTF8')), 'hex');
  insert into public.payment_unc_ocr_drafts (
    file_sha256, storage_path, ocr_amount, transfer_date, ocr_reference
  ) values (
    v_sha_evidence_cash, 'payment-unc/smoke/cash.jpg', 500000, current_date, 'SMOKE-CASH-REF-001'
  );
  insert into public.payment_unc_ocr_drafts (
    file_sha256, storage_path, ocr_amount, transfer_date, ocr_reference
  ) values (
    v_sha_evidence_bank, 'payment-unc/smoke/bank.jpg', 100000, current_date, 'SMOKE-BANK-REF-001'
  );

  -- Receipts are written by the service role (the edge function path).
  perform set_config('role', 'service_role', true);

  insert into public.payment_cash_receipts (
    id, payment_request_id, storage_path, file_sha256, ocr_amount, amount, status
  ) values
    (v_r1, v_cash_pr, 'payment-unc/smoke/r1.jpg', encode(sha256(convert_to('smoke-r1', 'UTF8')), 'hex'), 252000, 252000, 'uploaded'),
    (v_r2, v_cash_pr, 'payment-unc/smoke/r2.jpg', encode(sha256(convert_to('smoke-r2', 'UTF8')), 'hex'), 248000, 248000, 'uploaded'),
    (v_r3, v_cash_pr, 'payment-unc/smoke/r3.jpg', encode(sha256(convert_to('smoke-r3', 'UTF8')), 'hex'), 100000, 100000, 'discarded'),
    (v_r4, v_cash_pr, 'payment-unc/smoke/r4.jpg', encode(sha256(convert_to('smoke-r4', 'UTF8')), 'hex'), 100000, 100000, 'uploaded'),
    (v_r_foreign, v_bank_pr, 'payment-unc/smoke/foreign.jpg', encode(sha256(convert_to('smoke-foreign', 'UTF8')), 'hex'), 100000, 100000, 'uploaded');

  perform set_config('role', 'postgres', true);
  v_log := v_log || 'fixtures ok; ';

  -- -------------------------------------------------------------------------
  -- 4. Cash PR paid through approve_payment_requests_with_unc -> awaiting.
  -- -------------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
  perform set_config('role', 'authenticated', true);

  v_result := public.approve_payment_requests_with_unc(
    array[v_cash_pr],
    jsonb_build_object(
      'file_sha256', v_sha_evidence_cash,
      'storage_path', 'payment-unc/smoke/cash.jpg',
      'ocr_amount', 500000,
      'payment_method', 'cash',
      'category', 'khac'
    ),
    'smoke-cash-approve-1'
  );

  if (select status::text from public.payment_requests where id = v_cash_pr) <> 'approved'
     or (select payment_status::text from public.payment_requests where id = v_cash_pr) <> 'paid' then
    raise exception 'CHECK FAIL: cash PR was not approved/paid';
  end if;
  if (select cash_settlement_status from public.payment_requests where id = v_cash_pr) <> 'awaiting_receipts' then
    raise exception 'CHECK FAIL: cash PR is not awaiting_receipts';
  end if;
  perform set_config('role', 'postgres', true);  -- outbox is not readable by authenticated
  if (select count(*) from public.finance_zalo_notifications where event_type = 'payment_cash_advanced' and entity_id = v_cash_pr) <> 1 then
    raise exception 'CHECK FAIL: expected exactly one payment_cash_advanced outbox row';
  end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('role', 'postgres', true);  -- outbox is not readable by authenticated
  if exists (select 1 from public.finance_zalo_notifications where event_type = 'payment_request_paid' and entity_id = v_cash_pr) then
    raise exception 'CHECK FAIL: cash PR also got a payment_request_paid row';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'cash paid -> awaiting + one cash_advanced; ';

  -- -------------------------------------------------------------------------
  -- 5. bank_transfer is unchanged: payment_request_paid, null cash status.
  -- -------------------------------------------------------------------------
  perform public.approve_payment_requests_with_unc(
    array[v_bank_pr],
    jsonb_build_object(
      'file_sha256', v_sha_evidence_bank,
      'storage_path', 'payment-unc/smoke/bank.jpg',
      'ocr_amount', 100000,
      'payment_method', 'bank_transfer',
      'category', 'khac'
    ),
    'smoke-bank-approve-1'
  );
  perform set_config('role', 'postgres', true);  -- outbox is not readable by authenticated
  if (select count(*) from public.finance_zalo_notifications where event_type = 'payment_request_paid' and entity_id = v_bank_pr) <> 1 then
    raise exception 'CHECK FAIL: bank PR did not get exactly one payment_request_paid row';
  end if;
  perform set_config('role', 'authenticated', true);
  if (select cash_settlement_status from public.payment_requests where id = v_bank_pr) is not null then
    raise exception 'CHECK FAIL: bank PR cash_settlement_status is not null';
  end if;
  v_log := v_log || 'bank_transfer unchanged; ';

  -- -------------------------------------------------------------------------
  -- 6. Partial settlement -> still awaiting with remaining > 0.
  -- -------------------------------------------------------------------------
  v_result := public.submit_cash_settlement(
    v_cash_pr,
    jsonb_build_array(jsonb_build_object('receipt_id', v_r1, 'item_id', v_item_a, 'amount', 252000)),
    'smoke-cash-submit-1'
  );
  if v_result->>'status' <> 'awaiting_receipts' then
    raise exception 'CHECK FAIL: partial submit status = %', v_result->>'status';
  end if;
  if (v_result->>'remaining_total')::numeric <= 0 then
    raise exception 'CHECK FAIL: partial submit remaining_total = %', v_result->>'remaining_total';
  end if;
  if (select cash_settlement_status from public.payment_requests where id = v_cash_pr) <> 'awaiting_receipts' then
    raise exception 'CHECK FAIL: partial submit changed the settlement status';
  end if;
  perform set_config('role', 'postgres', true);  -- outbox is not readable by authenticated
  if (select count(*) from public.finance_zalo_notifications where event_type = 'payment_cash_settled' and entity_id = v_cash_pr) <> 0 then
    raise exception 'CHECK FAIL: partial submit enqueued payment_cash_settled';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'partial submit ok; ';

  -- -------------------------------------------------------------------------
  -- 7. Rejections: over-allocation, foreign receipt, discarded receipt.
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.submit_cash_settlement(
      v_cash_pr,
      jsonb_build_array(jsonb_build_object('receipt_id', v_r2, 'item_id', v_item_b, 'amount', 300000)),
      'smoke-cash-over-1'
    );
  exception when others then
    v_ok := sqlerrm like '%item_over_allocated%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: item over-allocation was accepted'; end if;

  v_ok := false;
  begin
    perform public.submit_cash_settlement(
      v_cash_pr,
      jsonb_build_array(jsonb_build_object('receipt_id', v_r4, 'item_id', v_item_b, 'amount', 200000)),
      'smoke-cash-receipt-over-1'
    );
  exception when others then
    v_ok := sqlerrm like '%receipt_over_allocated%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: receipt over-allocation was accepted'; end if;

  v_ok := false;
  begin
    perform public.submit_cash_settlement(
      v_cash_pr,
      jsonb_build_array(jsonb_build_object('receipt_id', v_r_foreign, 'item_id', v_item_b, 'amount', 100000)),
      'smoke-cash-foreign-1'
    );
  exception when others then
    v_ok := sqlerrm like '%receipt_not_uploaded%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a foreign receipt was accepted'; end if;

  v_ok := false;
  begin
    perform public.submit_cash_settlement(
      v_cash_pr,
      jsonb_build_array(jsonb_build_object('receipt_id', v_r3, 'item_id', v_item_b, 'amount', 100000)),
      'smoke-cash-discarded-1'
    );
  exception when others then
    v_ok := sqlerrm like '%receipt_not_uploaded%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a discarded receipt was accepted'; end if;
  v_log := v_log || 'over/foreign/discarded rejected; ';

  -- -------------------------------------------------------------------------
  -- 8. A staff member without owner/edit/creator permission is rejected.
  -- -------------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_outsider, 'role', 'authenticated')::text,
    true
  );
  v_ok := false;
  begin
    perform public.submit_cash_settlement(
      v_cash_pr,
      jsonb_build_array(jsonb_build_object('receipt_id', v_r2, 'item_id', v_item_b, 'amount', 248000)),
      'smoke-cash-perm-1'
    );
  exception when others then
    v_ok := sqlerrm like '%insufficient_privilege%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: an unrelated staff member could settle'; end if;
  v_log := v_log || 'unrelated staff rejected; ';

  -- -------------------------------------------------------------------------
  -- 9. Complete settlement + one payment_cash_settled + replay idempotency.
  -- -------------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
  v_result := public.submit_cash_settlement(
    v_cash_pr,
    jsonb_build_array(jsonb_build_object('receipt_id', v_r2, 'item_id', v_item_b, 'amount', 248000)),
    'smoke-cash-submit-2'
  );
  if v_result->>'status' <> 'completed' then
    raise exception 'CHECK FAIL: final submit status = %', v_result->>'status';
  end if;
  if (v_result->>'remaining_total')::numeric <> 0 then
    raise exception 'CHECK FAIL: final submit remaining_total = %', v_result->>'remaining_total';
  end if;
  if (select cash_settlement_status from public.payment_requests where id = v_cash_pr) <> 'completed' then
    raise exception 'CHECK FAIL: PR not completed';
  end if;
  if (select cash_settled_at from public.payment_requests where id = v_cash_pr) is null
     or (select cash_settled_by from public.payment_requests where id = v_cash_pr) is null then
    raise exception 'CHECK FAIL: cash_settled_at/by not recorded';
  end if;
  perform set_config('role', 'postgres', true);  -- outbox is not readable by authenticated
  if (select count(*) from public.finance_zalo_notifications where event_type = 'payment_cash_settled' and entity_id = v_cash_pr) <> 1 then
    raise exception 'CHECK FAIL: expected exactly one payment_cash_settled outbox row';
  end if;
  perform set_config('role', 'authenticated', true);

  v_result := public.submit_cash_settlement(
    v_cash_pr,
    jsonb_build_array(jsonb_build_object('receipt_id', v_r2, 'item_id', v_item_b, 'amount', 248000)),
    'smoke-cash-submit-2'
  );
  if coalesce((v_result->>'idempotent')::boolean, false) is not true then
    raise exception 'CHECK FAIL: replay did not return idempotent=true';
  end if;
  perform set_config('role', 'postgres', true);  -- outbox is not readable by authenticated
  if (select count(*) from public.finance_zalo_notifications where event_type = 'payment_cash_settled' and entity_id = v_cash_pr) <> 1 then
    raise exception 'CHECK FAIL: replay enqueued a second payment_cash_settled row';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'completed + one settled + replay; ';

  -- -------------------------------------------------------------------------
  -- 10. Detail read exposes the CEO evidence, receipts and items.
  -- -------------------------------------------------------------------------
  v_result := public.get_cash_settlement(v_cash_pr);
  if v_result is null then
    raise exception 'CHECK FAIL: get_cash_settlement returned null';
  end if;
  if jsonb_array_length(v_result->'items') <> 2 then
    raise exception 'CHECK FAIL: get_cash_settlement items = %', jsonb_array_length(v_result->'items');
  end if;
  if jsonb_array_length(v_result->'receipts') < 2 then
    raise exception 'CHECK FAIL: get_cash_settlement receipts missing';
  end if;
  if jsonb_array_length(v_result->'evidence') < 1 then
    raise exception 'CHECK FAIL: get_cash_settlement evidence missing';
  end if;
  if coalesce(v_result->'evidence'->0->'evidence'->>'storage_path', '') = '' then
    raise exception 'CHECK FAIL: CEO evidence storage_path missing';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_result->'receipts') r
    where r->>'status' = 'allocated' and coalesce(r->>'payment_request_item_id', '') <> ''
  ) then
    raise exception 'CHECK FAIL: allocated receipts do not expose their item';
  end if;
  v_log := v_log || 'detail read ok; ';

  raise exception 'SMOKE_RESULT PASS: %', v_log;
end $$;
