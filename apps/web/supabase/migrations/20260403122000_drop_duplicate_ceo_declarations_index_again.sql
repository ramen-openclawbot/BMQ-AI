-- ============================================================================
-- v0.0.36 — Remove duplicate closing_date index on ceo_daily_closing_declarations
--
-- Context:
-- - Performance Advisor reports duplicate indexes:
--   * idx_ceo_daily_closing_declarations_closing_date
--   * idx_ceo_declarations_closing_date
-- - The shorter index was reintroduced in v0.0.33.
--
-- Goal:
-- - Keep the original production index and drop the duplicate re-added later.
-- ============================================================================

DROP INDEX IF EXISTS public.idx_ceo_declarations_closing_date;
