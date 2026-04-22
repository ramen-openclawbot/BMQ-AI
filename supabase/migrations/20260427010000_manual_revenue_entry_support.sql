-- Phase 7A — manual revenue entry support
-- Keeps manual entries inside the existing revenue_drafts approval pipeline.

ALTER TABLE public.revenue_drafts
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'auto_sync',
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS entered_by text;

ALTER TABLE public.revenue_drafts
  DROP CONSTRAINT IF EXISTS revenue_drafts_status_check;

ALTER TABLE public.revenue_drafts
  ADD CONSTRAINT revenue_drafts_status_check
  CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'exception'));

ALTER TABLE public.revenue_drafts
  DROP CONSTRAINT IF EXISTS revenue_drafts_source_check;

ALTER TABLE public.revenue_drafts
  ADD CONSTRAINT revenue_drafts_source_check
  CHECK (source IN ('auto_sync', 'manual'));

CREATE INDEX IF NOT EXISTS idx_revenue_drafts_source
  ON public.revenue_drafts(source);
