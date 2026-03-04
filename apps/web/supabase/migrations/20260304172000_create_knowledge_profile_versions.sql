create table if not exists public.mini_crm_knowledge_profile_versions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  knowledge_profile_id uuid references public.mini_crm_knowledge_profiles(id) on delete set null,
  version_no integer not null,
  profile_name text not null,
  po_mode text not null,
  profile_status text not null default 'active',
  calculation_notes text,
  operational_notes text,
  changed_by text,
  change_note text,
  is_active boolean not null default true,
  effective_from timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(customer_id, version_no)
);

create index if not exists mini_crm_kb_versions_customer_idx
  on public.mini_crm_knowledge_profile_versions(customer_id, version_no desc);

alter table public.mini_crm_knowledge_profile_versions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'mini_crm_knowledge_profile_versions' and policyname = 'Authenticated users can read KB versions'
  ) then
    create policy "Authenticated users can read KB versions"
      on public.mini_crm_knowledge_profile_versions
      for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'mini_crm_knowledge_profile_versions' and policyname = 'Authenticated users can write KB versions'
  ) then
    create policy "Authenticated users can write KB versions"
      on public.mini_crm_knowledge_profile_versions
      for insert
      to authenticated
      with check (true);
  end if;
end $$;
