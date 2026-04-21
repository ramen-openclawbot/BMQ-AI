-- ============================================================================
-- Phase 4: Revenue draft approval → production order generation
-- Adds audit linkage columns and unique idempotency index
-- ============================================================================

-- 1. Track the generated production order on the revenue draft side
--    (fast UI lookup: show production order badge next to approved draft)
ALTER TABLE revenue_drafts
  ADD COLUMN IF NOT EXISTS production_order_id uuid;

-- 2. Track revenue provenance on the production order side
--    Allows audit: which draft → which sales doc triggered this order
ALTER TABLE production_orders
  ADD COLUMN IF NOT EXISTS revenue_draft_id uuid,
  ADD COLUMN IF NOT EXISTS sales_po_doc_id   uuid;

-- 3. Enforce at-most-one production order per source PO inbox row.
--    This is the primary idempotency guard: re-approving a draft that maps to
--    the same inbox row will find the existing order rather than creating a duplicate.
--    Partial index so NULLs (manually created orders with no inbox link) are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS uq_production_orders_source_po_inbox
  ON production_orders(source_po_inbox_id)
  WHERE source_po_inbox_id IS NOT NULL;

-- 4. Supporting indexes
CREATE INDEX IF NOT EXISTS idx_revenue_drafts_production_order
  ON revenue_drafts(production_order_id);

CREATE INDEX IF NOT EXISTS idx_production_orders_revenue_draft
  ON production_orders(revenue_draft_id);
