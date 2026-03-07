-- ============================================================================
-- v0.0.28 — Phase 3: targeted indexes for finance_daily_snapshot UNC branches
-- Goal: make both branches index-friendly:
--   (1) payment_method='bank_transfer' + created_at day window
--   (2) payment_method='bank_transfer' + join invoice_id + invoices.invoice_date
-- ============================================================================

-- Branch (1): created_at window on bank_transfer
CREATE INDEX IF NOT EXISTS idx_payment_requests_bank_transfer_created_at
  ON public.payment_requests (created_at DESC)
  WHERE payment_method = 'bank_transfer';

-- Branch (2): join to invoices by invoice_id for bank_transfer
CREATE INDEX IF NOT EXISTS idx_payment_requests_bank_transfer_invoice_id
  ON public.payment_requests (invoice_id)
  WHERE payment_method = 'bank_transfer' AND invoice_id IS NOT NULL;

-- Invoices date lookup used by snapshot branch (2)
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_date
  ON public.invoices (invoice_date DESC);
