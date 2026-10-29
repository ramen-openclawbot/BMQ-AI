-- Rollback-only dry run for 20261103370000_supplier_payment_notifications.sql.
--
-- Run as one file after the migration is present in the database. Every fixture
-- uses a fixed 00000000-… id and the final rollback discards everything. The
-- last statement prints one summary row so the expected values can be compared.
-- This never sends email or Zalo and never approves/pays a real request.

begin;

create temp table supplier_payment_dryrun_checks (
  check_name text primary key,
  result text not null
) on commit drop;

-- ---------------------------------------------------------------------------
-- 1. Test mode inside this rolled-back transaction.
-- ---------------------------------------------------------------------------

insert into public.app_settings (key, value)
values ('supplier_payment_notify_mode', 'test')
on conflict (key) do update set value = excluded.value;

insert into public.app_settings (key, value)
values ('supplier_payment_notify_test_email', 'order@bmq.vn')
on conflict (key) do update set value = excluded.value;

insert into public.app_settings (key, value)
values ('supplier_payment_notify_test_zalo_group', '2263202896844008192')
on conflict (key) do update set value = excluded.value;

-- ---------------------------------------------------------------------------
-- 2. Fixtures + trigger assertions.
-- ---------------------------------------------------------------------------

do $$
declare
  v_owner uuid;
  v_supplier uuid := '00000000-0000-0000-0000-000000000001';
  v_po uuid := '00000000-0000-0000-0000-000000000002';
  v_pr uuid := '00000000-0000-0000-0000-000000000003';
  v_payment uuid := '00000000-0000-0000-0000-000000000004';
  v_no_email_supplier uuid := '00000000-0000-0000-0000-000000000010';
  v_no_email_payment uuid := '00000000-0000-0000-0000-000000000011';
  v_count integer;
  v_not_before timestamptz;
begin
  select user_id
    into v_owner
  from public.user_roles
  order by user_id
  limit 1;

  insert into public.suppliers (id, name, email)
  values (v_supplier, 'NCC Smoke Payment Notify', 'ncc-smoke@example.test');

  insert into public.suppliers (id, name)
  values (v_no_email_supplier, 'NCC Smoke Không Email');

  insert into public.purchase_orders (
    id, po_number, supplier_id, status, total_amount
  ) values (
    v_po, 'PO-SMOKE-SPN-0001', v_supplier, 'draft', 1250000
  );

  insert into public.payment_requests (
    id, request_number, supplier_id, purchase_order_id, title, total_amount,
    status, delivery_status, payment_status, requires_receipt, created_by
  ) values (
    v_pr, 'PR-SMOKE-SPN-0001', v_supplier, v_po, 'Đề nghị chi dry run',
    1250000, 'approved', 'pending', 'unpaid', true, v_owner
  );

  insert into public.payments (
    id, payment_number, supplier_id, payment_date, amount, payment_method,
    reference_number
  ) values (
    v_payment, 'PAY-SMOKE-SPN-0001', v_supplier, '2026-10-28', 1250000,
    'bank_transfer', 'REF-SMOKE-SPN'
  );

  insert into public.payment_allocations (
    payment_id, payment_request_id, amount
  ) values (
    v_payment, v_pr, 1250000
  );

  -- First UNC image creates exactly one pending notification.
  insert into public.payment_unc_evidence (
    id, payment_id, storage_path, file_sha256, ocr_amount, ocr_reference,
    transfer_date, created_at
  ) values (
    '00000000-0000-0000-0000-000000000005',
    v_payment,
    'payment-unc/2026/10/smoke-spn-1.jpg',
    'spn-smoke-sha-1',
    1250000,
    'UNC-SMOKE-SPN-1',
    '2026-10-28',
    '2026-10-28 09:00:00+07'
  );

  select count(*), min(not_before)
    into v_count, v_not_before
  from public.supplier_payment_notifications
  where payment_id = v_payment;

  if v_count <> 1 then
    raise exception 'CHECK FAIL: expected 1 pending notification, got %', v_count;
  end if;
  if v_not_before <= now() then
    raise exception 'CHECK FAIL: not_before was not scheduled in the future';
  end if;

  insert into supplier_payment_dryrun_checks (check_name, result)
  values ('after_first_unc', v_count::text);

  -- Make the stored deadline stale so the second image must push it forward.
  update public.supplier_payment_notifications
     set not_before = now() - interval '1 hour'
   where payment_id = v_payment;

  insert into public.payment_unc_evidence (
    id, payment_id, storage_path, file_sha256, ocr_amount, ocr_reference,
    transfer_date, created_at
  ) values (
    '00000000-0000-0000-0000-000000000006',
    v_payment,
    'payment-unc/2026/10/smoke-spn-2.jpg',
    'spn-smoke-sha-2',
    1250000,
    'UNC-SMOKE-SPN-2',
    '2026-10-28',
    '2026-10-28 09:01:00+07'
  );

  select count(*), min(not_before)
    into v_count, v_not_before
  from public.supplier_payment_notifications
  where payment_id = v_payment;

  if v_count <> 1 then
    raise exception 'CHECK FAIL: second UNC created % notifications, expected 1',
      v_count;
  end if;
  if v_not_before < now() + interval '1 minute'
     or v_not_before > now() + interval '3 minutes' then
    raise exception 'CHECK FAIL: not_before was not pushed forward: %',
      v_not_before;
  end if;

  insert into supplier_payment_dryrun_checks (check_name, result)
  values
    ('after_second_unc', v_count::text),
    ('not_before_pushed', 'true');

  -- Supplier without an email: evidence must not create a notification.
  insert into public.payments (
    id, payment_number, supplier_id, payment_date, amount, payment_method
  ) values (
    v_no_email_payment, 'PAY-SMOKE-SPN-0002', v_no_email_supplier,
    '2026-10-28', 500000, 'bank_transfer'
  );

  insert into public.payment_unc_evidence (
    id, payment_id, storage_path, file_sha256, ocr_amount, ocr_reference,
    transfer_date
  ) values (
    '00000000-0000-0000-0000-000000000012',
    v_no_email_payment,
    'payment-unc/2026/10/smoke-spn-no-email.jpg',
    'spn-smoke-sha-3',
    500000,
    'UNC-SMOKE-SPN-3',
    '2026-10-28'
  );

  select count(*)
    into v_count
  from public.supplier_payment_notifications
  where payment_id = v_no_email_payment;

  if v_count <> 0 then
    raise exception 'CHECK FAIL: no-email supplier produced % notification(s)',
      v_count;
  end if;

  insert into supplier_payment_dryrun_checks (check_name, result)
  values ('no_email_notifications', v_count::text);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Claim as service_role, mark sent, and verify the Zalo outbox row.
-- ---------------------------------------------------------------------------

set local role service_role;

do $$
declare
  v_payment uuid := '00000000-0000-0000-0000-000000000004';
  v_claimed jsonb;
  v_first jsonb;
  v_id uuid;
  v_status text;
  v_to_email text;
  v_message_id text;
  v_mode text;
  v_group text;
  v_message text;
  v_count integer;
begin
  update public.supplier_payment_notifications
     set not_before = now() - interval '1 minute'
   where payment_id = v_payment;

  v_claimed := public.claim_supplier_payment_notifications(3);

  if jsonb_typeof(v_claimed) <> 'array' then
    raise exception 'CHECK FAIL: claim did not return a JSON array';
  end if;
  if jsonb_array_length(v_claimed) <> 1 then
    raise exception 'CHECK FAIL: claim returned %, expected 1',
      jsonb_array_length(v_claimed);
  end if;

  v_first := v_claimed->0;

  if (v_first->>'payment_number') <> 'PAY-SMOKE-SPN-0001' then
    raise exception 'CHECK FAIL: payment_number is %', v_first->>'payment_number';
  end if;
  if (v_first->>'amount')::numeric <> 1250000 then
    raise exception 'CHECK FAIL: amount is %', v_first->>'amount';
  end if;
  if v_first->'po_numbers' <> '["PO-SMOKE-SPN-0001"]'::jsonb then
    raise exception 'CHECK FAIL: po_numbers is %', v_first->'po_numbers';
  end if;
  if v_first->'request_numbers' <> '["PR-SMOKE-SPN-0001"]'::jsonb then
    raise exception 'CHECK FAIL: request_numbers is %', v_first->'request_numbers';
  end if;
  if jsonb_array_length(v_first->'unc_paths') <> 2 then
    raise exception 'CHECK FAIL: unc_paths has % item(s), expected 2',
      jsonb_array_length(v_first->'unc_paths');
  end if;
  if (v_first->'unc_paths'->>0) <> 'payment-unc/2026/10/smoke-spn-1.jpg'
     or (v_first->'unc_paths'->>1) <> 'payment-unc/2026/10/smoke-spn-2.jpg' then
    raise exception 'CHECK FAIL: unc_paths order/values are %',
      v_first->'unc_paths';
  end if;
  if (v_first->>'ocr_reference') <> 'UNC-SMOKE-SPN-2' then
    raise exception 'CHECK FAIL: ocr_reference is %', v_first->>'ocr_reference';
  end if;
  if (v_first->>'mode') <> 'test' then
    raise exception 'CHECK FAIL: mode is %', v_first->>'mode';
  end if;
  if (v_first->>'test_email') <> 'order@bmq.vn' then
    raise exception 'CHECK FAIL: test_email is %', v_first->>'test_email';
  end if;

  v_id := (v_first->>'id')::uuid;

  perform public.mark_supplier_payment_notification(
    v_id, true, 'order@bmq.vn', 'gmail-smoke-spn-1', null
  );

  select status, to_email, gmail_message_id, mode
    into v_status, v_to_email, v_message_id, v_mode
  from public.supplier_payment_notifications
  where id = v_id;

  if v_status <> 'sent' then
    raise exception 'CHECK FAIL: notification status is %, expected sent', v_status;
  end if;
  if v_to_email <> 'order@bmq.vn' then
    raise exception 'CHECK FAIL: to_email is %', v_to_email;
  end if;
  if v_message_id <> 'gmail-smoke-spn-1' then
    raise exception 'CHECK FAIL: gmail_message_id is %', v_message_id;
  end if;
  if v_mode <> 'test' then
    raise exception 'CHECK FAIL: stored mode is %, expected test', v_mode;
  end if;

  select count(*), min(zalo_group_id), min(message)
    into v_count, v_group, v_message
  from public.supplier_zalo_notifications
  where payment_id = v_payment;

  if v_count <> 1 then
    raise exception 'CHECK FAIL: expected 1 Zalo row, got %', v_count;
  end if;
  if v_group <> '2263202896844008192' then
    raise exception 'CHECK FAIL: Zalo group is %, expected test group', v_group;
  end if;
  if v_message is distinct from
    '[THỬ] BMQ đã thanh toán PO-SMOKE-SPN-0001, số tiền 1.250.000 đ. Anh/Chị vui lòng kiểm tra email để xem ảnh UNC. Trân trọng.'
  then
    raise exception 'CHECK FAIL: Zalo message mismatch: %', v_message;
  end if;

  perform set_config('bmq.spn_claimed_count', '1', true);
  perform set_config('bmq.spn_zalo_count', v_count::text, true);
end;
$$;

reset role;

insert into supplier_payment_dryrun_checks (check_name, result)
select 'claimed_count', current_setting('bmq.spn_claimed_count', true)
union all
select 'final_status', status
from public.supplier_payment_notifications
where payment_id = '00000000-0000-0000-0000-000000000004'
union all
select 'zalo_count', current_setting('bmq.spn_zalo_count', true);

-- ---------------------------------------------------------------------------
-- 4. One-row summary (the last statement of the file).
-- ---------------------------------------------------------------------------

select string_agg(
         check_name || '=' || result,
         ' | ' order by check_name
       ) as summary
from supplier_payment_dryrun_checks;

rollback;
