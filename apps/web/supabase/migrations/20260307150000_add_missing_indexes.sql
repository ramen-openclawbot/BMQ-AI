-- ============================================================================
-- v0.0.22 — Add Missing Database Indexes
-- Based on Supabase Query Performance Advisor analysis:
-- - ceo_daily_closing_declarations: 60% of total DB time, no index on closing_date
-- - payment_requests: filter columns unindexed
-- - purchase_orders, goods_receipts, suppliers, product_skus: ORDER BY unindexed
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- PHẦN 1: ceo_daily_closing_declarations — CRITICAL (60% DB time)
-- Queries: WHERE closing_date = $1  AND  WHERE closing_date >= $1 AND <= $2
-- Mean query time before: 2,412ms (range), 535ms (single date)
-- Expected after: <5ms
-- ────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ceo_declarations_closing_date
  ON public.ceo_daily_closing_declarations (closing_date DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- PHẦN 2: payment_requests — filter + sort columns
-- Queries from usePaymentStats (v0.0.20): server-side .eq() filters
-- ────────────────────────────────────────────────────────────────────────────

-- Individual filter columns
CREATE INDEX IF NOT EXISTS idx_payment_requests_status
  ON public.payment_requests (status);

CREATE INDEX IF NOT EXISTS idx_payment_requests_payment_status
  ON public.payment_requests (payment_status);

CREATE INDEX IF NOT EXISTS idx_payment_requests_delivery_status
  ON public.payment_requests (delivery_status);

CREATE INDEX IF NOT EXISTS idx_payment_requests_invoice_created
  ON public.payment_requests (invoice_created);

-- Composite index for most common combined filter (status + payment_status)
CREATE INDEX IF NOT EXISTS idx_payment_requests_status_payment_status
  ON public.payment_requests (status, payment_status);

-- Ordering by created_at DESC (list views)
CREATE INDEX IF NOT EXISTS idx_payment_requests_created_at
  ON public.payment_requests (created_at DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- PHẦN 3: Other high-frequency tables — ORDER BY indexes
-- ────────────────────────────────────────────────────────────────────────────

-- purchase_orders: ORDER BY created_at DESC (2,400 calls/session)
CREATE INDEX IF NOT EXISTS idx_purchase_orders_created_at
  ON public.purchase_orders (created_at DESC);

-- goods_receipts: ORDER BY created_at DESC (5,568 calls/session)
CREATE INDEX IF NOT EXISTS idx_goods_receipts_created_at
  ON public.goods_receipts (created_at DESC);

-- suppliers: ORDER BY created_at DESC (6,372 calls/session)
CREATE INDEX IF NOT EXISTS idx_suppliers_created_at
  ON public.suppliers (created_at DESC);

-- product_skus: ORDER BY sku_code ASC (2,433 calls/session)
CREATE INDEX IF NOT EXISTS idx_product_skus_sku_code
  ON public.product_skus (sku_code ASC);

-- ============================================================================
