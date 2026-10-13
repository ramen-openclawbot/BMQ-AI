-- Rollback-only production smoke CHECKS for migration
-- 20261031130000_unc_whole_dong_match.sql.
--
-- Run as one file: `begin; <migration>; <this file>` (the caller wraps the
-- migration and these checks in a transaction). This file contains CHECKS ONLY
-- and never copies the migration. The final RAISE ends the transaction, so every
-- fixture created here is rolled back. It assumes production has exactly 1 owner.
--
-- Rule under test: an UNC amount and a payable request total match when they are
-- equal after rounding to whole đồng (|difference| < 1). A request total of
-- 1.371.659,87 đ (item VAT leaves the .87) approves against a 1.371.660 đ bank
-- slip, while 1.371.661 đ is still a mismatch; an allocation of 1.371.660 đ is
-- allowed on the 1.371.659,87 đ remaining, 1.371.661 đ exceeds it.
do $$
declare
  v_owner uuid;
  v_staff uuid := gen_random_uuid();
  v_request_pass uuid := gen_random_uuid();
  v_request_mismatch uuid := gen_random_uuid();
  v_sha_pass text := encode(
    sha256(convert_to('smoke-unc-whole-dong-pass:' || gen_random_uuid()::text, 'UTF8')),
    'hex'
  );
  v_sha_mismatch text := encode(
    sha256(convert_to('smoke-unc-whole-dong-mismatch:' || gen_random_uuid()::text, 'UTF8')),
    'hex'
  );
  v_sha_alloc text := encode(
    sha256(convert_to('smoke-unc-whole-dong-alloc:' || gen_random_uuid()::text, 'UTF8')),
    'hex'
  );
  v_result jsonb;
  v_ok boolean;
  v_log text := '';
begin
  -- -------------------------------------------------------------------------
  -- 1. Fixtures: exactly 1 owner, two rollback-only pending phiếu whose total
  --    carries the lẻ-xu VAT fraction, and their server-side OCR drafts.
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
  ) values
    (
      v_request_pass,
      'SMOKE-UNC-WD-' || left(v_request_pass::text, 8),
      'Smoke UNC lẻ xu duyệt thẳng', 'Smoke', 1371659.87,
      'pending', 'pending', 'unpaid', 'bank_transfer', v_staff
    ),
    (
      v_request_mismatch,
      'SMOKE-UNC-WD-' || left(v_request_mismatch::text, 8),
      'Smoke UNC lẻ xu lệch/phân bổ', 'Smoke', 1371659.87,
      'pending', 'pending', 'unpaid', 'bank_transfer', v_staff
    );

  insert into public.payment_request_items (
    payment_request_id, product_name, quantity, unit, unit_price, line_total,
    cost_review_routing, standard_cost_code_type
  ) values
    (v_request_pass, 'Nước', 1, 'lần', 1371659.87, 1371659.87, 'none', 'OTHER'),
    (v_request_mismatch, 'Nước', 1, 'lần', 1371659.87, 1371659.87, 'none', 'OTHER');

  insert into public.payment_unc_ocr_drafts (
    file_sha256, storage_path, ocr_amount, transfer_date, ocr_reference
  ) values
    (v_sha_pass, 'payment-unc/smoke/whole-dong-pass.jpg', 1371660, current_date, 'SMOKE-UNC-WD-PASS'),
    (v_sha_mismatch, 'payment-unc/smoke/whole-dong-mismatch.jpg', 1371661, current_date, 'SMOKE-UNC-WD-MISMATCH'),
    (v_sha_alloc, 'payment-unc/smoke/whole-dong-alloc.jpg', 1371660, current_date, 'SMOKE-UNC-WD-ALLOC');
  v_log := v_log || 'fixtures ok; ';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
  perform set_config('role', 'authenticated', true);

  -- -------------------------------------------------------------------------
  -- 2. No allocations, no manual override: the 1.371.660 đ draft matches the
  --    1.371.659,87 đ total and the request becomes paid.
  -- -------------------------------------------------------------------------
  v_result := public.approve_payment_requests_with_unc(
    array[v_request_pass],
    jsonb_build_object(
      'file_sha256', v_sha_pass,
      'storage_path', 'payment-unc/smoke/whole-dong-pass.jpg',
      'ocr_amount', 1371660,
      'payment_method', 'bank_transfer',
      'category', 'khac'
    ),
    'smoke-unc-whole-dong-pass-1'
  );
  if (select status::text from public.payment_requests where id = v_request_pass) <> 'approved'
     or (select payment_status::text from public.payment_requests where id = v_request_pass) <> 'paid' then
    raise exception 'CHECK FAIL: the lẻ-xu request was not approved/paid';
  end if;
  if (v_result->>'amount')::numeric <> 1371659.87 then
    raise exception 'CHECK FAIL: payment amount = % (expected 1371659.87)', v_result->>'amount';
  end if;
  v_log := v_log || 'lẻ-xu total approved as paid; ';

  -- -------------------------------------------------------------------------
  -- 3. A draft one đồng over the lẻ-xu total is still a mismatch.
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.approve_payment_requests_with_unc(
      array[v_request_mismatch],
      jsonb_build_object(
        'file_sha256', v_sha_mismatch,
        'storage_path', 'payment-unc/smoke/whole-dong-mismatch.jpg',
        'ocr_amount', 1371661,
        'payment_method', 'bank_transfer',
        'category', 'khac'
      ),
      'smoke-unc-whole-dong-mismatch-1'
    );
  exception when others then
    v_ok := sqlerrm like '%amount_mismatch%';
  end;
  if not v_ok then
    raise exception 'CHECK FAIL: 1371661 was accepted for a 1371659.87 total';
  end if;
  v_log := v_log || 'one đồng over is amount_mismatch; ';

  -- -------------------------------------------------------------------------
  -- 4. Per-request allocations: 1.371.661 đ exceeds the lẻ-xu remaining (and
  --    leaves the request untouched), 1.371.660 đ is allowed and pays it.
  -- -------------------------------------------------------------------------
  v_ok := false;
  begin
    perform public.approve_payment_requests_with_unc(
      array[v_request_mismatch],
      jsonb_build_object(
        'file_sha256', v_sha_alloc,
        'storage_path', 'payment-unc/smoke/whole-dong-alloc.jpg',
        'ocr_amount', 1371660,
        'payment_method', 'bank_transfer',
        'category', 'khac',
        'allocations', jsonb_build_array(
          jsonb_build_object('payment_request_id', v_request_mismatch, 'amount', 1371661)
        )
      ),
      'smoke-unc-whole-dong-alloc-over-1'
    );
  exception when others then
    v_ok := sqlerrm like '%allocation_exceeds_remaining%';
  end;
  if not v_ok then
    raise exception 'CHECK FAIL: an allocation of 1371661 did not exceed the lẻ-xu remaining';
  end if;
  if (select status::text from public.payment_requests where id = v_request_mismatch) <> 'pending' then
    raise exception 'CHECK FAIL: the rejected allocation changed the request state';
  end if;
  v_log := v_log || 'alloc 1371661 exceeds and is rejected; ';

  v_result := public.approve_payment_requests_with_unc(
    array[v_request_mismatch],
    jsonb_build_object(
      'file_sha256', v_sha_alloc,
      'storage_path', 'payment-unc/smoke/whole-dong-alloc.jpg',
      'ocr_amount', 1371660,
      'payment_method', 'bank_transfer',
      'category', 'khac',
      'allocations', jsonb_build_array(
        jsonb_build_object('payment_request_id', v_request_mismatch, 'amount', 1371660)
      )
    ),
    'smoke-unc-whole-dong-alloc-pass-1'
  );
  if (select status::text from public.payment_requests where id = v_request_mismatch) <> 'approved'
     or (select payment_status::text from public.payment_requests where id = v_request_mismatch) <> 'paid' then
    raise exception 'CHECK FAIL: the 1371660 allocation did not mark the lẻ-xu request paid';
  end if;
  v_log := v_log || 'alloc 1371660 covers and pays; ';

  raise exception 'SMOKE_RESULT PASS: %', v_log;
end $$;
