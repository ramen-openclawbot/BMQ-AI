-- Domain separation: raw material SKU vs finished good SKU

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'sku_type'
  ) THEN
    CREATE TYPE public.sku_type AS ENUM ('raw_material', 'finished_good');
  END IF;
END $$;

ALTER TABLE public.product_skus
  ADD COLUMN IF NOT EXISTS sku_type public.sku_type;

-- Backfill from legacy category labels
UPDATE public.product_skus
SET sku_type = CASE
  WHEN lower(coalesce(category, '')) LIKE '%thành phẩm%'
    OR lower(coalesce(category, '')) LIKE '%thanh pham%'
    OR lower(coalesce(category, '')) LIKE '%finished%'
    THEN 'finished_good'::public.sku_type
  ELSE 'raw_material'::public.sku_type
END
WHERE sku_type IS NULL;

ALTER TABLE public.product_skus
  ALTER COLUMN sku_type SET DEFAULT 'raw_material'::public.sku_type;

ALTER TABLE public.product_skus
  ALTER COLUMN sku_type SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_skus_sku_type ON public.product_skus(sku_type);

-- Guardrail: goods receipt items can only reference raw material SKUs
CREATE OR REPLACE FUNCTION public.enforce_goods_receipt_raw_material_sku()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_type public.sku_type;
BEGIN
  IF NEW.sku_id IS NULL THEN
    RAISE EXCEPTION 'goods_receipt_items.sku_id is required for raw material receiving';
  END IF;

  SELECT sku_type INTO v_type
  FROM public.product_skus
  WHERE id = NEW.sku_id;

  IF v_type IS NULL THEN
    RAISE EXCEPTION 'SKU % does not exist', NEW.sku_id;
  END IF;

  IF v_type <> 'raw_material'::public.sku_type THEN
    RAISE EXCEPTION 'Goods receipt only accepts raw material SKU. Got: %', v_type;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_goods_receipt_items_enforce_raw_material ON public.goods_receipt_items;

CREATE TRIGGER trg_goods_receipt_items_enforce_raw_material
BEFORE INSERT OR UPDATE OF sku_id
ON public.goods_receipt_items
FOR EACH ROW
EXECUTE FUNCTION public.enforce_goods_receipt_raw_material_sku();
