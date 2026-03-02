create table if not exists public.mini_crm_customer_contracts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  file_name text not null,
  file_url text not null,
  file_size bigint,
  mime_type text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists mini_crm_customer_contracts_customer_idx on public.mini_crm_customer_contracts(customer_id);

alter table public.mini_crm_customer_contracts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='mini_crm_customer_contracts' and policyname='Authenticated users can read customer contracts'
  ) then
    create policy "Authenticated users can read customer contracts"
      on public.mini_crm_customer_contracts for select to authenticated using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='mini_crm_customer_contracts' and policyname='Authenticated users can manage customer contracts'
  ) then
    create policy "Authenticated users can manage customer contracts"
      on public.mini_crm_customer_contracts for all to authenticated using (true) with check (true);
  end if;
end $$;