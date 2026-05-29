-- Payables receiving flow foundation
-- Adds planned-vs-actual receiving fields without replacing existing receipt/inventory tables.

ALTER TABLE public.goods_receipts
  ADD COLUMN IF NOT EXISTS payable_status text NOT NULL DEFAULT 'not_generated',
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalized_by uuid,
  ADD COLUMN IF NOT EXISTS variance_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.goods_receipt_items
  ADD COLUMN IF NOT EXISTS purchase_order_item_id uuid REFERENCES public.purchase_order_items(id),
  ADD COLUMN IF NOT EXISTS ordered_quantity numeric,
  ADD COLUMN IF NOT EXISTS actual_quantity numeric,
  ADD COLUMN IF NOT EXISTS unit_price numeric,
  ADD COLUMN IF NOT EXISTS line_status text,
  ADD COLUMN IF NOT EXISTS variance_reason text;

CREATE INDEX IF NOT EXISTS idx_goods_receipts_po_status
  ON public.goods_receipts (purchase_order_id, status);

CREATE INDEX IF NOT EXISTS idx_goods_receipts_payable_status
  ON public.goods_receipts (payable_status);

CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_purchase_order_item_id
  ON public.goods_receipt_items (purchase_order_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_goods_receipts_pending_purchase_order
  ON public.goods_receipts (purchase_order_id)
  WHERE purchase_order_id IS NOT NULL AND status IN ('draft', 'confirmed');

ALTER TABLE public.goods_receipts
  ADD CONSTRAINT goods_receipts_payable_status_check
  CHECK (payable_status IN ('not_generated', 'generating', 'generated', 'error'))
  NOT VALID;

ALTER TABLE public.goods_receipt_items
  ADD CONSTRAINT goods_receipt_items_line_status_check
  CHECK (line_status IS NULL OR line_status IN ('du', 'thieu', 'du_thua'))
  NOT VALID;

CREATE OR REPLACE FUNCTION public.ensure_purchase_order_receipt_queue(p_purchase_order_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_purchase_order public.purchase_orders%ROWTYPE;
  v_receipt_id uuid;
  v_receipt_number text;
BEGIN
  SELECT *
  INTO v_purchase_order
  FROM public.purchase_orders
  WHERE id = p_purchase_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order % not found', p_purchase_order_id;
  END IF;

  SELECT id
  INTO v_receipt_id
  FROM public.goods_receipts
  WHERE purchase_order_id = p_purchase_order_id
    AND status IN ('draft', 'confirmed')
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_receipt_id IS NOT NULL THEN
    RETURN v_receipt_id;
  END IF;

  v_receipt_number := public.generate_receipt_number();

  INSERT INTO public.goods_receipts (
    receipt_number,
    receipt_date,
    purchase_order_id,
    supplier_id,
    status,
    total_quantity,
    payable_status,
    variance_summary,
    notes
  ) VALUES (
    v_receipt_number,
    CURRENT_DATE,
    p_purchase_order_id,
    v_purchase_order.supplier_id,
    'draft',
    0,
    'not_generated',
    '{}'::jsonb,
    'Tự động tạo phiếu chờ nhập kho từ PO'
  )
  RETURNING id INTO v_receipt_id;

  INSERT INTO public.goods_receipt_items (
    goods_receipt_id,
    purchase_order_item_id,
    product_name,
    ordered_quantity,
    actual_quantity,
    quantity,
    unit,
    unit_price,
    sku_id,
    notes
  )
  SELECT
    v_receipt_id,
    poi.id,
    poi.product_name,
    poi.quantity,
    NULL,
    0,
    poi.unit,
    poi.unit_price,
    poi.sku_id,
    poi.notes
  FROM public.purchase_order_items poi
  WHERE poi.purchase_order_id = p_purchase_order_id
  ORDER BY poi.created_at ASC;

  RETURN v_receipt_id;
EXCEPTION
  WHEN unique_violation THEN
    SELECT id
    INTO v_receipt_id
    FROM public.goods_receipts
    WHERE purchase_order_id = p_purchase_order_id
      AND status IN ('draft', 'confirmed')
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_receipt_id IS NOT NULL THEN
      RETURN v_receipt_id;
    END IF;

    RAISE;
END;
$$;
