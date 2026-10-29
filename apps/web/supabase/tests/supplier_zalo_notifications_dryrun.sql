-- Rollback-only dry run for 20261103350000_supplier_zalo_notifications.sql.
--
-- Run as one file after the migration is present in the database. Every fixture
-- uses a fixed 00000000-… id and the final rollback discards everything. The
-- last statement prints one summary row so the expected values can be compared.

begin;

create temp table supplier_zalo_dryrun_checks (
  check_name text primary key,
  result text not null
) on commit drop;

-- ---------------------------------------------------------------------------
-- 1. Fixtures: one request for Cholimex (enabled group) and one request for a
--    supplier without a Zalo group.
-- ---------------------------------------------------------------------------

do $$
declare
  v_created_by uuid;
  v_supplier_name text;
  v_sent_at timestamptz;
  v_expected text;
  v_message text;
  v_count integer;
begin
  select created_by
    into v_created_by
  from public.supplier_order_requests
  where created_by is not null
  order by created_at
  limit 1;

  select btrim(name)
    into v_supplier_name
  from public.suppliers
  where id = 'ecd49e72-96fe-465d-b8a5-2c474aa7d6ae';

  if v_supplier_name is null then
    raise exception 'CHECK FAIL: seeded Cholimex supplier is missing';
  end if;

  insert into public.purchase_orders (
    id, po_number, supplier_id, status, total_amount, notes
  ) values (
    '00000000-0000-0000-0000-000000000001',
    'PO-SMOKE-ZALO-0001',
    'ecd49e72-96fe-465d-b8a5-2c474aa7d6ae',
    'draft',
    1250000,
    'Dry run Zalo notification'
  );

  insert into public.supplier_order_requests (
    id, request_id, supplier_id, purchase_order_id, to_email, subject,
    quantity, unit, status, note, total_amount, subtotal_amount, vat_amount,
    created_by
  ) values (
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000012',
    'ecd49e72-96fe-465d-b8a5-2c474aa7d6ae',
    '00000000-0000-0000-0000-000000000001',
    'order-test@bmq.vn',
    'BMQ đặt hàng PO-SMOKE-ZALO-0001',
    1,
    'đơn',
    'preparing',
    'Giao trước 10h tại kho Bình Thạnh',
    1250000,
    1136363,
    113637,
    v_created_by
  );

  insert into public.supplier_order_request_lines (
    id, request_id, position, kitchen_inventory_item_id, product_name,
    quantity, unit, unit_price, line_total
  ) values
    (
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000002',
      1,
      '00000000-0000-0000-0000-000000000201',
      'Bột ngọt AJI-NO-MOTO',
      2,
      'kg',
      100000,
      200000
    ),
    (
      '00000000-0000-0000-0000-000000000102',
      '00000000-0000-0000-0000-000000000002',
      2,
      '00000000-0000-0000-0000-000000000202',
      'Tương ớt Cholimex',
      1.5,
      'chai',
      700000,
      1050000
    );

  -- Supplier without a supplier_zalo_groups row: inserting the request already
  -- as 'sent' proves the trigger produces no message for it.
  insert into public.suppliers (id, name)
  values (
    '00000000-0000-0000-0000-000000000004',
    'NCC Không Có Nhóm Zalo'
  );

  insert into public.purchase_orders (
    id, po_number, supplier_id, status, total_amount
  ) values (
    '00000000-0000-0000-0000-000000000005',
    'PO-SMOKE-ZALO-0002',
    '00000000-0000-0000-0000-000000000004',
    'draft',
    100000
  );

  insert into public.supplier_order_requests (
    id, request_id, supplier_id, purchase_order_id, to_email, subject,
    quantity, unit, status, total_amount, created_by
  ) values (
    '00000000-0000-0000-0000-000000000006',
    '00000000-0000-0000-0000-000000000016',
    '00000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000005',
    'no-group@bmq.vn',
    'BMQ đặt hàng PO-SMOKE-ZALO-0002',
    1,
    'kg',
    'sent',
    100000,
    v_created_by
  );

  -- -------------------------------------------------------------------------
  -- 2. First 'sent' transition must enqueue exactly one correct message.
  -- -------------------------------------------------------------------------

  update public.supplier_order_requests
     set status = 'sent',
         sent_at = now()
   where id = '00000000-0000-0000-0000-000000000002';

  select sent_at
    into v_sent_at
  from public.supplier_order_requests
  where id = '00000000-0000-0000-0000-000000000002';

  v_expected := '🧾 BMQ đặt hàng — ' || v_supplier_name
    || E'\nPO: PO-SMOKE-ZALO-0001 · Ngày: '
    || to_char(v_sent_at at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY')
    || E'\n\n• Bột ngọt AJI-NO-MOTO: 2 kg'
    || E'\n• Tương ớt Cholimex: 1,5 chai'
    || E'\n\nTổng: 1.250.000 đ (đã gồm VAT)'
    || E'\nGhi chú: Giao trước 10h tại kho Bình Thạnh'
    || E'\nEmail đơn đã gửi tới: order-test@bmq.vn'
    || E'\nBánh Mì Que xin cảm ơn!';

  select count(*), max(message)
    into v_count, v_message
  from public.supplier_zalo_notifications
  where order_request_id = '00000000-0000-0000-0000-000000000002'
    and status = 'pending';

  if v_count <> 1 then
    raise exception 'CHECK FAIL: expected 1 pending message, got %', v_count;
  end if;
  if v_message is distinct from v_expected then
    raise exception 'CHECK FAIL: message mismatch. got=%, expected=%',
      v_message, v_expected;
  end if;

  insert into supplier_zalo_dryrun_checks (check_name, result)
  values
    ('after_first_sent', v_count::text),
    ('message_matches', 'true');

  -- -------------------------------------------------------------------------
  -- 3. Updating status to 'sent' again must not enqueue a duplicate.
  -- -------------------------------------------------------------------------

  update public.supplier_order_requests
     set status = 'sent'
   where id = '00000000-0000-0000-0000-000000000002';

  select count(*)
    into v_count
  from public.supplier_zalo_notifications
  where order_request_id = '00000000-0000-0000-0000-000000000002';

  if v_count <> 1 then
    raise exception 'CHECK FAIL: duplicate message after second sent update: %',
      v_count;
  end if;

  insert into supplier_zalo_dryrun_checks (check_name, result)
  values ('after_second_sent', v_count::text);

  -- -------------------------------------------------------------------------
  -- 4. Supplier without an enabled group must not create a message.
  -- -------------------------------------------------------------------------

  select count(*)
    into v_count
  from public.supplier_zalo_notifications
  where order_request_id = '00000000-0000-0000-0000-000000000006';

  if v_count <> 0 then
    raise exception 'CHECK FAIL: no-group supplier produced % message(s)', v_count;
  end if;

  insert into supplier_zalo_dryrun_checks (check_name, result)
  values
    ('no_group_notifications', v_count::text),
    ('before_claim_status', (
      select status
      from public.supplier_zalo_notifications
      where order_request_id = '00000000-0000-0000-0000-000000000002'
    ));
end;
$$;

-- Show the single queued row and its full Vietnamese message.
select count(*) as pending_count, min(message) as pending_message
from public.supplier_zalo_notifications
where order_request_id = '00000000-0000-0000-0000-000000000002';

-- ---------------------------------------------------------------------------
-- 5. Claim as service_role, then mark the claimed message as sent.
-- ---------------------------------------------------------------------------

set local role service_role;

do $$
declare
  v_claimed_count integer;
  v_claimed_id uuid;
  v_status text;
  v_attempts integer;
  v_sent_at_set boolean;
begin
  select count(*)
    into v_claimed_count
  from public.claim_supplier_zalo_notifications(10);

  if v_claimed_count <> 1 then
    raise exception 'CHECK FAIL: claim returned %, expected 1', v_claimed_count;
  end if;

  select id, status, attempts
    into v_claimed_id, v_status, v_attempts
  from public.supplier_zalo_notifications
  where order_request_id = '00000000-0000-0000-0000-000000000002';

  if v_status <> 'sending' then
    raise exception 'CHECK FAIL: claimed status is %, expected sending', v_status;
  end if;
  if v_attempts <> 1 then
    raise exception 'CHECK FAIL: claimed attempts is %, expected 1', v_attempts;
  end if;

  perform public.mark_supplier_zalo_notification(v_claimed_id, true);

  select status, attempts, sent_at is not null
    into v_status, v_attempts, v_sent_at_set
  from public.supplier_zalo_notifications
  where id = v_claimed_id;

  if v_status <> 'sent' then
    raise exception 'CHECK FAIL: final status is %, expected sent', v_status;
  end if;
  if v_attempts <> 1 then
    raise exception 'CHECK FAIL: final attempts is %, expected 1', v_attempts;
  end if;
  if not v_sent_at_set then
    raise exception 'CHECK FAIL: sent_at was not set';
  end if;

  perform set_config('bmq.zalo_claimed_count', v_claimed_count::text, true);
end;
$$;

reset role;

-- Re-read the row after the role switch so the summary reflects committed
-- in-transaction state.
insert into supplier_zalo_dryrun_checks (check_name, result)
select 'claimed_count', current_setting('bmq.zalo_claimed_count', true)
union all
select 'final_status', status
from public.supplier_zalo_notifications
where order_request_id = '00000000-0000-0000-0000-000000000002'
union all
select 'final_attempts', attempts::text
from public.supplier_zalo_notifications
where order_request_id = '00000000-0000-0000-0000-000000000002'
union all
select 'sent_at_set', (sent_at is not null)::text
from public.supplier_zalo_notifications
where order_request_id = '00000000-0000-0000-0000-000000000002'
on conflict (check_name) do update
  set result = excluded.result;

-- ---------------------------------------------------------------------------
-- 6. Final state and one-row summary.
-- ---------------------------------------------------------------------------

select status, attempts, sent_at is not null as sent_at_set, last_error
from public.supplier_zalo_notifications
where order_request_id = '00000000-0000-0000-0000-000000000002';

select string_agg(
         check_name || '=' || result,
         ' | ' order by check_name
       ) as summary
from supplier_zalo_dryrun_checks;

rollback;
