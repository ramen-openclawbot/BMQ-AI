-- Rollback-only production smoke CHECKS for migration
-- 20261012110000_cash_payment_request_create.sql.
--
-- Run as one file: `begin; <migration>; <this file>` (the caller wraps the
-- migration and these checks in a transaction). This file contains CHECKS ONLY
-- and never copies the migration. The final RAISE ends the transaction, so every
-- fixture created here is rolled back. It assumes production has exactly 1 owner.
do $$
declare
  v_owner uuid;
  v_outsider uuid := gen_random_uuid();
  v_result jsonb;
  v_pr_id uuid;
  v_pr public.payment_requests%rowtype;
  v_count integer;
  v_item_count integer;
  v_ok boolean;
  v_request_number text;
  v_replayed_id uuid;
  v_sha_evidence text;
  v_reference text;
  v_log text := '';
begin
  -- -------------------------------------------------------------------------
  -- 1. Table / RLS / grants / function privileges.
  -- -------------------------------------------------------------------------
  if to_regclass('public.cash_pr_idempotency') is null then
    raise exception 'CHECK FAIL: cash_pr_idempotency missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.cash_pr_idempotency'::regclass) then
    raise exception 'CHECK FAIL: RLS off on cash_pr_idempotency';
  end if;
  if has_table_privilege('authenticated', 'public.cash_pr_idempotency', 'select')
     or has_table_privilege('authenticated', 'public.cash_pr_idempotency', 'insert')
     or has_table_privilege('anon', 'public.cash_pr_idempotency', 'select') then
    raise exception 'CHECK FAIL: a client can read/write cash_pr_idempotency';
  end if;

  if to_regprocedure('public.create_cash_payment_request(jsonb,text)') is null then
    raise exception 'CHECK FAIL: create_cash_payment_request missing';
  end if;
  if has_function_privilege('anon', to_regprocedure('public.create_cash_payment_request(jsonb,text)'), 'execute') then
    raise exception 'CHECK FAIL: anon can execute create_cash_payment_request';
  end if;
  if not has_function_privilege('authenticated', to_regprocedure('public.create_cash_payment_request(jsonb,text)'), 'execute') then
    raise exception 'CHECK FAIL: authenticated cannot execute create_cash_payment_request';
  end if;
  v_log := v_log || 'objects/grants ok; ';

  -- -------------------------------------------------------------------------
  -- 2. Owner fixture (production has exactly 1 owner).
  -- -------------------------------------------------------------------------
  select user_id into v_owner from public.user_roles where role = 'owner' limit 1;
  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user';
  end if;
  if (select count(*) from public.user_roles where role = 'owner') <> 1 then
    raise exception 'CHECK FAIL: production smoke expects exactly 1 owner';
  end if;

  -- -------------------------------------------------------------------------
  -- 3. The owner creates one phiếu with 3 khoản (252000 + 130000 + 320000).
  -- -------------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
  perform set_config('role', 'authenticated', true);

  v_result := public.create_cash_payment_request(
    jsonb_build_object(
      'title', 'Smoke chi tiền mặt nhiều hoá đơn',
      'description', 'Smoke 3 khoản lẻ',
      'items', jsonb_build_array(
        jsonb_build_object('name', 'Nước', 'amount', 252000),
        jsonb_build_object('name', 'Vận chuyển', 'amount', 130000),
        jsonb_build_object('name', 'Xăng', 'amount', 320000)
      )
    ),
    'smoke-cash-pr-1'
  );

  v_pr_id := (v_result->>'payment_request_id')::uuid;
  v_request_number := v_result->>'request_number';

  if v_pr_id is null then
    raise exception 'CHECK FAIL: no payment_request_id returned';
  end if;
  if v_request_number !~ '^PR-[0-9A-F]{8}$' then
    raise exception 'CHECK FAIL: bad request_number %', v_request_number;
  end if;
  if coalesce((v_result->>'replayed')::boolean, false) then
    raise exception 'CHECK FAIL: first create reported replayed=true';
  end if;
  if (v_result->>'total')::numeric <> 702000 then
    raise exception 'CHECK FAIL: result total = %', v_result->>'total';
  end if;

  select * into v_pr from public.payment_requests where id = v_pr_id;
  if not found then
    raise exception 'CHECK FAIL: payment request not found';
  end if;
  if v_pr.payment_method::text is distinct from 'cash' then
    raise exception 'CHECK FAIL: payment_method = %', v_pr.payment_method;
  end if;
  if v_pr.payment_type::text is distinct from 'new_order' then
    raise exception 'CHECK FAIL: payment_type = %', v_pr.payment_type;
  end if;
  if v_pr.status::text is distinct from 'pending' then
    raise exception 'CHECK FAIL: status = %', v_pr.status;
  end if;
  if v_pr.payment_status::text is distinct from 'unpaid' then
    raise exception 'CHECK FAIL: payment_status = %', v_pr.payment_status;
  end if;
  if v_pr.supplier_id is not null then
    raise exception 'CHECK FAIL: supplier_id is not null';
  end if;
  if v_pr.requires_receipt then
    raise exception 'CHECK FAIL: requires_receipt is true';
  end if;
  if v_pr.no_receipt_reason is distinct from 'Chi tiền mặt — không nhập kho' then
    raise exception 'CHECK FAIL: no_receipt_reason = %', v_pr.no_receipt_reason;
  end if;
  if v_pr.no_receipt_set_by is distinct from v_owner then
    raise exception 'CHECK FAIL: no_receipt_set_by';
  end if;
  if v_pr.no_receipt_set_at is null then
    raise exception 'CHECK FAIL: no_receipt_set_at';
  end if;
  if coalesce(v_pr.total_amount, 0) <> 702000 then
    raise exception 'CHECK FAIL: total_amount = %', v_pr.total_amount;
  end if;
  if v_pr.created_by is distinct from v_owner then
    raise exception 'CHECK FAIL: created_by';
  end if;

  select count(*) into v_item_count
  from public.payment_request_items
  where payment_request_id = v_pr_id;
  if v_item_count <> 3 then
    raise exception 'CHECK FAIL: item count = %', v_item_count;
  end if;
  if exists (
    select 1
    from public.payment_request_items i
    where i.payment_request_id = v_pr_id
      and (
        i.quantity <> 1
        or i.unit <> 'lần'
        or i.unit_price <> i.line_total
        or i.standard_cost_code_type <> 'OTHER'
        or i.cost_review_routing <> 'needs_review'
        or i.cost_category_code <> 'UNMAPPED_REVIEW'
      )
  ) then
    raise exception 'CHECK FAIL: an item has the wrong shape';
  end if;
  if (
    select coalesce(sum(i.line_total), 0)
    from public.payment_request_items i
    where i.payment_request_id = v_pr_id
  ) <> 702000 then
    raise exception 'CHECK FAIL: item line_total sum <> 702000';
  end if;

  perform set_config('role', 'postgres', true);
  if (
    select count(*)
    from public.finance_zalo_notifications
    where event_type = 'payment_request_created' and entity_id = v_pr_id
  ) <> 1 then
    raise exception 'CHECK FAIL: expected exactly one payment_request_created outbox row';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'create 3 khoản (OTHER x1) + one notice; ';

  -- -------------------------------------------------------------------------
  -- 4. Replay with the same key: same id, no extra rows or notice.
  -- -------------------------------------------------------------------------
  v_result := public.create_cash_payment_request(
    jsonb_build_object(
      'title', 'Smoke chi tiền mặt nhiều hoá đơn',
      'description', 'Smoke 3 khoản lẻ',
      'items', jsonb_build_array(
        jsonb_build_object('name', 'Nước', 'amount', 252000),
        jsonb_build_object('name', 'Vận chuyển', 'amount', 130000),
        jsonb_build_object('name', 'Xăng', 'amount', 320000)
      )
    ),
    'smoke-cash-pr-1'
  );
  v_replayed_id := (v_result->>'payment_request_id')::uuid;
  if v_replayed_id is distinct from v_pr_id then
    raise exception 'CHECK FAIL: replay id % <> %', v_replayed_id, v_pr_id;
  end if;
  if coalesce((v_result->>'replayed')::boolean, false) is not true then
    raise exception 'CHECK FAIL: replay did not return replayed=true';
  end if;
  if (v_result->>'request_number') is distinct from v_request_number then
    raise exception 'CHECK FAIL: replay request_number changed';
  end if;

  select count(*) into v_count
  from public.payment_request_items
  where payment_request_id = v_pr_id;
  if v_count <> 3 then
    raise exception 'CHECK FAIL: replay added items (% rows)', v_count;
  end if;

  perform set_config('role', 'postgres', true);
  if (
    select count(*) from public.cash_pr_idempotency
    where idempotency_key = 'smoke-cash-pr-1'
  ) <> 1 then
    raise exception 'CHECK FAIL: replay added idempotency rows';
  end if;
  if (
    select count(*)
    from public.finance_zalo_notifications
    where event_type = 'payment_request_created' and entity_id = v_pr_id
  ) <> 1 then
    raise exception 'CHECK FAIL: replay added an outbox row';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'replay same id, no extra rows; ';

  -- -------------------------------------------------------------------------
  -- 5. Invalid inputs are rejected.
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.create_cash_payment_request(
      jsonb_build_object('title', 'Bad', 'items', jsonb_build_array()),
      'smoke-cash-pr-bad-1'
    );
  exception when others then
    v_ok := sqlerrm like '%items_required%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: 0 items was accepted'; end if;

  v_ok := false;
  begin
    perform public.create_cash_payment_request(
      jsonb_build_object(
        'title', 'Bad',
        'items', jsonb_build_array(jsonb_build_object('name', 'A', 'amount', 0))
      ),
      'smoke-cash-pr-bad-2'
    );
  exception when others then
    v_ok := sqlerrm like '%invalid_amount%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: amount 0 was accepted'; end if;

  v_ok := false;
  begin
    perform public.create_cash_payment_request(
      jsonb_build_object(
        'title', 'Bad',
        'items', jsonb_build_array(jsonb_build_object('name', 'A', 'amount', 50000001))
      ),
      'smoke-cash-pr-bad-3'
    );
  exception when others then
    v_ok := sqlerrm like '%amount_over_limit%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: over-limit amount was accepted'; end if;

  v_ok := false;
  begin
    perform public.create_cash_payment_request(
      jsonb_build_object(
        'title', 'Bad',
        'items', jsonb_build_array(jsonb_build_object('name', '   ', 'amount', 1000))
      ),
      'smoke-cash-pr-bad-4'
    );
  exception when others then
    v_ok := sqlerrm like '%invalid_item_name%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a blank name was accepted'; end if;
  v_log := v_log || 'invalid inputs rejected; ';

  -- -------------------------------------------------------------------------
  -- 6. A user without owner/edit permission is rejected.
  -- -------------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_outsider, 'role', 'authenticated')::text,
    true
  );
  v_ok := false;
  begin
    perform public.create_cash_payment_request(
      jsonb_build_object(
        'title', 'Nope',
        'items', jsonb_build_array(jsonb_build_object('name', 'A', 'amount', 1000))
      ),
      'smoke-cash-pr-out-1'
    );
  exception when others then
    v_ok := sqlerrm like '%insufficient_privilege%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: an unrelated staff member could create'; end if;
  v_log := v_log || 'outsider rejected; ';

  -- -------------------------------------------------------------------------
  -- 7. Owner later pays it with cash: material controller passes, PR becomes
  --    paid + awaiting_receipts with one payment_cash_advanced row.
  -- -------------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
  perform set_config('role', 'postgres', true);
  v_sha_evidence := encode(
    sha256(convert_to('smoke-cash-pr-evidence:' || gen_random_uuid()::text, 'UTF8')),
    'hex'
  );
  v_reference := 'SMOKE-CASH-PR-' || upper(substr(replace(v_pr_id::text, '-', ''), 1, 10));
  insert into public.payment_unc_ocr_drafts (
    file_sha256, storage_path, ocr_amount, transfer_date, ocr_reference
  ) values (
    v_sha_evidence, 'payment-unc/smoke/cash-pr.jpg', 702000, current_date, v_reference
  );
  perform set_config('role', 'authenticated', true);

  v_result := public.approve_payment_requests_with_unc(
    array[v_pr_id],
    jsonb_build_object(
      'file_sha256', v_sha_evidence,
      'storage_path', 'payment-unc/smoke/cash-pr.jpg',
      'ocr_amount', 702000,
      'payment_method', 'cash',
      'category', 'khac'
    ),
    'smoke-cash-pr-approve-1'
  );

  if (select status::text from public.payment_requests where id = v_pr_id) is distinct from 'approved' then
    raise exception 'CHECK FAIL: cash PR was not approved';
  end if;
  if (select payment_status::text from public.payment_requests where id = v_pr_id) is distinct from 'paid' then
    raise exception 'CHECK FAIL: cash PR was not paid';
  end if;
  if (select cash_settlement_status from public.payment_requests where id = v_pr_id) is distinct from 'awaiting_receipts' then
    raise exception 'CHECK FAIL: cash PR is not awaiting_receipts';
  end if;
  if (select cash_settled_by from public.payment_requests where id = v_pr_id) is not null then
    raise exception 'CHECK FAIL: cash_settled_by should only be set on completion';
  end if;

  perform set_config('role', 'postgres', true);
  if (
    select count(*)
    from public.finance_zalo_notifications
    where event_type = 'payment_cash_advanced' and entity_id = v_pr_id
  ) <> 1 then
    raise exception 'CHECK FAIL: expected exactly one payment_cash_advanced row';
  end if;
  if exists (
    select 1 from public.finance_zalo_notifications
    where event_type = 'payment_request_paid' and entity_id = v_pr_id
  ) then
    raise exception 'CHECK FAIL: cash PR also got a payment_request_paid row';
  end if;
  perform set_config('role', 'authenticated', true);
  v_log := v_log || 'cash approved -> awaiting_receipts + one cash_advanced; ';

  raise exception 'SMOKE_RESULT PASS: %', v_log;
end $$;
