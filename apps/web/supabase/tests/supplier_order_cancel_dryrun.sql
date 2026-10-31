-- Rollback-only dry run for 20261103560000_supplier_order_cancel.sql.
--
-- Run as one file after the migration is present in the database. Every fixture
-- uses a fixed 00000000-… id and the final rollback discards everything. The
-- last statement prints one summary row so the expected values can be compared.
--
-- It covers: cancel a sent order (PO cancelled, request cancelled with reason,
-- exactly one Zalo 'cancel' message), a repeat cancel (already_cancelled, still
-- one message), a received goods receipt (po_cancel_has_receipt, request stays
-- 'sent') and an empty reason (cancel_reason_required).

begin;

-- ---------------------------------------------------------------------------
-- 1. Fixtures: supplier with an enabled Zalo group, two sent requests.
-- ---------------------------------------------------------------------------

insert into public.suppliers (id, name)
values (
  '00000000-0000-0000-0000-000000000001',
  'NCC Dry Run Huỷ Đơn'
);

insert into public.supplier_zalo_groups (
  id, supplier_id, zalo_group_id, zalo_group_name, enabled
) values (
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000001',
  'dryrun-cancel-group',
  'Nhóm Zalo Dry Run Huỷ Đơn',
  true
);

-- First PO: a normal sent order that can be cancelled.
insert into public.purchase_orders (
  id, po_number, supplier_id, status, total_amount, notes
) values (
  '00000000-0000-0000-0000-000000000021',
  'PO-DRYRUN-CANCEL-01',
  '00000000-0000-0000-0000-000000000001',
  'draft',
  1250000,
  'Dry run huỷ đơn'
);

insert into public.supplier_order_requests (
  id, request_id, supplier_id, purchase_order_id, to_email, subject,
  status, total_amount, sent_at, created_by
) values (
  '00000000-0000-0000-0000-000000000031',
  '00000000-0000-0000-0000-000000000041',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000021',
  'ncc-cancel@example.test',
  'BMQ đặt hàng PO-DRYRUN-CANCEL-01',
  'sent',
  1250000,
  timestamptz '2026-11-01 03:00:00+00',
  null
);

insert into public.supplier_order_request_lines (
  id, request_id, position, kitchen_inventory_item_id, product_name,
  quantity, unit, unit_price, line_total
) values
  (
    '00000000-0000-0000-0000-000000000051',
    '00000000-0000-0000-0000-000000000031',
    1,
    '00000000-0000-0000-0000-000000000071',
    'Bột mì Dry Run',
    2,
    'kg',
    500000,
    1000000
  ),
  (
    '00000000-0000-0000-0000-000000000052',
    '00000000-0000-0000-0000-000000000031',
    2,
    '00000000-0000-0000-0000-000000000072',
    'Đường Dry Run',
    1.5,
    'bao',
    166666.67,
    250000
  );

-- Second PO: its goods receipt is already 'received', so cancel must be refused.
insert into public.purchase_orders (
  id, po_number, supplier_id, status, total_amount, notes
) values (
  '00000000-0000-0000-0000-000000000022',
  'PO-DRYRUN-CANCEL-02',
  '00000000-0000-0000-0000-000000000001',
  'draft',
  300000,
  'Dry run huỷ đơn đã nhập kho'
);

insert into public.supplier_order_requests (
  id, request_id, supplier_id, purchase_order_id, to_email, subject,
  status, total_amount, sent_at, created_by
) values (
  '00000000-0000-0000-0000-000000000032',
  '00000000-0000-0000-0000-000000000042',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000022',
  'ncc-cancel-2@example.test',
  'BMQ đặt hàng PO-DRYRUN-CANCEL-02',
  'sent',
  300000,
  timestamptz '2026-11-02 03:00:00+00',
  null
);

insert into public.supplier_order_request_lines (
  id, request_id, position, kitchen_inventory_item_id, product_name,
  quantity, unit, unit_price, line_total
) values (
  '00000000-0000-0000-0000-000000000053',
  '00000000-0000-0000-0000-000000000032',
  1,
  '00000000-0000-0000-0000-000000000073',
  'Bột mì Dry Run 2',
  1,
  'kg',
  300000,
  300000
);

insert into public.goods_receipts (
  id, purchase_order_id, receipt_number, supplier_id, receipt_date, status
) values (
  '00000000-0000-0000-0000-000000000091',
  '00000000-0000-0000-0000-000000000022',
  'PN-DRYRUN-CANCEL-02',
  '00000000-0000-0000-0000-000000000001',
  current_date,
  'received'
);

-- ---------------------------------------------------------------------------
-- 2. Call the RPCs as service_role.
-- ---------------------------------------------------------------------------

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_result jsonb;
  v_error text;
  v_ok boolean;
begin
  -- First cancel succeeds and queues exactly one 'cancel' Zalo message.
  v_result := public.cancel_supplier_order(
    '00000000-0000-0000-0000-000000000041',
    'Nhà cung cấp hết hàng đột xuất'
  );

  if coalesce((v_result ->> 'already_cancelled')::boolean, false) then
    raise exception 'CHECK FAIL: first cancel reported already_cancelled';
  end if;
  if not coalesce((v_result ->> 'zalo_queued')::boolean, false) then
    raise exception 'CHECK FAIL: first cancel did not queue a Zalo message';
  end if;
  if v_result ->> 'cancel_reason' is distinct from 'Nhà cung cấp hết hàng đột xuất' then
    raise exception 'CHECK FAIL: cancel_reason in result is %', v_result ->> 'cancel_reason';
  end if;
  if v_result ->> 'po_number' is distinct from 'PO-DRYRUN-CANCEL-01' then
    raise exception 'CHECK FAIL: po_number in result is %', v_result ->> 'po_number';
  end if;
  if v_result ->> 'supplier_name' is distinct from 'NCC Dry Run Huỷ Đơn' then
    raise exception 'CHECK FAIL: supplier_name in result is %', v_result ->> 'supplier_name';
  end if;
  if jsonb_array_length(coalesce(v_result -> 'lines', '[]'::jsonb)) <> 2 then
    raise exception 'CHECK FAIL: expected 2 result lines, got %',
      jsonb_array_length(coalesce(v_result -> 'lines', '[]'::jsonb));
  end if;

  -- Repeat cancel: already_cancelled, no extra message.
  v_result := public.cancel_supplier_order(
    '00000000-0000-0000-0000-000000000031',
    'Huỷ lần hai'
  );

  if not coalesce((v_result ->> 'already_cancelled')::boolean, false) then
    raise exception 'CHECK FAIL: second cancel did not report already_cancelled';
  end if;
  if coalesce((v_result ->> 'zalo_queued')::boolean, false) then
    raise exception 'CHECK FAIL: second cancel queued another Zalo message';
  end if;
  if v_result ->> 'cancel_reason' is distinct from 'Nhà cung cấp hết hàng đột xuất' then
    raise exception 'CHECK FAIL: second cancel changed the reason to %',
      v_result ->> 'cancel_reason';
  end if;

  -- A received goods receipt blocks the cancel and leaves the request 'sent'.
  v_ok := false;
  begin
    perform public.cancel_supplier_order(
      '00000000-0000-0000-0000-000000000042',
      'Thử huỷ đơn đã nhập kho'
    );
  exception when others then
    v_error := sqlerrm;
    v_ok := position('po_cancel_has_receipt' in v_error) > 0;
    if not v_ok then
      raise exception 'CHECK FAIL: expected po_cancel_has_receipt, got %', v_error;
    end if;
  end;
  if not v_ok then
    raise exception 'CHECK FAIL: received receipt did not block the cancel';
  end if;

  -- An empty reason is refused before any change.
  v_ok := false;
  begin
    perform public.cancel_supplier_order(
      '00000000-0000-0000-0000-000000000031',
      '   '
    );
  exception when others then
    v_error := sqlerrm;
    v_ok := position('cancel_reason_required' in v_error) > 0;
    if not v_ok then
      raise exception 'CHECK FAIL: expected cancel_reason_required, got %', v_error;
    end if;
  end;
  if not v_ok then
    raise exception 'CHECK FAIL: empty reason was accepted';
  end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 3. Verify the stored state (as the fixture owner) and print one summary row.
-- ---------------------------------------------------------------------------

do $$
declare
  v_po_status text;
  v_request_status text;
  v_reason text;
  v_cancelled_at_set boolean;
  v_zalo_count integer;
  v_zalo_message text;
  v_order_count integer;
  v_second_po_status text;
  v_second_request_status text;
begin
  select status::text into v_po_status
  from public.purchase_orders
  where id = '00000000-0000-0000-0000-000000000021';
  if v_po_status <> 'cancelled' then
    raise exception 'CHECK FAIL: PO status is %, expected cancelled', v_po_status;
  end if;

  select status, cancel_reason, cancelled_at is not null
    into v_request_status, v_reason, v_cancelled_at_set
  from public.supplier_order_requests
  where id = '00000000-0000-0000-0000-000000000031';
  if v_request_status <> 'cancelled' then
    raise exception 'CHECK FAIL: request status is %, expected cancelled', v_request_status;
  end if;
  if v_reason is distinct from 'Nhà cung cấp hết hàng đột xuất' then
    raise exception 'CHECK FAIL: stored reason is %', v_reason;
  end if;
  if not v_cancelled_at_set then
    raise exception 'CHECK FAIL: cancelled_at was not set';
  end if;

  select count(*), max(message)
    into v_zalo_count, v_zalo_message
  from public.supplier_zalo_notifications
  where order_request_id = '00000000-0000-0000-0000-000000000031'
    and kind = 'cancel';
  if v_zalo_count <> 1 then
    raise exception 'CHECK FAIL: expected 1 cancel Zalo message, got %', v_zalo_count;
  end if;
  if position('KHÔNG giao' in v_zalo_message) = 0 then
    raise exception 'CHECK FAIL: cancel Zalo message missing KHÔNG giao: %', v_zalo_message;
  end if;
  if position('Lý do: Nhà cung cấp hết hàng đột xuất' in v_zalo_message) = 0 then
    raise exception 'CHECK FAIL: cancel Zalo message missing reason: %', v_zalo_message;
  end if;

  select count(*)
    into v_order_count
  from public.supplier_zalo_notifications
  where order_request_id = '00000000-0000-0000-0000-000000000031'
    and kind = 'order';
  -- The fixture inserts the request already 'sent', which queues its one
  -- 'order' message; cancelling must not add or remove it.
  if v_order_count <> 1 then
    raise exception 'CHECK FAIL: expected exactly one order-kind message, got %', v_order_count;
  end if;

  select status::text into v_second_po_status
  from public.purchase_orders
  where id = '00000000-0000-0000-0000-000000000022';
  if v_second_po_status <> 'draft' then
    raise exception 'CHECK FAIL: blocked PO status is %, expected draft', v_second_po_status;
  end if;

  select status into v_second_request_status
  from public.supplier_order_requests
  where id = '00000000-0000-0000-0000-000000000032';
  if v_second_request_status <> 'sent' then
    raise exception 'CHECK FAIL: blocked request status is %, expected sent', v_second_request_status;
  end if;
end;
$$;

select 'SUMMARY'
  || ' | po1=' || (select status::text from public.purchase_orders
                   where id = '00000000-0000-0000-0000-000000000021')
  || ' | request1=' || (select status from public.supplier_order_requests
                        where id = '00000000-0000-0000-0000-000000000031')
  || ' | reason=' || (select cancel_reason from public.supplier_order_requests
                      where id = '00000000-0000-0000-0000-000000000031')
  || ' | zalo_cancel=' || (select count(*)::text from public.supplier_zalo_notifications
                            where order_request_id = '00000000-0000-0000-0000-000000000031'
                              and kind = 'cancel')
  || ' | po2=' || (select status::text from public.purchase_orders
                   where id = '00000000-0000-0000-0000-000000000022')
  || ' | request2=' || (select status from public.supplier_order_requests
                        where id = '00000000-0000-0000-0000-000000000032')
  as summary;

rollback;
