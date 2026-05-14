-- NPP debt management: fixed per-agency management fee and Anh Thanh agency split.

alter table if exists public.mini_crm_customers
  add column if not exists npp_management_fee_vnd numeric(14,2) not null default 0;

comment on column public.mini_crm_customers.npp_management_fee_vnd is
  'Fixed VND management/support fee deducted from NPP debt payable for this customer.';

create index if not exists idx_mini_crm_customers_npp_management_fee
  on public.mini_crm_customers (supplied_by_npp_customer_id, npp_management_fee_vnd);

do $$
declare
  anh_thanh_id uuid;
  combined_id uuid;
  di_an_id uuid;
begin
  select id into anh_thanh_id
  from public.mini_crm_customers
  where lower(customer_name) in (lower('Đại lý cấp 1 - Anh Thanh'), lower('Dai ly cap 1 - Anh Thanh'))
     or lower(customer_name) like lower('%Anh Thanh%')
  order by case when lower(customer_name) = lower('Đại lý cấp 1 - Anh Thanh') then 0 else 1 end, created_at asc
  limit 1;

  if anh_thanh_id is not null then
    update public.mini_crm_customers
    set is_npp = true,
        supplied_by_npp_customer_id = null,
        is_tier1 = true,
        customer_group = coalesce(customer_group, 'banhmi_agency'),
        product_group = coalesce(product_group, 'banhmi'),
        updated_at = now()
    where id = anh_thanh_id;

    select id into combined_id
    from public.mini_crm_customers
    where supplied_by_npp_customer_id = anh_thanh_id
      and (
        lower(customer_name) like lower('%xtra%linh%trung%dĩ%an%')
        or lower(customer_name) like lower('%xtra%linh%trung%di%an%')
        or lower(customer_name) like lower('%linh%trung%dĩ%an%')
        or lower(customer_name) like lower('%linh%trung%di%an%')
      )
    order by created_at asc
    limit 1;

    if combined_id is not null then
      update public.mini_crm_customers
      set customer_name = 'Đại Lý Xtra Linh Trung',
          customer_group = 'banhmi_agency',
          product_group = 'banhmi',
          is_npp = false,
          is_tier1 = false,
          supplied_by_npp_customer_id = anh_thanh_id,
          is_active = true,
          updated_at = now()
      where id = combined_id;
    end if;

    select id into di_an_id
    from public.mini_crm_customers
    where supplied_by_npp_customer_id = anh_thanh_id
      and lower(customer_name) in (lower('Đại Lý Dĩ An'), lower('Đại Lý Di An'), lower('Dĩ An'), lower('Di An'))
    order by created_at asc
    limit 1;

    if di_an_id is null then
      insert into public.mini_crm_customers (
        customer_name,
        customer_group,
        product_group,
        is_active,
        is_npp,
        is_tier1,
        supplied_by_npp_customer_id,
        npp_management_fee_vnd
      ) values (
        'Đại Lý Dĩ An',
        'banhmi_agency',
        'banhmi',
        true,
        false,
        false,
        anh_thanh_id,
        0
      );
    end if;

    update public.mini_crm_customers
    set npp_management_fee_vnd = case
      when lower(customer_name) like lower('%Phan Thiết%') or lower(customer_name) like lower('%Phan Thiet%') then 300000
      when lower(customer_name) like lower('%Rạch Giá%') or lower(customer_name) like lower('%Rach Gia%') then 320000
      when lower(customer_name) like lower('%Satra%Củ Chi%') or lower(customer_name) like lower('%Satra%Cu Chi%') then 150000
      when lower(customer_name) like lower('%Mỹ Tho%') or lower(customer_name) like lower('%My Tho%') then 250000
      else coalesce(npp_management_fee_vnd, 0)
    end,
    updated_at = now()
    where supplied_by_npp_customer_id = anh_thanh_id;
  end if;
end $$;
