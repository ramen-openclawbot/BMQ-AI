-- Product label control configuration for QA pass & finished-goods receiving.
-- Failed or missing required label checks must block finished-goods inventory posting.

CREATE TABLE IF NOT EXISTS public.product_label_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL REFERENCES public.product_skus(id) ON DELETE CASCADE,
  sku_code text,
  product_name text,
  shelf_life_days integer NOT NULL DEFAULT 1 CHECK (shelf_life_days >= 1),
  net_weight_value numeric,
  net_weight_unit text DEFAULT 'g',
  traceability_sheet_url text,
  is_label_scan_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku_id)
);

CREATE TABLE IF NOT EXISTS public.qa_label_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qa_inspection_id uuid REFERENCES public.qa_inspections(id) ON DELETE CASCADE,
  production_order_id uuid REFERENCES public.production_orders(id) ON DELETE CASCADE,
  production_order_item_id uuid REFERENCES public.production_order_items(id) ON DELETE SET NULL,
  sku_id uuid REFERENCES public.product_skus(id) ON DELETE SET NULL,
  product_label_spec_id uuid REFERENCES public.product_label_specs(id) ON DELETE SET NULL,
  expected_manufacturing_date date,
  expected_expiry_date date,
  extracted_manufacturing_date date,
  extracted_expiry_date date,
  extracted_product_code text,
  extracted_product_name text,
  extracted_net_weight_value numeric,
  extracted_net_weight_unit text,
  raw_ocr_text text,
  image_url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','passed','failed')),
  failure_reason text,
  checked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_label_specs_sku_id ON public.product_label_specs(sku_id);
CREATE INDEX IF NOT EXISTS idx_qa_label_checks_order ON public.qa_label_checks(production_order_id);
CREATE INDEX IF NOT EXISTS idx_qa_label_checks_inspection ON public.qa_label_checks(qa_inspection_id);

ALTER TABLE public.product_label_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qa_label_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read product label specs" ON public.product_label_specs;
CREATE POLICY "Authenticated users can read product label specs"
ON public.product_label_specs FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated users can manage product label specs" ON public.product_label_specs;
CREATE POLICY "Authenticated users can manage product label specs"
ON public.product_label_specs FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated users can read QA label checks" ON public.qa_label_checks;
CREATE POLICY "Authenticated users can read QA label checks"
ON public.qa_label_checks FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated users can manage QA label checks" ON public.qa_label_checks;
CREATE POLICY "Authenticated users can manage QA label checks"
ON public.qa_label_checks FOR ALL TO authenticated USING (true) WITH CHECK (true);
