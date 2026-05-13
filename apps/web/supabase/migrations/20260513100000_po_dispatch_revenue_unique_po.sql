-- Guard against duplicate actual-dispatch revenue confirmations for the same PO.
-- A PO can be revised through the existing confirmation flow, but it must not create
-- multiple active confirmations that could double-count operational revenue.

create unique index if not exists uq_po_dispatch_revenue_confirmations_active_po
  on public.po_dispatch_revenue_confirmations(customer_po_inbox_id)
  where status <> 'cancelled';
