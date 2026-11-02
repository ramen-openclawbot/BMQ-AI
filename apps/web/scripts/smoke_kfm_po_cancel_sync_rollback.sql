-- Rollback-only smoke for 20261103620000_kfm_po_cancel_sync.sql.
-- Run AFTER applying the migration:
--   psql -v ON_ERROR_STOP=1 -f apps/web/scripts/smoke_kfm_po_cancel_sync_rollback.sql
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
  not has_function_privilege('anon', 'public.kfm_mark_po_cancelled(text)', 'execute'),
  'anon can execute kfm_mark_po_cancelled');
select pg_temp.assert_true(
  not has_function_privilege('authenticated', 'public.kfm_mark_po_cancelled(text)', 'execute'),
  'authenticated can execute kfm_mark_po_cancelled');
select pg_temp.assert_true(
  has_function_privilege('service_role', 'public.kfm_mark_po_cancelled(text)', 'execute'),
  'service_role cannot execute kfm_mark_po_cancelled');

-- 2. Disposable fixtures: one PO with a planned order, one with a started order.
insert into public.customer_po_inbox (
  id, gmail_message_id, from_email, from_name, po_number, delivery_date,
  production_items, match_status, raw_payload
) values
  ('a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', 'kfm-portal:1865:999999901',
   'portal@kingfoodmart.com', 'KINGFOOD MART', 'PO-SMOKE-CANCEL-A', current_date,
   '[]'::jsonb, 'approved', '{"source":"kfm_portal","portal_sub_status":6}'::jsonb),
  ('a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2', 'kfm-portal:1865:999999902',
   'portal@kingfoodmart.com', 'KINGFOOD MART', 'PO-SMOKE-CANCEL-B', current_date,
   '[]'::jsonb, 'approved', '{"source":"kfm_portal","portal_sub_status":6}'::jsonb);

insert into public.production_orders (
  id, production_number, source_po_inbox_id, status, location_code
) values
  ('b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1', 'SX-SMOKE-CANCEL-PLANNED',
   'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', 'planned', 'q7'),
  ('b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2', 'SX-SMOKE-CANCEL-STARTED',
   'a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2', 'in_progress', 'q7');

-- 3. Planned order is cancelled, started order only warns, repeat is a no-op.
set local role service_role;

do $$
declare
  v_result jsonb;
  v_inbox public.customer_po_inbox%rowtype;
begin
  v_result := public.kfm_mark_po_cancelled(' po-smoke-cancel-a ');
  perform pg_temp.assert_true((v_result->>'cancelled_count')::integer = 1,
    'planned order was not cancelled');
  perform pg_temp.assert_true((v_result->>'warning_count')::integer = 0,
    'planned-only PO returned a warning');
  perform pg_temp.assert_true(
    (select status::text from public.production_orders
      where id = 'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1') = 'cancelled',
    'planned order stayed planned');

  select * into v_inbox from public.customer_po_inbox
  where id = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
  perform pg_temp.assert_true(v_inbox.match_status = 'rejected', 'inbox was not rejected');
  perform pg_temp.assert_true(v_inbox.review_note = 'KFM đã hủy PO trên cổng',
    'inbox review note was not written');
  perform pg_temp.assert_true((v_inbox.raw_payload->>'portal_sub_status')::integer = 11,
    'inbox raw payload did not record subStatus 11');

  v_result := public.kfm_mark_po_cancelled('PO-SMOKE-CANCEL-A');
  perform pg_temp.assert_true((v_result->>'status') = 'noop', 'second call was not a noop');
  perform pg_temp.assert_true((v_result->>'cancelled_count')::integer = 0,
    'second call cancelled another order');

  v_result := public.kfm_mark_po_cancelled('PO-SMOKE-CANCEL-B');
  perform pg_temp.assert_true((v_result->>'cancelled_count')::integer = 0,
    'started order was counted as cancelled');
  perform pg_temp.assert_true((v_result->>'warning_count')::integer = 1,
    'started order was not returned as a warning');
  perform pg_temp.assert_true(
    (select status::text from public.production_orders
      where id = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2') = 'in_progress',
    'started order was cancelled');
end $$;

reset role;

-- 4. anon and authenticated cannot call the RPC.
set local role anon;
do $$
begin
  begin
    perform public.kfm_mark_po_cancelled('PO-SMOKE-CANCEL-B');
    raise exception 'anon unexpectedly called kfm_mark_po_cancelled';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;

set local role authenticated;
do $$
begin
  begin
    perform public.kfm_mark_po_cancelled('PO-SMOKE-CANCEL-B');
    raise exception 'authenticated unexpectedly called kfm_mark_po_cancelled';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;

rollback;
