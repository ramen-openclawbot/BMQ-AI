-- Rollback-only smoke checks for 20261104100000_dealer_signup_payment_verify.sql.
--
-- Run inside a transaction and abort at the end so nothing is persisted:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f 20261104100000_dealer_signup_payment_verify.sql \
--     -f dealer_signup_payment_verify_smoke.sql
--
-- This file starts its own transaction and ends with `raise exception` so the
-- whole fixture (customers, applications, verification rows) is rolled back.

begin;

do $$
declare
  v_reviewer uuid := gen_random_uuid();
  v_customer uuid;
  v_customer_b uuid;
  v_app uuid;
  v_app_b uuid;
  v_app_c uuid;
  v_code text;
  v_result jsonb;
  v_status text;
  v_reason text := 'Số tiền chuyển khoản chưa khớp';
  v_hash text := repeat('a', 64);
  v_expires timestamptz := now() + interval '14 days';
begin
  -- -------------------------------------------------------------------------
  -- Fixture A: approved waiting slip -> activate -> confirm payment.
  -- -------------------------------------------------------------------------
  insert into public.mini_crm_customers (
    customer_name, customer_group, product_group, is_active, order_locked,
    dealer_onboarding_status
  ) values (
    'SMOKE Đại lý thanh toán A', 'banhmi_agency', 'banhmi', true, false,
    'waiting_slip'
  ) returning id into v_customer;

  insert into public.dealer_signup_applications (
    application_code, status, applicant_name, cccd, cccd_valid_until, phone,
    email, business_name, address_text, lat, lng, idempotency_key,
    crm_customer_id
  ) values (
    'DLM-20261104-' || upper(substr(md5(random()::text), 1, 4)),
    'approved_waiting_slip',
    'SMOKE Nguyễn Văn A',
    '079123456789',
    '2035-06-30',
    '0909123456',
    'smoke-payment-a@bmq.invalid',
    'SMOKE Đại lý thanh toán A',
    '12 Lê Lợi, Quận 1, TP.HCM',
    10.7769,
    106.7009,
    'smoke-payment-a-' || gen_random_uuid(),
    v_customer
  ) returning id into v_app;

  v_result := public.dealer_signup_activate(v_app, v_app || '/slip-first.pdf');
  if v_result->>'status' <> 'slip_submitted' then
    raise exception 'SMOKE_RESULT FAIL activate status=%', v_result->>'status';
  end if;
  if (v_result->>'already_submitted')::boolean then
    raise exception 'SMOKE_RESULT FAIL first activate already_submitted';
  end if;
  select dealer_onboarding_status into v_status
  from public.mini_crm_customers where id = v_customer;
  if v_status <> 'slip_submitted' then
    raise exception 'SMOKE_RESULT FAIL customer after activate=%', v_status;
  end if;
  if exists (
    select 1 from public.dealer_signup_applications
    where id = v_app and (slip_token_hash is not null or slip_token_expires_at is not null)
  ) then
    raise exception 'SMOKE_RESULT FAIL activate did not clear the slip token';
  end if;

  v_result := public.dealer_signup_activate(v_app, v_app || '/slip-second.pdf');
  if not (v_result->>'already_submitted')::boolean then
    raise exception 'SMOKE_RESULT FAIL second activate is not idempotent';
  end if;

  v_result := public.dealer_signup_confirm_payment(v_app, v_reviewer);
  if v_result->>'status' <> 'active' or (v_result->>'already_active')::boolean then
    raise exception 'SMOKE_RESULT FAIL first confirm=%', v_result;
  end if;
  select dealer_onboarding_status into v_status
  from public.mini_crm_customers where id = v_customer;
  if v_status <> 'active' then
    raise exception 'SMOKE_RESULT FAIL customer after confirm=%', v_status;
  end if;
  if not exists (
    select 1 from public.dealer_signup_applications
    where id = v_app
      and status = 'active'
      and payment_confirmed_by = v_reviewer
      and payment_confirmed_at is not null
  ) then
    raise exception 'SMOKE_RESULT FAIL confirm did not record reviewer/time';
  end if;

  v_result := public.dealer_signup_confirm_payment(v_app, v_reviewer);
  if not (v_result->>'already_active')::boolean then
    raise exception 'SMOKE_RESULT FAIL second confirm is not idempotent';
  end if;

  -- -------------------------------------------------------------------------
  -- Fixture B: activate -> reject slip -> back to waiting_slip with new link.
  -- -------------------------------------------------------------------------
  insert into public.mini_crm_customers (
    customer_name, customer_group, product_group, is_active, order_locked,
    dealer_onboarding_status
  ) values (
    'SMOKE Đại lý thanh toán B', 'banhmi_agency', 'banhmi', true, false,
    'waiting_slip'
  ) returning id into v_customer_b;

  insert into public.dealer_signup_applications (
    application_code, status, applicant_name, cccd, cccd_valid_until, phone,
    email, business_name, address_text, lat, lng, idempotency_key,
    crm_customer_id
  ) values (
    'DLM-20261104-' || upper(substr(md5(random()::text), 1, 4)),
    'approved_waiting_slip',
    'SMOKE Nguyễn Văn B',
    '079123456780',
    '2035-06-30',
    '0909123457',
    'smoke-payment-b@bmq.invalid',
    'SMOKE Đại lý thanh toán B',
    '13 Lê Lợi, Quận 1, TP.HCM',
    10.7769,
    106.7009,
    'smoke-payment-b-' || gen_random_uuid(),
    v_customer_b
  ) returning id into v_app_b;

  perform public.dealer_signup_activate(v_app_b, v_app_b || '/slip-b.pdf');

  v_result := public.dealer_signup_reject_slip(
    v_app_b, v_reviewer, v_reason, v_hash, v_expires
  );
  if v_result->>'status' <> 'approved_waiting_slip' then
    raise exception 'SMOKE_RESULT FAIL reject_slip status=%', v_result->>'status';
  end if;
  select dealer_onboarding_status into v_status
  from public.mini_crm_customers where id = v_customer_b;
  if v_status <> 'waiting_slip' then
    raise exception 'SMOKE_RESULT FAIL customer after reject_slip=%', v_status;
  end if;
  if not exists (
    select 1 from public.dealer_signup_applications
    where id = v_app_b
      and status = 'approved_waiting_slip'
      and slip_reject_reason = v_reason
      and slip_token_hash = v_hash
      and slip_token_expires_at = v_expires
      and payment_confirmed_at is null
  ) then
    raise exception 'SMOKE_RESULT FAIL reject_slip did not store reason/token';
  end if;

  begin
    perform public.dealer_signup_reject_slip(
      v_app_b, v_reviewer, v_reason, v_hash, v_expires
    );
    raise exception 'SMOKE_RESULT FAIL reject_slip accepted a waiting application';
  exception when others then
    if sqlerrm not like '%application_not_slip_submitted%' then
      raise;
    end if;
  end;

  -- -------------------------------------------------------------------------
  -- Wrong status: confirm only works from slip_submitted.
  -- -------------------------------------------------------------------------
  insert into public.dealer_signup_applications (
    application_code, status, applicant_name, cccd, cccd_valid_until, phone,
    email, business_name, address_text, lat, lng, idempotency_key
  ) values (
    'DLM-20261104-' || upper(substr(md5(random()::text), 1, 4)),
    'manual_review',
    'SMOKE Nguyễn Văn C',
    '079123456781',
    '2035-06-30',
    '0909123458',
    'smoke-payment-c@bmq.invalid',
    'SMOKE Đại lý thanh toán C',
    '14 Lê Lợi, Quận 1, TP.HCM',
    10.7769,
    106.7009,
    'smoke-payment-c-' || gen_random_uuid()
  ) returning id into v_app_c;

  begin
    perform public.dealer_signup_confirm_payment(v_app_c, v_reviewer);
    raise exception 'SMOKE_RESULT FAIL confirm accepted a manual_review application';
  exception when others then
    if sqlerrm not like '%application_not_slip_submitted%' then
      raise;
    end if;
  end;

  -- -------------------------------------------------------------------------
  -- Permissions: no anon/authenticated EXECUTE on any new RPC.
  -- -------------------------------------------------------------------------
  if has_function_privilege('anon', 'public.dealer_signup_activate(uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.dealer_signup_activate(uuid,text)', 'EXECUTE') then
    raise exception 'SMOKE_RESULT FAIL activate granted to anon/authenticated';
  end if;
  if has_function_privilege('anon', 'public.dealer_signup_confirm_payment(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.dealer_signup_confirm_payment(uuid,uuid)', 'EXECUTE') then
    raise exception 'SMOKE_RESULT FAIL confirm_payment granted to anon/authenticated';
  end if;
  if has_function_privilege('anon', 'public.dealer_signup_reject_slip(uuid,uuid,text,text,timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.dealer_signup_reject_slip(uuid,uuid,text,text,timestamptz)', 'EXECUTE') then
    raise exception 'SMOKE_RESULT FAIL reject_slip granted to anon/authenticated';
  end if;
  if has_function_privilege('anon', 'public.dealer_signup_consume_verification_token(text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.dealer_signup_consume_verification_token(text,text,text)', 'EXECUTE') then
    raise exception 'SMOKE_RESULT FAIL consume token granted to anon/authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.dealer_signup_confirm_payment(uuid,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.dealer_signup_reject_slip(uuid,uuid,text,text,timestamptz)', 'EXECUTE') then
    raise exception 'SMOKE_RESULT FAIL service_role missing EXECUTE';
  end if;

  -- Verification tables: RLS on and no policies at all.
  if not exists (
    select 1 from pg_class
    where oid = 'public.dealer_signup_verifications'::regclass and relrowsecurity
  ) or exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'dealer_signup_verifications'
  ) then
    raise exception 'SMOKE_RESULT FAIL dealer_signup_verifications RLS/policies';
  end if;
  if not exists (
    select 1 from pg_class
    where oid = 'public.dealer_signup_verification_tokens'::regclass and relrowsecurity
  ) or exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'dealer_signup_verification_tokens'
  ) then
    raise exception 'SMOKE_RESULT FAIL verification tokens RLS/policies';
  end if;
  if has_table_privilege('anon', 'public.dealer_signup_verifications', 'SELECT')
     or has_table_privilege('authenticated', 'public.dealer_signup_verification_tokens', 'SELECT') then
    raise exception 'SMOKE_RESULT FAIL verification tables readable by anon/authenticated';
  end if;

  -- Deliberately abort: the caller's transaction must roll back every fixture.
  raise exception 'SMOKE_RESULT ROLLBACK dealer_signup_payment_verify_smoke_ok';
end;
$$;
