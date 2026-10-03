-- Rollback-only probe for Demo 3 stage 3B write-safety RPCs.
-- Run against a disposable/staging Supabase database after applying:
--   20261003100000_stage3_write_safety_rpcs.sql
--
-- psql -v ON_ERROR_STOP=1 -f apps/web/scripts/smoke_stage3_write_safety_rollback.sql

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if coalesce(p_ok, false) is false then raise exception '%', p_message; end if;
end $$;

-- 1. Execute surface: anon denied, authenticated allowed.
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.reject_payment_request(uuid, text)', 'execute'),
  'anon can execute reject_payment_request');
select pg_temp.assert_true(
  has_function_privilege('authenticated', 'public.reject_payment_request(uuid, text)', 'execute'),
  'authenticated cannot execute reject_payment_request');
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.transition_warehouse_dispatch_status(uuid, text)', 'execute'),
  'anon can execute transition_warehouse_dispatch_status');
select pg_temp.assert_true(
  has_function_privilege('authenticated', 'public.transition_warehouse_dispatch_status(uuid, text)', 'execute'),
  'authenticated cannot execute transition_warehouse_dispatch_status');

-- 2. Disposable fixture inside the transaction.
reset role;

do $$
declare
  v_cols text;
  v_vals text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position),
         string_agg(case column_name
           when 'id' then quote_literal('a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1') || '::uuid'
           when 'aud' then quote_literal('authenticated')
           when 'role' then quote_literal('authenticated')
           when 'email' then quote_literal('stage3-owner-smoke@example.invalid')
           when 'encrypted_password' then quote_literal('')
           when 'email_confirmed_at' then 'now()'
           when 'created_at' then 'now()'
           when 'updated_at' then 'now()'
           else 'null'
         end, ', ' order by ordinal_position)
  into v_cols, v_vals
  from information_schema.columns
  where table_schema = 'auth' and table_name = 'users'
    and column_name in ('id', 'aud', 'role', 'email', 'encrypted_password', 'email_confirmed_at', 'created_at', 'updated_at');
  execute format('insert into auth.users (%s) values (%s) on conflict (id) do nothing', v_cols, v_vals);
end $$;

insert into public.user_roles (user_id, role)
values ('a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', 'owner')
on conflict do nothing;

insert into public.payment_requests (id, request_number, title, status, payment_status, total_amount)
values
  ('11111111-1111-4111-8111-111111111101', 'SMOKE-PR-PENDING', 'Smoke pending', 'pending', 'unpaid', 100000),
  ('11111111-1111-4111-8111-111111111102', 'SMOKE-PR-APPROVED', 'Smoke approved', 'approved', 'unpaid', 100000)
on conflict (id) do nothing;

insert into public.inventory_items (id, name, quantity, unit)
values
  ('33333333-3333-4333-8333-333333333301', 'Bột mì smoke OK', 100, 'kg'),
  ('33333333-3333-4333-8333-333333333302', 'Bột mì smoke short', 1, 'kg')
on conflict (id) do nothing;

insert into public.warehouse_dispatches (id, dispatch_number, status, dispatch_date)
values
  ('22222222-2222-4222-8222-222222222201', 'XK-SMOKE-0001', 'picked', current_date),
  ('22222222-2222-4222-8222-222222222202', 'XK-SMOKE-0002', 'picked', current_date)
on conflict (id) do nothing;

insert into public.warehouse_dispatch_items (dispatch_id, product_name, quantity, unit)
values
  ('22222222-2222-4222-8222-222222222201', 'Bột mì smoke OK', 5, 'kg'),
  ('22222222-2222-4222-8222-222222222202', 'Bột mì smoke short', 5, 'kg');

-- 3. Act as the temporary owner (authenticated, non service_role).
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', true);

-- 4. Reject: pending succeeds, identical repeat is idempotent, approved is blocked.
do $$
declare
  v_result jsonb;
  v_blocked boolean := false;
begin
  v_result := public.reject_payment_request('11111111-1111-4111-8111-111111111101', 'Thiếu chứng từ');
  perform pg_temp.assert_true((v_result->>'idempotent')::boolean is false, 'first reject not idempotent');
  perform pg_temp.assert_true(
    (select status::text from public.payment_requests where id = '11111111-1111-4111-8111-111111111101') = 'rejected',
    'pending reject did not set rejected');

  v_result := public.reject_payment_request('11111111-1111-4111-8111-111111111101', 'Thiếu chứng từ');
  perform pg_temp.assert_true((v_result->>'idempotent')::boolean, 'identical repeat reject not idempotent');

  begin
    perform public.reject_payment_request('11111111-1111-4111-8111-111111111102', 'Thiếu chứng từ');
  exception when sqlstate 'P0001' then
    v_blocked := true;
  end;
  perform pg_temp.assert_true(v_blocked, 'approved payment request was rejected');
  perform pg_temp.assert_true(
    (select status::text from public.payment_requests where id = '11111111-1111-4111-8111-111111111102') = 'approved',
    'blocked reject changed approved status');
end $$;

-- 5. Dispatch: deducts once, second call is idempotent, short stock is blocked.
do $$
declare
  v_result jsonb;
  v_blocked boolean := false;
  v_message text;
  v_before numeric;
begin
  v_result := public.transition_warehouse_dispatch_status('22222222-2222-4222-8222-222222222201', 'dispatched');
  perform pg_temp.assert_true((v_result->>'idempotent')::boolean is false, 'first dispatch marked idempotent');
  perform pg_temp.assert_true(
    (v_result->'deducted'->0->>'quantity')::numeric = 5, 'deducted quantity mismatch');
  perform pg_temp.assert_true(
    (select quantity from public.inventory_items where id = '33333333-3333-4333-8333-333333333301') = 95,
    'inventory was not deducted');
  perform pg_temp.assert_true(
    (select count(*) from public.inventory_movements where reference_type = 'dispatch' and reference_id = '22222222-2222-4222-8222-222222222201') = 1,
    'dispatch movement was not recorded');

  v_result := public.transition_warehouse_dispatch_status('22222222-2222-4222-8222-222222222201', 'dispatched');
  perform pg_temp.assert_true((v_result->>'idempotent')::boolean, 'repeat dispatch not idempotent');
  perform pg_temp.assert_true(
    (select quantity from public.inventory_items where id = '33333333-3333-4333-8333-333333333301') = 95,
    'idempotent dispatch deducted inventory again');
  perform pg_temp.assert_true(
    (select count(*) from public.inventory_movements where reference_id = '22222222-2222-4222-8222-222222222201') = 1,
    'idempotent dispatch added a movement');

  select quantity into v_before from public.inventory_items where id = '33333333-3333-4333-8333-333333333302';
  begin
    perform public.transition_warehouse_dispatch_status('22222222-2222-4222-8222-222222222202', 'dispatched');
  exception when sqlstate 'P0001' then
    get stacked diagnostics v_message = message_text;
    if v_message <> 'insufficient_stock' then raise; end if;
    v_blocked := true;
  end;
  perform pg_temp.assert_true(v_blocked, 'insufficient stock was not blocked');
  perform pg_temp.assert_true(
    (select quantity from public.inventory_items where id = '33333333-3333-4333-8333-333333333302') = v_before,
    'insufficient stock changed inventory');
  perform pg_temp.assert_true(
    (select status::text from public.warehouse_dispatches where id = '22222222-2222-4222-8222-222222222202') = 'picked',
    'insufficient stock changed dispatch status');
  perform pg_temp.assert_true(
    not exists (select 1 from public.inventory_movements where reference_id = '22222222-2222-4222-8222-222222222202'),
    'insufficient stock wrote a movement');
end $$;

rollback;
