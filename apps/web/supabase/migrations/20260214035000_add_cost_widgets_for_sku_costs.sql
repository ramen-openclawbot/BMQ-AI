-- Phase B: chi tiết widget chi phí theo nhóm cho SKU Costs
ALTER TABLE public.product_skus
  ADD COLUMN IF NOT EXISTS cost_widgets JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill dữ liệu cũ để UI luôn có cấu trúc tương thích
UPDATE public.product_skus
SET cost_widgets = COALESCE(cost_widgets, '{}'::jsonb)
  || jsonb_build_object(
    'packaging', COALESCE(cost_widgets->'packaging', '[]'::jsonb),
    'direct_labor', COALESCE(cost_widgets->'direct_labor', '[]'::jsonb),
    'management', COALESCE(cost_widgets->'management', '[]'::jsonb),
    'delivery', COALESCE(cost_widgets->'delivery', '[]'::jsonb),
    'other', COALESCE(cost_widgets->'other', '[]'::jsonb)
  )
WHERE TRUE;
