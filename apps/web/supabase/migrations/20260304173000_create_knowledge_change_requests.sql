create table if not exists public.mini_crm_knowledge_change_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  profile_name text not null,
  po_mode text not null,
  profile_status text not null default 'pending_approval',
  calculation_notes text,
  operational_notes text,
  change_note text,
  request_status text not null default 'pending',
  requested_by text,
  approved_by text,
  approved_at timestamptz,
  applied_version_no integer,
  created_at timestamptz not null default now()
);

create index if not exists mini_crm_kb_change_requests_customer_idx
  on public.mini_crm_knowledge_change_requests(customer_id, created_at desc);

create index if not exists mini_crm_kb_change_requests_status_idx
  on public.mini_crm_knowledge_change_requests(request_status, created_at desc);

alter table public.mini_crm_knowledge_change_requests enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'mini_crm_knowledge_change_requests' and policyname = 'Authenticated users can read KB change requests'
  ) then
    create policy "Authenticated users can read KB change requests"
      on public.mini_crm_knowledge_change_requests
      for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'mini_crm_knowledge_change_requests' and policyname = 'Authenticated users can write KB change requests'
  ) then
    create policy "Authenticated users can write KB change requests"
      on public.mini_crm_knowledge_change_requests
      for insert
      to authenticated
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'mini_crm_knowledge_change_requests' and policyname = 'Authenticated users can approve KB change requests'
  ) then
    create policy "Authenticated users can approve KB change requests"
      on public.mini_crm_knowledge_change_requests
      for update
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;
