-- Daily snapshot for finished SKU costing

CREATE TABLE IF NOT EXISTS public.sku_cost_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL,
  sku_id UUID NOT NULL REFERENCES public.product_skus(id) ON DELETE CASCADE,
  sku_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  ingredient_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  packaging_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  labor_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  delivery_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  other_production_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  sga_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_cost_per_unit NUMERIC(14,2) NOT NULL DEFAULT 0,
  selling_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  margin_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  margin_pct NUMERIC(9,4) NOT NULL DEFAULT 0,
  source_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(snapshot_date, sku_id)
);

CREATE INDEX IF NOT EXISTS idx_sku_cost_snapshots_date ON public.sku_cost_snapshots(snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_sku_cost_snapshots_sku ON public.sku_cost_snapshots(sku_id);

ALTER TABLE public.sku_cost_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_full_sku_cost_snapshots" ON public.sku_cost_snapshots;
CREATE POLICY "auth_full_sku_cost_snapshots" ON public.sku_cost_snapshots
FOR ALL TO authenticated
USING (true)
WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.snapshot_sku_costs_daily(p_snapshot_date DATE DEFAULT CURRENT_DATE)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  INSERT INTO public.sku_cost_snapshots (
    snapshot_date,
    sku_id,
    sku_code,
    product_name,
    ingredient_cost,
    packaging_cost,
    labor_cost,
    delivery_cost,
    other_production_cost,
    sga_cost,
    total_cost_per_unit,
    selling_price,
    margin_amount,
    margin_pct,
    source_note
  )
  SELECT
    p_snapshot_date AS snapshot_date,
    s.id,
    s.sku_code,
    s.product_name,
    COALESCE(fc.ingredient_cost, 0) AS ingredient_cost,
    COALESCE((s.cost_values->>'packaging_cost')::numeric, 0) AS packaging_cost,
    COALESCE((s.cost_values->>'labor_cost')::numeric, 0) AS labor_cost,
    COALESCE((s.cost_values->>'delivery_cost')::numeric, 0) AS delivery_cost,
    COALESCE((s.cost_values->>'other_production_cost')::numeric, 0) AS other_production_cost,
    COALESCE((s.cost_values->>'sga_cost')::numeric, 0) AS sga_cost,
    (
      COALESCE(fc.ingredient_cost, 0)
      + COALESCE((s.cost_values->>'packaging_cost')::numeric, 0)
      + COALESCE((s.cost_values->>'labor_cost')::numeric, 0)
      + COALESCE((s.cost_values->>'delivery_cost')::numeric, 0)
      + COALESCE((s.cost_values->>'other_production_cost')::numeric, 0)
      + COALESCE((s.cost_values->>'sga_cost')::numeric, 0)
    ) AS total_cost_per_unit,
    COALESCE((s.cost_values->>'selling_price')::numeric, 0) AS selling_price,
    (
      COALESCE((s.cost_values->>'selling_price')::numeric, 0)
      - (
        COALESCE(fc.ingredient_cost, 0)
        + COALESCE((s.cost_values->>'packaging_cost')::numeric, 0)
        + COALESCE((s.cost_values->>'labor_cost')::numeric, 0)
        + COALESCE((s.cost_values->>'delivery_cost')::numeric, 0)
        + COALESCE((s.cost_values->>'other_production_cost')::numeric, 0)
        + COALESCE((s.cost_values->>'sga_cost')::numeric, 0)
      )
    ) AS margin_amount,
    CASE
      WHEN COALESCE((s.cost_values->>'selling_price')::numeric, 0) > 0
        THEN (
          (
            COALESCE((s.cost_values->>'selling_price')::numeric, 0)
            - (
              COALESCE(fc.ingredient_cost, 0)
              + COALESCE((s.cost_values->>'packaging_cost')::numeric, 0)
              + COALESCE((s.cost_values->>'labor_cost')::numeric, 0)
              + COALESCE((s.cost_values->>'delivery_cost')::numeric, 0)
              + COALESCE((s.cost_values->>'other_production_cost')::numeric, 0)
              + COALESCE((s.cost_values->>'sga_cost')::numeric, 0)
            )
          ) / COALESCE((s.cost_values->>'selling_price')::numeric, 1)
        ) * 100
      ELSE 0
    END AS margin_pct,
    'auto_snapshot'::text AS source_note
  FROM public.product_skus s
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(SUM(
        (
          COALESCE(lp.unit_price, f.unit_price, 0)
          * COALESCE(f.dosage_qty, 0)
          * (1 + COALESCE(f.wastage_percent, 0) / 100)
        )
      ), 0)
      / GREATEST(COALESCE(s.finished_output_qty, 1), 1) AS ingredient_cost
    FROM public.sku_formulations f
    LEFT JOIN LATERAL (
      SELECT src.unit_price
      FROM (
        SELECT poi.unit_price::numeric AS unit_price, COALESCE(po.order_date, poi.created_at::date) AS effective_date
        FROM public.purchase_order_items poi
        LEFT JOIN public.purchase_orders po ON po.id = poi.purchase_order_id
        WHERE poi.sku_id = f.ingredient_sku_id
        UNION ALL
        SELECT pri.unit_price::numeric AS unit_price, pri.created_at::date AS effective_date
        FROM public.payment_request_items pri
        WHERE pri.sku_id = f.ingredient_sku_id
      ) src
      WHERE src.unit_price IS NOT NULL
      ORDER BY src.effective_date DESC
      LIMIT 1
    ) lp ON true
    WHERE f.sku_id = s.id
  ) fc ON true
  WHERE lower(COALESCE(s.category, '')) LIKE '%thành phẩm%'
  ON CONFLICT (snapshot_date, sku_id)
  DO UPDATE SET
    sku_code = EXCLUDED.sku_code,
    product_name = EXCLUDED.product_name,
    ingredient_cost = EXCLUDED.ingredient_cost,
    packaging_cost = EXCLUDED.packaging_cost,
    labor_cost = EXCLUDED.labor_cost,
    delivery_cost = EXCLUDED.delivery_cost,
    other_production_cost = EXCLUDED.other_production_cost,
    sga_cost = EXCLUDED.sga_cost,
    total_cost_per_unit = EXCLUDED.total_cost_per_unit,
    selling_price = EXCLUDED.selling_price,
    margin_amount = EXCLUDED.margin_amount,
    margin_pct = EXCLUDED.margin_pct,
    source_note = EXCLUDED.source_note;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.snapshot_sku_costs_daily(DATE) TO authenticated;
