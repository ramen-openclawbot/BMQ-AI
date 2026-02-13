-- Extend SKU costing structure for management/analysis bridge
ALTER TABLE public.product_skus
  ADD COLUMN IF NOT EXISTS packaging_cost_per_unit NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS labor_cost_per_unit NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_cost_per_unit NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_production_cost_per_unit NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sga_cost_per_unit NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS finished_output_qty NUMERIC(14,4) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS finished_output_unit TEXT;
