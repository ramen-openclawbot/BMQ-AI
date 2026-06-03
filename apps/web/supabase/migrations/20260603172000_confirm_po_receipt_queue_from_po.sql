-- PO-created goods receipt queues should be immediately ready for warehouse accounting confirmation.
-- They inherit the PO lines (product, ordered qty, unit, price) and default to PO quantities in the UI.
-- Delivery-note OCR only changes actual quantities when there is a variance.

CREATE OR REPLACE FUNCTION public.enforce_goods_receipt_raw_material_sku()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_type public.sku_type;
BEGIN
  -- Raw-material SKU mapping is optional for PO-generated receipt queues because many BMQ purchase
  -- items are not maintained as SKU rows yet. When a SKU is provided, still enforce that it is a raw
  -- material SKU. Inventory posting can still use/create inventory_items by product name.
  IF NEW.sku_id IS NULL THEN
    RETURN NEW;
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
BEFORE INSERT OR UPDATE OF sku_id ON public.goods_receipt_items
FOR EACH ROW
EXECUTE FUNCTION public.enforce_goods_receipt_raw_material_sku();

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
  v_payable_id uuid;
  v_request_number text;
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
  LIMIT 1
  FOR UPDATE;

  IF v_receipt_id IS NULL THEN
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
      'confirmed',
      0,
      'not_generated',
      '{}'::jsonb,
      'Tự động tạo phiếu chờ kế toán kho xác nhận từ PO; mặc định khớp PO, chỉ cập nhật thực tế khi có chênh lệch.'
    )
    RETURNING id INTO v_receipt_id;
  ELSE
    UPDATE public.goods_receipts
    SET status = CASE WHEN status = 'draft' THEN 'confirmed'::public.goods_receipt_status ELSE status END,
        notes = COALESCE(NULLIF(notes, ''), 'Tự động tạo phiếu chờ kế toán kho xác nhận từ PO; mặc định khớp PO, chỉ cập nhật thực tế khi có chênh lệch.'),
        updated_at = now()
    WHERE id = v_receipt_id;
  END IF;

  -- Keep the receipt detail lines in sync with the PO until warehouse/accounting finalizes it.
  IF EXISTS (SELECT 1 FROM public.goods_receipts WHERE id = v_receipt_id AND status = 'confirmed') THEN
    DELETE FROM public.goods_receipt_items
    WHERE goods_receipt_id = v_receipt_id;

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
      NULLIF(concat_ws('; ', 'Từ PO - mặc định thực nhận khớp số đặt nếu không có chênh lệch', poi.notes), '')
    FROM public.purchase_order_items poi
    WHERE poi.purchase_order_id = p_purchase_order_id
    ORDER BY poi.created_at ASC;
  END IF;

  SELECT id
  INTO v_payable_id
  FROM public.payment_requests
  WHERE purchase_order_id = p_purchase_order_id
    AND goods_receipt_id = v_receipt_id
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF v_payable_id IS NULL THEN
    SELECT payment_request_id
    INTO v_payable_id
    FROM public.goods_receipts
    WHERE id = v_receipt_id
      AND payment_request_id IS NOT NULL
    LIMIT 1;

    IF v_payable_id IS NOT NULL THEN
      PERFORM 1 FROM public.payment_requests WHERE id = v_payable_id FOR UPDATE;
    END IF;
  END IF;

  IF v_payable_id IS NULL THEN
    v_request_number := 'PR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

    INSERT INTO public.payment_requests (
      request_number,
      supplier_id,
      purchase_order_id,
      goods_receipt_id,
      title,
      description,
      total_amount,
      vat_amount,
      status,
      delivery_status,
      payment_status,
      payment_type,
      payment_method,
      image_url,
      created_by,
      notes
    ) VALUES (
      v_request_number,
      v_purchase_order.supplier_id,
      p_purchase_order_id,
      v_receipt_id,
      'Duyệt chi PO ' || v_purchase_order.po_number,
      'Tạm tính từ PO ' || v_purchase_order.po_number || '. Kế toán kho xác nhận phiếu nhập; nếu phiếu giao hàng lệch PO thì công nợ cập nhật theo số thực nhận.',
      COALESCE(v_purchase_order.total_amount, 0),
      COALESCE(v_purchase_order.vat_amount, 0),
      'pending',
      'pending',
      'unpaid',
      'new_order',
      'bank_transfer',
      v_purchase_order.image_url,
      v_purchase_order.created_by,
      'Tự động tạo cùng PO; chờ kế toán kho xác nhận nhập kho/công nợ.'
    )
    RETURNING id INTO v_payable_id;
  ELSE
    UPDATE public.payment_requests
    SET supplier_id = v_purchase_order.supplier_id,
        purchase_order_id = p_purchase_order_id,
        goods_receipt_id = v_receipt_id,
        title = 'Duyệt chi PO ' || v_purchase_order.po_number,
        description = 'Tạm tính/cập nhật từ PO ' || v_purchase_order.po_number || '. Kế toán kho xác nhận phiếu nhập; nếu phiếu giao hàng lệch PO thì công nợ cập nhật theo số thực nhận.',
        total_amount = COALESCE(v_purchase_order.total_amount, 0),
        vat_amount = COALESCE(v_purchase_order.vat_amount, 0),
        status = CASE WHEN status = 'rejected' THEN 'pending'::payment_request_status ELSE status END,
        delivery_status = CASE WHEN delivery_status = 'delivered' THEN delivery_status ELSE 'pending'::delivery_status END,
        payment_status = COALESCE(payment_status, 'unpaid'::payment_status),
        payment_type = COALESCE(payment_type, 'new_order'::payment_type),
        payment_method = COALESCE(payment_method, 'bank_transfer'::payment_method_type),
        image_url = COALESCE(image_url, v_purchase_order.image_url),
        updated_at = now(),
        notes = 'Tự động tạo/cập nhật cùng PO; chờ kế toán kho xác nhận nhập kho/công nợ.'
    WHERE id = v_payable_id;

    DELETE FROM public.payment_request_items
    WHERE payment_request_id = v_payable_id;
  END IF;

  INSERT INTO public.payment_request_items (
    payment_request_id,
    product_name,
    quantity,
    unit,
    unit_price,
    line_total,
    sku_id,
    notes
  )
  SELECT
    v_payable_id,
    poi.product_name,
    poi.quantity,
    poi.unit,
    poi.unit_price,
    COALESCE(poi.line_total, poi.quantity * poi.unit_price),
    poi.sku_id,
    NULLIF(concat_ws('; ', 'PO item: ' || poi.id::text, poi.notes), '')
  FROM public.purchase_order_items poi
  WHERE poi.purchase_order_id = p_purchase_order_id
  ORDER BY poi.created_at ASC;

  UPDATE public.goods_receipts
  SET payment_request_id = v_payable_id,
      updated_at = now()
  WHERE id = v_receipt_id;

  UPDATE public.purchase_orders
  SET status = CASE WHEN status = 'draft' THEN 'sent'::purchase_order_status ELSE status END,
      updated_at = now()
  WHERE id = p_purchase_order_id;

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
      RETURN public.ensure_purchase_order_receipt_queue(p_purchase_order_id);
    END IF;

    RAISE;
END;
$$;

-- Existing stuck PO-created queues should become ready for warehouse accounting confirmation.
UPDATE public.goods_receipts
SET status = 'confirmed'::public.goods_receipt_status,
    notes = COALESCE(NULLIF(notes, ''), 'Tự động tạo phiếu chờ kế toán kho xác nhận từ PO; mặc định khớp PO, chỉ cập nhật thực tế khi có chênh lệch.'),
    updated_at = now()
WHERE purchase_order_id IS NOT NULL
  AND status = 'draft'::public.goods_receipt_status
  AND payable_status = 'not_generated';

GRANT EXECUTE ON FUNCTION public.ensure_purchase_order_receipt_queue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_purchase_order_receipt_queue(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.enforce_goods_receipt_raw_material_sku() TO service_role;
