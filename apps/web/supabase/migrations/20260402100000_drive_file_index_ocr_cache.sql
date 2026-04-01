-- Add OCR result cache columns to drive_file_index
-- so subsequent reconciliation runs can reuse extracted amounts
-- instead of re-downloading + re-OCR-ing every file.
ALTER TABLE drive_file_index
  ADD COLUMN IF NOT EXISTS extracted_amount numeric,
  ADD COLUMN IF NOT EXISTS extraction_confidence numeric;

-- Index for fast lookup of cached OCR results during reconciliation
CREATE INDEX IF NOT EXISTS idx_drive_file_index_ocr_cache
  ON drive_file_index (file_id)
  WHERE extracted_amount IS NOT NULL;
