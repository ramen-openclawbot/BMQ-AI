create table if not exists public.mini_crm_agent_ui_audit_logs (
  id uuid primary key default gen_random_uuid(),
  action_name text not null,
  actor text,
  input_payload jsonb,
  normalized_payload jsonb,
  execution_plan jsonb,
  action_timeline jsonb,
  result_status text not null,
  result_message text,
  customer_name text,
  created_customer_id uuid references public.mini_crm_customers(id) on delete set null,
  rolled_back boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists mini_crm_agent_ui_audit_logs_created_idx
  on public.mini_crm_agent_ui_audit_logs(created_at desc);

create index if not exists mini_crm_agent_ui_audit_logs_action_idx
  on public.mini_crm_agent_ui_audit_logs(action_name, result_status, created_at desc);

alter table public.mini_crm_agent_ui_audit_logs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'mini_crm_agent_ui_audit_logs' and policyname = 'Authenticated users can read agent ui audit logs'
  ) then
    create policy "Authenticated users can read agent ui audit logs"
      on public.mini_crm_agent_ui_audit_logs
      for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'mini_crm_agent_ui_audit_logs' and policyname = 'Authenticated users can write agent ui audit logs'
  ) then
    create policy "Authenticated users can write agent ui audit logs"
      on public.mini_crm_agent_ui_audit_logs
      for insert
      to authenticated
      with check (true);
  end if;
end $$;
