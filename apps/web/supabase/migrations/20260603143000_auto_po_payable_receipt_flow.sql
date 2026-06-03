-- Auto-open the operational flow as soon as a staff PO is created/sent.
-- A PO should immediately have both:
--   1) a pending CEO payment request (duyệt chi), and
--   2) a draft warehouse goods receipt queue (phiếu nhập kho chờ kho xác nhận).
-- Warehouse finalization later updates the same payment_request from actual received quantities.

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
      'draft',
      0,
      'not_generated',
      '{}'::jsonb,
      'Tự động tạo phiếu chờ nhập kho từ PO'
    )
    RETURNING id INTO v_receipt_id;
  END IF;

  -- Keep the receipt detail lines in sync with the PO until warehouse confirms/finalizes it.
  IF EXISTS (SELECT 1 FROM public.goods_receipts WHERE id = v_receipt_id AND status = 'draft') THEN
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
      poi.notes
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
      'Tự động tạo từ PO ' || v_purchase_order.po_number || '. CEO là chốt chặn duyệt chi; kho xác nhận nhập sau.',
      COALESCE(v_purchase_order.total_amount, 0),
      COALESCE(v_purchase_order.vat_amount, 0),
      'pending',
      'pending',
      'unpaid',
      'new_order',
      'bank_transfer',
      v_purchase_order.image_url,
      v_purchase_order.created_by,
      'Tự động tạo cùng PO; phiếu nhập kho chờ kho xác nhận.'
    )
    RETURNING id INTO v_payable_id;
  ELSE
    UPDATE public.payment_requests
    SET supplier_id = v_purchase_order.supplier_id,
        purchase_order_id = p_purchase_order_id,
        goods_receipt_id = v_receipt_id,
        title = 'Duyệt chi PO ' || v_purchase_order.po_number,
        description = 'Tự động tạo/cập nhật từ PO ' || v_purchase_order.po_number || '. CEO là chốt chặn duyệt chi; kho xác nhận nhập sau.',
        total_amount = COALESCE(v_purchase_order.total_amount, 0),
        vat_amount = COALESCE(v_purchase_order.vat_amount, 0),
        status = CASE WHEN status = 'rejected' THEN 'pending'::payment_request_status ELSE status END,
        delivery_status = CASE WHEN delivery_status = 'delivered' THEN delivery_status ELSE 'pending'::delivery_status END,
        payment_status = COALESCE(payment_status, 'unpaid'::payment_status),
        payment_type = COALESCE(payment_type, 'new_order'::payment_type),
        payment_method = COALESCE(payment_method, 'bank_transfer'::payment_method_type),
        image_url = COALESCE(image_url, v_purchase_order.image_url),
        updated_at = now(),
        notes = 'Tự động tạo/cập nhật cùng PO; phiếu nhập kho chờ kho xác nhận.'
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

  -- Staff PO creation should leave the order operationally active, not stuck waiting for a separate PO approval/send step.
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

GRANT EXECUTE ON FUNCTION public.ensure_purchase_order_receipt_queue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_purchase_order_receipt_queue(uuid) TO service_role;
