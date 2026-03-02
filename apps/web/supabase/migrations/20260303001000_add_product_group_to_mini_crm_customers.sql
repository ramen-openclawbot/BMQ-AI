alter table if exists public.mini_crm_customers
  add column if not exists product_group text not null default 'banhmi';

create index if not exists mini_crm_customers_product_group_idx
  on public.mini_crm_customers(product_group);