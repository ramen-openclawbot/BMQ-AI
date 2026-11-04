begin;

-- Rollback-only dry run cho 20261104110000_supplier_payment_upload_link.sql.
--
-- CHẠY SAU khi migration 20261104110000_supplier_payment_upload_link.sql đã được
-- áp lên database (Maestro áp migration rồi chạy file này; \i không dùng được).
-- Mọi fixture dùng id cố định 00000000-… và rollback ở cuối, không gửi Zalo/email
-- thật và không đụng dữ liệu thật.

create temp table supplier_payment_upload_link_checks (
  check_name text primary key,
  result text not null
) on commit drop;

-- ---------------------------------------------------------------------------
-- 1. Chế độ live trong giao dịch + fixtures.
-- ---------------------------------------------------------------------------

insert into public.app_settings (key, value)
values ('supplier_payment_notify_mode', 'live')
on conflict (key) do update set value = excluded.value;

do $$
declare
  v_owner uuid;
  v_supplier uuid := '00000000-0000-0000-0000-000000000101';
  v_item uuid := '00000000-0000-0000-0000-000000000102';
  v_po_a uuid := '00000000-0000-0000-0000-000000000110';
  v_po_b uuid := '00000000-0000-0000-0000-000000000111';
  v_po_c uuid := '00000000-0000-0000-0000-000000000112';
  v_po_d uuid := '00000000-0000-0000-0000-000000000113';
  v_po_e uuid := '00000000-0000-0000-0000-000000000114';
  v_order_a_old uuid := '00000000-0000-0000-0000-000000000120';
  v_order_a_latest uuid := '00000000-0000-0000-0000-000000000121';
  v_order_b uuid := '00000000-0000-0000-0000-000000000122';
  v_order_d uuid := '00000000-0000-0000-0000-000000000123';
  v_payment_1 uuid := '00000000-0000-0000-0000-000000000130';
  v_payment_2 uuid := '00000000-0000-0000-0000-000000000131';
  v_payment_3 uuid := '00000000-0000-0000-0000-000000000132';
  v_pr_a uuid := '00000000-0000-0000-0000-000000000140';
  v_pr_b uuid := '00000000-0000-0000-0000-000000000141';
  v_pr_c uuid := '00000000-0000-0000-0000-000000000142';
  v_pr_d uuid := '00000000-0000-0000-0000-000000000143';
  v_pr_e uuid := '00000000-0000-0000-0000-000000000144';
  v_notification_1 uuid := '00000000-0000-0000-0000-000000000150';
  v_notification_2 uuid := '00000000-0000-0000-0000-000000000151';
  v_notification_3 uuid := '00000000-0000-0000-0000-000000000152';
  v_allocation_a uuid := '00000000-0000-0000-0000-000000000160';
  v_allocation_b uuid := '00000000-0000-0000-0000-000000000161';
  v_allocation_c uuid := '00000000-0000-0000-0000-000000000162';
  v_allocation_d uuid := '00000000-0000-0000-0000-000000000163';
  v_allocation_e uuid := '00000000-0000-0000-0000-000000000164';
  v_old_hash_a text;
  v_old_hash_b text;
  v_old_hash_d text;
begin
  select user_id
    into v_owner
  from public.user_roles
  order by user_id
  limit 1;

  v_old_hash_a := encode(
    extensions.digest(convert_to('dryrun-old-token-a', 'UTF8'), 'sha256'), 'hex'
  );
  v_old_hash_b := encode(
    extensions.digest(convert_to('dryrun-old-token-b', 'UTF8'), 'sha256'), 'hex'
  );
  v_old_hash_d := encode(
    extensions.digest(convert_to('dryrun-old-token-d', 'UTF8'), 'sha256'), 'hex'
  );

  insert into public.suppliers (id, name, email)
  values (
    v_supplier, 'NCC Dry Run Upload Link', 'ncc-upload-link@example.test'
  );

  insert into public.kitchen_inventory_items (
    id, item_code, normalized_key, item_type, name, unit, active
  ) values (
    v_item, 'DRYRUN-UPLOAD-LINK-ITEM', 'dryrun:upload-link-item',
    'ingredient', 'Dry run upload link item', 'kg', true
  );

  insert into public.supplier_zalo_groups (
    supplier_id, zalo_group_id, zalo_group_name, enabled
  ) values (
    v_supplier, 'dryrun-upload-link-group', 'Dry run upload link group', true
  );

  insert into public.purchase_orders (
    id, po_number, supplier_id, status, total_amount
  ) values
    (v_po_a, 'PO-DRYRUN-UPLOAD-0001', v_supplier, 'draft', 1000000),
    (v_po_b, 'PO-DRYRUN-UPLOAD-0002', v_supplier, 'draft', 1200000),
    (v_po_c, 'PO-DRYRUN-UPLOAD-0003', v_supplier, 'draft', 800000),
    (v_po_d, 'PO-DRYRUN-UPLOAD-0004', v_supplier, 'draft', 500000),
    (v_po_e, 'PO-DRYRUN-UPLOAD-0005', v_supplier, 'draft', 700000);

  insert into public.payment_requests (
    id, request_number, supplier_id, purchase_order_id, title, total_amount,
    status, delivery_status, payment_status, requires_receipt, created_by
  ) values
    (v_pr_a, 'PR-DRYRUN-UPLOAD-0001', v_supplier, v_po_a,
     'Dry run upload link A', 1000000, 'approved', 'pending', 'unpaid', true,
     v_owner),
    (v_pr_b, 'PR-DRYRUN-UPLOAD-0002', v_supplier, v_po_b,
     'Dry run upload link B', 1200000, 'approved', 'pending', 'unpaid', true,
     v_owner),
    (v_pr_c, 'PR-DRYRUN-UPLOAD-0003', v_supplier, v_po_c,
     'Dry run upload link C', 800000, 'approved', 'pending', 'unpaid', true,
     v_owner),
    (v_pr_d, 'PR-DRYRUN-UPLOAD-0004', v_supplier, v_po_d,
     'Dry run upload link D', 500000, 'approved', 'pending', 'unpaid', true,
     v_owner),
    (v_pr_e, 'PR-DRYRUN-UPLOAD-0005', v_supplier, v_po_e,
     'Dry run upload link E', 700000, 'approved', 'pending', 'unpaid', true,
     v_owner);

  insert into public.payments (
    id, payment_number, supplier_id, payment_date, amount, payment_method,
    reference_number
  ) values
    (v_payment_1, 'PAY-DRYRUN-UPLOAD-0001', v_supplier, '2026-11-04',
     3000000, 'bank_transfer', 'REF-DRYRUN-UPLOAD-1'),
    (v_payment_2, 'PAY-DRYRUN-UPLOAD-0002', v_supplier, '2026-11-04',
     500000, 'bank_transfer', 'REF-DRYRUN-UPLOAD-2'),
    (v_payment_3, 'PAY-DRYRUN-UPLOAD-0003', v_supplier, '2026-11-04',
     700000, 'bank_transfer', 'REF-DRYRUN-UPLOAD-3');

  -- Explicit created_at/id keeps supplier_payment_allocation_labels() order
  -- deterministic: PO-A, PO-B, PO-C.
  insert into public.payment_allocations (
    id, payment_id, payment_request_id, amount, created_at, updated_at
  ) values
    (v_allocation_a, v_payment_1, v_pr_a, 1000000,
     '2026-11-04 09:00:00+07', '2026-11-04 09:00:00+07'),
    (v_allocation_b, v_payment_1, v_pr_b, 1200000,
     '2026-11-04 09:01:00+07', '2026-11-04 09:01:00+07'),
    (v_allocation_c, v_payment_1, v_pr_c, 800000,
     '2026-11-04 09:02:00+07', '2026-11-04 09:02:00+07'),
    (v_allocation_d, v_payment_2, v_pr_d, 500000,
     '2026-11-04 09:03:00+07', '2026-11-04 09:03:00+07'),
    (v_allocation_e, v_payment_3, v_pr_e, 700000,
     '2026-11-04 09:04:00+07', '2026-11-04 09:04:00+07');

  insert into public.supplier_order_requests (
    id, request_id, kitchen_inventory_item_id, supplier_id, purchase_order_id,
    to_email, subject, quantity, unit, status, upload_token_hash,
    upload_expires_at, created_by, created_at, sent_at
  ) values
    (v_order_a_old, '00000000-0000-0000-0000-000000000220', v_item,
     v_supplier, v_po_a, 'ncc-upload-link@example.test',
     'Dry run order A old', 1, 'kg', 'sent', v_old_hash_a,
     now() + interval '30 days', v_owner,
     '2026-11-01 08:00:00+07', '2026-11-01 08:00:00+07'),
    (v_order_a_latest, '00000000-0000-0000-0000-000000000221', v_item,
     v_supplier, v_po_a, 'ncc-upload-link@example.test',
     'Dry run order A latest', 1, 'kg', 'sent', null,
     null, v_owner,
     '2026-11-02 08:00:00+07', '2026-11-02 08:00:00+07'),
    (v_order_b, '00000000-0000-0000-0000-000000000222', v_item,
     v_supplier, v_po_b, 'ncc-upload-link@example.test',
     'Dry run order B', 1, 'kg', 'sent', v_old_hash_b,
     now() + interval '30 days', v_owner,
     '2026-11-01 09:00:00+07', '2026-11-01 09:00:00+07'),
    (v_order_d, '00000000-0000-0000-0000-000000000223', v_item,
     v_supplier, v_po_d, 'ncc-upload-link@example.test',
     'Dry run order D', 1, 'kg', 'sent', v_old_hash_d,
     now() + interval '30 days', v_owner,
     '2026-11-01 10:00:00+07', '2026-11-01 10:00:00+07');

  insert into public.supplier_payment_notifications (
    id, payment_id, supplier_id
  ) values
    (v_notification_1, v_payment_1, v_supplier),
    (v_notification_2, v_payment_2, v_supplier),
    (v_notification_3, v_payment_3, v_supplier);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Gọi mark như service_role và kiểm tra từng ca.
-- ---------------------------------------------------------------------------

-- Chạy với quyền postgres: mark_supplier_payment_notification nhận
-- current_user postgres; set role service_role không có JWT nên auth.role() rỗng.

do $$
declare
  v_po_a uuid := '00000000-0000-0000-0000-000000000110';
  v_order_a_old uuid := '00000000-0000-0000-0000-000000000120';
  v_order_a_latest uuid := '00000000-0000-0000-0000-000000000121';
  v_order_b uuid := '00000000-0000-0000-0000-000000000122';
  v_order_d uuid := '00000000-0000-0000-0000-000000000123';
  v_payment_1 uuid := '00000000-0000-0000-0000-000000000130';
  v_payment_2 uuid := '00000000-0000-0000-0000-000000000131';
  v_payment_3 uuid := '00000000-0000-0000-0000-000000000132';
  v_notification_1 uuid := '00000000-0000-0000-0000-000000000150';
  v_notification_2 uuid := '00000000-0000-0000-0000-000000000151';
  v_notification_3 uuid := '00000000-0000-0000-0000-000000000152';
  v_old_hash_a text;
  v_old_hash_d text;
  v_message text;
  v_expected text;
  v_tokens text[];
  v_token text;
  v_hash_a text;
  v_hash_b text;
  v_hash_d text;
  v_resolved jsonb;
  v_count integer;
  v_token_count integer;
begin
  -- ----- Ca nhiều PO: payment 1 trả cho PO-A, PO-B, PO-C; chỉ A/B có đơn. -----
  perform public.mark_supplier_payment_notification(
    v_notification_1, true, 'dryrun@example.test', 'gmail-dryrun-1', null
  );

  select count(*)
    into v_count
  from public.supplier_zalo_notifications
  where payment_id = v_payment_1
    and kind = 'payment';
  if v_count <> 1 then
    raise exception 'CHECK FAIL: multi case queued % Zalo row(s), expected 1',
      v_count;
  end if;

  select message
    into v_message
  from public.supplier_zalo_notifications
  where payment_id = v_payment_1
    and kind = 'payment';

  select count(*)
    into v_token_count
  from public.supplier_order_upload_tokens
  where payment_id = v_payment_1
    and purpose = 'payment';
  if v_token_count <> 2 then
    raise exception 'CHECK FAIL: multi case created % token(s), expected 2',
      v_token_count;
  end if;

  select token_hash
    into v_hash_a
  from public.supplier_order_upload_tokens
  where payment_id = v_payment_1
    and order_request_id = v_order_a_latest;
  if v_hash_a is null then
    raise exception 'CHECK FAIL: no token for the latest PO-A order';
  end if;

  select token_hash
    into v_hash_b
  from public.supplier_order_upload_tokens
  where payment_id = v_payment_1
    and order_request_id = v_order_b;
  if v_hash_b is null then
    raise exception 'CHECK FAIL: no token for PO-B order';
  end if;

  v_resolved := public.resolve_supplier_order_upload_token(v_hash_a);
  if (v_resolved->>'order_request_id')::uuid is distinct from v_order_a_latest then
    raise exception 'CHECK FAIL: new PO-A token resolved to %, expected %',
      v_resolved->>'order_request_id', v_order_a_latest;
  end if;

  v_resolved := public.resolve_supplier_order_upload_token(v_hash_b);
  if (v_resolved->>'order_request_id')::uuid is distinct from v_order_b then
    raise exception 'CHECK FAIL: new PO-B token resolved to %, expected %',
      v_resolved->>'order_request_id', v_order_b;
  end if;

  -- Token cũ trong email đặt hàng vẫn resolve.
  v_old_hash_a := encode(
    extensions.digest(convert_to('dryrun-old-token-a', 'UTF8'), 'sha256'), 'hex'
  );
  v_resolved := public.resolve_supplier_order_upload_token(v_old_hash_a);
  if (v_resolved->>'order_request_id')::uuid is distinct from v_order_a_old then
    raise exception 'CHECK FAIL: old PO-A email token resolved to %, expected %',
      v_resolved->>'order_request_id', v_order_a_old;
  end if;

  select coalesce(array_agg(token_match[1]), '{}'::text[])
    into v_tokens
  from regexp_matches(
    v_message,
    'https://ai\.banhmique\.vn/ncc/hoa-don/([A-Za-z0-9_-]+)',
    'g'
  ) as rm(token_match);

  if coalesce(array_length(v_tokens, 1), 0) <> 2 then
    raise exception 'CHECK FAIL: multi message has % link(s), expected 2',
      coalesce(array_length(v_tokens, 1), 0);
  end if;

  if encode(
       extensions.digest(convert_to(v_tokens[1], 'UTF8'), 'sha256'), 'hex'
     ) <> v_hash_a then
    raise exception 'CHECK FAIL: first message link does not hash to PO-A token';
  end if;
  if encode(
       extensions.digest(convert_to(v_tokens[2], 'UTF8'), 'sha256'), 'hex'
     ) <> v_hash_b then
    raise exception 'CHECK FAIL: second message link does not hash to PO-B token';
  end if;

  v_expected :=
    'BMQ đã thanh toán PO-DRYRUN-UPLOAD-0001, PO-DRYRUN-UPLOAD-0002, PO-DRYRUN-UPLOAD-0003, số tiền 3.000.000 đ. Anh/Chị vui lòng kiểm tra email để xem ảnh UNC.'
    || E'\n' || 'Quý nhà cung cấp vui lòng upload phiếu giao hàng/hoá đơn tại các link sau:'
    || E'\n' || '• PO-DRYRUN-UPLOAD-0001: https://ai.banhmique.vn/ncc/hoa-don/' || v_tokens[1]
    || E'\n' || '• PO-DRYRUN-UPLOAD-0002: https://ai.banhmique.vn/ncc/hoa-don/' || v_tokens[2]
    || E'\n' || 'Trân trọng.';

  if v_message is distinct from v_expected then
    raise exception 'CHECK FAIL: multi message mismatch: %', v_message;
  end if;

  if position('• PO-DRYRUN-UPLOAD-0003:' in v_message) > 0 then
    raise exception 'CHECK FAIL: PO-C has no order but got a link line';
  end if;

  -- Token mới hết hạn phải bị chặn.
  update public.supplier_order_upload_tokens
     set expires_at = now() - interval '1 hour'
   where token_hash = v_hash_b;

  v_resolved := public.resolve_supplier_order_upload_token(v_hash_b);
  if v_resolved is not null then
    raise exception 'CHECK FAIL: expired token still resolved to %',
      v_resolved->>'order_request_id';
  end if;

  -- Gọi lại: không thêm tin, không thêm token.
  perform public.mark_supplier_payment_notification(
    v_notification_1, true, 'dryrun@example.test', 'gmail-dryrun-1-retry', null
  );

  select count(*)
    into v_count
  from public.supplier_zalo_notifications
  where payment_id = v_payment_1;
  if v_count <> 1 then
    raise exception 'CHECK FAIL: retry queued % Zalo row(s), expected 1', v_count;
  end if;

  select count(*)
    into v_token_count
  from public.supplier_order_upload_tokens
  where payment_id = v_payment_1;
  if v_token_count <> 2 then
    raise exception 'CHECK FAIL: retry created extra tokens: % (expected 2)',
      v_token_count;
  end if;

  perform set_config('bmq.uplink_multi', 'ok', true);
  perform set_config('bmq.uplink_old', 'ok', true);
  perform set_config('bmq.uplink_new', 'ok', true);
  perform set_config('bmq.uplink_expired', 'ok', true);
  perform set_config('bmq.uplink_retry', 'ok', true);

  -- ----- Ca đúng 1 PO có đơn: định dạng một link. -----
  perform public.mark_supplier_payment_notification(
    v_notification_2, true, 'dryrun@example.test', 'gmail-dryrun-2', null
  );

  select message
    into v_message
  from public.supplier_zalo_notifications
  where payment_id = v_payment_2
    and kind = 'payment';

  select count(*)
    into v_token_count
  from public.supplier_order_upload_tokens
  where payment_id = v_payment_2;
  if v_token_count <> 1 then
    raise exception 'CHECK FAIL: single case created % token(s), expected 1',
      v_token_count;
  end if;

  select token_hash
    into v_hash_d
  from public.supplier_order_upload_tokens
  where payment_id = v_payment_2
    and order_request_id = v_order_d;
  if v_hash_d is null then
    raise exception 'CHECK FAIL: no token for PO-D order';
  end if;

  v_resolved := public.resolve_supplier_order_upload_token(v_hash_d);
  if (v_resolved->>'order_request_id')::uuid is distinct from v_order_d then
    raise exception 'CHECK FAIL: new PO-D token resolved to %, expected %',
      v_resolved->>'order_request_id', v_order_d;
  end if;

  v_token := substring(v_message from 'hoa-don/([A-Za-z0-9_-]+)');
  v_expected :=
    'BMQ đã thanh toán PO-DRYRUN-UPLOAD-0004, số tiền 500.000 đ. Anh/Chị vui lòng kiểm tra email để xem ảnh UNC.'
    || E'\n' || 'Quý nhà cung cấp vui lòng upload phiếu giao hàng/hoá đơn tại link sau:'
    || E'\n' || 'https://ai.banhmique.vn/ncc/hoa-don/' || v_token
    || E'\n' || 'Trân trọng.';

  if v_message is distinct from v_expected then
    raise exception 'CHECK FAIL: single message mismatch: %', v_message;
  end if;

  perform set_config('bmq.uplink_single', 'ok', true);

  -- ----- Ca không PO nào có đơn: giữ nguyên chuỗi cũ. -----
  perform public.mark_supplier_payment_notification(
    v_notification_3, true, 'dryrun@example.test', 'gmail-dryrun-3', null
  );

  select message
    into v_message
  from public.supplier_zalo_notifications
  where payment_id = v_payment_3
    and kind = 'payment';

  if v_message is distinct from
    'BMQ đã thanh toán PO-DRYRUN-UPLOAD-0005, số tiền 700.000 đ. Anh/Chị vui lòng kiểm tra email để xem ảnh UNC. Trân trọng.'
  then
    raise exception 'CHECK FAIL: no-order message mismatch: %', v_message;
  end if;

  select count(*)
    into v_token_count
  from public.supplier_order_upload_tokens
  where payment_id = v_payment_3;
  if v_token_count <> 0 then
    raise exception 'CHECK FAIL: no-order case created % token(s)', v_token_count;
  end if;

  perform set_config('bmq.uplink_no_order', 'ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Tổng hợp kết quả (statement cuối trước rollback).
-- ---------------------------------------------------------------------------

insert into supplier_payment_upload_link_checks (check_name, result)
values
  ('multi_links', current_setting('bmq.uplink_multi', true)),
  ('old_email_token', current_setting('bmq.uplink_old', true)),
  ('new_payment_tokens', current_setting('bmq.uplink_new', true)),
  ('expired_token_blocked', current_setting('bmq.uplink_expired', true)),
  ('retry_no_duplicate', current_setting('bmq.uplink_retry', true)),
  ('single_link', current_setting('bmq.uplink_single', true)),
  ('no_order_message', current_setting('bmq.uplink_no_order', true)),
  ('multi_zalo_count', (
    select count(*)::text
    from public.supplier_zalo_notifications
    where payment_id = '00000000-0000-0000-0000-000000000130'
  )),
  ('multi_token_count', (
    select count(*)::text
    from public.supplier_order_upload_tokens
    where payment_id = '00000000-0000-0000-0000-000000000130'
  )),
  ('retry_zalo_count', (
    select count(*)::text
    from public.supplier_zalo_notifications
    where payment_id = '00000000-0000-0000-0000-000000000130'
  )),
  ('retry_token_count', (
    select count(*)::text
    from public.supplier_order_upload_tokens
    where payment_id = '00000000-0000-0000-0000-000000000130'
  )),
  ('single_token_count', (
    select count(*)::text
    from public.supplier_order_upload_tokens
    where payment_id = '00000000-0000-0000-0000-000000000131'
  )),
  ('no_order_token_count', (
    select count(*)::text
    from public.supplier_order_upload_tokens
    where payment_id = '00000000-0000-0000-0000-000000000132'
  ));

select string_agg(
         check_name || '=' || result,
         ' | ' order by check_name
       ) as summary
from supplier_payment_upload_link_checks;

rollback;
