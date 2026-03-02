alter table public.mini_crm_po_templates
  add column if not exists version_no integer not null default 1,
  add column if not exists confirmation_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists parse_confidence numeric(5,2);

create index if not exists mini_crm_po_templates_customer_version_idx
  on public.mini_crm_po_templates(customer_id, version_no desc);