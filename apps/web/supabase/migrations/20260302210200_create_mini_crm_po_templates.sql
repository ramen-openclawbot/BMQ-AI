create table if not exists public.mini_crm_po_templates (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  template_name text not null,
  file_name text,
  parser_config jsonb not null default '{}'::jsonb,
  sample_preview jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mini_crm_po_templates_customer_idx on public.mini_crm_po_templates(customer_id);
create unique index if not exists mini_crm_po_templates_one_active_per_customer_idx
  on public.mini_crm_po_templates(customer_id)
  where is_active = true;

create or replace function public.set_mini_crm_po_templates_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_mini_crm_po_templates_updated_at
before update on public.mini_crm_po_templates
for each row execute function public.set_mini_crm_po_templates_updated_at();

alter table public.mini_crm_po_templates enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'mini_crm_po_templates' and policyname = 'Authenticated users can read po templates'
  ) then
    create policy "Authenticated users can read po templates"
      on public.mini_crm_po_templates
      for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'mini_crm_po_templates' and policyname = 'Authenticated users can manage po templates'
  ) then
    create policy "Authenticated users can manage po templates"
      on public.mini_crm_po_templates
      for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;