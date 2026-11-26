-- Rollback-only production smoke CHECKS for migration
-- 20261127100000_cash_shared_slip.sql.
--
-- Run as one file: `begin; <migration>; <this file>` (the caller wraps the
-- migration and these checks in a transaction). This file contains CHECKS ONLY
-- and never copies the migration. The final RAISE ends the transaction, so every
-- fixture created here is rolled back. It uses an isolated throwaway requester
-- so real production rows never affect the candidate counts.
do $$
declare
  v_requester uuid := gen_random_uuid();
  v_other_user uuid := gen_random_uuid();
  v_pr1 uuid := gen_random_uuid();
  v_pr2 uuid := gen_random_uuid();
  v_pr3 uuid := gen_random_uuid();
  v_other_pr uuid := gen_random_uuid();
  v_bank_pr uuid := gen_random_uuid();
  v_item1 uuid;
  v_item2a uuid;
  v_item2b uuid;
  v_item3 uuid;
  v_other_item uuid;
  v_receipt uuid := gen_random_uuid();
  v_pr1_number text;
  v_pr2_number text;
  v_result jsonb;
  v_allocations jsonb;
  v_count integer;
  v_sum numeric;
  v_ok boolean;
  v_log text := '';
begin
  -- -------------------------------------------------------------------------
  -- 1. Fixtures (rollback only): 3 cash phiếu of an isolated requester awaiting
  --    receipts, one cash phiếu of another requester, and one 11.133.000 slip.
  -- -------------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email) values
    (v_requester, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
      'smoke-cash-shared-requester-' || left(v_requester::text, 8) || '@bmq.invalid'),
    (v_other_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
      'smoke-cash-shared-other-' || left(v_other_user::text, 8) || '@bmq.invalid');
  insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
    values (v_requester, 'payment_requests', true, false);

  v_pr1_number := 'SMOKE-SHARED-A-' || left(v_pr1::text, 8);
  v_pr2_number := 'SMOKE-SHARED-B-' || left(v_pr2::text, 8);

  insert into public.payment_requests (
    id, request_number, title, description, total_amount,
    status, delivery_status, payment_status, payment_method, created_by,
    cash_settlement_status
  ) values
    (v_pr1, v_pr1_number, 'Smoke shared slip A', 'Smoke',
     2560000, 'approved', 'pending', 'paid', 'cash', v_requester, 'awaiting_receipts'),
    (v_pr2, v_pr2_number, 'Smoke shared slip B', 'Smoke',
     4373000, 'approved', 'pending', 'paid', 'cash', v_requester, 'awaiting_receipts'),
    (v_pr3, 'SMOKE-SHARED-C-' || left(v_pr3::text, 8), 'Smoke shared slip C', 'Smoke',
     4200000, 'approved', 'pending', 'paid', 'cash', v_requester, 'awaiting_receipts'),
    (v_other_pr, 'SMOKE-SHARED-X-' || left(v_other_pr::text, 8), 'Smoke other requester', 'Smoke',
     500000, 'approved', 'pending', 'paid', 'cash', v_other_user, 'awaiting_receipts'),
    (v_bank_pr, 'SMOKE-SHARED-BANK-' || left(v_bank_pr::text, 8), 'Smoke bank transfer current', 'Smoke',
     1000000, 'approved', 'pending', 'paid', 'bank_transfer', v_requester, 'awaiting_receipts');

  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values (
    v_pr1, 'Khoản A', 1, 'lần', 2560000, 2560000, 'none', 'OTHER'
  ) returning id into v_item1;
  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values (
    v_pr2, 'Khoản B1', 1, 'lần', 3000000, 3000000, 'none', 'OTHER'
  ) returning id into v_item2a;
  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values (
    v_pr2, 'Khoản B2', 1, 'lần', 1373000, 1373000, 'none', 'OTHER'
  ) returning id into v_item2b;
  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values (
    v_pr3, 'Khoản C', 1, 'lần', 4200000, 4200000, 'none', 'OTHER'
  ) returning id into v_item3;
  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values (
    v_other_pr, 'Khoản X', 1, 'lần', 500000, 500000, 'none', 'OTHER'
  ) returning id into v_other_item;

  perform set_config('role', 'service_role', true);
  insert into public.payment_cash_receipts (
    id, payment_request_id, storage_path, file_sha256, ocr_amount, amount, status
  ) values (
    v_receipt, v_pr1, 'payment-unc/smoke/shared.jpg',
    encode(sha256(convert_to('smoke-shared-' || v_receipt::text, 'UTF8')), 'hex'),
    11133000, 11133000, 'uploaded'
  );
  perform set_config('role', 'postgres', true);
  v_log := v_log || 'fixtures ok; ';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_requester, 'role', 'authenticated')::text,
    true
  );
  perform set_config('role', 'authenticated', true);

  -- -------------------------------------------------------------------------
  -- 2. Candidates: exactly the 3 requester phiếu, current tagged, no other person.
  -- -------------------------------------------------------------------------
  v_result := public.list_cash_shared_slip_candidates(v_pr1);
  if jsonb_typeof(v_result) <> 'array' then
    raise exception 'CHECK FAIL: candidates is not an array: %', v_result;
  end if;
  if jsonb_array_length(v_result) <> 3 then
    raise exception 'CHECK FAIL: candidates length = % (%)', jsonb_array_length(v_result), v_result;
  end if;
  if (select count(*) from jsonb_array_elements(v_result) c
      where (c->>'id')::uuid in (v_pr1, v_pr2, v_pr3)) <> 3 then
    raise exception 'CHECK FAIL: candidates missing a fixture phiếu: %', v_result;
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_result) c where (c->>'id')::uuid = v_other_pr
  ) then
    raise exception 'CHECK FAIL: candidates leaked another requester';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_result) c
    where (c->>'id')::uuid = v_pr1 and (c->>'is_current')::boolean
  ) then
    raise exception 'CHECK FAIL: current phiếu is not tagged is_current';
  end if;
  -- An ineligible current (bank_transfer) must not be offered at all.
  if jsonb_array_length(public.list_cash_shared_slip_candidates(v_bank_pr)) <> 0 then
    raise exception 'CHECK FAIL: candidates returned an ineligible current phiếu';
  end if;
  if (select count(*) from jsonb_array_elements(v_result) c
      where (c->>'remaining_total')::numeric > 0
        and jsonb_array_length(c->'items') > 0) <> 3 then
    raise exception 'CHECK FAIL: candidates missing items/remaining_total';
  end if;
  v_log := v_log || 'candidates 3 + current + no other requester; ';

  -- -------------------------------------------------------------------------
  -- 3. Allocation total below the slip -> shared_total_mismatch, no writes.
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.submit_cash_shared_slip(
      v_receipt,
      jsonb_build_array(
        jsonb_build_object('request_id', v_pr1, 'item_id', v_item1, 'amount', 2560000),
        jsonb_build_object('request_id', v_pr2, 'item_id', v_item2a, 'amount', 3000000),
        jsonb_build_object('request_id', v_pr2, 'item_id', v_item2b, 'amount', 1372999),
        jsonb_build_object('request_id', v_pr3, 'item_id', v_item3, 'amount', 4200000)
      ),
      'cash-shared:' || v_receipt::text || ':total-1'
    );
  exception when others then
    v_ok := sqlerrm like '%shared_total_mismatch%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: an under-total allocation was accepted'; end if;
  if (select count(*) from public.payment_cash_receipt_splits where receipt_id = v_receipt) <> 0 then
    raise exception 'CHECK FAIL: the rejected total wrote split rows';
  end if;
  if (select status from public.payment_cash_receipts where id = v_receipt) <> 'uploaded' then
    raise exception 'CHECK FAIL: the rejected total allocated the receipt';
  end if;
  if (select count(*) from public.payment_requests
      where id in (v_pr1, v_pr2, v_pr3) and cash_settlement_status = 'awaiting_receipts') <> 3 then
    raise exception 'CHECK FAIL: the rejected total changed a phiếu status';
  end if;
  v_log := v_log || 'shared_total_mismatch ok; ';

  -- -------------------------------------------------------------------------
  -- 4. A phiếu of another requester -> requester_mismatch, no writes.
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.submit_cash_shared_slip(
      v_receipt,
      jsonb_build_array(
        jsonb_build_object('request_id', v_pr1, 'item_id', v_item1, 'amount', 2560000),
        jsonb_build_object('request_id', v_other_pr, 'item_id', v_other_item, 'amount', 500000)
      ),
      'cash-shared:' || v_receipt::text || ':other-1'
    );
  exception when others then
    -- A caller who may not edit the other phiếu is refused before any detail
    -- (insufficient_privilege); an owner gets requester_mismatch.
    v_ok := sqlerrm like '%requester_mismatch%' or sqlerrm like '%insufficient_privilege%';
    v_log := v_log || 'other requester refused (' || sqlerrm || '); ';
  end;
  if not v_ok then raise exception 'CHECK FAIL: another requester phiếu was accepted %', v_log; end if;
  if (select count(*) from public.payment_cash_receipt_splits where receipt_id = v_receipt) <> 0 then
    raise exception 'CHECK FAIL: the requester mismatch wrote split rows';
  end if;
  v_log := v_log || 'requester_mismatch ok; ';

  -- -------------------------------------------------------------------------
  -- 5. One item above its remaining -> item_over_allocated, no writes.
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.submit_cash_shared_slip(
      v_receipt,
      jsonb_build_array(
        jsonb_build_object('request_id', v_pr1, 'item_id', v_item1, 'amount', 2560001),
        jsonb_build_object('request_id', v_pr2, 'item_id', v_item2a, 'amount', 3000000),
        jsonb_build_object('request_id', v_pr2, 'item_id', v_item2b, 'amount', 1373000),
        jsonb_build_object('request_id', v_pr3, 'item_id', v_item3, 'amount', 4200000)
      ),
      'cash-shared:' || v_receipt::text || ':over-1'
    );
  exception when others then
    v_ok := sqlerrm like '%item_over_allocated%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: an over-item allocation was accepted'; end if;
  if (select count(*) from public.payment_cash_receipt_splits where receipt_id = v_receipt) <> 0 then
    raise exception 'CHECK FAIL: the item over-allocation wrote split rows';
  end if;
  v_log := v_log || 'item_over_allocated ok; ';

  -- -------------------------------------------------------------------------
  -- 6. Correct split: 3 phiếu completed, 4 split rows, 3 Zalo outbox rows.
  -- -------------------------------------------------------------------------
  v_allocations := jsonb_build_array(
    jsonb_build_object('request_id', v_pr1, 'item_id', v_item1, 'amount', 2560000),
    jsonb_build_object('request_id', v_pr2, 'item_id', v_item2a, 'amount', 3000000),
    jsonb_build_object('request_id', v_pr2, 'item_id', v_item2b, 'amount', 1373000),
    jsonb_build_object('request_id', v_pr3, 'item_id', v_item3, 'amount', 4200000)
  );

  v_result := public.submit_cash_shared_slip(v_receipt, v_allocations, 'cash-shared:' || v_receipt::text || ':submit-1');
  if v_result->>'status' <> 'ok' then
    raise exception 'CHECK FAIL: shared submit status = %', v_result->>'status';
  end if;
  if jsonb_array_length(v_result->'requests') <> 3 then
    raise exception 'CHECK FAIL: shared submit requests = %', v_result->'requests';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_result->'requests') r
    where r->>'status' <> 'completed'
       or (r->>'remaining_total')::numeric <> 0
  ) then
    raise exception 'CHECK FAIL: a shared phiếu is not completed/fully covered: %', v_result->'requests';
  end if;

  if (select count(*) from public.payment_cash_receipt_splits where receipt_id = v_receipt) <> 4 then
    raise exception 'CHECK FAIL: expected 4 split rows';
  end if;
  select count(*), coalesce(sum(amount), 0)
    into v_count, v_sum
  from public.payment_cash_receipt_splits
  where receipt_id = v_receipt;
  if v_count <> 4 or v_sum <> 11133000 then
    raise exception 'CHECK FAIL: split rows count=% sum=%', v_count, v_sum;
  end if;

  if (select status from public.payment_cash_receipts where id = v_receipt) <> 'allocated' then
    raise exception 'CHECK FAIL: shared receipt is not allocated';
  end if;
  if (select amount from public.payment_cash_receipts where id = v_receipt) <> 11133000 then
    raise exception 'CHECK FAIL: shared receipt amount is not the slip amount';
  end if;
  if (select payment_request_item_id from public.payment_cash_receipts where id = v_receipt) is not null then
    raise exception 'CHECK FAIL: shared receipt kept a legacy item column';
  end if;
  if (select allocated_at from public.payment_cash_receipts where id = v_receipt) is null then
    raise exception 'CHECK FAIL: shared receipt allocated_at is null';
  end if;

  if (select count(*) from public.payment_requests
      where id in (v_pr1, v_pr2, v_pr3) and cash_settlement_status = 'completed') <> 3 then
    raise exception 'CHECK FAIL: not all 3 phiếu are completed';
  end if;

  perform set_config('role', 'service_role', true);
  select count(*) into v_count
  from public.finance_zalo_notifications
  where event_type = 'payment_cash_settled'
    and entity_id in (v_pr1, v_pr2, v_pr3);
  perform set_config('role', 'authenticated', true);
  if v_count <> 3 then
    raise exception 'CHECK FAIL: expected 3 payment_cash_settled outbox rows, got %', v_count;
  end if;
  v_log := v_log || 'shared submit -> 3 completed + 4 splits + 3 outbox; ';

  -- -------------------------------------------------------------------------
  -- 6b. A non-editor cannot replay the stored result by guessing the key.
  -- -------------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_other_user, 'role', 'authenticated')::text,
    true
  );
  v_ok := false;
  begin
    perform public.submit_cash_shared_slip(
      v_receipt, v_allocations, 'cash-shared:' || v_receipt::text || ':submit-1'
    );
  exception when others then
    v_ok := sqlerrm like '%insufficient_privilege%';
  end;
  if not v_ok then
    raise exception 'CHECK FAIL: a non-editor replayed the stored settlement result';
  end if;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_requester, 'role', 'authenticated')::text,
    true
  );

  -- A key from the single-phiếu flow (or a foreign prefix) is never replayed.
  v_ok := false;
  begin
    perform public.submit_cash_shared_slip(
      v_receipt, v_allocations, 'cash-settle:smoke-shared-foreign-key'
    );
  exception when others then
    v_ok := sqlerrm like '%invalid_idempotency_key%';
  end;
  if not v_ok then
    raise exception 'CHECK FAIL: a foreign idempotency key prefix was accepted';
  end if;

  -- The single-phiếu flow may neither replay nor reserve a shared key.
  v_ok := false;
  begin
    perform public.submit_cash_settlement(
      v_pr2,
      jsonb_build_array(
        jsonb_build_object('receipt_id', v_receipt, 'item_id', v_item2a, 'amount', 3000000)
      ),
      'cash-shared:' || v_receipt::text || ':submit-1'
    );
  exception when others then
    v_ok := sqlerrm like '%invalid_idempotency_key%';
  end;
  if not v_ok then
    raise exception 'CHECK FAIL: submit_cash_settlement accepted a cash-shared key';
  end if;

  -- A single-phiếu key from another phiếu must not replay that phiếu's result.
  perform set_config('role', 'postgres', true);
  insert into public.payment_cash_settlement_idempotency (
    idempotency_key, payment_request_id, result, created_by
  ) values (
    'smoke-single-scope-' || left(v_receipt::text, 8),
    v_pr1,
    '{"status":"ok","requests":[]}'::jsonb,
    v_requester
  );
  perform set_config('role', 'authenticated', true);
  v_ok := false;
  begin
    perform public.submit_cash_settlement(
      v_pr2,
      '[]'::jsonb,
      'smoke-single-scope-' || left(v_receipt::text, 8)
    );
  exception when others then
    v_ok := sqlerrm like '%invalid_idempotency_key%';
  end;
  if not v_ok then
    raise exception 'CHECK FAIL: submit_cash_settlement replayed another phiếu''s ledger row';
  end if;
  perform set_config('role', 'postgres', true);
  delete from public.payment_cash_settlement_idempotency
  where idempotency_key = 'smoke-single-scope-' || left(v_receipt::text, 8);
  perform set_config('role', 'authenticated', true);

  -- -------------------------------------------------------------------------
  -- 7. Replay with the same key -> idempotent true, no extra rows / outbox.
  -- -------------------------------------------------------------------------
  v_result := public.submit_cash_shared_slip(v_receipt, v_allocations, 'cash-shared:' || v_receipt::text || ':submit-1');
  if (v_result->>'idempotent')::boolean is not true then
    raise exception 'CHECK FAIL: replay is not idempotent: %', v_result;
  end if;
  if jsonb_array_length(v_result->'requests') <> 3 then
    raise exception 'CHECK FAIL: replay lost the stored requests';
  end if;
  if (select count(*) from public.payment_cash_receipt_splits where receipt_id = v_receipt) <> 4 then
    raise exception 'CHECK FAIL: replay wrote more split rows';
  end if;
  perform set_config('role', 'service_role', true);
  select count(*) into v_count
  from public.finance_zalo_notifications
  where event_type = 'payment_cash_settled'
    and entity_id in (v_pr1, v_pr2, v_pr3);
  perform set_config('role', 'authenticated', true);
  if v_count <> 3 then
    raise exception 'CHECK FAIL: replay duplicated Zalo outbox rows: %', v_count;
  end if;
  v_log := v_log || 'idempotent replay ok; ';

  -- -------------------------------------------------------------------------
  -- 8. get_cash_settlement on phiếu 2 shows the shared receipt + full coverage.
  -- -------------------------------------------------------------------------
  v_result := public.get_cash_settlement(v_pr2);
  if v_result is null then
    raise exception 'CHECK FAIL: get_cash_settlement(v_pr2) returned null';
  end if;
  if jsonb_array_length(v_result->'receipts') <> 1 then
    raise exception 'CHECK FAIL: phiếu 2 receipts = %', v_result->'receipts';
  end if;
  if (v_result->'receipts'->0->>'id')::uuid <> v_receipt then
    raise exception 'CHECK FAIL: phiếu 2 does not show the shared receipt';
  end if;
  if (v_result->'receipts'->0->>'shared_from_request_id') is distinct from v_pr1::text then
    raise exception 'CHECK FAIL: shared_from_request_id = %', v_result->'receipts'->0->>'shared_from_request_id';
  end if;
  if (v_result->'receipts'->0->>'shared_from_request_number') is distinct from v_pr1_number then
    raise exception 'CHECK FAIL: shared_from_request_number = %', v_result->'receipts'->0->>'shared_from_request_number';
  end if;
  if not (v_result->'receipts'->0 ? 'splits')
     or jsonb_array_length(v_result->'receipts'->0->'splits') <> 4 then
    raise exception 'CHECK FAIL: shared receipt splits = %', v_result->'receipts'->0->'splits';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_result->'receipts'->0->'splits') s
    where not (s ? 'request_id')
  ) then
    raise exception 'CHECK FAIL: a split has no request_id';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_result->'items') i
    where (i->>'covered')::numeric <> (i->>'amount')::numeric
  ) then
    raise exception 'CHECK FAIL: phiếu 2 items are not fully covered: %', v_result->'items';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_result->'receipts'->0->'splits') s
    where (s->>'request_id')::uuid = v_pr2
      and (s->>'amount')::numeric not in (3000000, 1373000)
  ) then
    raise exception 'CHECK FAIL: phiếu 2 split amounts are wrong';
  end if;

  -- The source phiếu still sees its own receipt with no shared_from annotation.
  v_result := public.get_cash_settlement(v_pr1);
  if (v_result->'receipts'->0->>'shared_from_request_id') is not null
     or (v_result->'receipts'->0->>'shared_from_request_number') is not null then
    raise exception 'CHECK FAIL: the source receipt is annotated as shared';
  end if;
  v_log := v_log || 'get_cash_settlement shared receipt ok; ';

  -- -------------------------------------------------------------------------
  -- 9. A manual reversal leaves the ledger row behind. Resubmitting the same
  --    selection must write again (stale idempotency result is ignored).
  -- -------------------------------------------------------------------------
  perform set_config('role', 'postgres', true);
  delete from public.payment_cash_receipt_splits where receipt_id = v_receipt;
  update public.payment_cash_receipts
  set status = 'uploaded',
      allocated_at = null,
      payment_request_item_id = null
  where id = v_receipt;
  update public.payment_requests
  set cash_settlement_status = 'awaiting_receipts',
      cash_settled_at = null,
      cash_settled_by = null
  where id in (v_pr1, v_pr2, v_pr3);
  perform set_config('role', 'authenticated', true);

  v_result := public.submit_cash_shared_slip(
    v_receipt, v_allocations, 'cash-shared:' || v_receipt::text || ':submit-1'
  );
  if v_result->>'status' <> 'ok' then
    raise exception 'CHECK FAIL: resubmit after reversal status = %', v_result->>'status';
  end if;
  if (v_result->>'idempotent')::boolean is true then
    raise exception 'CHECK FAIL: a stale ledger result was replayed after reversal';
  end if;
  if (select status from public.payment_cash_receipts where id = v_receipt) <> 'allocated' then
    raise exception 'CHECK FAIL: resubmit after reversal did not allocate the receipt';
  end if;
  if (select count(*) from public.payment_cash_receipt_splits where receipt_id = v_receipt) <> 4 then
    raise exception 'CHECK FAIL: resubmit after reversal did not write split rows';
  end if;
  if (select count(*) from public.payment_requests
      where id in (v_pr1, v_pr2, v_pr3) and cash_settlement_status = 'completed') <> 3 then
    raise exception 'CHECK FAIL: resubmit after reversal did not complete all 3 phiếu';
  end if;
  v_log := v_log || 'manual reversal + resubmit ok; ';

  raise exception 'SMOKE_RESULT PASS: %', v_log;
end $$;
