-- Allow B2B customer group in mini CRM
alter table if exists public.mini_crm_customers
  drop constraint if exists mini_crm_customers_customer_group_check;

alter table if exists public.mini_crm_customers
  add constraint mini_crm_customers_customer_group_check
  check (
    customer_group in (
      'banhmi_point',
      'banhmi_agency',
      'online',
      'cake_kingfoodmart',
      'cake_cafe',
      'b2b'
    )
  );
