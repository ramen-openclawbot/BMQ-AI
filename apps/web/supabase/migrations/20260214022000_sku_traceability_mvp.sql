-- SKU + Costing + Batch Coding + Traceability MVP (sample-data focused)

-- 1) Extend SKU master for costing controls
ALTER TABLE public.product_skus
  ADD COLUMN IF NOT EXISTS base_unit TEXT,
  ADD COLUMN IF NOT EXISTS yield_percent NUMERIC(8,2) NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS extra_cost_per_unit NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS selling_price NUMERIC(14,2) NOT NULL DEFAULT 0;

-- 2) SKU formulation rows for costing
CREATE TABLE IF NOT EXISTS public.sku_formulations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id UUID NOT NULL REFERENCES public.product_skus(id) ON DELETE CASCADE,
  ingredient_sku_id UUID NULL REFERENCES public.product_skus(id) ON DELETE SET NULL,
  ingredient_name TEXT NOT NULL,
  unit TEXT,
  unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  dosage_qty NUMERIC(14,4) NOT NULL DEFAULT 0,
  wastage_percent NUMERIC(8,2) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sku_formulations_sku_id ON public.sku_formulations(sku_id);

-- 3) Documents for traceability (image/proof attachments)
CREATE TABLE IF NOT EXISTS public.sku_trace_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id UUID NOT NULL REFERENCES public.product_skus(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL DEFAULT 'image',
  document_name TEXT NOT NULL,
  document_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sku_trace_documents_sku_id ON public.sku_trace_documents(sku_id);

-- 4) Batch code pattern config
CREATE TABLE IF NOT EXISTS public.batch_code_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_group TEXT NOT NULL UNIQUE, -- ingredient|packaging|filling_sauce|shell|finished
  prefix TEXT NOT NULL,
  date_format TEXT NOT NULL DEFAULT 'YYMMDD',
  seq_digits INTEGER NOT NULL DEFAULT 3,
  separator TEXT NOT NULL DEFAULT '-',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5) Production batches
CREATE TABLE IF NOT EXISTS public.production_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_id UUID NOT NULL REFERENCES public.product_skus(id) ON DELETE CASCADE,
  batch_code TEXT NOT NULL UNIQUE,
  shell_code TEXT,
  finished_code TEXT,
  filling_sauce_code TEXT,
  production_date DATE NOT NULL DEFAULT CURRENT_DATE,
  expiry_date DATE,
  partner_slug TEXT,
  public_token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_production_batches_token ON public.production_batches(public_token);
CREATE INDEX IF NOT EXISTS idx_production_batches_sku ON public.production_batches(sku_id);

-- 6) Materials inside production batch
CREATE TABLE IF NOT EXISTS public.production_batch_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES public.production_batches(id) ON DELETE CASCADE,
  material_group TEXT NOT NULL, -- ingredient|packaging|filling_sauce|shell|finished
  material_name TEXT NOT NULL,
  material_code TEXT,
  material_batch_code TEXT,
  quantity NUMERIC(14,4) NOT NULL DEFAULT 0,
  unit TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_production_batch_materials_batch_id ON public.production_batch_materials(batch_id);

-- Updated-at helper
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sku_formulations_touch ON public.sku_formulations;
CREATE TRIGGER trg_sku_formulations_touch
BEFORE UPDATE ON public.sku_formulations
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_batch_code_patterns_touch ON public.batch_code_patterns;
CREATE TRIGGER trg_batch_code_patterns_touch
BEFORE UPDATE ON public.batch_code_patterns
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_production_batches_touch ON public.production_batches;
CREATE TRIGGER trg_production_batches_touch
BEFORE UPDATE ON public.production_batches
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- RLS
ALTER TABLE public.sku_formulations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sku_trace_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batch_code_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_batch_materials ENABLE ROW LEVEL SECURITY;

-- Authenticated full access (MVP)
DROP POLICY IF EXISTS "auth_full_sku_formulations" ON public.sku_formulations;
CREATE POLICY "auth_full_sku_formulations" ON public.sku_formulations
FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_full_sku_trace_documents" ON public.sku_trace_documents;
CREATE POLICY "auth_full_sku_trace_documents" ON public.sku_trace_documents
FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_full_batch_code_patterns" ON public.batch_code_patterns;
CREATE POLICY "auth_full_batch_code_patterns" ON public.batch_code_patterns
FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_full_production_batches" ON public.production_batches;
CREATE POLICY "auth_full_production_batches" ON public.production_batches
FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_full_production_batch_materials" ON public.production_batch_materials;
CREATE POLICY "auth_full_production_batch_materials" ON public.production_batch_materials
FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Public read for traceability link MVP (sample env only)
DROP POLICY IF EXISTS "anon_read_production_batches" ON public.production_batches;
CREATE POLICY "anon_read_production_batches" ON public.production_batches
FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_read_production_batch_materials" ON public.production_batch_materials;
CREATE POLICY "anon_read_production_batch_materials" ON public.production_batch_materials
FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_read_product_skus_for_trace" ON public.product_skus;
CREATE POLICY "anon_read_product_skus_for_trace" ON public.product_skus
FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_read_sku_trace_documents" ON public.sku_trace_documents;
CREATE POLICY "anon_read_sku_trace_documents" ON public.sku_trace_documents
FOR SELECT TO anon USING (true);

-- Seed patterns
INSERT INTO public.batch_code_patterns(material_group, prefix, date_format, seq_digits, separator)
VALUES
  ('ingredient', 'NL', 'YYMMDD', 3, '-'),
  ('packaging', 'BB', 'YYMMDD', 3, '-'),
  ('filling_sauce', 'NS', 'YYMMDD', 3, '-'),
  ('shell', 'VO', 'YYMMDD', 3, '-'),
  ('finished', 'TP', 'YYMMDD', 3, '-')
ON CONFLICT (material_group) DO NOTHING;

-- Sample seed data only if not exists
DO $$
DECLARE
  v_sku UUID;
  v_ing UUID;
  v_pkg UUID;
  v_batch UUID;
BEGIN
  SELECT id INTO v_ing FROM public.product_skus WHERE sku_code = 'NL-BOTMI-001' LIMIT 1;
  IF v_ing IS NULL THEN
    INSERT INTO public.product_skus(sku_code, product_name, unit, unit_price, category, notes, base_unit)
    VALUES ('NL-BOTMI-001', 'Bột mì đa dụng', 'kg', 18000, 'Nguyên liệu', 'Mẫu seed', 'kg')
    RETURNING id INTO v_ing;
  END IF;

  SELECT id INTO v_pkg FROM public.product_skus WHERE sku_code = 'BB-TUIPE-001' LIMIT 1;
  IF v_pkg IS NULL THEN
    INSERT INTO public.product_skus(sku_code, product_name, unit, unit_price, category, notes, base_unit)
    VALUES ('BB-TUIPE-001', 'Túi PE 500g', 'cái', 600, 'Bao bì', 'Mẫu seed', 'cái')
    RETURNING id INTO v_pkg;
  END IF;

  SELECT id INTO v_sku FROM public.product_skus WHERE sku_code = 'TP-RAMEN-001' LIMIT 1;
  IF v_sku IS NULL THEN
    INSERT INTO public.product_skus(
      sku_code, product_name, unit, unit_price, category, notes, base_unit,
      yield_percent, extra_cost_per_unit, selling_price
    )
    VALUES (
      'TP-RAMEN-001', 'Ramen Tonkotsu 500g', 'gói', 0, 'Thành phẩm', 'Mẫu seed thành phẩm', 'gói',
      98, 2500, 45000
    ) RETURNING id INTO v_sku;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.sku_formulations WHERE sku_id = v_sku) THEN
    INSERT INTO public.sku_formulations(sku_id, ingredient_sku_id, ingredient_name, unit, unit_price, dosage_qty, wastage_percent, sort_order)
    VALUES
      (v_sku, v_ing, 'Bột mì đa dụng', 'kg', 18000, 0.32, 2, 1),
      (v_sku, v_pkg, 'Túi PE 500g', 'cái', 600, 1, 0, 2);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.sku_trace_documents WHERE sku_id = v_sku) THEN
    INSERT INTO public.sku_trace_documents(sku_id, document_type, document_name, document_url)
    VALUES
      (v_sku, 'image', 'Ảnh bao bì mẫu', 'https://images.unsplash.com/photo-1606787366850-de6330128bfc?w=1200'),
      (v_sku, 'certificate', 'Phiếu kiểm nghiệm mẫu', 'https://example.com/sample-coa.pdf');
  END IF;

  SELECT id INTO v_batch FROM public.production_batches WHERE batch_code = 'TP-260214-001' LIMIT 1;
  IF v_batch IS NULL THEN
    INSERT INTO public.production_batches(
      sku_id, batch_code, shell_code, finished_code, filling_sauce_code,
      production_date, expiry_date, partner_slug, notes, public_token
    ) VALUES (
      v_sku, 'TP-260214-001', 'VO-260214-001', 'TP-260214-001', 'NS-260214-001',
      CURRENT_DATE, CURRENT_DATE + INTERVAL '6 months', 'doi-tac-a', 'Batch demo MVP', 'trace-mvp-ramen-001'
    ) RETURNING id INTO v_batch;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.production_batch_materials WHERE batch_id = v_batch) THEN
    INSERT INTO public.production_batch_materials(batch_id, material_group, material_name, material_code, material_batch_code, quantity, unit, sort_order)
    VALUES
      (v_batch, 'ingredient', 'Bột mì đa dụng', 'NL-BOTMI-001', 'NL-260214-011', 32, 'kg', 1),
      (v_batch, 'packaging', 'Túi PE 500g', 'BB-TUIPE-001', 'BB-260214-004', 1000, 'cái', 2),
      (v_batch, 'filling_sauce', 'Sốt tonkotsu', 'NS-TONKO-001', 'NS-260214-001', 45, 'kg', 3);
  END IF;
END $$;