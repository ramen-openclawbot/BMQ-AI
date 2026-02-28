-- Compatibility columns for Mini-CRM revenue posting flow
-- Safe to run multiple times

alter table if exists public.customer_po_inbox
  add column if not exists po_number text;

alter table if exists public.customer_po_inbox
  add column if not exists posted_to_revenue boolean not null default false;

alter table if exists public.customer_po_inbox
  add column if not exists posted_to_revenue_at timestamptz;
