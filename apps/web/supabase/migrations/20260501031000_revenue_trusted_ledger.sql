-- Production revenue ledger and source document model.
-- Dashboard reads approved/trusted ledger lines; parsed PO/email remains evidence until approved.

create table if not exists public.revenue_source_documents (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  source_name text not null,
  period text not null,
  status text not null default 'pending',
  source_uri text,
  checksum text,
  summary jsonb not null default '{}'::jsonb,
  imported_by uuid,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint revenue_source_documents_source_type_check check (source_type in ('csv_audit','po_email_parse','manual_entry','invoice_import','adjustment')),
  constraint revenue_source_documents_status_check check (status in ('pending','trusted','superseded','rejected')),
  constraint revenue_source_documents_period_check check (period ~ '^\d{4}-\d{2}$')
);

create unique index if not exists uq_revenue_source_documents_checksum
  on public.revenue_source_documents(source_type, period, checksum)
  where checksum is not null;

create index if not exists idx_revenue_source_documents_period
  on public.revenue_source_documents(period, source_type, status);

create table if not exists public.revenue_ledger_lines (
  id uuid primary key default gen_random_uuid(),
  source_document_id uuid not null references public.revenue_source_documents(id) on delete restrict,
  source_row_number integer not null,
  period text not null,
  revenue_date date not null,
  channel text not null,
  source_tab text,
  branch text,
  invoice_no text,
  customer_id uuid references public.mini_crm_customers(id) on delete set null,
  parent_customer_id uuid references public.mini_crm_customers(id) on delete set null,
  customer_code text,
  customer_name text not null,
  product_code text,
  product_name text,
  item_note text,
  quantity numeric(14,3) not null default 0,
  unit_price numeric(14,2) not null default 0,
  gross_revenue numeric(16,2) not null default 0,
  order_gross numeric(16,2),
  order_discount numeric(16,2),
  customer_payable numeric(16,2),
  source_type text not null,
  approval_status text not null default 'pending',
  audit_status text not null default 'pending',
  confidence_status text not null default 'unreviewed',
  review_status text not null default 'not_required',
  reconciliation_status text not null default 'not_reconciled',
  source_ref text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint revenue_ledger_lines_period_check check (period ~ '^\d{4}-\d{2}$'),
  constraint revenue_ledger_lines_source_type_check check (source_type in ('csv_audit','po_email_parse','manual_entry','invoice_import','adjustment')),
  constraint revenue_ledger_lines_approval_status_check check (approval_status in ('pending','approved','rejected','superseded')),
  constraint revenue_ledger_lines_audit_status_check check (audit_status in ('pending','tied','needs_review','adjusted','rejected')),
  constraint revenue_ledger_lines_confidence_status_check check (confidence_status in ('trusted','matched','unreviewed','manual_review','low_confidence')),
  constraint revenue_ledger_lines_review_status_check check (review_status in ('not_required','needs_manual_review','reviewed','resolved')),
  constraint revenue_ledger_lines_reconciliation_status_check check (reconciliation_status in ('not_reconciled','matched_po','csv_only','po_delta','alternate_source','manual_override'))
);

create unique index if not exists uq_revenue_ledger_lines_source_row
  on public.revenue_ledger_lines(source_document_id, source_row_number);

create index if not exists idx_revenue_ledger_lines_period_date
  on public.revenue_ledger_lines(period, revenue_date);

create index if not exists idx_revenue_ledger_lines_customer
  on public.revenue_ledger_lines(customer_id, period);

create index if not exists idx_revenue_ledger_lines_parent_customer
  on public.revenue_ledger_lines(parent_customer_id, period);

create index if not exists idx_revenue_ledger_lines_status
  on public.revenue_ledger_lines(period, approval_status, audit_status, review_status);

create index if not exists idx_revenue_ledger_lines_raw_payload_gin
  on public.revenue_ledger_lines using gin(raw_payload);

alter table public.revenue_source_documents enable row level security;
alter table public.revenue_ledger_lines enable row level security;

revoke all on table public.revenue_source_documents from anon;
revoke all on table public.revenue_ledger_lines from anon;
revoke all on table public.revenue_source_documents from authenticated;
revoke all on table public.revenue_ledger_lines from authenticated;

grant select, insert, update, delete on table public.revenue_source_documents to authenticated;
grant select, insert, update, delete on table public.revenue_ledger_lines to authenticated;

drop policy if exists "finance_read_revenue_source_documents" on public.revenue_source_documents;
create policy "finance_read_revenue_source_documents"
  on public.revenue_source_documents for select to authenticated
  using (public.has_role((select auth.uid()), 'owner') or public.has_role((select auth.uid()), 'staff'));

drop policy if exists "finance_write_revenue_source_documents" on public.revenue_source_documents;
create policy "finance_write_revenue_source_documents"
  on public.revenue_source_documents for all to authenticated
  using (public.has_role((select auth.uid()), 'owner') or public.has_role((select auth.uid()), 'staff'))
  with check (public.has_role((select auth.uid()), 'owner') or public.has_role((select auth.uid()), 'staff'));

drop policy if exists "finance_read_revenue_ledger_lines" on public.revenue_ledger_lines;
create policy "finance_read_revenue_ledger_lines"
  on public.revenue_ledger_lines for select to authenticated
  using (public.has_role((select auth.uid()), 'owner') or public.has_role((select auth.uid()), 'staff'));

drop policy if exists "finance_write_revenue_ledger_lines" on public.revenue_ledger_lines;
create policy "finance_write_revenue_ledger_lines"
  on public.revenue_ledger_lines for all to authenticated
  using (public.has_role((select auth.uid()), 'owner') or public.has_role((select auth.uid()), 'staff'))
  with check (public.has_role((select auth.uid()), 'owner') or public.has_role((select auth.uid()), 'staff'));

create or replace function public.touch_revenue_ledger_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_revenue_source_documents on public.revenue_source_documents;
create trigger trg_touch_revenue_source_documents
  before update on public.revenue_source_documents
  for each row execute function public.touch_revenue_ledger_updated_at();

drop trigger if exists trg_touch_revenue_ledger_lines on public.revenue_ledger_lines;
create trigger trg_touch_revenue_ledger_lines
  before update on public.revenue_ledger_lines
  for each row execute function public.touch_revenue_ledger_updated_at();
