alter table public.mini_crm_customers
add column if not exists is_npp boolean not null default false;

alter table public.mini_crm_customers
add column if not exists supplied_by_npp_customer_id uuid null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'mini_crm_customers_supplied_by_npp_customer_id_fkey'
  ) then
    alter table public.mini_crm_customers
    add constraint mini_crm_customers_supplied_by_npp_customer_id_fkey
    foreign key (supplied_by_npp_customer_id)
    references public.mini_crm_customers(id)
    on update cascade
    on delete set null;
  end if;
end $$;

create index if not exists idx_mini_crm_customers_is_npp
  on public.mini_crm_customers (is_npp);

create index if not exists idx_mini_crm_customers_supplied_by_npp_customer_id
  on public.mini_crm_customers (supplied_by_npp_customer_id);
