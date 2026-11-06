-- Rollback-only smoke for 20261106140000_kfm_po_change_sync.sql.
-- Run AFTER applying the migration:
--   psql -v ON_ERROR_STOP=1 -f apps/web/scripts/smoke_kfm_po_change_sync_rollback.sql
--
-- Everything is created inside the transaction and rolled back; no production
-- PO, order, inventory or ledger row is touched. Each inbox row has at most one
-- production order (uq_production_orders_source_po_inbox), so the planned and
-- the started cases use two separate portal POs.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if coalesce(p_ok, false) is false then raise exception '%', p_message; end if;
end $$;

-- 1. Execute surface: only service_role may call the RPC.
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.kfm_apply_po_change(text, jsonb)', 'execute'),
  'anon can execute kfm_apply_po_change');
select pg_temp.assert_true(
  not has_function_privilege('authenticated', 'public.kfm_apply_po_change(text, jsonb)', 'execute'),
  'authenticated can execute kfm_apply_po_change');
select pg_temp.assert_true(
  has_function_privilege('service_role', 'public.kfm_apply_po_change(text, jsonb)', 'execute'),
  'service_role cannot execute kfm_apply_po_change');

-- 2. Disposable fixtures: one PO with a planned order, one with a started order.
insert into public.customer_po_inbox (
  id, gmail_message_id, from_email, from_name, po_number, delivery_date,
  production_items, subtotal_amount, vat_amount, total_amount, match_status, raw_payload
) values
  ('c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1', 'kfm-portal:1865:999999911',
   'portal@kingfoodmart.com', 'KINGFOOD MART', 'PO-SMOKE-CHANGE-A', current_date,
   '[{"sku":"SP-SMOKE-A","sku_code":"SKU-SMOKE-A","product_name":"Bánh A","qty":10,"unit":"Cái","unit_price":100}]'::jsonb,
   1000, 80, 1080, 'approved',
   '{"source":"kfm_portal","portal_sub_status":5,"keep_me":true}'::jsonb),
  ('c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2', 'kfm-portal:1865:999999912',
   'portal@kingfoodmart.com', 'KINGFOOD MART', 'PO-SMOKE-CHANGE-B', current_date,
   '[{"sku":"SP-SMOKE-B","sku_code":"SKU-SMOKE-B","product_name":"Bánh B","qty":10,"unit":"Cái","unit_price":100}]'::jsonb,
   1000, 80, 1080, 'approved',
   '{"source":"kfm_portal","portal_sub_status":5}'::jsonb);

insert into public.production_orders (
  id, production_number, source_po_inbox_id, status, location_code
) values
  ('d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1', 'SX-SMOKE-CHANGE-PLANNED',
   'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1', 'planned', 'q7'),
  ('d2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2', 'SX-SMOKE-CHANGE-STARTED',
   'c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2', 'in_progress', 'q7');

-- 3. Planned order is cancelled, items/amounts/history are replaced, repeat is a no-op.
set local role service_role;

do $$
declare
  v_result jsonb;
  v_inbox public.customer_po_inbox%rowtype;
  v_payload jsonb := jsonb_build_object(
    'po_number', 'PO-SMOKE-CHANGE-A',
    'delivery_date', to_char(current_date + 1, 'YYYY-MM-DD'),
    'production_items', jsonb_build_array(jsonb_build_object(
      'sku', 'SP-SMOKE-A',
      'sku_code', 'SKU-SMOKE-A',
      'product_name', 'Bánh A',
      'qty', 12,
      'unit', 'Cái',
      'unit_price', 100
    )),
    'subtotal_amount', 1200,
    'vat_amount', 96,
    'total_amount', 1296,
    'raw_payload', jsonb_build_object(
      'source', 'kfm_portal',
      'portal_sub_status', 5,
      'portal_new_key', 'new-value'
    )
  );
begin
  v_result := public.kfm_apply_po_change(' po-smoke-change-a ', v_payload);
  perform pg_temp.assert_true((v_result->>'status') = 'updated',
    'planned-only PO was not updated');
  perform pg_temp.assert_true((v_result->>'cancelled_count')::integer = 1,
    'planned order was not counted as cancelled');
  perform pg_temp.assert_true(
    (v_result->'old_items'->0->>'qty')::numeric = 10,
    'old items were not returned');
  perform pg_temp.assert_true(
    (v_result->'new_items'->0->>'qty')::numeric = 12,
    'new items were not returned');

  select * into v_inbox from public.customer_po_inbox
  where id = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';
  perform pg_temp.assert_true(
    (v_inbox.production_items->0->>'qty')::numeric = 12,
    'inbox production items were not replaced');
  perform pg_temp.assert_true(v_inbox.subtotal_amount = 1200,
    'inbox subtotal was not replaced');
  perform pg_temp.assert_true(v_inbox.vat_amount = 96,
    'inbox VAT was not replaced');
  perform pg_temp.assert_true(v_inbox.total_amount = 1296,
    'inbox total was not replaced');
  perform pg_temp.assert_true(v_inbox.review_note = 'KFM đổi số lượng PO trên cổng',
    'inbox review note was not written');
  perform pg_temp.assert_true((v_inbox.raw_payload->>'keep_me') = 'true',
    'old raw payload keys were not preserved');
  perform pg_temp.assert_true((v_inbox.raw_payload->>'portal_new_key') = 'new-value',
    'new portal raw payload keys were not merged');
  perform pg_temp.assert_true(
    jsonb_typeof(v_inbox.raw_payload->'kfm_revisions') = 'array'
      and jsonb_array_length(v_inbox.raw_payload->'kfm_revisions') = 1,
    'revision history was not appended');
  perform pg_temp.assert_true(
    (v_inbox.raw_payload->'kfm_revisions'->0->'old_items'->0->>'qty')::numeric = 10,
    'revision history did not keep old items');
  perform pg_temp.assert_true(
    (v_inbox.raw_payload->'kfm_revisions'->0->>'old_total')::numeric = 1080,
    'revision history did not keep the old total');
  perform pg_temp.assert_true(
    (select status::text from public.production_orders
      where id = 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1') = 'cancelled',
    'planned order stayed planned');
  perform pg_temp.assert_true(
    (select notes from public.production_orders
      where id = 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1')
      like '%KFM đổi số lượng PO PO-SMOKE-CHANGE-A%',
    'cancelled order note was not appended');
  perform pg_temp.assert_true(
    (select source_po_inbox_id from public.production_orders
      where id = 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1') is null,
    'cancelled order still linked to the inbox, a new order could not be created');
  perform pg_temp.assert_true(
    not exists (select 1 from public.production_orders
      where source_po_inbox_id = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1'),
    'inbox still has a linked order after the change');

  v_result := public.kfm_apply_po_change('PO-SMOKE-CHANGE-A', v_payload);
  perform pg_temp.assert_true((v_result->>'status') = 'noop',
    'second identical call was not a noop');
  select * into v_inbox from public.customer_po_inbox
  where id = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';
  perform pg_temp.assert_true(
    jsonb_array_length(v_inbox.raw_payload->'kfm_revisions') = 1,
    'second call appended another revision');

  v_result := public.kfm_apply_po_change('PO-SMOKE-CHANGE-B', jsonb_set(v_payload, '{po_number}', '"PO-SMOKE-CHANGE-B"'));
  perform pg_temp.assert_true((v_result->>'status') = 'blocked',
    'started order did not block the change');
  perform pg_temp.assert_true((v_result->>'warning_count')::integer = 1,
    'started order was not returned as a warning');
  perform pg_temp.assert_true(
    (v_result->'warnings'->0->>'message') = 'Lệnh sản xuất đã bắt đầu; cần xử lý tay.',
    'warning message was wrong');
  select * into v_inbox from public.customer_po_inbox
  where id = 'c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2';
  perform pg_temp.assert_true(
    (v_inbox.production_items->0->>'qty')::numeric = 10,
    'blocked change still replaced inbox items');
  perform pg_temp.assert_true(v_inbox.total_amount = 1080,
    'blocked change still replaced inbox total');
  perform pg_temp.assert_true(
    jsonb_array_length(coalesce(v_inbox.raw_payload->'kfm_revisions', '[]'::jsonb)) = 0,
    'blocked change still appended revision history');
  perform pg_temp.assert_true(
    (select status::text from public.production_orders
      where id = 'd2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2') = 'in_progress',
    'started order was cancelled');
end $$;

reset role;

-- 4. anon and authenticated cannot call the RPC.
set local role anon;
do $$
begin
  begin
    perform public.kfm_apply_po_change('PO-SMOKE-CHANGE-B', '{}'::jsonb);
    raise exception 'anon unexpectedly called kfm_apply_po_change';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;

set local role authenticated;
do $$
begin
  begin
    perform public.kfm_apply_po_change('PO-SMOKE-CHANGE-B', '{}'::jsonb);
    raise exception 'authenticated unexpectedly called kfm_apply_po_change';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;

rollback;

\echo SMOKE_ALL_PASSED
