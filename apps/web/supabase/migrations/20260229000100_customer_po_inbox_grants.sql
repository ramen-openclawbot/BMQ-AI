-- Ensure PostgREST schema cache exposes all columns to app roles
grant select, insert, update, delete on table public.customer_po_inbox to authenticated;
grant select on table public.customer_po_inbox to anon;
