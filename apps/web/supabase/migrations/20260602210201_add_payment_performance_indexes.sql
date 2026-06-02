-- Fix hot queries from Supabase Query Performance Statements (2026-06-02).
-- The report is dominated by PostgREST reads against payment_requests plus
-- embedded payment_request_items/payment_allocations. Existing single-column
-- indexes cover some filters, but the nested item join was missing its FK index
-- and two frequent compound filters had to combine indexes or scan extra rows.

-- Advisor suggestion for the heavy embedded detail query:
--   CREATE INDEX ON public.payment_request_items USING btree (payment_request_id)
create index if not exists idx_payment_request_items_payment_request_id
  on public.payment_request_items using btree (payment_request_id);

-- Hot aggregate/list query: payment_status + payment_method, projecting totals.
create index if not exists idx_payment_requests_payment_status_method
  on public.payment_requests using btree (payment_status, payment_method);

-- Hot invoice workflow list/count query: status + invoice_created.
create index if not exists idx_payment_requests_status_invoice_created
  on public.payment_requests using btree (status, invoice_created);

-- Helps newest-first payment request lists after filtering by delivery status.
create index if not exists idx_payment_requests_delivery_status_created_at
  on public.payment_requests using btree (delivery_status, created_at desc);
