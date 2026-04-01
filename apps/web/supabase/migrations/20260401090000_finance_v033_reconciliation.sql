-- v0.0.33: Add QTM reconciliation columns + performance indexes

-- 1. Add QTM-specific columns to daily_reconciliations
ALTER TABLE public.daily_reconciliations
  ADD COLUMN IF NOT EXISTS qtm_spent_from_folder numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qtm_variance_amount numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unc_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS qtm_status text DEFAULT 'pending';

COMMENT ON COLUMN public.daily_reconciliations.qtm_spent_from_folder IS 'Total QTM amount from Google Drive folder scan';
COMMENT ON COLUMN public.daily_reconciliations.qtm_variance_amount IS 'QTM variance: spent - declared (positive = overspend)';
COMMENT ON COLUMN public.daily_reconciliations.unc_status IS 'UNC reconciliation status: match or mismatch';
COMMENT ON COLUMN public.daily_reconciliations.qtm_status IS 'QTM reconciliation status: match (underspend OK) or mismatch (overspend)';

-- 2. Performance index: closing_date DESC (covers all major query patterns)
CREATE INDEX IF NOT EXISTS idx_daily_reconciliations_closing_date
  ON public.daily_reconciliations (closing_date DESC);

-- 3. Performance index: ceo_daily_closing_declarations.closing_date (60% of DB time per profiling)
CREATE INDEX IF NOT EXISTS idx_ceo_declarations_closing_date
  ON public.ceo_daily_closing_declarations (closing_date DESC);
