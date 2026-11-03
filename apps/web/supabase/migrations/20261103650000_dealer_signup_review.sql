-- 2026-11-03 — Duyệt hồ sơ đăng ký đại lý mới: trạng thái onboarding, hợp đồng
-- PDF, bank slip và các RPC chỉ service_role được gọi.
--
-- Additive only. Không sửa migration cũ, không đổi dữ liệu khách hiện hữu:
--   * mini_crm_customers.dealer_onboarding_status mặc định NULL (khách cũ giữ
--     nguyên hành vi đặt hàng);
--   * dealer_signup_applications có thêm trạng thái duyệt và cột lưu hợp đồng /
--     bank slip;
--   * bucket riêng tư dealer-signup-docs (chỉ service_role ghi; đọc bằng signed
--     URL ngắn hạn do Edge Function tạo).
--
-- Luồng tạo khách dùng nhóm mặc định của Mini CRM hiện tại:
--   customer_group = 'banhmi_agency' (Đại lý), product_group = 'banhmi'.

-- ===========================================================================
-- A. mini_crm_customers.dealer_onboarding_status
-- ===========================================================================
alter table public.mini_crm_customers
  add column if not exists dealer_onboarding_status text;

alter table public.mini_crm_customers
  drop constraint if exists mini_crm_customers_dealer_onboarding_status_check;
alter table public.mini_crm_customers
  add constraint mini_crm_customers_dealer_onboarding_status_check
  check (
    dealer_onboarding_status is null
    or dealer_onboarding_status in ('waiting_slip', 'active')
  );

comment on column public.mini_crm_customers.dealer_onboarding_status is
  'Đại lý mới: waiting_slip = đã duyệt, chờ bank slip (bị chặn đặt bánh); active = đã có bank slip, đặt bánh bình thường; NULL = khách cũ / khách thường, giữ nguyên hành vi.';

create index if not exists idx_mini_crm_customers_dealer_onboarding_status
  on public.mini_crm_customers (dealer_onboarding_status)
  where dealer_onboarding_status is not null;

-- ===========================================================================
-- B. dealer_signup_applications: trạng thái duyệt + giấy tờ
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
    'active',
    'rejected_manual'
  ));

alter table public.dealer_signup_applications
  add column if not exists approval_mode text,
  add column if not exists reviewed_by uuid,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reject_reason text,
  add column if not exists crm_customer_id uuid,
  add column if not exists contract_draft_path text,
  add column if not exists contract_generated_at timestamptz,
  add column if not exists contract_signed_path text,
  add column if not exists contract_signed_uploaded_at timestamptz,
  add column if not exists contract_signed_uploaded_by uuid,
  add column if not exists slip_token_hash text,
  add column if not exists slip_token_expires_at timestamptz,
  add column if not exists slip_storage_path text,
  add column if not exists slip_uploaded_at timestamptz;

alter table public.dealer_signup_applications
  drop constraint if exists dealer_signup_applications_approval_mode_check;
alter table public.dealer_signup_applications
  add constraint dealer_signup_applications_approval_mode_check
  check (approval_mode is null or approval_mode in ('auto', 'manual'));

alter table public.dealer_signup_applications
  drop constraint if exists dealer_signup_applications_reject_reason_check;
alter table public.dealer_signup_applications
  add constraint dealer_signup_applications_reject_reason_check
  check (reject_reason is null or char_length(reject_reason) between 1 and 500);

-- crm_customer_id: unique + FK set null. Added through DO blocks so the
-- migration stays safe when replayed on a database that already has them.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'dealer_signup_applications_crm_customer_id_fkey'
      and conrelid = 'public.dealer_signup_applications'::regclass
  ) then
    alter table public.dealer_signup_applications
      add constraint dealer_signup_applications_crm_customer_id_fkey
      foreign key (crm_customer_id)
      references public.mini_crm_customers(id)
      on delete set null;
  end if;
end;
$$;

create unique index if not exists dealer_signup_applications_crm_customer_id_key
  on public.dealer_signup_applications (crm_customer_id)
  where crm_customer_id is not null;

create unique index if not exists dealer_signup_applications_slip_token_hash_key
  on public.dealer_signup_applications (slip_token_hash)
  where slip_token_hash is not null;

create index if not exists idx_dealer_signup_applications_crm_customer
  on public.dealer_signup_applications (crm_customer_id);

comment on column public.dealer_signup_applications.approval_mode is
  'auto = hồ sơ eligible được duyệt tự động; manual = nhân sự CRM duyệt tay.';
comment on column public.dealer_signup_applications.reviewed_by is
  'auth.users.id của người duyệt/từ chối; NULL cho duyệt tự động.';
comment on column public.dealer_signup_applications.crm_customer_id is
  'Khách Mini CRM được tạo đúng một lần khi hồ sơ được duyệt.';
comment on column public.dealer_signup_applications.contract_draft_path is
  'Đường dẫn PDF hợp đồng trong bucket dealer-signup-docs để kế toán tải/đóng dấu.';
comment on column public.dealer_signup_applications.contract_signed_path is
  'Đường dẫn PDF/ảnh hợp đồng đã đóng dấu do kế toán upload lại.';
comment on column public.dealer_signup_applications.slip_token_hash is
  'SHA-256 của token link bank slip; token gốc chỉ nằm trong thư gửi khách.';
comment on column public.dealer_signup_applications.slip_storage_path is
  'Đường dẫn bank slip khách đã upload trong bucket dealer-signup-docs.';

-- ===========================================================================
-- C. Bucket riêng tư dealer-signup-docs
-- ===========================================================================
-- public = false: không có URL công khai. Không tạo policy cho anon /
-- authenticated; service_role bỏ qua RLS và là bên duy nhất đọc/ghi. Edge
-- Function tạo signed URL 5 phút khi người có quyền tải giấy tờ.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'dealer-signup-docs',
  'dealer-signup-docs',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ===========================================================================
-- D. Rate limit cho upload bank slip
-- ===========================================================================
alter table public.dealer_signup_rate_limits
  drop constraint if exists dealer_signup_rate_limits_action_check;
alter table public.dealer_signup_rate_limits
  add constraint dealer_signup_rate_limits_action_check
  check (action in ('check', 'submit', 'slip'));

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

  if p_action is null or p_action not in ('check', 'submit', 'slip') then
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
-- E. Duyệt hồ sơ (một khách CRM đúng một lần)
-- ===========================================================================
create or replace function public.dealer_signup_approve(
  p_application_id uuid,
  p_reviewer uuid,
  p_mode text,
  p_customer_group text default null,
  p_product_group text default null,
  p_slip_token_hash text default null,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app public.dealer_signup_applications%rowtype;
  v_phone text;
  v_conflict_name text;
  v_customer_id uuid;
  v_customer_group text := coalesce(nullif(btrim(coalesce(p_customer_group, '')), ''), 'banhmi_agency');
  v_product_group text := coalesce(nullif(btrim(coalesce(p_product_group, '')), ''), 'banhmi');
  v_status text;
begin
  if p_application_id is null then
    raise exception 'application_id_required' using errcode = '22023';
  end if;

  if p_mode is null or p_mode not in ('auto', 'manual') then
    raise exception 'invalid_approval_mode' using errcode = '22023';
  end if;

  select * into v_app
  from public.dealer_signup_applications
  where id = p_application_id
  for update;

  if not found then
    raise exception 'application_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent: a retried approval returns the existing result and never
  -- creates a second customer / contact.
  if v_app.crm_customer_id is not null
     or v_app.status in ('approved_waiting_slip', 'active') then
    return jsonb_build_object(
      'application_id', v_app.id,
      'application_code', v_app.application_code,
      'status', v_app.status,
      'crm_customer_id', v_app.crm_customer_id,
      'already_approved', true
    );
  end if;

  if v_app.status not in ('manual_review', 'contract_sent', 'email_failed') then
    raise exception 'application_not_approvable' using errcode = '22023';
  end if;

  -- Normalise the registered phone to the dealer contact format 84xxxxxxxxx.
  v_phone := regexp_replace(coalesce(v_app.phone, ''), '[^0-9+]', '', 'g');
  if v_phone like '+84%' then
    v_phone := '84' || substr(v_phone, 4);
  elsif v_phone like '0084%' then
    v_phone := substr(v_phone, 3);
  elsif v_phone like '0%' then
    v_phone := '84' || substr(v_phone, 2);
  end if;

  if v_phone !~ '^84(3|5|7|8|9)[0-9]{8}$' then
    raise exception 'invalid_application_phone' using errcode = '22023';
  end if;

  select c.customer_name
    into v_conflict_name
  from public.dealer_customer_contacts d
  join public.mini_crm_customers c on c.id = d.customer_id
  where d.phone_normalized = v_phone
    and d.is_active = true
  limit 1;

  if v_conflict_name is not null then
    raise exception using
      errcode = '23505',
      message = format(
        'SĐT %s đang được dùng cho khách hàng %s. Vui lòng xoá/ngưng hoạt động số đó ở khách hàng cũ trước khi duyệt.',
        v_app.phone,
        v_conflict_name
      );
  end if;

  insert into public.mini_crm_customers (
    customer_name,
    customer_group,
    product_group,
    debt_emails,
    is_active,
    order_locked,
    dealer_onboarding_status,
    location_lat,
    location_lng,
    location_source
  ) values (
    v_app.business_name,
    v_customer_group,
    v_product_group,
    array[v_app.email],
    true,
    false,
    'waiting_slip',
    v_app.lat,
    v_app.lng,
    'dealer_signup'
  )
  returning id into v_customer_id;

  begin
    insert into public.dealer_customer_contacts (
      customer_id,
      contact_name,
      phone_raw,
      phone_normalized,
      is_primary,
      is_active
    ) values (
      v_customer_id,
      v_app.applicant_name,
      v_app.phone,
      v_phone,
      true,
      true
    );
  exception when unique_violation then
    select c.customer_name
      into v_conflict_name
    from public.dealer_customer_contacts d
    join public.mini_crm_customers c on c.id = d.customer_id
    where d.phone_normalized = v_phone
      and d.is_active = true
    limit 1;

    raise exception using
      errcode = '23505',
      message = format(
        'SĐT %s đang được dùng cho khách hàng %s. Vui lòng xoá/ngưng hoạt động số đó ở khách hàng cũ trước khi duyệt.',
        v_app.phone,
        coalesce(v_conflict_name, 'khác')
      );
  end;

  update public.dealer_signup_applications
  set status = 'approved_waiting_slip',
      approval_mode = p_mode,
      reviewed_by = p_reviewer,
      reviewed_at = now(),
      reject_reason = null,
      crm_customer_id = v_customer_id,
      slip_token_hash = coalesce(p_slip_token_hash, slip_token_hash),
      slip_token_expires_at = coalesce(p_expires_at, slip_token_expires_at),
      last_error_code = null
  where id = p_application_id
  returning status into v_status;

  return jsonb_build_object(
    'application_id', p_application_id,
    'application_code', v_app.application_code,
    'status', v_status,
    'crm_customer_id', v_customer_id,
    'already_approved', false
  );
end;
$$;

revoke all on function public.dealer_signup_approve(uuid, uuid, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.dealer_signup_approve(uuid, uuid, text, text, text, text, timestamptz)
  to service_role;

comment on function public.dealer_signup_approve(uuid, uuid, text, text, text, text, timestamptz) is
  'Service-role RPC: duyệt hồ sơ đại lý đúng một lần, tạo Mini CRM customer waiting_slip + contact SĐT, trả kết quả cũ nếu đã duyệt.';

-- ===========================================================================
-- F. Hợp đồng PDF + hợp đồng đã đóng dấu
-- ===========================================================================
create or replace function public.dealer_signup_set_contract_draft(
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

  if v_app.status not in ('approved_waiting_slip', 'active') then
    raise exception 'application_not_approved' using errcode = '22023';
  end if;

  update public.dealer_signup_applications
  set contract_draft_path = p_storage_path,
      contract_generated_at = now()
  where id = p_application_id;

  return jsonb_build_object(
    'application_id', p_application_id,
    'contract_draft_path', p_storage_path,
    'status', v_app.status
  );
end;
$$;

revoke all on function public.dealer_signup_set_contract_draft(uuid, text)
  from public, anon, authenticated;
grant execute on function public.dealer_signup_set_contract_draft(uuid, text)
  to service_role;

create or replace function public.dealer_signup_set_signed_contract(
  p_application_id uuid,
  p_storage_path text,
  p_uploaded_by uuid default null
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

  if v_app.status not in ('approved_waiting_slip', 'active') then
    raise exception 'application_not_approved' using errcode = '22023';
  end if;

  update public.dealer_signup_applications
  set contract_signed_path = p_storage_path,
      contract_signed_uploaded_at = now(),
      contract_signed_uploaded_by = p_uploaded_by
  where id = p_application_id;

  return jsonb_build_object(
    'application_id', p_application_id,
    'contract_signed_path', p_storage_path,
    'status', v_app.status
  );
end;
$$;

revoke all on function public.dealer_signup_set_signed_contract(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.dealer_signup_set_signed_contract(uuid, text, uuid)
  to service_role;

-- ===========================================================================
-- G. Từ chối thủ công
-- ===========================================================================
create or replace function public.dealer_signup_reject(
  p_application_id uuid,
  p_reviewer uuid,
  p_reason text
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
    raise exception 'reject_reason_required' using errcode = '22023';
  end if;

  if char_length(v_reason) > 500 then
    raise exception 'reject_reason_too_long' using errcode = '22023';
  end if;

  select * into v_app
  from public.dealer_signup_applications
  where id = p_application_id
  for update;

  if not found then
    raise exception 'application_not_found' using errcode = 'P0002';
  end if;

  if v_app.status not in ('manual_review', 'contract_sent', 'email_failed') then
    raise exception 'application_not_rejectable' using errcode = '22023';
  end if;

  update public.dealer_signup_applications
  set status = 'rejected_manual',
      reject_reason = v_reason,
      reviewed_by = p_reviewer,
      reviewed_at = now(),
      slip_token_hash = null,
      slip_token_expires_at = null
  where id = p_application_id;

  return jsonb_build_object(
    'application_id', p_application_id,
    'application_code', v_app.application_code,
    'status', 'rejected_manual',
    'reject_reason', v_reason
  );
end;
$$;

revoke all on function public.dealer_signup_reject(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.dealer_signup_reject(uuid, uuid, text)
  to service_role;

-- ===========================================================================
-- H. Kích hoạt sau bank slip (không phụ thuộc hợp đồng đóng dấu)
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

  -- Idempotent: a retried upload after activation returns the old result.
  if v_app.status = 'active' then
    return jsonb_build_object(
      'application_id', v_app.id,
      'application_code', v_app.application_code,
      'status', v_app.status,
      'crm_customer_id', v_app.crm_customer_id,
      'slip_storage_path', v_app.slip_storage_path,
      'already_active', true
    );
  end if;

  if v_app.status <> 'approved_waiting_slip' then
    raise exception 'application_not_awaiting_slip' using errcode = '22023';
  end if;

  if v_app.crm_customer_id is null then
    raise exception 'application_customer_missing' using errcode = '22023';
  end if;

  update public.mini_crm_customers
  set dealer_onboarding_status = 'active'
  where id = v_app.crm_customer_id;

  update public.dealer_signup_applications
  set status = 'active',
      slip_storage_path = p_storage_path,
      slip_uploaded_at = now(),
      slip_token_hash = null,
      slip_token_expires_at = null,
      last_error_code = null
  where id = p_application_id;

  return jsonb_build_object(
    'application_id', p_application_id,
    'application_code', v_app.application_code,
    'status', 'active',
    'crm_customer_id', v_app.crm_customer_id,
    'slip_storage_path', p_storage_path,
    'already_active', false
  );
end;
$$;

revoke all on function public.dealer_signup_activate(uuid, text)
  from public, anon, authenticated;
grant execute on function public.dealer_signup_activate(uuid, text)
  to service_role;

comment on function public.dealer_signup_activate(uuid, text) is
  'Service-role RPC: lưu bank slip, chuyển customer sang dealer_onboarding_status=active, xoá token và trả kết quả cũ nếu đã active.';
