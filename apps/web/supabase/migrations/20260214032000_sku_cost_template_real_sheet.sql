-- Real-sheet aligned SKU cost template (configurable, non hard-code)

ALTER TABLE public.product_skus
  ADD COLUMN IF NOT EXISTS cost_template JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS cost_values JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill from legacy columns so old data still works on new UI
UPDATE public.product_skus
SET cost_values = COALESCE(cost_values, '{}'::jsonb)
  || jsonb_build_object(
    'material_provision_percent', 0,
    'packaging_cost', COALESCE(packaging_cost_per_unit, 0),
    'labor_cost', COALESCE(labor_cost_per_unit, 0),
    'delivery_cost', COALESCE(delivery_cost_per_unit, 0),
    'other_production_cost', COALESCE(other_production_cost_per_unit, 0),
    'sga_cost', COALESCE(sga_cost_per_unit, 0),
    'selling_price', COALESCE(selling_price, 0)
  )
WHERE TRUE;

UPDATE public.product_skus
SET cost_template =
  '[
    {"key":"material_provision_percent","label":"Dự phòng hao hụt/tăng giá (%)","mode":"percent_of_material","block":"material-adjustment","order":10,"editable":true},
    {"key":"packaging_cost","label":"Cost bao bì","mode":"amount","block":"production","order":20,"editable":true},
    {"key":"labor_cost","label":"Cost nhân công","mode":"amount","block":"production","order":30,"editable":true},
    {"key":"delivery_cost","label":"Delivery cost","mode":"amount","block":"production","order":40,"editable":true},
    {"key":"other_production_cost","label":"Other production cost","mode":"amount","block":"production","order":50,"editable":true},
    {"key":"sga_cost","label":"Chi phí bán hàng & quản lý","mode":"amount","block":"sales-admin","order":60,"editable":true},
    {"key":"selling_price","label":"Giá bán","mode":"amount","block":"pricing","order":70,"editable":true}
  ]'::jsonb
WHERE cost_template = '[]'::jsonb OR cost_template IS NULL;

-- Seed sample set aligned to real-sheet style (for 1:1 demo)
DO $$
DECLARE
  v_sku UUID;
BEGIN
  SELECT id INTO v_sku FROM public.product_skus WHERE sku_code = 'TP-BMQ-HEOSATE-001' LIMIT 1;

  IF v_sku IS NULL THEN
    INSERT INTO public.product_skus (
      sku_code,
      product_name,
      unit,
      category,
      base_unit,
      yield_percent,
      finished_output_qty,
      finished_output_unit,
      cost_template,
      cost_values,
      notes
    )
    VALUES (
      'TP-BMQ-HEOSATE-001',
      'Bánh mì heo sate',
      'ổ',
      'Thành phẩm',
      'ổ',
      100,
      1,
      'ổ',
      '[
        {"key":"material_provision_percent","label":"Dự phòng hao hụt/tăng giá (%)","mode":"percent_of_material","block":"material-adjustment","order":10,"editable":true},
        {"key":"packaging_cost","label":"Cost bao bì","mode":"amount","block":"production","order":20,"editable":true},
        {"key":"labor_cost","label":"Cost nhân công","mode":"amount","block":"production","order":30,"editable":true},
        {"key":"delivery_cost","label":"Delivery cost","mode":"amount","block":"production","order":40,"editable":true},
        {"key":"other_production_cost","label":"Other production cost","mode":"amount","block":"production","order":50,"editable":true},
        {"key":"sga_cost","label":"Chi phí bán hàng & quản lý","mode":"amount","block":"sales-admin","order":60,"editable":true},
        {"key":"selling_price","label":"Giá bán","mode":"amount","block":"pricing","order":70,"editable":true}
      ]'::jsonb,
      '{
        "material_provision_percent": 5,
        "packaging_cost": 1800,
        "labor_cost": 3200,
        "delivery_cost": 1100,
        "other_production_cost": 900,
        "sga_cost": 2500,
        "selling_price": 28000
      }'::jsonb,
      'Seed demo theo template cost sheet thực tế'
    )
    RETURNING id INTO v_sku;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.sku_formulations WHERE sku_id = v_sku) THEN
    INSERT INTO public.sku_formulations (sku_id, ingredient_name, unit, unit_price, dosage_qty, wastage_percent, sort_order)
    VALUES
      (v_sku, 'Bánh mì', 'ổ', 3800, 1.00, 0, 1),
      (v_sku, 'Thịt heo', 'gram', 165, 85, 0, 2),
      (v_sku, 'Sate + gia vị', 'gram', 120, 35, 0, 3),
      (v_sku, 'Rau + đồ chua', 'gram', 45, 55, 0, 4),
      (v_sku, 'Nước sốt', 'gram', 60, 28, 0, 5);
  END IF;
END $$;
