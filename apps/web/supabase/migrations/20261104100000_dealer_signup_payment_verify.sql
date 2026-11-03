-- 2026-11-04 — Đại lý mới: kế toán xác nhận tiền chuyển khoản + xác minh SĐT/email
-- khi đăng ký.
--
-- Additive only. Không sửa migration cũ, không đổi dữ liệu khách hiện hữu:
--   * hồ sơ có thêm trạng thái slip_submitted (đã upload bank slip, chờ kế toán
--     xác nhận tiền) và khách có dealer_onboarding_status tương ứng;
--   * cột xác nhận thanh toán, lý do từ chối bank slip và mốc xác minh SĐT/email;
--   * bảng dealer_signup_verifications (OTP băm) + bảng token xác minh (băm);
--   * rate limit thêm action verify_send / verify_check;
--   * RPC kích hoạt mới (activate -> slip_submitted), xác nhận thanh toán,
--     từ chối bank slip và tiêu thụ token xác minh. Tất cả chỉ service_role.

-- ===========================================================================
-- A. Trạng thái onboarding của khách
-- ===========================================================================
alter table public.mini_crm_customers
  drop constraint if exists mini_crm_customers_dealer_onboarding_status_check;
alter table public.mini_crm_customers
  add constraint mini_crm_customers_dealer_onboarding_status_check
  check (
    dealer_onboarding_status is null
    or dealer_onboarding_status in ('waiting_slip', 'slip_submitted', 'active')
  );

comment on column public.mini_crm_customers.dealer_onboarding_status is
  'Đại lý mới: waiting_slip = đã duyệt, chờ bank slip; slip_submitted = đã upload bank slip, chờ kế toán xác nhận tiền (bị chặn đặt bánh); active = đã xác nhận tiền, đặt bánh bình thường; NULL = khách cũ / khách thường, giữ nguyên hành vi.';

-- ===========================================================================
-- B. Hồ sơ: trạng thái slip_submitted + cột thanh toán/xác minh
-- ===========================================================================
alter table public.dealer_signup_applications
  drop constraint if exists dealer_signup_applications_status_check;
alter table public.dealer_signup_applications
  add constraint dealer_signup_applications_status_check
  check (status in (
    'rejected_too_close',
    'manual_review',
    'contract_sent',
    'email_failed',
    'approved_waiting_slip',
    'slip_submitted',
    'active',
    'rejected_manual'
  ));

alter table public.dealer_signup_applications
  add column if not exists payment_confirmed_by uuid,
  add column if not exists payment_confirmed_at timestamptz,
  add column if not exists slip_reject_reason text,
  add column if not exists phone_verified_at timestamptz,
  add column if not exists email_verified_at timestamptz;

alter table public.dealer_signup_applications
  drop constraint if exists dealer_signup_applications_slip_reject_reason_check;
alter table public.dealer_signup_applications
  add constraint dealer_signup_applications_slip_reject_reason_check
  check (
    slip_reject_reason is null
    or char_length(slip_reject_reason) between 1 and 500
  );

comment on column public.dealer_signup_applications.payment_confirmed_by is
  'auth.users.id của owner/kế toán đã xác nhận tiền chuyển khoản.';
comment on column public.dealer_signup_applications.payment_confirmed_at is
  'Thời điểm kế toán xác nhận tiền chuyển khoản.';
comment on column public.dealer_signup_applications.slip_reject_reason is
  'Lý do kế toán từ chối bank slip (1–500 ký tự).';
comment on column public.dealer_signup_applications.phone_verified_at is
  'Thời điểm SĐT đăng ký được xác minh bằng OTP; chỉ service_role ghi.';
comment on column public.dealer_signup_applications.email_verified_at is
  'Thời điểm email đăng ký được xác minh bằng mã; chỉ service_role ghi.';

create index if not exists idx_dealer_signup_applications_payment_confirmed_at
  on public.dealer_signup_applications (payment_confirmed_at)
  where payment_confirmed_at is not null;

-- ===========================================================================
-- C. Bảng OTP xác minh SĐT/email (chỉ lưu mã băm)
-- ===========================================================================
create table if not exists public.dealer_signup_verifications (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  channel text not null check (channel in ('phone', 'email')),
  target_normalized text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  verified_at timestamptz,
  consumed_at timestamptz,
  ip_hash text not null,
  created_at timestamptz not null default now(),
  unique (session_id, channel)
);

create index if not exists idx_dealer_signup_verifications_expires_at
  on public.dealer_signup_verifications (expires_at);

alter table public.dealer_signup_verifications enable row level security;

-- No policy for anon/authenticated: only service_role (Edge Function) touches
-- this table. Raw OTP codes are never stored.
revoke all on table public.dealer_signup_verifications from public, anon, authenticated;
grant select, insert, update, delete on table public.dealer_signup_verifications to service_role;

comment on table public.dealer_signup_verifications is
  'OTP 6 số đã băm cho xác minh SĐT/email đăng ký đại lý; hết hạn 10 phút, tối đa 5 lần sai. Chỉ service_role.';

-- ===========================================================================
-- D. Token xác minh dùng một lần (chỉ lưu băm)
-- ===========================================================================
create table if not exists public.dealer_signup_verification_tokens (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  token_hash text not null unique,
  phone_normalized text not null,
  email_normalized text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_dealer_signup_verification_tokens_session
  on public.dealer_signup_verification_tokens (session_id);

alter table public.dealer_signup_verification_tokens enable row level security;

revoke all on table public.dealer_signup_verification_tokens from public, anon, authenticated;
grant select, insert, update, delete on table public.dealer_signup_verification_tokens to service_role;

comment on table public.dealer_signup_verification_tokens is
  'Token xác minh SĐT+email dùng một lần, hạn 30 phút, chỉ lưu SHA-256; gắn đúng SĐT 84... và email chữ thường. Chỉ service_role.';

-- ===========================================================================
-- E. Rate limit thêm action verify_send / verify_check
-- ===========================================================================
alter table public.dealer_signup_rate_limits
  drop constraint if exists dealer_signup_rate_limits_action_check;
alter table public.dealer_signup_rate_limits
  add constraint dealer_signup_rate_limits_action_check
  check (action in ('check', 'submit', 'slip', 'verify_send', 'verify_check'));

create or replace function public.dealer_signup_record_rate_limit(
  p_ip_hash text,
  p_action text,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window_start timestamptz := date_trunc('hour', now());
  v_count integer;
  v_retry_after integer;
begin
  if p_ip_hash is null or length(btrim(p_ip_hash)) < 16 then
    raise exception 'ip_hash_required' using errcode = '22023';
  end if;

  if p_action is null or p_action not in ('check', 'submit', 'slip', 'verify_send', 'verify_check') then
    raise exception 'invalid_rate_limit_action' using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 then
    raise exception 'invalid_rate_limit' using errcode = '22023';
  end if;

  delete from public.dealer_signup_rate_limits
  where window_start < now() - interval '2 days';

  insert into public.dealer_signup_rate_limits (ip_hash, action, window_start, request_count)
  values (btrim(p_ip_hash), p_action, v_window_start, 1)
  on conflict (ip_hash, action, window_start)
  do update set request_count = dealer_signup_rate_limits.request_count + 1
  returning request_count into v_count;

  v_retry_after := case
    when v_count > p_limit then greatest(
      1,
      ceil(extract(epoch from (v_window_start + interval '1 hour' - now())))::integer
    )
    else 0
  end;

  return jsonb_build_object(
    'allowed', v_count <= p_limit,
    'remaining', greatest(0, p_limit - v_count),
    'retry_after_seconds', v_retry_after,
    'window_start', v_window_start
  );
end;
$$;

revoke all on function public.dealer_signup_record_rate_limit(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.dealer_signup_record_rate_limit(text, text, integer)
  to service_role;

-- ===========================================================================
-- F. Kích hoạt sau bank slip: approved_waiting_slip -> slip_submitted
-- ===========================================================================
create or replace function public.dealer_signup_activate(
  p_application_id uuid,
  p_storage_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app public.dealer_signup_applications%rowtype;
begin
  if nullif(btrim(coalesce(p_storage_path, '')), '') is null then
    raise exception 'storage_path_required' using errcode = '22023';
  end if;

  select * into v_app
  from public.dealer_signup_applications
  where id = p_application_id
  for update;

  if not found then
    raise exception 'application_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent: a retried upload after the slip was stored returns the same
  -- slip_submitted result and never clears the token a second time.
  if v_app.status = 'slip_submitted' then
    return jsonb_build_object(
      'application_id', v_app.id,
      'application_code', v_app.application_code,
      'status', v_app.status,
      'crm_customer_id', v_app.crm_customer_id,
      'slip_storage_path', coalesce(v_app.slip_storage_path, p_storage_path),
      'already_active', false,
      'already_submitted', true
    );
  end if;

  if v_app.status = 'active' then
    return jsonb_build_object(
      'application_id', v_app.id,
      'application_code', v_app.application_code,
      'status', v_app.status,
      'crm_customer_id', v_app.crm_customer_id,
      'slip_storage_path', v_app.slip_storage_path,
      'already_active', true,
      'already_submitted', false
    );
  end if;

  if v_app.status <> 'approved_waiting_slip' then
    raise exception 'application_not_awaiting_slip' using errcode = '22023';
  end if;

  if v_app.crm_customer_id is null then
    raise exception 'application_customer_missing' using errcode = '22023';
  end if;

  update public.mini_crm_customers
  set dealer_onboarding_status = 'slip_submitted'
  where id = v_app.crm_customer_id;

  update public.dealer_signup_applications
  set status = 'slip_submitted',
      slip_storage_path = p_storage_path,
      slip_uploaded_at = now(),
      slip_token_hash = null,
      slip_token_expires_at = null,
      slip_reject_reason = null,
      last_error_code = null
  where id = p_application_id;

  return jsonb_build_object(
    'application_id', p_application_id,
    'application_code', v_app.application_code,
    'status', 'slip_submitted',
    'crm_customer_id', v_app.crm_customer_id,
    'slip_storage_path', p_storage_path,
    'already_active', false,
    'already_submitted', false
  );
end;
$$;

revoke all on function public.dealer_signup_activate(uuid, text)
  from public, anon, authenticated;
grant execute on function public.dealer_signup_activate(uuid, text)
  to service_role;

comment on function public.dealer_signup_activate(uuid, text) is
  'Service-role RPC: lưu bank slip, chuyển hồ sơ và khách sang slip_submitted, xoá token; trả kết quả cũ nếu đã gửi/đã active.';

-- ===========================================================================
-- G. Kế toán xác nhận tiền: slip_submitted -> active
-- ===========================================================================
create or replace function public.dealer_signup_confirm_payment(
  p_application_id uuid,
  p_reviewer uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app public.dealer_signup_applications%rowtype;
  v_confirmed_at timestamptz;
begin
  if p_reviewer is null then
    raise exception 'reviewer_required' using errcode = '22023';
  end if;

  select * into v_app
  from public.dealer_signup_applications
  where id = p_application_id
  for update;

  if not found then
    raise exception 'application_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent: a repeated click returns the existing active result.
  if v_app.status = 'active' then
    return jsonb_build_object(
      'application_id', v_app.id,
      'application_code', v_app.application_code,
      'status', v_app.status,
      'crm_customer_id', v_app.crm_customer_id,
      'already_active', true,
      'payment_confirmed_at', v_app.payment_confirmed_at
    );
  end if;

  if v_app.status <> 'slip_submitted' then
    raise exception 'application_not_slip_submitted' using errcode = '22023';
  end if;

  if v_app.crm_customer_id is null then
    raise exception 'application_customer_missing' using errcode = '22023';
  end if;

  update public.mini_crm_customers
  set dealer_onboarding_status = 'active'
  where id = v_app.crm_customer_id;

  update public.dealer_signup_applications
  set status = 'active',
      payment_confirmed_by = p_reviewer,
      payment_confirmed_at = now(),
      slip_reject_reason = null,
      last_error_code = null
  where id = p_application_id
  returning payment_confirmed_at into v_confirmed_at;

  return jsonb_build_object(
    'application_id', p_application_id,
    'application_code', v_app.application_code,
    'status', 'active',
    'crm_customer_id', v_app.crm_customer_id,
    'already_active', false,
    'payment_confirmed_at', v_confirmed_at
  );
end;
$$;

revoke all on function public.dealer_signup_confirm_payment(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.dealer_signup_confirm_payment(uuid, uuid)
  to service_role;

comment on function public.dealer_signup_confirm_payment(uuid, uuid) is
  'Service-role RPC: owner/kế toán xác nhận tiền, chuyển hồ sơ và khách slip_submitted -> active; idempotent khi đã active.';

-- ===========================================================================
-- H. Từ chối bank slip: slip_submitted -> approved_waiting_slip + link mới
-- ===========================================================================
create or replace function public.dealer_signup_reject_slip(
  p_application_id uuid,
  p_reviewer uuid,
  p_reason text,
  p_new_token_hash text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app public.dealer_signup_applications%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_reason is null then
    raise exception 'slip_reject_reason_required' using errcode = '22023';
  end if;

  if char_length(v_reason) > 500 then
    raise exception 'slip_reject_reason_too_long' using errcode = '22023';
  end if;

  if p_reviewer is null then
    raise exception 'reviewer_required' using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_new_token_hash, '')), '') is null then
    raise exception 'slip_token_hash_required' using errcode = '22023';
  end if;

  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'slip_token_expiry_invalid' using errcode = '22023';
  end if;

  select * into v_app
  from public.dealer_signup_applications
  where id = p_application_id
  for update;

  if not found then
    raise exception 'application_not_found' using errcode = 'P0002';
  end if;

  if v_app.status <> 'slip_submitted' then
    raise exception 'application_not_slip_submitted' using errcode = '22023';
  end if;

  if v_app.crm_customer_id is null then
    raise exception 'application_customer_missing' using errcode = '22023';
  end if;

  update public.mini_crm_customers
  set dealer_onboarding_status = 'waiting_slip'
  where id = v_app.crm_customer_id;

  update public.dealer_signup_applications
  set status = 'approved_waiting_slip',
      slip_reject_reason = v_reason,
      slip_token_hash = p_new_token_hash,
      slip_token_expires_at = p_expires_at,
      payment_confirmed_by = null,
      payment_confirmed_at = null,
      last_error_code = null
  where id = p_application_id;

  return jsonb_build_object(
    'application_id', p_application_id,
    'application_code', v_app.application_code,
    'status', 'approved_waiting_slip',
    'crm_customer_id', v_app.crm_customer_id,
    'slip_reject_reason', v_reason,
    'slip_expires_at', p_expires_at
  );
end;
$$;

revoke all on function public.dealer_signup_reject_slip(uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.dealer_signup_reject_slip(uuid, uuid, text, text, timestamptz)
  to service_role;

comment on function public.dealer_signup_reject_slip(uuid, uuid, text, text, timestamptz) is
  'Service-role RPC: bắt buộc lý do, từ chối bank slip, đưa hồ sơ về approved_waiting_slip + khách waiting_slip và gắn link mới 14 ngày.';

-- ===========================================================================
-- I. Tiêu thụ token xác minh khi tạo hồ sơ
-- ===========================================================================
create or replace function public.dealer_signup_consume_verification_token(
  p_token_hash text,
  p_phone_normalized text,
  p_email_normalized text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token public.dealer_signup_verification_tokens%rowtype;
  v_phone_at timestamptz;
  v_email_at timestamptz;
begin
  if nullif(btrim(coalesce(p_token_hash, '')), '') is null then
    raise exception 'verification_token_required' using errcode = '22023';
  end if;

  if nullif(btrim(coalesce(p_phone_normalized, '')), '') is null
     or nullif(btrim(coalesce(p_email_normalized, '')), '') is null then
    raise exception 'verification_target_required' using errcode = '22023';
  end if;

  select * into v_token
  from public.dealer_signup_verification_tokens
  where token_hash = p_token_hash
  for update;

  if not found then
    raise exception 'verification_token_invalid' using errcode = 'P0002';
  end if;

  if v_token.consumed_at is not null then
    raise exception 'verification_token_used' using errcode = '22023';
  end if;

  if v_token.expires_at <= now() then
    raise exception 'verification_token_expired' using errcode = '22023';
  end if;

  if v_token.phone_normalized <> btrim(p_phone_normalized)
     or v_token.email_normalized <> lower(btrim(p_email_normalized)) then
    raise exception 'verification_token_mismatch' using errcode = '22023';
  end if;

  select max(verified_at) filter (where channel = 'phone'),
         max(verified_at) filter (where channel = 'email')
    into v_phone_at, v_email_at
  from public.dealer_signup_verifications
  where session_id = v_token.session_id;

  update public.dealer_signup_verification_tokens
  set consumed_at = now()
  where id = v_token.id;

  return jsonb_build_object(
    'phone_verified_at', coalesce(v_phone_at, v_token.created_at),
    'email_verified_at', coalesce(v_email_at, v_token.created_at)
  );
end;
$$;

revoke all on function public.dealer_signup_consume_verification_token(text, text, text)
  from public, anon, authenticated;
grant execute on function public.dealer_signup_consume_verification_token(text, text, text)
  to service_role;

comment on function public.dealer_signup_consume_verification_token(text, text, text) is
  'Service-role RPC: tiêu thụ token xác minh đúng SĐT 84... + email, trả mốc phone_verified_at/email_verified_at cho hồ sơ.';
