-- Rollback-only dry run for 20261116100000_payment_unc_skip_delivery_image.sql.
--
-- Run as one file after the migration is present in the database. Every fixture
-- uses a fixed 00000000-… id and the final rollback discards everything. The
-- last statement prints one summary row so the expected values can be compared.
--
-- It covers: (a) without the key a request whose receipt has no delivery image
-- is still refused with pr_requires_delivery_image; (b) skip_delivery_image =
-- true approves it and stamps skip_delivery_image_by/at; (c) a caller without
-- approval permission is still refused even with the key; (d) a supplier with
-- pay_before_delivery = true still passes without the key.
--
-- It only calls the approval RPC; it never approves a real request because every
-- fixture and write is rolled back at the end.

begin;

create temp table payment_unc_skip_delivery_image_checks (
  check_name text primary key,
  result text not null
) on commit drop;

-- ---------------------------------------------------------------------------
-- 1. Fixtures: two suppliers, four PO/receipt/request triples, OCR drafts.
-- ---------------------------------------------------------------------------

do $$
declare
  v_owner uuid;
  v_supplier uuid := '00000000-0000-0000-0000-000000000101';
  v_supplier_pay_before uuid := '00000000-0000-0000-0000-000000000102';
  v_po_no_image uuid := '00000000-0000-0000-0000-000000000111';
  v_po_skip uuid := '00000000-0000-0000-0000-000000000112';
  v_po_denied uuid := '00000000-0000-0000-0000-000000000113';
  v_po_pay_before uuid := '00000000-0000-0000-0000-000000000114';
  v_gr_no_image uuid := '00000000-0000-0000-0000-000000000121';
  v_gr_skip uuid := '00000000-0000-0000-0000-000000000122';
  v_gr_denied uuid := '00000000-0000-0000-0000-000000000123';
  v_gr_pay_before uuid := '00000000-0000-0000-0000-000000000124';
  v_pr_no_image uuid := '00000000-0000-0000-0000-000000000131';
  v_pr_skip uuid := '00000000-0000-0000-0000-000000000132';
  v_pr_denied uuid := '00000000-0000-0000-0000-000000000133';
  v_pr_pay_before uuid := '00000000-0000-0000-0000-000000000134';
  v_sha_no_image text := 'dryrun-skip-delivery-no-image';
  v_sha_skip text := 'dryrun-skip-delivery-skip';
  v_sha_pay_before text := 'dryrun-skip-delivery-pay-before';
begin
  select ur.user_id
    into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'CHECK FAIL: no owner user';
  end if;

  insert into public.suppliers (id, name, pay_before_delivery)
  values
    (v_supplier, 'NCC Dry Run Skip Delivery Image', false),
    (v_supplier_pay_before, 'NCC Dry Run Trả Trước', true);

  insert into public.purchase_orders (
    id, po_number, supplier_id, status, total_amount, order_date
  ) values
    (v_po_no_image, 'PO-SKIP-DRYRUN-NOIMAGE', v_supplier, 'sent', 1250000, current_date),
    (v_po_skip, 'PO-SKIP-DRYRUN-SKIP', v_supplier, 'sent', 1250000, current_date),
    (v_po_denied, 'PO-SKIP-DRYRUN-DENIED', v_supplier, 'sent', 1250000, current_date),
    (v_po_pay_before, 'PO-SKIP-DRYRUN-PAYBEFORE', v_supplier_pay_before, 'sent', 1250000, current_date);

  insert into public.goods_receipts (
    id, purchase_order_id, receipt_number, supplier_id, receipt_date, status
  ) values
    (v_gr_no_image, v_po_no_image, 'PN-SKIP-DRYRUN-NOIMAGE', v_supplier, current_date, 'received'),
    (v_gr_skip, v_po_skip, 'PN-SKIP-DRYRUN-SKIP', v_supplier, current_date, 'received'),
    (v_gr_denied, v_po_denied, 'PN-SKIP-DRYRUN-DENIED', v_supplier, current_date, 'received'),
    (v_gr_pay_before, v_po_pay_before, 'PN-SKIP-DRYRUN-PAYBEFORE', v_supplier_pay_before, current_date, 'received');

  insert into public.payment_requests (
    id, request_number, supplier_id, purchase_order_id, goods_receipt_id,
    title, total_amount, status, delivery_status, payment_status,
    payment_method, created_by
  ) values
    (
      v_pr_no_image, 'PR-SKIP-DRYRUN-NOIMAGE', v_supplier, v_po_no_image,
      v_gr_no_image, 'Dry run thiếu ảnh giao hàng', 1250000, 'pending',
      'pending', 'unpaid', 'bank_transfer', v_owner
    ),
    (
      v_pr_skip, 'PR-SKIP-DRYRUN-SKIP', v_supplier, v_po_skip,
      v_gr_skip, 'Dry run tick trả trước', 1250000, 'pending',
      'pending', 'unpaid', 'bank_transfer', v_owner
    ),
    (
      v_pr_denied, 'PR-SKIP-DRYRUN-DENIED', v_supplier, v_po_denied,
      v_gr_denied, 'Dry run không có quyền duyệt', 1250000, 'pending',
      'pending', 'unpaid', 'bank_transfer', v_owner
    ),
    (
      v_pr_pay_before, 'PR-SKIP-DRYRUN-PAYBEFORE', v_supplier_pay_before,
      v_po_pay_before, v_gr_pay_before, 'Dry run NCC trả trước', 1250000,
      'pending', 'pending', 'unpaid', 'bank_transfer', v_owner
    );

  -- The approval RPC reads the OCR amount from the server-side draft, never
  -- from the caller.
  insert into public.payment_unc_ocr_drafts (
    file_sha256, storage_path, ocr_amount, transfer_date, ocr_reference
  ) values
    (
      v_sha_no_image, 'payment-unc/dryrun/skip-delivery-no-image.jpg',
      1250000, current_date, 'DRYRUN-SKIP-DELIVERY-NOIMAGE'
    ),
    (
      v_sha_skip, 'payment-unc/dryrun/skip-delivery-skip.jpg',
      1250000, current_date, 'DRYRUN-SKIP-DELIVERY-SKIP'
    ),
    (
      v_sha_pay_before, 'payment-unc/dryrun/skip-delivery-pay-before.jpg',
      1250000, current_date, 'DRYRUN-SKIP-DELIVERY-PAYBEFORE'
    );

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  -- -------------------------------------------------------------------------
  -- (a) Without skip_delivery_image the missing delivery image still blocks.
  -- -------------------------------------------------------------------------
  declare
    v_error text;
    v_status text;
    v_by uuid;
    v_at timestamptz;
  begin
    begin
      perform public.approve_payment_requests_with_unc(
        array[v_pr_no_image],
        jsonb_build_object(
          'file_sha256', v_sha_no_image,
          'payment_method', 'bank_transfer',
          'category', 'khac'
        ),
        'dryrun-skip-delivery-no-key'
      );
    exception when others then
      v_error := sqlerrm;
    end;

    if v_error is distinct from
       'pr_requires_delivery_image: PN-SKIP-DRYRUN-NOIMAGE' then
      raise exception 'CHECK FAIL: expected pr_requires_delivery_image, got %', v_error;
    end if;

    select status::text, skip_delivery_image_by, skip_delivery_image_at
      into v_status, v_by, v_at
    from public.payment_requests
    where id = v_pr_no_image;
    if v_status is distinct from 'pending' then
      raise exception 'CHECK FAIL: refused request status is %', v_status;
    end if;
    if v_by is not null or v_at is not null then
      raise exception 'CHECK FAIL: refused request got skip audit columns';
    end if;
  end;

  insert into payment_unc_skip_delivery_image_checks (check_name, result)
  values ('a_without_key_refused', 'pr_requires_delivery_image');

  -- -------------------------------------------------------------------------
  -- (b) skip_delivery_image = true approves and stamps the actor/time.
  -- -------------------------------------------------------------------------
  declare
    v_result jsonb;
    v_status text;
    v_payment_status text;
    v_by uuid;
    v_at timestamptz;
  begin
    v_result := public.approve_payment_requests_with_unc(
      array[v_pr_skip],
      jsonb_build_object(
        'file_sha256', v_sha_skip,
        'payment_method', 'bank_transfer',
        'category', 'khac',
        'skip_delivery_image', true
      ),
      'dryrun-skip-delivery-key-true'
    );

    if v_result ->> 'status' is distinct from 'approved' then
      raise exception 'CHECK FAIL: approval result is %', v_result ->> 'status';
    end if;

    select status::text, payment_status::text, skip_delivery_image_by,
           skip_delivery_image_at
      into v_status, v_payment_status, v_by, v_at
    from public.payment_requests
    where id = v_pr_skip;

    if v_status is distinct from 'approved' then
      raise exception 'CHECK FAIL: skipped request status is %', v_status;
    end if;
    if v_payment_status is distinct from 'paid' then
      raise exception 'CHECK FAIL: skipped request payment_status is %', v_payment_status;
    end if;
    if v_by is distinct from v_owner then
      raise exception 'CHECK FAIL: skip_delivery_image_by is % (expected %)', v_by, v_owner;
    end if;
    if v_at is null then
      raise exception 'CHECK FAIL: skip_delivery_image_at was not set';
    end if;
  end;

  insert into payment_unc_skip_delivery_image_checks (check_name, result)
  values ('b_with_key_approved', 'approved+audit');

  -- -------------------------------------------------------------------------
  -- (c) A caller without approval permission is refused even with the key.
  -- -------------------------------------------------------------------------
  declare
    v_error text;
    v_status text;
    v_by uuid;
    v_at timestamptz;
  begin
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text,
      true
    );

    begin
      perform public.approve_payment_requests_with_unc(
        array[v_pr_denied],
        jsonb_build_object(
          'file_sha256', 'dryrun-skip-delivery-denied',
          'payment_method', 'bank_transfer',
          'category', 'khac',
          'skip_delivery_image', true
        ),
        'dryrun-skip-delivery-denied'
      );
    exception when others then
      v_error := sqlerrm;
    end;

    if position('not_owner' in coalesce(v_error, '')) = 0 then
      raise exception 'CHECK FAIL: expected not_owner, got %', v_error;
    end if;

    select status::text, skip_delivery_image_by, skip_delivery_image_at
      into v_status, v_by, v_at
    from public.payment_requests
    where id = v_pr_denied;
    if v_status is distinct from 'pending' then
      raise exception 'CHECK FAIL: denied request status is %', v_status;
    end if;
    if v_by is not null or v_at is not null then
      raise exception 'CHECK FAIL: denied request got skip audit columns';
    end if;

    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', v_owner, 'role', 'authenticated')::text,
      true
    );
  end;

  insert into payment_unc_skip_delivery_image_checks (check_name, result)
  values ('c_without_permission_refused', 'not_owner');

  -- -------------------------------------------------------------------------
  -- (d) pay_before_delivery = true still passes without the key, and does not
  --     write the skip audit columns.
  -- -------------------------------------------------------------------------
  declare
    v_result jsonb;
    v_status text;
    v_payment_status text;
    v_by uuid;
    v_at timestamptz;
  begin
    v_result := public.approve_payment_requests_with_unc(
      array[v_pr_pay_before],
      jsonb_build_object(
        'file_sha256', v_sha_pay_before,
        'payment_method', 'bank_transfer',
        'category', 'khac'
      ),
      'dryrun-skip-delivery-pay-before'
    );

    if v_result ->> 'status' is distinct from 'approved' then
      raise exception 'CHECK FAIL: pay-before approval result is %',
        v_result ->> 'status';
    end if;

    select status::text, payment_status::text, skip_delivery_image_by,
           skip_delivery_image_at
      into v_status, v_payment_status, v_by, v_at
    from public.payment_requests
    where id = v_pr_pay_before;

    if v_status is distinct from 'approved' then
      raise exception 'CHECK FAIL: pay-before request status is %', v_status;
    end if;
    if v_payment_status is distinct from 'paid' then
      raise exception 'CHECK FAIL: pay-before payment_status is %', v_payment_status;
    end if;
    if v_by is not null or v_at is not null then
      raise exception 'CHECK FAIL: pay-before request got skip audit columns';
    end if;
  end;

  insert into payment_unc_skip_delivery_image_checks (check_name, result)
  values ('d_pay_before_still_passes', 'approved');
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. One-row summary (the last statement of the file).
-- ---------------------------------------------------------------------------

select string_agg(
         check_name || '=' || result,
         ' | ' order by check_name
       ) as summary
from payment_unc_skip_delivery_image_checks;

rollback;
