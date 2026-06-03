-- Allow PO-created draft receipt queues to exist before warehouse/accounting maps each raw-material SKU.
-- Root cause: ensure_purchase_order_receipt_queue() copied PO items whose purchase_order_items.sku_id was NULL,
-- but the receipt-item trigger rejected every NULL sku_id, so no Phiếu nhập kho / Duyệt chi queue was created.

CREATE OR REPLACE FUNCTION public.enforce_goods_receipt_raw_material_sku()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_type public.sku_type;
  v_receipt_status public.goods_receipt_status;
  v_effective_quantity numeric;
BEGIN
  v_effective_quantity := GREATEST(
    COALESCE(NEW.actual_quantity, 0),
    COALESCE(NEW.quantity, 0)
  );

  IF NEW.sku_id IS NULL THEN
    SELECT status
    INTO v_receipt_status
    FROM public.goods_receipts
    WHERE id = NEW.goods_receipt_id;

    -- Draft/confirmed queue rows are allowed to start without SKU only while no actual stock is posted.
    -- Warehouse must select/map a raw-material SKU before entering positive received quantity/finalizing.
    IF v_receipt_status IN ('draft'::public.goods_receipt_status, 'confirmed'::public.goods_receipt_status)
       AND v_effective_quantity <= 0 THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'goods_receipt_items.sku_id is required before receiving stock';
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
BEFORE INSERT OR UPDATE OF sku_id, actual_quantity, quantity ON public.goods_receipt_items
FOR EACH ROW
EXECUTE FUNCTION public.enforce_goods_receipt_raw_material_sku();

-- Backfill the stuck June-03 POs reported by the team: create the pending receipt + CEO payment queues.
DO $$
DECLARE
  v_po_id uuid;
BEGIN
  FOR v_po_id IN
    SELECT po.id
    FROM public.purchase_orders po
    WHERE po.created_at >= timestamptz '2026-06-03 00:00:00+00'
      AND po.status IN ('draft'::public.purchase_order_status, 'sent'::public.purchase_order_status, 'in_transit'::public.purchase_order_status)
      AND (
        NOT EXISTS (SELECT 1 FROM public.goods_receipts gr WHERE gr.purchase_order_id = po.id)
        OR NOT EXISTS (SELECT 1 FROM public.payment_requests pr WHERE pr.purchase_order_id = po.id)
      )
    ORDER BY po.created_at ASC
  LOOP
    PERFORM public.ensure_purchase_order_receipt_queue(v_po_id);
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.enforce_goods_receipt_raw_material_sku() TO service_role;
