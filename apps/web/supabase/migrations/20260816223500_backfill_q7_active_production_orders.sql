-- Existing production orders predate the explicit Q7 location column.
-- This production screen is the Q7 workshop order source, so classify its
-- legacy rows without touching any inventory/material-issue ledger.
update public.production_orders
set location_code = 'q7'
where location_code is null;

-- Legacy orders remained in the raw draft state while the UI derived an
-- active display status from their dates. Align only active/future Q7 drafts
-- with the existing PDF generator eligibility. Historical drafts stay intact.
update public.production_orders
set status = 'planned'
where status::text = 'draft'
  and location_code = 'q7'
  and coalesce(planned_end_date, planned_start_date) >=
    (now() at time zone 'Asia/Ho_Chi_Minh')::date;
