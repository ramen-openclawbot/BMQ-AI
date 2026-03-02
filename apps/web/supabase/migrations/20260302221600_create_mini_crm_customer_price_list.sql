create table if not exists public.mini_crm_customer_price_list (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  sku_id uuid not null references public.product_skus(id) on delete cascade,
  price_vnd_per_unit numeric(14,2) not null,
  currency text not null default 'VND',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mini_crm_customer_price_list_customer_idx on public.mini_crm_customer_price_list(customer_id);
create index if not exists mini_crm_customer_price_list_sku_idx on public.mini_crm_customer_price_list(sku_id);
create unique index if not exists mini_crm_customer_price_list_active_unique
  on public.mini_crm_customer_price_list(customer_id, sku_id)
  where is_active = true;

create or replace function public.set_mini_crm_customer_price_list_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_mini_crm_customer_price_list_updated_at
before update on public.mini_crm_customer_price_list
for each row execute function public.set_mini_crm_customer_price_list_updated_at();

alter table public.mini_crm_customer_price_list enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='mini_crm_customer_price_list' and policyname='Authenticated users can read customer price list'
  ) then
    create policy "Authenticated users can read customer price list"
      on public.mini_crm_customer_price_list for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='mini_crm_customer_price_list' and policyname='Authenticated users can manage customer price list'
  ) then
    create policy "Authenticated users can manage customer price list"
      on public.mini_crm_customer_price_list for all to authenticated using (true) with check (true);
  end if;
end $$;