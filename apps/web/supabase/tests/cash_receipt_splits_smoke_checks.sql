-- Rollback-only production smoke CHECKS for migration
-- 20261102100000_cash_receipt_splits.sql.
--
-- Run as one file: `begin; <migration>; <this file>` (the caller wraps the
-- migration and these checks in a transaction). This file contains CHECKS ONLY
-- and never copies the migration. The final RAISE ends the transaction, so every
-- fixture created here is rolled back. It assumes production has exactly 1 owner.
do $$
declare
  v_owner uuid;
  v_split_pr uuid := gen_random_uuid();
  v_split_item_a uuid;
  v_split_item_b uuid;
  v_split_receipt uuid := gen_random_uuid();
  v_over_pr uuid := gen_random_uuid();
  v_over_item_a uuid;
  v_over_item_b uuid;
  v_over_receipt uuid := gen_random_uuid();
  v_legacy_pr uuid := gen_random_uuid();
  v_legacy_item uuid;
  v_legacy_receipt uuid := gen_random_uuid();
  v_result jsonb;
  v_count integer;
  v_sum numeric;
  v_ok boolean;
  v_log text := '';
begin
  -- -------------------------------------------------------------------------
  -- 1. Schema / grants / RLS / policy / unique key.
  -- -------------------------------------------------------------------------
  if to_regclass('public.payment_cash_receipt_splits') is null then
    raise exception 'CHECK FAIL: payment_cash_receipt_splits is missing';
  end if;

  if not exists (
    select 1 from pg_class
    where oid = 'public.payment_cash_receipt_splits'::regclass and relrowsecurity
  ) then
    raise exception 'CHECK FAIL: RLS off on payment_cash_receipt_splits';
  end if;

  if not has_table_privilege('authenticated', 'public.payment_cash_receipt_splits', 'select') then
    raise exception 'CHECK FAIL: authenticated cannot select payment_cash_receipt_splits';
  end if;
  if has_table_privilege('authenticated', 'public.payment_cash_receipt_splits', 'insert')
     or has_table_privilege('authenticated', 'public.payment_cash_receipt_splits', 'update')
     or has_table_privilege('authenticated', 'public.payment_cash_receipt_splits', 'delete') then
    raise exception 'CHECK FAIL: authenticated has a write privilege on payment_cash_receipt_splits';
  end if;
  if has_table_privilege('anon', 'public.payment_cash_receipt_splits', 'select') then
    raise exception 'CHECK FAIL: anon can read payment_cash_receipt_splits';
  end if;
  if not has_table_privilege('service_role', 'public.payment_cash_receipt_splits', 'select')
     or not has_table_privilege('service_role', 'public.payment_cash_receipt_splits', 'insert')
     or not has_table_privilege('service_role', 'public.payment_cash_receipt_splits', 'update')
     or not has_table_privilege('service_role', 'public.payment_cash_receipt_splits', 'delete') then
    raise exception 'CHECK FAIL: service_role does not have all on payment_cash_receipt_splits';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_cash_receipt_splits'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) like '%(receipt_id, payment_request_item_id)%'
  ) then
    raise exception 'CHECK FAIL: unique(receipt_id, payment_request_item_id) is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_cash_receipt_splits'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) like '%payment_cash_receipts(id)%'
  ) then
    raise exception 'CHECK FAIL: receipt_id FK is missing';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'payment_cash_receipt_splits'
      and policyname = 'payment_cash_receipt_splits_select'
      and cmd = 'SELECT'
  ) then
    raise exception 'CHECK FAIL: payment_cash_receipt_splits_select policy is missing';
  end if;
  v_log := v_log || 'schema/grants/rls/unique/policy ok; ';

  -- -------------------------------------------------------------------------
  -- 2. Fixtures (rollback only): one owner + three cash PRs awaiting receipts.
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
    status, delivery_status, payment_status, payment_method, created_by,
    cash_settlement_status
  ) values (
    v_split_pr, 'SMOKE-SPLIT-' || left(v_split_pr::text, 8), 'Smoke split receipt', 'Smoke',
    5238000, 'approved', 'pending', 'paid', 'cash', v_owner, 'awaiting_receipts'
  );
  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values (
    v_split_pr, 'Khoản A', 1, 'lần', 2592000, 2592000, 'none', 'OTHER'
  ) returning id into v_split_item_a;
  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values (
    v_split_pr, 'Khoản B', 1, 'lần', 2646000, 2646000, 'none', 'OTHER'
  ) returning id into v_split_item_b;

  insert into public.payment_requests (
    id, request_number, title, description, total_amount,
    status, delivery_status, payment_status, payment_method, created_by,
    cash_settlement_status
  ) values (
    v_over_pr, 'SMOKE-OVER-' || left(v_over_pr::text, 8), 'Smoke over-allocated receipt', 'Smoke',
    4000000, 'approved', 'pending', 'paid', 'cash', v_owner, 'awaiting_receipts'
  );
  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values (
    v_over_pr, 'Khoản C', 1, 'lần', 2000000, 2000000, 'none', 'OTHER'
  ) returning id into v_over_item_a;
  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values (
    v_over_pr, 'Khoản D', 1, 'lần', 2000000, 2000000, 'none', 'OTHER'
  ) returning id into v_over_item_b;

  insert into public.payment_requests (
    id, request_number, title, description, total_amount,
    status, delivery_status, payment_status, payment_method, created_by,
    cash_settlement_status
  ) values (
    v_legacy_pr, 'SMOKE-LEGACY-' || left(v_legacy_pr::text, 8), 'Smoke legacy single receipt', 'Smoke',
    1000000, 'approved', 'pending', 'paid', 'cash', v_owner, 'awaiting_receipts'
  );
  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values (
    v_legacy_pr, 'Khoản E', 1, 'lần', 1000000, 1000000, 'none', 'OTHER'
  ) returning id into v_legacy_item;

  -- Receipts are written by the service role (the edge function path).
  perform set_config('role', 'service_role', true);
  insert into public.payment_cash_receipts (
    id, payment_request_id, storage_path, file_sha256, ocr_amount, amount, status
  ) values
    (v_split_receipt, v_split_pr, 'payment-unc/smoke/split.jpg',
      encode(sha256(convert_to('smoke-split-' || v_split_receipt::text, 'UTF8')), 'hex'),
      5238000, 5238000, 'uploaded'),
    (v_over_receipt, v_over_pr, 'payment-unc/smoke/over.jpg',
      encode(sha256(convert_to('smoke-over-' || v_over_receipt::text, 'UTF8')), 'hex'),
      3000000, 3000000, 'uploaded'),
    (v_legacy_receipt, v_legacy_pr, 'payment-unc/smoke/legacy.jpg',
      encode(sha256(convert_to('smoke-legacy-' || v_legacy_receipt::text, 'UTF8')), 'hex'),
      1000000, 1000000, 'uploaded');
  perform set_config('role', 'postgres', true);
  v_log := v_log || 'fixtures ok; ';

  -- -------------------------------------------------------------------------
  -- 3. A duplicate (receipt_id, item_id) pair is still invalid_allocation.
  -- -------------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
  perform set_config('role', 'authenticated', true);

  v_ok := false;
  begin
    perform public.submit_cash_settlement(
      v_split_pr,
      jsonb_build_array(
        jsonb_build_object('receipt_id', v_split_receipt, 'item_id', v_split_item_a, 'amount', 1000000),
        jsonb_build_object('receipt_id', v_split_receipt, 'item_id', v_split_item_a, 'amount', 1000000)
      ),
      'smoke-split-dup-pair'
    );
  exception when others then
    v_ok := sqlerrm like '%invalid_allocation%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a duplicate receipt+item pair was accepted'; end if;
  v_log := v_log || 'duplicate pair rejected; ';

  -- -------------------------------------------------------------------------
  -- 4. One receipt allocated across both items -> two split rows, allocated
  --    receipt with null legacy item, completed PR, coverage on both sides.
  -- -------------------------------------------------------------------------
  v_result := public.submit_cash_settlement(
    v_split_pr,
    jsonb_build_array(
      jsonb_build_object('receipt_id', v_split_receipt, 'item_id', v_split_item_a, 'amount', 2592000),
      jsonb_build_object('receipt_id', v_split_receipt, 'item_id', v_split_item_b, 'amount', 2646000)
    ),
    'smoke-split-submit-1'
  );
  if v_result->>'status' <> 'completed' then
    raise exception 'CHECK FAIL: split submit status = %', v_result->>'status';
  end if;
  if (v_result->>'covered_total')::numeric <> 5238000
     or (v_result->>'remaining_total')::numeric <> 0 then
    raise exception 'CHECK FAIL: split submit totals = %', v_result;
  end if;

  select count(*), coalesce(sum(amount), 0)
    into v_count, v_sum
  from public.payment_cash_receipt_splits
  where receipt_id = v_split_receipt;
  if v_count <> 2 or v_sum <> 5238000 then
    raise exception 'CHECK FAIL: expected 2 split rows summing 5238000, got count=% sum=%', v_count, v_sum;
  end if;
  if (select count(*)
      from public.payment_cash_receipt_splits s
      join public.payment_request_items i on i.id = s.payment_request_item_id
      where s.receipt_id = v_split_receipt
        and s.amount = i.line_total) <> 2 then
    raise exception 'CHECK FAIL: split rows do not match their item amounts';
  end if;

  if (select status from public.payment_cash_receipts where id = v_split_receipt) <> 'allocated' then
    raise exception 'CHECK FAIL: split receipt is not allocated';
  end if;
  if (select payment_request_item_id from public.payment_cash_receipts where id = v_split_receipt) is not null then
    raise exception 'CHECK FAIL: split receipt kept a legacy payment_request_item_id';
  end if;
  if (select amount from public.payment_cash_receipts where id = v_split_receipt) <> 5238000 then
    raise exception 'CHECK FAIL: split receipt amount is not the split sum';
  end if;
  if (select allocated_at from public.payment_cash_receipts where id = v_split_receipt) is null then
    raise exception 'CHECK FAIL: split receipt allocated_at is null';
  end if;
  if (select cash_settlement_status from public.payment_requests where id = v_split_pr) <> 'completed' then
    raise exception 'CHECK FAIL: split PR is not completed';
  end if;

  -- Allocated split receipts are still refused by discard_cash_receipt.
  v_ok := false;
  begin
    perform public.discard_cash_receipt(v_split_receipt);
  exception when others then
    v_ok := sqlerrm like '%receipt_not_uploaded%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: an allocated split receipt was discarded'; end if;

  v_result := public.get_cash_settlement(v_split_pr);
  if v_result is null then
    raise exception 'CHECK FAIL: get_cash_settlement returned null';
  end if;
  if jsonb_array_length(v_result->'receipts') <> 1 then
    raise exception 'CHECK FAIL: get_cash_settlement receipts = %', v_result->'receipts';
  end if;
  if not (v_result->'receipts'->0 ? 'splits') then
    raise exception 'CHECK FAIL: get_cash_settlement receipt has no splits key';
  end if;
  if jsonb_array_length(v_result->'receipts'->0->'splits') <> 2 then
    raise exception 'CHECK FAIL: get_cash_settlement splits = %', v_result->'receipts'->0->'splits';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_result->'receipts'->0->'splits') s
    where s->>'item_id' = v_split_item_a::text and (s->>'amount')::numeric = 2592000
  ) or not exists (
    select 1 from jsonb_array_elements(v_result->'receipts'->0->'splits') s
    where s->>'item_id' = v_split_item_b::text and (s->>'amount')::numeric = 2646000
  ) then
    raise exception 'CHECK FAIL: get_cash_settlement splits contents = %', v_result->'receipts'->0->'splits';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_result->'items') i
    where (i->>'covered')::numeric <> (i->>'amount')::numeric
  ) then
    raise exception 'CHECK FAIL: get_cash_settlement item coverage is incomplete';
  end if;
  if not (v_result->'receipts'->0 ? 'payment_request_item_id')
     or not (v_result->'receipts'->0 ? 'storage_path')
     or not (v_result->'receipts'->0 ? 'ocr_amount')
     or not (v_result->'receipts'->0 ? 'status')
     or not (v_result->'receipts'->0 ? 'allocated_at') then
    raise exception 'CHECK FAIL: get_cash_settlement lost an existing receipt key';
  end if;
  v_log := v_log || 'split submit -> 2 rows + completed + splits read ok; ';

  -- -------------------------------------------------------------------------
  -- 5. The split sum may not exceed the receipt amount (receipt_over_allocated).
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.submit_cash_settlement(
      v_over_pr,
      jsonb_build_array(
        jsonb_build_object('receipt_id', v_over_receipt, 'item_id', v_over_item_a, 'amount', 2000000),
        jsonb_build_object('receipt_id', v_over_receipt, 'item_id', v_over_item_b, 'amount', 2000000)
      ),
      'smoke-split-over-1'
    );
  exception when others then
    v_ok := sqlerrm like '%receipt_over_allocated%';
  end;
  if not v_ok then raise exception 'CHECK FAIL: a split sum above the receipt was accepted'; end if;
  if (select count(*) from public.payment_cash_receipt_splits where receipt_id = v_over_receipt) <> 0 then
    raise exception 'CHECK FAIL: the rejected over-allocation wrote split rows';
  end if;
  if (select status from public.payment_cash_receipts where id = v_over_receipt) <> 'uploaded' then
    raise exception 'CHECK FAIL: the rejected receipt is no longer uploaded';
  end if;
  if (select cash_settlement_status from public.payment_requests where id = v_over_pr) <> 'awaiting_receipts' then
    raise exception 'CHECK FAIL: the rejected over-allocation changed the PR status';
  end if;
  v_log := v_log || 'receipt_over_allocated ok; ';

  -- -------------------------------------------------------------------------
  -- 6. Single-receipt/single-item still writes the legacy receipt column and
  --    no split rows (today's behaviour).
  -- -------------------------------------------------------------------------
  v_result := public.submit_cash_settlement(
    v_legacy_pr,
    jsonb_build_array(
      jsonb_build_object('receipt_id', v_legacy_receipt, 'item_id', v_legacy_item, 'amount', 1000000)
    ),
    'smoke-split-legacy-1'
  );
  if v_result->>'status' <> 'completed' then
    raise exception 'CHECK FAIL: legacy single submit status = %', v_result->>'status';
  end if;
  if (select payment_request_item_id from public.payment_cash_receipts where id = v_legacy_receipt)
     is distinct from v_legacy_item then
    raise exception 'CHECK FAIL: single receipt did not keep the legacy item column';
  end if;
  if (select amount from public.payment_cash_receipts where id = v_legacy_receipt) <> 1000000 then
    raise exception 'CHECK FAIL: single receipt amount changed';
  end if;
  if (select status from public.payment_cash_receipts where id = v_legacy_receipt) <> 'allocated' then
    raise exception 'CHECK FAIL: single receipt is not allocated';
  end if;
  if (select count(*) from public.payment_cash_receipt_splits where receipt_id = v_legacy_receipt) <> 0 then
    raise exception 'CHECK FAIL: a single allocation wrote split rows';
  end if;
  v_result := public.get_cash_settlement(v_legacy_pr);
  if jsonb_array_length(v_result->'receipts'->0->'splits') <> 0 then
    raise exception 'CHECK FAIL: single receipt splits is not empty';
  end if;
  if (select cash_settlement_status from public.payment_requests where id = v_legacy_pr) <> 'completed' then
    raise exception 'CHECK FAIL: legacy single PR is not completed';
  end if;
  v_log := v_log || 'single allocation keeps legacy column; ';

  raise exception 'SMOKE_RESULT PASS: %', v_log;
end $$;
