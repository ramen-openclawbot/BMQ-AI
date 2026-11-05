-- 2026-11-05 — Địa chỉ bên ký hợp đồng cho hồ sơ đăng ký đại lý mới.
--
-- Additive only. address_text giữ nguyên vai trò địa chỉ bán hàng (khoảng cách
-- 2 km, địa chỉ khách Mini CRM, điều khoản phạm vi 1 km). contract_address_text
-- là địa chỉ pháp lý ghi ở dòng "Địa chỉ:" của Bên B trong hợp đồng.
--
-- Hồ sơ cũ có contract_address_text = NULL và hợp đồng fallback về address_text.
-- Chỉ service_role được ghi cột này, qua RPC dealer_signup_set_contract_address.

-- ===========================================================================
-- A. Cột contract_address_text
-- ===========================================================================
alter table public.dealer_signup_applications
  add column if not exists contract_address_text text;

alter table public.dealer_signup_applications
  drop constraint if exists dealer_signup_applications_contract_address_text_check;
alter table public.dealer_signup_applications
  add constraint dealer_signup_applications_contract_address_text_check
  check (
    contract_address_text is null
    or char_length(contract_address_text) between 5 and 500
  );

comment on column public.dealer_signup_applications.contract_address_text is
  'Địa chỉ bên ký hợp đồng (Bên B), tách biệt với address_text là địa chỉ bán hàng; NULL = hồ sơ cũ, hợp đồng dùng address_text.';

-- ===========================================================================
-- B. RPC sửa địa chỉ bên ký hợp đồng (chỉ service_role)
-- ===========================================================================
create or replace function public.dealer_signup_set_contract_address(
  p_application_id uuid,
  p_contract_address_text text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_app public.dealer_signup_applications%rowtype;
  v_contract_address text := btrim(coalesce(p_contract_address_text, ''));
begin
  if p_application_id is null then
    raise exception 'application_id_required' using errcode = '22023';
  end if;

  if char_length(v_contract_address) < 5 or char_length(v_contract_address) > 500 then
    raise exception 'invalid_contract_address' using errcode = '22023';
  end if;

  select * into v_app
  from public.dealer_signup_applications
  where id = p_application_id
  for update;

  if not found then
    raise exception 'application_not_found' using errcode = 'P0002';
  end if;

  -- Match the rejection statuses actually used by the signup/review migrations.
  if v_app.status in ('rejected_too_close', 'rejected_manual') then
    raise exception 'application_rejected' using errcode = '22023';
  end if;

  update public.dealer_signup_applications
  set contract_address_text = v_contract_address
  where id = p_application_id;
end;
$$;

revoke all on function public.dealer_signup_set_contract_address(uuid, text)
  from public, anon, authenticated;
grant execute on function public.dealer_signup_set_contract_address(uuid, text)
  to service_role;

comment on function public.dealer_signup_set_contract_address(uuid, text) is
  'Service-role RPC: cập nhật địa chỉ bên ký hợp đồng cho hồ sơ chưa bị từ chối; không tự tạo lại PDF.';
