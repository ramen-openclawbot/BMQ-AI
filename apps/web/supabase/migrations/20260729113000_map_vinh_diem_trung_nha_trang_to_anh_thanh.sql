-- Map the Vinh Diem Trung / Nha Trang agency under Anh Thanh NPP.
-- Keep the agency's Gmail address for debt notices, while adding the Tony/Anh Thanh
-- PO sender address so future route lines can resolve to this child agency.

do $$
declare
  anh_thanh_id uuid;
  nha_trang_id uuid;
begin
  select id into anh_thanh_id
  from public.mini_crm_customers
  where lower(customer_name) = lower('Đại lý cấp 1 - Anh Thanh')
  limit 1;

  select id into nha_trang_id
  from public.mini_crm_customers
  where lower(customer_name) = lower('ĐẠI LÝ VĨNH ĐIỀM TRUNG_NHA TRANG')
  limit 1;

  if anh_thanh_id is null then
    raise exception 'Anh Thanh NPP customer not found';
  end if;

  if nha_trang_id is null then
    raise exception 'Vinh Diem Trung / Nha Trang agency customer not found';
  end if;

  update public.mini_crm_customers
  set is_npp = false,
      is_tier1 = false,
      supplied_by_npp_customer_id = anh_thanh_id,
      updated_at = now()
  where id = nha_trang_id;

  insert into public.mini_crm_customer_emails (customer_id, email)
  select nha_trang_id, 'tonythanh@hotmail.com'
  where not exists (
    select 1
    from public.mini_crm_customer_emails
    where customer_id = nha_trang_id
      and lower(email) = 'tonythanh@hotmail.com'
  );

  update public.revenue_ledger_lines
  set raw_payload = jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                coalesce(raw_payload, '{}'::jsonb),
                '{route_customer_id}', to_jsonb(nha_trang_id::text), true
              ),
              '{agency_customer_id}', to_jsonb(nha_trang_id::text), true
            ),
            '{route_customer_name}', to_jsonb('ĐẠI LÝ VĨNH ĐIỀM TRUNG_NHA TRANG'::text), true
          ),
          '{agency_customer_name}', to_jsonb('ĐẠI LÝ VĨNH ĐIỀM TRUNG_NHA TRANG'::text), true
        ),
        '{item_needs_manual_review}', 'false'::jsonb, true
      ) || jsonb_build_object('item_review_reasons', '[]'::jsonb)
  where parent_customer_id = anh_thanh_id
    and lower(trim(coalesce(raw_payload->>'route', ''))) = 'nha trang'
    and coalesce(raw_payload->>'automation_rule', '') = 'tony_thanh_npp_text';
end $$;
