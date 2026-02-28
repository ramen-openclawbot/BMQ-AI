alter table public.customer_po_inbox
  add column if not exists po_number text,
  add column if not exists delivery_date date,
  add column if not exists subtotal_amount numeric(15,2),
  add column if not exists vat_amount numeric(15,2),
  add column if not exists total_amount numeric(15,2),
  add column if not exists production_items jsonb not null default '[]'::jsonb,
  add column if not exists posted_to_revenue boolean not null default false,
  add column if not exists posted_to_revenue_at timestamptz;

create index if not exists idx_customer_po_inbox_po_number on public.customer_po_inbox(po_number);
create index if not exists idx_customer_po_inbox_posted_to_revenue on public.customer_po_inbox(posted_to_revenue);