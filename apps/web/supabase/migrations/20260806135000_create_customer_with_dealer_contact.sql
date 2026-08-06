create or replace function public.create_mini_crm_customer_with_dealer_contact(
  p_customer_name text,
  p_customer_group text,
  p_product_group text,
  p_debt_emails text[],
  p_is_npp boolean,
  p_supplied_by_npp_customer_id uuid,
  p_npp_management_fee_vnd numeric,
  p_phone_raw text,
  p_phone_normalized text
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_conflict_customer_id uuid;
  v_conflict_customer_name text;
  v_phone_raw text := nullif(btrim(coalesce(p_phone_raw, '')), '');
  v_phone_normalized text := nullif(btrim(coalesce(p_phone_normalized, '')), '');
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Bạn không có quyền tạo khách hàng';
  end if;

  if nullif(btrim(coalesce(p_customer_name, '')), '') is null then
    raise exception using errcode = '22023', message = 'Vui lòng nhập tên khách hàng';
  end if;

  if (v_phone_raw is null) <> (v_phone_normalized is null) then
    raise exception using errcode = '22023', message = 'SĐT nhận OTP không hợp lệ';
  end if;

  if v_phone_normalized is not null and v_phone_normalized !~ '^84(3|5|7|8|9)[0-9]{8}$' then
    raise exception using errcode = '22023', message = format('SĐT nhận OTP không hợp lệ: %s', v_phone_raw);
  end if;

  if v_phone_normalized is not null then
    select d.customer_id, c.customer_name
      into v_conflict_customer_id, v_conflict_customer_name
    from public.dealer_customer_contacts d
    join public.mini_crm_customers c on c.id = d.customer_id
    where d.phone_normalized = v_phone_normalized
      and d.is_active = true
    limit 1;

    if v_conflict_customer_id is not null then
      raise exception using
        errcode = '23505',
        message = format(
          'SĐT %s đang được dùng cho khách hàng %s. Vui lòng xoá/ngưng hoạt động số đó ở khách hàng cũ trước khi lưu.',
          coalesce(v_phone_raw, v_phone_normalized),
          coalesce(v_conflict_customer_name, v_conflict_customer_id::text)
        );
    end if;
  end if;

  insert into public.mini_crm_customers (
    customer_name,
    customer_group,
    product_group,
    debt_emails,
    is_npp,
    supplied_by_npp_customer_id,
    npp_management_fee_vnd
  ) values (
    btrim(p_customer_name),
    p_customer_group,
    p_product_group,
    coalesce(p_debt_emails, '{}'::text[]),
    coalesce(p_is_npp, false),
    case when coalesce(p_is_npp, false) then null else p_supplied_by_npp_customer_id end,
    coalesce(p_npp_management_fee_vnd, 0)
  )
  returning id into v_customer_id;

  if v_phone_normalized is not null then
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
        btrim(p_customer_name),
        v_phone_raw,
        v_phone_normalized,
        true,
        true
      );
    exception when unique_violation then
      select d.customer_id, c.customer_name
        into v_conflict_customer_id, v_conflict_customer_name
      from public.dealer_customer_contacts d
      join public.mini_crm_customers c on c.id = d.customer_id
      where d.phone_normalized = v_phone_normalized
        and d.is_active = true
      limit 1;

      raise exception using
        errcode = '23505',
        message = format(
          'SĐT %s đang được dùng cho khách hàng %s. Vui lòng xoá/ngưng hoạt động số đó ở khách hàng cũ trước khi lưu.',
          coalesce(v_phone_raw, v_phone_normalized),
          coalesce(v_conflict_customer_name, v_conflict_customer_id::text, 'khác')
        );
    end;
  end if;

  return v_customer_id;
end;
$$;

revoke all on function public.create_mini_crm_customer_with_dealer_contact(text, text, text, text[], boolean, uuid, numeric, text, text) from public, anon;
grant execute on function public.create_mini_crm_customer_with_dealer_contact(text, text, text, text[], boolean, uuid, numeric, text, text) to authenticated, service_role;
