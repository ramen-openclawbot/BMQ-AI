-- Phase 6 slice 1: cumulative PO sync snapshots

create table if not exists po_sync_snapshots (
  id uuid primary key default gen_random_uuid(),
  sync_job_id uuid not null references po_sync_jobs(id) on delete cascade,
  customer_id uuid references mini_crm_customers(id) on delete set null,
  triggered_by text,
  snapshot_kind text not null default 'post_sync',
  snapshot_date date not null default current_date,
  total_drafts_count integer not null default 0,
  pending_drafts_count integer not null default 0,
  approved_drafts_count integer not null default 0,
  rejected_drafts_count integer not null default 0,
  exception_drafts_count integer not null default 0,
  cumulative_total_amount numeric(18,2) not null default 0,
  cumulative_pending_amount numeric(18,2) not null default 0,
  cumulative_approved_amount numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint po_sync_snapshots_sync_job_unique unique (sync_job_id)
);

create index if not exists idx_po_sync_snapshots_created_at
  on po_sync_snapshots(created_at desc);

create index if not exists idx_po_sync_snapshots_snapshot_date
  on po_sync_snapshots(snapshot_date desc);

create index if not exists idx_po_sync_snapshots_customer
  on po_sync_snapshots(customer_id);
