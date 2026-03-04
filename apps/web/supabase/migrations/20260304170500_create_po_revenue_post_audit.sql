create table if not exists public.po_revenue_post_audit (
  id uuid primary key default gen_random_uuid(),
  po_inbox_id uuid not null references public.customer_po_inbox(id) on delete cascade,
  customer_id uuid references public.mini_crm_customers(id) on delete set null,
  action text not null,
  decision text,
  amount numeric(18,2) not null default 0,
  full_snapshot_total numeric(18,2) not null default 0,
  base_amount numeric(18,2) not null default 0,
  delta_amount numeric(18,2) not null default 0,
  note text,
  actor text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists po_revenue_post_audit_po_idx
  on public.po_revenue_post_audit(po_inbox_id, created_at desc);

create index if not exists po_revenue_post_audit_customer_idx
  on public.po_revenue_post_audit(customer_id, created_at desc);

alter table public.po_revenue_post_audit enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'po_revenue_post_audit' and policyname = 'Authenticated users can read po revenue audit'
  ) then
    create policy "Authenticated users can read po revenue audit"
      on public.po_revenue_post_audit
      for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'po_revenue_post_audit' and policyname = 'Authenticated users can write po revenue audit'
  ) then
    create policy "Authenticated users can write po revenue audit"
      on public.po_revenue_post_audit
      for insert
      to authenticated
      with check (true);
  end if;
end $$;
