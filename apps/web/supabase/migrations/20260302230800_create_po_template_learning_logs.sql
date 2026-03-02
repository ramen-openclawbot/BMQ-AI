create table if not exists public.mini_crm_po_template_learning_logs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid null,
  source_file_name text,
  source_confidence numeric(5,2),
  before_snapshot jsonb not null default '{}'::jsonb,
  after_snapshot jsonb not null default '{}'::jsonb,
  diff_summary text,
  created_at timestamptz not null default now()
);

create index if not exists mini_crm_po_template_learning_logs_customer_idx
  on public.mini_crm_po_template_learning_logs(customer_id, created_at desc);