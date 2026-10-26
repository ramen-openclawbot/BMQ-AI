-- Rollback-only production QA/CHECKS for migration
-- 20261103040000_payment_request_stock_label_jev.sql.
--
-- Run as one file (the caller wraps the migration and these checks in one
-- transaction, e.g. `begin; <migration>; <this file>; rollback;`). This file
-- contains CHECKS ONLY: it never copies the migration and the final ROLLBACK
-- discards every fixture. It assumes production has exactly 1 owner and the
-- pg_cron / pg_net extensions used by the cost-classify-sushi schedule.
begin;

do $$
declare
  v_owner uuid;
  v_supplier uuid;
  v_po uuid;
  v_receipt uuid;
  v_candidate uuid;
  v_rejected uuid;
  v_receipt_linked uuid;
  v_po_linked uuid;
  v_manual uuid;
  v_jev uuid;
  v_low uuid;
  v_below uuid;
  v_ran uuid;
  v_disabled uuid;
  v_created_nonstock uuid;
  v_old uuid;
  v_result jsonb;
  v_row record;
  v_count integer;
  v_source text;
  v_class text;
  v_requires boolean;
  v_reason text;
  v_confidence numeric;
  v_set_by uuid;
  v_set_at timestamptz;
  v_before jsonb;
begin
  -- -------------------------------------------------------------------------
  -- 1. Schema / grants / RLS / RPCs / schedule exist.
  -- -------------------------------------------------------------------------
  if not exists (
    select 1 from pg_class
    where oid = 'public.payment_stock_label_jev_settings'::regclass and relrowsecurity
  ) then
    raise exception 'CHECK FAIL: settings table is missing or RLS is off';
  end if;
  if not exists (
    select 1 from pg_class
    where oid = 'public.payment_stock_label_jev_runs'::regclass and relrowsecurity
  ) then
    raise exception 'CHECK FAIL: runs table is missing or RLS is off';
  end if;

  if not has_table_privilege('authenticated', 'public.payment_stock_label_jev_settings', 'select')
     or has_table_privilege('authenticated', 'public.payment_stock_label_jev_settings', 'insert')
     or has_table_privilege('authenticated', 'public.payment_stock_label_jev_settings', 'update')
     or has_table_privilege('authenticated', 'public.payment_stock_label_jev_settings', 'delete') then
    raise exception 'CHECK FAIL: settings grants are not select-only for authenticated';
  end if;
  if not has_table_privilege('authenticated', 'public.payment_stock_label_jev_runs', 'select')
     or has_table_privilege('authenticated', 'public.payment_stock_label_jev_runs', 'insert')
     or has_table_privilege('authenticated', 'public.payment_stock_label_jev_runs', 'update')
     or has_table_privilege('authenticated', 'public.payment_stock_label_jev_runs', 'delete') then
    raise exception 'CHECK FAIL: runs grants are not select-only for authenticated';
  end if;

  if has_function_privilege(
       'authenticated',
       to_regprocedure('public.list_payment_requests_for_stock_label(int)'),
       'execute'
     )
     or has_function_privilege(
       'anon',
       to_regprocedure('public.list_payment_requests_for_stock_label(int)'),
       'execute'
     ) then
    raise exception 'CHECK FAIL: list_payment_requests_for_stock_label is callable by a client role';
  end if;
  if has_function_privilege(
       'authenticated',
       to_regprocedure('public.apply_payment_request_stock_label_jev(uuid,text,numeric,text,text)'),
       'execute'
     )
     or has_function_privilege(
       'anon',
       to_regprocedure('public.apply_payment_request_stock_label_jev(uuid,text,numeric,text,text)'),
       'execute'
     ) then
    raise exception 'CHECK FAIL: apply_payment_request_stock_label_jev is callable by a client role';
  end if;
  if not has_function_privilege(
       'service_role',
       to_regprocedure('public.apply_payment_request_stock_label_jev(uuid,text,numeric,text,text)'),
       'execute'
     ) then
    raise exception 'CHECK FAIL: service_role cannot execute the apply RPC';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_requests'::regclass
      and conname = 'payment_requests_stock_label_source_check'
  ) then
    raise exception 'CHECK FAIL: payment_requests.stock_label_source check is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.payment_requests'::regclass
      and conname = 'payment_requests_stock_label_jev_class_check'
  ) then
    raise exception 'CHECK FAIL: payment_requests.stock_label_jev_class check is missing';
  end if;

  if not exists (
    select 1 from cron.job where jobname = 'payment-stock-label-jev-15m'
  ) then
    raise exception 'CHECK FAIL: the 15-minute pg_cron job is missing';
  end if;

  select user_id into v_owner
  from public.user_roles
  where role = 'owner'::public.app_role
  order by created_at
  limit 1;
  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user';
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Rollback-only fixtures.
  -- -------------------------------------------------------------------------
  insert into public.suppliers (name)
  values ('NCC Smoke Jev Stock Label')
  returning id into v_supplier;

  insert into public.purchase_orders (po_number, supplier_id, status, total_amount)
  values ('PO-SMOKE-JEV-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), v_supplier, 'draft', 1000000)
  returning id into v_po;

  insert into public.goods_receipts (receipt_number, supplier_id, status)
  values ('GR-SMOKE-JEV-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), v_supplier, 'draft')
  returning id into v_receipt;

  insert into public.payment_requests (
    request_number, supplier_id, title, description, total_amount, vat_amount,
    status, delivery_status, payment_status, requires_receipt, created_by
  ) values (
    'PR-SMOKE-JEV-A-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_supplier, 'Đề nghị chi - Bột mì 888', 'Nhập bột cho bếp', 250000, 0,
    'pending', 'pending', 'unpaid', true, v_owner
  ) returning id into v_candidate;

  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total
  ) values
    (v_candidate, 'Bột mì 888', 10, 'kg', 20000, 200000),
    (v_candidate, 'Bột năng', 5, 'kg', 10000, 50000);

  insert into public.payment_requests (
    request_number, supplier_id, title, total_amount, status, delivery_status,
    payment_status, requires_receipt, created_by
  ) values (
    'PR-SMOKE-JEV-REJ-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_supplier, 'Đề nghị chi bị từ chối', 100000, 'rejected', 'pending', 'unpaid', true, v_owner
  ) returning id into v_rejected;

  insert into public.payment_requests (
    request_number, supplier_id, goods_receipt_id, title, total_amount, status,
    delivery_status, payment_status, requires_receipt, created_by
  ) values (
    'PR-SMOKE-JEV-GR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_supplier, v_receipt, 'Đề nghị chi đã có phiếu nhập', 150000, 'pending', 'pending', 'unpaid', true, v_owner
  ) returning id into v_receipt_linked;

  insert into public.payment_requests (
    request_number, supplier_id, purchase_order_id, title, total_amount, status,
    delivery_status, payment_status, requires_receipt, created_by
  ) values (
    'PR-SMOKE-JEV-PO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_supplier, v_po, 'Đề nghị chi đã gắn PO', 160000, 'pending', 'pending', 'unpaid', true, v_owner
  ) returning id into v_po_linked;

  insert into public.payment_requests (
    request_number, supplier_id, title, total_amount, status, delivery_status,
    payment_status, requires_receipt, no_receipt_reason, no_receipt_set_at,
    stock_label_source, created_by
  ) values (
    'PR-SMOKE-JEV-MAN-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_supplier, 'Đề nghị chi đã gắn nhãn tay', 90000, 'pending', 'pending',
    'unpaid', false, 'Người đặt nhãn tay', now(), 'manual', v_owner
  ) returning id into v_manual;

  insert into public.payment_requests (
    request_number, supplier_id, title, total_amount, status, delivery_status,
    payment_status, requires_receipt, no_receipt_reason, no_receipt_set_at,
    stock_label_source, stock_label_jev_class, stock_label_jev_confidence,
    stock_label_jev_reason, stock_label_jev_at, created_by
  ) values (
    'PR-SMOKE-JEV-JEV-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_supplier, 'Đề nghị chi Jev đã gắn nhãn', 70000, 'pending', 'pending',
    'unpaid', false, 'Jev: Tiền điện', now(), 'jev', 'non_stock', 0.97,
    'Tiền điện', now(), v_owner
  ) returning id into v_jev;

  insert into public.payment_requests (
    request_number, supplier_id, title, total_amount, status, delivery_status,
    payment_status, requires_receipt, created_by
  ) values (
    'PR-SMOKE-JEV-LOW-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_supplier, 'Đề nghị chi dưới ngưỡng', 80000, 'pending', 'pending', 'unpaid', true, v_owner
  ) returning id into v_low;

  insert into public.payment_requests (
    request_number, supplier_id, title, total_amount, status, delivery_status,
    payment_status, requires_receipt, created_by
  ) values (
    'PR-SMOKE-JEV-BELOW-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_supplier, 'Đề nghị chi gợi ý dưới ngưỡng', 85000, 'pending', 'pending', 'unpaid', true, v_owner
  ) returning id into v_below;

  insert into public.payment_requests (
    request_number, supplier_id, title, total_amount, status, delivery_status,
    payment_status, requires_receipt, created_by
  ) values (
    'PR-SMOKE-JEV-RAN-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_supplier, 'Đề nghị chi đã chạy Jev', 86000, 'pending', 'pending', 'unpaid', true, v_owner
  ) returning id into v_ran;

  insert into public.payment_stock_label_jev_runs (request_id, class, confidence, reason, applied)
  values (v_ran, 'stock', 0.6, 'Đã chạy trước đó', false);

  insert into public.payment_requests (
    request_number, supplier_id, title, total_amount, status, delivery_status,
    payment_status, requires_receipt, created_by
  ) values (
    'PR-SMOKE-JEV-OFF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_supplier, 'Đề nghị chi khi công tắc tắt', 87000, 'pending', 'pending', 'unpaid', true, v_owner
  ) returning id into v_disabled;

  -- Created as không nhập kho by a person (checkbox), no Jev/manual source yet.
  insert into public.payment_requests (
    request_number, supplier_id, title, total_amount, status, delivery_status,
    payment_status, requires_receipt, no_receipt_reason, created_by
  ) values (
    'PR-SMOKE-JEV-NEW-NS-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_supplier, 'Tiền điện tạo sẵn không nhập kho', 88000, 'pending', 'pending', 'unpaid', false,
    'Người lập tích không nhập kho', v_owner
  ) returning id into v_created_nonstock;

  -- Created before start_from: historical requests are never relabelled.
  insert into public.payment_requests (
    request_number, supplier_id, title, total_amount, status, delivery_status,
    payment_status, requires_receipt, created_by, created_at
  ) values (
    'PR-SMOKE-JEV-OLD-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    v_supplier, 'Đề nghị chi cũ', 89000, 'pending', 'pending', 'unpaid', true, v_owner,
    now() - interval '2 days'
  ) returning id into v_old;

  update public.payment_stock_label_jev_settings
  set enabled = true,
      min_confidence = 0.9,
      daily_limit = 200,
      start_from = now() - interval '1 day',
      updated_at = now()
  where id = true;

  -- -------------------------------------------------------------------------
  -- 3. Candidate reader honours every exclusion and returns manual examples.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);

  select count(*) into v_count
  from public.list_payment_requests_for_stock_label(50) l
  where l.request_id in (v_candidate, v_low, v_below, v_disabled);
  if v_count <> 4 then
    raise exception 'CHECK FAIL: expected 4 candidates, got %', v_count;
  end if;

  select count(*) into v_count
  from public.list_payment_requests_for_stock_label(50) l
  where l.request_id in (v_rejected, v_receipt_linked, v_po_linked, v_manual, v_jev, v_ran, v_created_nonstock, v_old);
  if v_count <> 0 then
    raise exception 'CHECK FAIL: excluded request still appears in the candidate list';
  end if;

  select l.manual_examples into v_before
  from public.list_payment_requests_for_stock_label(50) l
  where l.request_id = v_candidate;
  if v_before is null or jsonb_array_length(v_before) < 1 then
    raise exception 'CHECK FAIL: manual examples missing for the same supplier';
  end if;
  if not (v_before->0 ? 'requires_receipt') then
    raise exception 'CHECK FAIL: manual example has no requires_receipt';
  end if;

  -- -------------------------------------------------------------------------
  -- 4. Client roles cannot call the two service-role RPCs.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);

  begin
    perform public.list_payment_requests_for_stock_label(10);
    raise exception 'CHECK FAIL: authenticated called list_payment_requests_for_stock_label';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.apply_payment_request_stock_label_jev(
      v_candidate, 'stock', 0.99, 'Không được phép', 'typesafe-ai/jev'
    );
    raise exception 'CHECK FAIL: authenticated called apply_payment_request_stock_label_jev';
  exception when insufficient_privilege then
    null;
  end;

  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- -------------------------------------------------------------------------
  -- 5. stock at/above the threshold applies and keeps requires_receipt = true.
  -- -------------------------------------------------------------------------
  v_result := public.apply_payment_request_stock_label_jev(
    v_candidate, 'stock', 0.95, 'Hàng hóa nhập kho', 'typesafe-ai/jev'
  );
  if v_result->>'status' <> 'applied' or (v_result->>'applied')::boolean is not true then
    raise exception 'CHECK FAIL: stock apply did not apply: %', v_result;
  end if;

  select requires_receipt, stock_label_source, stock_label_jev_class,
         no_receipt_reason
    into v_requires, v_source, v_class, v_reason
  from public.payment_requests
  where id = v_candidate;
  if v_requires is not true or v_source <> 'jev' or v_class <> 'stock' then
    raise exception 'CHECK FAIL: stock apply wrote wrong state: % / % / %', v_requires, v_source, v_class;
  end if;

  select count(*) into v_count
  from public.payment_stock_label_jev_runs
  where request_id = v_candidate and applied = true and skipped_reason is null;
  if v_count <> 1 then
    raise exception 'CHECK FAIL: stock apply did not write exactly one applied run row';
  end if;

  -- A second pass is skipped and can never overwrite the Jev row.
  v_result := public.apply_payment_request_stock_label_jev(
    v_candidate, 'non_stock', 0.99, 'Ghi đè', 'typesafe-ai/jev'
  );
  if v_result->>'status' <> 'skipped' or v_result->>'reason' not in ('already_labeled', 'already_ran') then
    raise exception 'CHECK FAIL: second apply was not skipped: %', v_result;
  end if;
  select requires_receipt, stock_label_source into v_requires, v_source
  from public.payment_requests where id = v_candidate;
  if v_requires is not true or v_source <> 'jev' then
    raise exception 'CHECK FAIL: second apply overwrote the first label';
  end if;

  -- -------------------------------------------------------------------------
  -- 6. non_stock at/above the threshold sets requires_receipt = false and
  --    no_receipt_reason = 'Jev: <reason>'.
  -- -------------------------------------------------------------------------
  v_result := public.apply_payment_request_stock_label_jev(
    v_low, 'non_stock', 0.96, 'Tiền điện tháng 10', 'typesafe-ai/jev'
  );
  if v_result->>'status' <> 'applied' then
    raise exception 'CHECK FAIL: non_stock apply did not apply: %', v_result;
  end if;

  select requires_receipt, stock_label_source, stock_label_jev_class,
         no_receipt_reason, no_receipt_set_by, no_receipt_set_at
    into v_requires, v_source, v_class, v_reason, v_set_by, v_set_at
  from public.payment_requests
  where id = v_low;
  if v_requires is not false or v_source <> 'jev' or v_class <> 'non_stock' then
    raise exception 'CHECK FAIL: non_stock apply wrote wrong state: % / % / %', v_requires, v_source, v_class;
  end if;
  if v_reason <> 'Jev: Tiền điện tháng 10' then
    raise exception 'CHECK FAIL: no_receipt_reason is %', v_reason;
  end if;
  if v_set_by is not null or v_set_at is null then
    raise exception 'CHECK FAIL: Jev non_stock must leave no_receipt_set_by null and set no_receipt_set_at';
  end if;
  if length(v_reason) > 200 then
    raise exception 'CHECK FAIL: no_receipt_reason is longer than 200 characters';
  end if;

  -- -------------------------------------------------------------------------
  -- 7. Below the threshold only the suggestion is stored.
  -- -------------------------------------------------------------------------
  v_result := public.apply_payment_request_stock_label_jev(
    v_below, 'non_stock', 0.5, 'Gợi ý yếu', 'typesafe-ai/jev'
  );
  if v_result->>'status' <> 'suggested' or (v_result->>'applied')::boolean is not false then
    raise exception 'CHECK FAIL: below-threshold result is %', v_result;
  end if;

  select requires_receipt, stock_label_source, stock_label_jev_class,
         stock_label_jev_confidence, stock_label_jev_reason
    into v_requires, v_source, v_class, v_confidence, v_reason
  from public.payment_requests
  where id = v_below;
  if v_requires is not true or v_source is not null or v_class <> 'non_stock' then
    raise exception 'CHECK FAIL: below-threshold changed the label: % / % / %', v_requires, v_source, v_class;
  end if;
  if v_reason <> 'Gợi ý yếu' then
    raise exception 'CHECK FAIL: below-threshold reason is %', v_reason;
  end if;
  select count(*) into v_count
  from public.payment_stock_label_jev_runs
  where request_id = v_below and applied = false and skipped_reason is null;
  if v_count <> 1 then
    raise exception 'CHECK FAIL: below-threshold suggestion was not logged';
  end if;

  -- -------------------------------------------------------------------------
  -- 8. A manual label always wins and is never overwritten by Jev.
  -- -------------------------------------------------------------------------
  v_result := public.apply_payment_request_stock_label_jev(
    v_manual, 'non_stock', 0.99, 'Jev muốn đổi', 'typesafe-ai/jev'
  );
  if v_result->>'status' <> 'skipped' or v_result->>'reason' <> 'already_labeled' then
    raise exception 'CHECK FAIL: manual label was not protected: %', v_result;
  end if;
  select stock_label_source, requires_receipt, no_receipt_reason
    into v_source, v_requires, v_reason
  from public.payment_requests where id = v_manual;
  if v_source <> 'manual' or v_requires is not false or v_reason <> 'Người đặt nhãn tay' then
    raise exception 'CHECK FAIL: manual label changed: % / % / %', v_source, v_requires, v_reason;
  end if;

  -- Rejected / receipt-linked / PO-linked / already-run requests are skipped.
  v_result := public.apply_payment_request_stock_label_jev(
    v_rejected, 'stock', 0.99, 'Thử', 'typesafe-ai/jev'
  );
  if v_result->>'reason' <> 'rejected' then
    raise exception 'CHECK FAIL: rejected request was not skipped: %', v_result;
  end if;

  v_result := public.apply_payment_request_stock_label_jev(
    v_receipt_linked, 'stock', 0.99, 'Thử', 'typesafe-ai/jev'
  );
  if v_result->>'reason' <> 'receipt_linked' then
    raise exception 'CHECK FAIL: receipt-linked request was not skipped: %', v_result;
  end if;

  v_result := public.apply_payment_request_stock_label_jev(
    v_po_linked, 'stock', 0.99, 'Thử', 'typesafe-ai/jev'
  );
  if v_result->>'reason' <> 'receipt_linked' then
    raise exception 'CHECK FAIL: PO-linked request was not skipped: %', v_result;
  end if;

  v_result := public.apply_payment_request_stock_label_jev(
    v_ran, 'stock', 0.99, 'Thử', 'typesafe-ai/jev'
  );
  if v_result->>'reason' <> 'already_ran' then
    raise exception 'CHECK FAIL: already-run request was not skipped: %', v_result;
  end if;

  v_result := public.apply_payment_request_stock_label_jev(
    v_created_nonstock, 'stock', 0.99, 'Thử', 'typesafe-ai/jev'
  );
  select requires_receipt into v_requires from public.payment_requests where id = v_created_nonstock;
  if v_result->>'status' <> 'skipped' or v_requires is not false then
    raise exception 'CHECK FAIL: Jev flipped a request created as không nhập kho: % / %', v_result, v_requires;
  end if;

  v_result := public.apply_payment_request_stock_label_jev(
    v_old, 'non_stock', 0.99, 'Thử', 'typesafe-ai/jev'
  );
  select requires_receipt into v_requires from public.payment_requests where id = v_old;
  if v_result->>'reason' <> 'before_start' or v_requires is not true then
    raise exception 'CHECK FAIL: Jev relabelled a request created before start_from: % / %', v_result, v_requires;
  end if;

  -- The enabled switch is re-checked by the writer.
  update public.payment_stock_label_jev_settings set enabled = false where id = true;
  v_result := public.apply_payment_request_stock_label_jev(
    v_disabled, 'non_stock', 0.99, 'Thử khi tắt', 'typesafe-ai/jev'
  );
  if v_result->>'reason' <> 'disabled' then
    raise exception 'CHECK FAIL: disabled switch was not enforced by the writer: %', v_result;
  end if;
  update public.payment_stock_label_jev_settings set enabled = true where id = true;

  -- -------------------------------------------------------------------------
  -- 9. A human override of a Jev label wins, sets source='manual' and writes
  --    one human_override feedback row.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);

  v_result := public.set_payment_request_requires_receipt(v_jev, true, null);
  if v_result->>'requires_receipt' <> 'true' then
    raise exception 'CHECK FAIL: human toggle failed: %', v_result;
  end if;

  select stock_label_source, requires_receipt, stock_label_jev_class
    into v_source, v_requires, v_class
  from public.payment_requests where id = v_jev;
  if v_source <> 'manual' or v_requires is not true then
    raise exception 'CHECK FAIL: human override did not set source=manual / requires_receipt=true';
  end if;
  if v_class <> 'non_stock' then
    raise exception 'CHECK FAIL: human override erased the Jev class used for feedback';
  end if;

  select count(*) into v_count
  from public.payment_stock_label_jev_runs
  where request_id = v_jev and skipped_reason = 'human_override' and class = 'stock';
  if v_count <> 1 then
    raise exception 'CHECK FAIL: human_override feedback row missing or wrong class: %', v_count;
  end if;

  -- Jev can never take the label back after the human override.
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);

  v_result := public.apply_payment_request_stock_label_jev(
    v_jev, 'non_stock', 0.99, 'Jev đổi lại', 'typesafe-ai/jev'
  );
  if v_result->>'status' <> 'skipped' then
    raise exception 'CHECK FAIL: Jev overwrote a human override: %', v_result;
  end if;
  select stock_label_source, requires_receipt into v_source, v_requires
  from public.payment_requests where id = v_jev;
  if v_source <> 'manual' or v_requires is not true then
    raise exception 'CHECK FAIL: human override was overwritten';
  end if;

  -- -------------------------------------------------------------------------
  -- 10. Every applied/suggested/override decision wrote an audit row.
  -- -------------------------------------------------------------------------
  select count(*) into v_count
  from public.audit_logs
  where action = 'payment_request_requires_receipt_changed'
    and target_id in (v_candidate, v_low, v_below, v_jev);
  if v_count < 4 then
    raise exception 'CHECK FAIL: expected at least 4 audit rows, got %', v_count;
  end if;

  raise notice 'ALL PASS: payment_request_stock_label_jev checks passed';
end $$;

rollback;
