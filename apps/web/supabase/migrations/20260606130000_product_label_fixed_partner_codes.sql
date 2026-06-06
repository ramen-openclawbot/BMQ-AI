-- Add fixed barcode and partner product-code controls for QA label validation.
-- These fields are managed in /production/products and must match scanned labels before QA receiving can pass.

ALTER TABLE public.product_label_specs
  ADD COLUMN IF NOT EXISTS barcode_value text,
  ADD COLUMN IF NOT EXISTS partner_product_code text;

ALTER TABLE public.qa_label_checks
  ADD COLUMN IF NOT EXISTS expected_barcode text,
  ADD COLUMN IF NOT EXISTS expected_partner_product_code text,
  ADD COLUMN IF NOT EXISTS extracted_barcode text,
  ADD COLUMN IF NOT EXISTS extracted_partner_product_code text;

CREATE INDEX IF NOT EXISTS idx_product_label_specs_barcode_value ON public.product_label_specs(barcode_value) WHERE barcode_value IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_label_specs_partner_product_code ON public.product_label_specs(partner_product_code) WHERE partner_product_code IS NOT NULL;
