-- Rollback-only smoke for migration 20261101420000_tan_tao_auto_dispatch.sql.
--
-- Run after the migration is applied, as the database owner/Maestro:
--   supabase db query --linked -f scripts/smoke_tan_tao_auto_dispatch.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_tan_tao_auto_dispatch.sql).
--
-- The file opens one transaction, impersonates the real owner through
-- request.jwt.claims, then exercises:
--   (a) close_tan_tao_open_before('2026-10-16', true) reports work but writes
--       no runs, events or stock movements;
--   (b) the committed close leaves 0 active reservations dated <= 2026-10-16
--       and still writes 0 stock movements;
--   (c) run_tan_tao_daily_ledger('2026-10-18', false) receives a synthetic
--       expected Tuyết Anh order and dispatches a synthetic dealer reservation
--       dated 2026-10-18; on-hand changes by received - dispatched;
--   (d) replaying the same date writes no new movements;
--   (e) a cancelled dealer order's active reservation is not dispatched.
--
-- It raises notice 'SMOKE_RESULT PASS' and rolls back; nothing is committed.

begin;

do $smoke$
declare
  v_owner uuid;
  v_customer uuid;
  v_sku_id uuid;
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_runs_before bigint;
  v_events_before bigint;
  v_movements_before bigint;
  v_movements_after bigint;
  v_on_hand_before numeric;
  v_on_hand_after numeric;
  v_dry jsonb;
  v_close jsonb;
  v_daily jsonb;
  v_second jsonb;
  v_active_after integer;
  v_order_id uuid;
  v_cancel_order_id uuid;
  v_document_id uuid;
  v_cancel_document_id uuid;
  v_reservation_id uuid;
  v_cancel_reservation_id uuid;
  v_supplier_document_id uuid;
  v_received numeric;
  v_dispatched numeric;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL: no owner role';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  select ps.id into v_sku_id
  from public.product_skus ps
  where upper(ps.sku_code) = 'BMQ-001'
  order by ps.created_at asc
  limit 1;
  if v_sku_id is null then
    raise exception 'SMOKE_RESULT FAIL: BMQ-001 is not configured';
  end if;

  select count(*) into v_runs_before from public.tan_tao_auto_ledger_runs;
  select count(*) into v_events_before from public.tan_tao_auto_ledger_events;
  select count(*) into v_movements_before from public.tan_tao_warehouse_movements;

  -- -------------------------------------------------------------------------
  -- (a) Dry-run close reports work and writes nothing.
  -- -------------------------------------------------------------------------
  v_dry := public.close_tan_tao_open_before('2026-10-16', true);
  if (v_dry ->> 'closed_reservations')::integer
     + (v_dry ->> 'closed_supplier_orders')::integer <= 0 then
    raise exception 'SMOKE_RESULT FAIL: dry-run close reported no work';
  end if;
  if (select count(*) from public.tan_tao_auto_ledger_runs) <> v_runs_before then
    raise exception 'SMOKE_RESULT FAIL: dry-run close wrote a run row';
  end if;
  if (select count(*) from public.tan_tao_auto_ledger_events) <> v_events_before then
    raise exception 'SMOKE_RESULT FAIL: dry-run close wrote an event row';
  end if;
  if (select count(*) from public.tan_tao_warehouse_movements) <> v_movements_before then
    raise exception 'SMOKE_RESULT FAIL: dry-run close wrote a stock movement';
  end if;

  -- -------------------------------------------------------------------------
  -- (b) Committed close leaves no active reservation on/before 2026-10-16.
  -- -------------------------------------------------------------------------
  v_close := public.close_tan_tao_open_before('2026-10-16', false);
  if (v_close ->> 'closed_reservations')::integer
     + (v_close ->> 'closed_supplier_orders')::integer <= 0 then
    raise exception 'SMOKE_RESULT FAIL: committed close reported no work';
  end if;

  select count(*) into v_active_after
  from public.tan_tao_warehouse_reservations r
  join public.tan_tao_warehouse_documents d on d.id = r.document_id
  where r.status = 'active'
    and public.tan_tao_auto_ledger_business_date(d.id) <= date '2026-10-16';
  if v_active_after <> 0 then
    raise exception 'SMOKE_RESULT FAIL: % active reservations still dated <= 2026-10-16', v_active_after;
  end if;
  if (select count(*) from public.tan_tao_warehouse_movements) <> v_movements_before then
    raise exception 'SMOKE_RESULT FAIL: committed close wrote a stock movement';
  end if;

  -- -------------------------------------------------------------------------
  -- (c) Synthetic 2026-10-18 dealer reservation + expected supplier order.
  -- -------------------------------------------------------------------------
  select c.id into v_customer
  from public.mini_crm_customers c
  order by c.created_at asc, c.id asc
  limit 1;
  if v_customer is null then
    raise exception 'SMOKE_RESULT FAIL: no mini_crm_customers row for a synthetic dealer order';
  end if;

  insert into public.dealer_orders (
    order_number, customer_id, status, currency,
    subtotal_amount_vnd, total_amount_vnd, requested_delivery_date,
    customer_snapshot, submitted_at, updated_at
  ) values (
    'SMOKE-AUTO-' || upper(v_suffix), v_customer, 'submitted', 'VND',
    0, 0, date '2026-10-18',
    jsonb_build_object('name', 'Smoke Auto Ledger'), now(), now()
  ) returning id into v_order_id;

  insert into public.tan_tao_warehouse_documents (
    document_number, location_code, sku_id, sku_code_snapshot, document_type, status,
    quantity, ordered_quantity, exchange_quantity, makeup_quantity, physical_quantity,
    source_authority, reference_type, reference_id, reference_label,
    idempotency_key, metadata
  ) values (
    'TT-OUT-20261018-' || upper(v_suffix), 'warehouse_tan_tao', v_sku_id, 'BMQ-001',
    'outbound_order', 'reserved', 20, 20, 0, 0, 20,
    'smoke_auto_ledger', 'dealer_order', v_order_id, 'Smoke Auto Ledger',
    'smoke-auto-dispatch:' || v_suffix,
    jsonb_build_object('stock_effect', 'reservation_only')
  ) returning id into v_document_id;

  insert into public.tan_tao_warehouse_reservations (
    document_id, location_code, sku_id, sku_code_snapshot,
    quantity, status, source_type, source_id
  ) values (
    v_document_id, 'warehouse_tan_tao', v_sku_id, 'BMQ-001',
    20, 'active', 'dealer_order', v_order_id
  ) returning id into v_reservation_id;

  insert into public.tan_tao_warehouse_documents (
    document_number, location_code, sku_id, sku_code_snapshot, document_type, status,
    quantity, physical_quantity, source_authority, reference_type, reference_label,
    idempotency_key, metadata
  ) values (
    'TT-SUP-20261018-' || upper(v_suffix), 'warehouse_tan_tao', v_sku_id, 'BMQ-001',
    'supplier_order', 'expected', 50, 50, 'smoke_auto_ledger',
    'production_bread_order', 'BMQ - HKD Tuyết Anh',
    'smoke-auto-supplier:' || v_suffix,
    jsonb_build_object('digest_date', '2026-10-18', 'stock_effect', 'incoming_only')
  ) returning id into v_supplier_document_id;

  -- A cancelled dealer order keeps an active reservation (insert does not fire
  -- the update-only cancellation release trigger). The daily job must not
  -- dispatch it.
  insert into public.dealer_orders (
    order_number, customer_id, status, currency,
    subtotal_amount_vnd, total_amount_vnd, requested_delivery_date,
    customer_snapshot, submitted_at, updated_at
  ) values (
    'SMOKE-AUTO-CANCEL-' || upper(v_suffix), v_customer, 'cancelled', 'VND',
    0, 0, date '2026-10-18',
    jsonb_build_object('name', 'Smoke Cancelled'), now(), now()
  ) returning id into v_cancel_order_id;

  insert into public.tan_tao_warehouse_documents (
    document_number, location_code, sku_id, sku_code_snapshot, document_type, status,
    quantity, ordered_quantity, exchange_quantity, makeup_quantity, physical_quantity,
    source_authority, reference_type, reference_id, reference_label,
    idempotency_key, metadata
  ) values (
    'TT-OUT-20261018-C' || upper(v_suffix), 'warehouse_tan_tao', v_sku_id, 'BMQ-001',
    'outbound_order', 'reserved', 7, 7, 0, 0, 7,
    'smoke_auto_ledger', 'dealer_order', v_cancel_order_id, 'Smoke Cancelled',
    'smoke-auto-cancel:' || v_suffix,
    jsonb_build_object('stock_effect', 'reservation_only')
  ) returning id into v_cancel_document_id;

  insert into public.tan_tao_warehouse_reservations (
    document_id, location_code, sku_id, sku_code_snapshot,
    quantity, status, source_type, source_id
  ) values (
    v_cancel_document_id, 'warehouse_tan_tao', v_sku_id, 'BMQ-001',
    7, 'active', 'dealer_order', v_cancel_order_id
  ) returning id into v_cancel_reservation_id;

  select coalesce(sum(m.quantity), 0) into v_on_hand_before
  from public.tan_tao_warehouse_movements m
  where m.location_code = 'warehouse_tan_tao' and m.sku_id = v_sku_id;
  select count(*) into v_movements_before
  from public.tan_tao_warehouse_movements
  where location_code = 'warehouse_tan_tao' and sku_id = v_sku_id;

  v_daily := public.run_tan_tao_daily_ledger('2026-10-18', false);
  if (v_daily ->> 'run_id') is null then
    raise exception 'SMOKE_RESULT FAIL: daily run did not return a run id';
  end if;

  select coalesce(sum(m.quantity), 0) into v_on_hand_after
  from public.tan_tao_warehouse_movements m
  where m.location_code = 'warehouse_tan_tao' and m.sku_id = v_sku_id;
  select count(*) into v_movements_after
  from public.tan_tao_warehouse_movements
  where location_code = 'warehouse_tan_tao' and sku_id = v_sku_id;

  v_received := coalesce((v_daily ->> 'received_quantity')::numeric, 0);
  v_dispatched := coalesce((v_daily ->> 'dispatched_quantity')::numeric, 0);
  if (v_on_hand_after - v_on_hand_before) <> (v_received - v_dispatched) then
    raise exception 'SMOKE_RESULT FAIL: on-hand delta % <> received % - dispatched %',
      (v_on_hand_after - v_on_hand_before), v_received, v_dispatched;
  end if;

  if not exists (
    select 1
    from public.tan_tao_warehouse_documents receipt
    where receipt.source_document_id = v_supplier_document_id
      and receipt.document_type = 'receipt'
      and receipt.status = 'posted'
      and receipt.quantity = 50
  ) then
    raise exception 'SMOKE_RESULT FAIL: synthetic expected supplier order was not received';
  end if;

  if not exists (
    select 1
    from public.tan_tao_warehouse_reservations r
    where r.id = v_reservation_id and r.status = 'dispatched'
  ) then
    raise exception 'SMOKE_RESULT FAIL: synthetic dealer reservation was not dispatched';
  end if;

  -- -------------------------------------------------------------------------
  -- (d) Replaying the same date writes no new movements.
  -- -------------------------------------------------------------------------
  v_second := public.run_tan_tao_daily_ledger('2026-10-18', false);
  if (select count(*) from public.tan_tao_warehouse_movements
      where location_code = 'warehouse_tan_tao' and sku_id = v_sku_id) <> v_movements_after then
    raise exception 'SMOKE_RESULT FAIL: second daily run wrote a new movement';
  end if;
  if (v_second ->> 'run_id') is null then
    raise exception 'SMOKE_RESULT FAIL: second daily run did not return a run id';
  end if;

  -- -------------------------------------------------------------------------
  -- (e) Cancelled dealer order is never dispatched.
  -- -------------------------------------------------------------------------
  if exists (
    select 1
    from public.tan_tao_warehouse_reservations r
    where r.id = v_cancel_reservation_id and r.status = 'dispatched'
  ) then
    raise exception 'SMOKE_RESULT FAIL: cancelled dealer reservation was dispatched';
  end if;
  if exists (
    select 1
    from public.tan_tao_warehouse_documents dispatch
    where dispatch.source_document_id = v_cancel_document_id
      and dispatch.document_type = 'dispatch'
  ) then
    raise exception 'SMOKE_RESULT FAIL: cancelled dealer order produced a dispatch document';
  end if;

  raise notice 'SMOKE_RESULT PASS';
end;
$smoke$;

rollback;
