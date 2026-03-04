create table if not exists public.mini_crm_knowledge_profiles (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.mini_crm_customers(id) on delete cascade,
  profile_name text not null,
  po_mode text not null default 'daily_new_po' check (po_mode in ('daily_new_po', 'cumulative_snapshot')),
  calculation_notes text,
  operational_notes text,
  profile_status text not null default 'active' check (profile_status in ('draft', 'active', 'deprecated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mini_crm_knowledge_profiles_customer_idx
  on public.mini_crm_knowledge_profiles(customer_id);

create or replace function public.set_mini_crm_knowledge_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_mini_crm_knowledge_profiles_updated_at on public.mini_crm_knowledge_profiles;
create trigger set_mini_crm_knowledge_profiles_updated_at
before update on public.mini_crm_knowledge_profiles
for each row execute function public.set_mini_crm_knowledge_profiles_updated_at();

alter table public.mini_crm_knowledge_profiles enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'mini_crm_knowledge_profiles' and policyname = 'Authenticated users can read knowledge profiles'
  ) then
    create policy "Authenticated users can read knowledge profiles"
      on public.mini_crm_knowledge_profiles
      for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'mini_crm_knowledge_profiles' and policyname = 'Authenticated users can manage knowledge profiles'
  ) then
    create policy "Authenticated users can manage knowledge profiles"
      on public.mini_crm_knowledge_profiles
      for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;
