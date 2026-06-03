-- Require PO goods receipts to keep an uploaded image/evidence attachment like payment requests.
-- The PO image is copied onto the auto-created receipt queue; warehouse can replace it with
-- the actual delivery note image/OCR upload before finalizing.

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
      image_url,
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
      v_purchase_order.image_url,
      'Tự động tạo phiếu chờ kế toán kho xác nhận từ PO; giữ ảnh/chứng từ PO để staff đối chiếu, mặc định khớp PO và chỉ cập nhật thực tế khi có chênh lệch.'
    )
    RETURNING id INTO v_receipt_id;
  ELSE
    UPDATE public.goods_receipts
    SET status = CASE WHEN status = 'draft' THEN 'confirmed'::public.goods_receipt_status ELSE status END,
        image_url = COALESCE(image_url, v_purchase_order.image_url),
        notes = COALESCE(NULLIF(notes, ''), 'Tự động tạo phiếu chờ kế toán kho xác nhận từ PO; giữ ảnh/chứng từ PO để staff đối chiếu, mặc định khớp PO và chỉ cập nhật thực tế khi có chênh lệch.'),
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
      image_url = COALESCE(image_url, v_purchase_order.image_url),
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

CREATE OR REPLACE FUNCTION public.finalize_goods_receipt(
  p_receipt_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receipt public.goods_receipts%ROWTYPE;
  v_purchase_order public.purchase_orders%ROWTYPE;
  v_item public.goods_receipt_items%ROWTYPE;
  v_inventory_item_id uuid;
  v_actual_quantity numeric;
  v_ordered_quantity numeric;
  v_unit_price numeric;
  v_line_total numeric;
  v_subtotal numeric := 0;
  v_planned_subtotal numeric := 0;
  v_vat_amount numeric := 0;
  v_total_amount numeric := 0;
  v_total_quantity numeric := 0;
  v_payable_id uuid;
  v_request_number text;
  v_variance_summary jsonb := '{}'::jsonb;
  v_has_shortage boolean := false;
BEGIN
  SELECT *
  INTO v_receipt
  FROM public.goods_receipts
  WHERE id = p_receipt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Goods receipt % not found', p_receipt_id;
  END IF;

  IF v_receipt.status = 'received' OR v_receipt.payable_status = 'generated' THEN
    RAISE EXCEPTION 'Goods receipt already finalized or already received';
  END IF;

  IF v_receipt.payable_status <> 'not_generated' THEN
    RAISE EXCEPTION 'Goods receipt payable is already in progress';
  END IF;

  UPDATE public.goods_receipts
  SET payable_status = 'generating', updated_at = now()
  WHERE id = p_receipt_id;

  IF v_receipt.purchase_order_id IS NOT NULL THEN
    SELECT *
    INTO v_purchase_order
    FROM public.purchase_orders
    WHERE id = v_receipt.purchase_order_id
    FOR UPDATE;

    IF NULLIF(COALESCE(v_receipt.image_url, v_purchase_order.image_url), '') IS NULL THEN
      RAISE EXCEPTION 'PO goods receipt requires an uploaded receipt/delivery-note image before finalizing';
    END IF;

    IF NULLIF(v_receipt.image_url, '') IS NULL AND NULLIF(v_purchase_order.image_url, '') IS NOT NULL THEN
      UPDATE public.goods_receipts
      SET image_url = v_purchase_order.image_url,
          updated_at = now()
      WHERE id = p_receipt_id;
      v_receipt.image_url := v_purchase_order.image_url;
    END IF;
  END IF;

  FOR v_item IN
    SELECT *
    FROM public.goods_receipt_items
    WHERE goods_receipt_id = p_receipt_id
    ORDER BY created_at ASC, id ASC
    FOR UPDATE
  LOOP
    v_actual_quantity := GREATEST(0, COALESCE(v_item.actual_quantity, v_item.quantity, 0));
    v_ordered_quantity := GREATEST(0, COALESCE(v_item.ordered_quantity, v_item.quantity, 0));
    v_unit_price := GREATEST(0, COALESCE(v_item.unit_price, 0));
    v_line_total := v_actual_quantity * v_unit_price;

    v_planned_subtotal := v_planned_subtotal + (v_ordered_quantity * v_unit_price);

    IF NOT (v_actual_quantity > 0) THEN
      CONTINUE;
    END IF;

    v_subtotal := v_subtotal + v_line_total;
    v_total_quantity := v_total_quantity + v_actual_quantity;
    v_inventory_item_id := v_item.inventory_item_id;

    IF v_item.line_status = 'thieu' OR v_actual_quantity < v_ordered_quantity THEN
      v_has_shortage := true;
    END IF;

    IF v_inventory_item_id IS NOT NULL THEN
      UPDATE public.inventory_items
      SET quantity = quantity + ROUND(v_actual_quantity)::integer,
          updated_at = now()
      WHERE id = v_inventory_item_id;

      IF NOT FOUND THEN
        v_inventory_item_id := NULL;
      END IF;
    END IF;

    IF v_inventory_item_id IS NULL THEN
      SELECT id
      INTO v_inventory_item_id
      FROM public.inventory_items
      WHERE name ILIKE v_item.product_name
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE;

      IF v_inventory_item_id IS NOT NULL THEN
        UPDATE public.inventory_items
        SET quantity = quantity + ROUND(v_actual_quantity)::integer,
            updated_at = now()
        WHERE id = v_inventory_item_id;
      ELSE
        INSERT INTO public.inventory_items (
          name,
          quantity,
          unit,
          category,
          supplier_id,
          created_by
        ) VALUES (
          v_item.product_name,
          ROUND(v_actual_quantity)::integer,
          v_item.unit,
          'Từ phiếu nhập',
          v_receipt.supplier_id,
          p_user_id
        )
        RETURNING id INTO v_inventory_item_id;
      END IF;

      UPDATE public.goods_receipt_items
      SET inventory_item_id = v_inventory_item_id
      WHERE id = v_item.id;
    END IF;

    INSERT INTO public.inventory_batches (
      inventory_item_id,
      sku_id,
      goods_receipt_id,
      goods_receipt_item_id,
      batch_number,
      quantity,
      unit,
      received_date,
      expiry_date,
      notes
    ) VALUES (
      v_inventory_item_id,
      v_item.sku_id,
      p_receipt_id,
      v_item.id,
      v_receipt.receipt_number || '-' || lpad((SELECT count(*) + 1 FROM public.inventory_batches WHERE goods_receipt_id = p_receipt_id)::text, 3, '0'),
      v_actual_quantity,
      v_item.unit,
      CURRENT_DATE,
      v_item.expiry_date,
      NULLIF(concat_ws('; ', v_item.variance_reason, v_item.notes), '')
    );
  END LOOP;

  IF v_total_quantity <= 0 THEN
    RAISE EXCEPTION 'Cannot finalize receipt without positive actual received quantities';
  END IF;

  SELECT COALESCE(jsonb_object_agg(line_status_key, item_count), '{}'::jsonb)
  INTO v_variance_summary
  FROM (
    SELECT
      COALESCE(
        line_status,
        CASE
          WHEN COALESCE(actual_quantity, quantity, 0) < COALESCE(ordered_quantity, quantity, 0) THEN 'thieu'
          WHEN COALESCE(actual_quantity, quantity, 0) > COALESCE(ordered_quantity, quantity, 0) THEN 'du_thua'
          ELSE 'du'
        END
      ) AS line_status_key,
      count(*) AS item_count
    FROM public.goods_receipt_items
    WHERE goods_receipt_id = p_receipt_id
    GROUP BY 1
  ) status_counts;

  IF v_planned_subtotal > 0 AND COALESCE(v_purchase_order.vat_amount, 0) > 0 THEN
    v_vat_amount := ROUND((v_purchase_order.vat_amount * v_subtotal / v_planned_subtotal) * 100) / 100;
  ELSE
    v_vat_amount := 0;
  END IF;

  v_total_amount := v_subtotal + v_vat_amount;

  IF v_total_amount <= 0 THEN
    RAISE EXCEPTION 'Cannot create payable with zero amount. Add PO unit prices or receipt item prices before finalizing.';
  END IF;

  v_payable_id := v_receipt.payment_request_id;

  IF v_payable_id IS NULL THEN
    SELECT id
    INTO v_payable_id
    FROM public.payment_requests
    WHERE goods_receipt_id = p_receipt_id
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.payment_requests WHERE id = v_payable_id FOR UPDATE;
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
      v_receipt.supplier_id,
      v_receipt.purchase_order_id,
      p_receipt_id,
      'Công nợ nhập kho ' || v_receipt.receipt_number,
      'Tạo từ phiếu nhập kho ' || v_receipt.receipt_number,
      v_total_amount,
      v_vat_amount,
      'pending',
      'delivered',
      'unpaid',
      'old_order',
      'bank_transfer',
      v_receipt.image_url,
      p_user_id,
      'Tự động tạo từ phiếu nhập kho. Chênh lệch: ' || v_variance_summary::text
    )
    RETURNING id INTO v_payable_id;
  ELSE
    UPDATE public.payment_requests
    SET supplier_id = v_receipt.supplier_id,
        purchase_order_id = v_receipt.purchase_order_id,
        goods_receipt_id = p_receipt_id,
        title = 'Công nợ nhập kho ' || v_receipt.receipt_number,
        description = 'Tạo từ phiếu nhập kho ' || v_receipt.receipt_number,
        total_amount = v_total_amount,
        vat_amount = v_vat_amount,
        status = 'pending',
        delivery_status = 'delivered',
        payment_status = 'unpaid',
        payment_type = 'old_order',
        image_url = COALESCE(v_receipt.image_url, image_url),
        updated_at = now(),
        notes = 'Tự động tạo/cập nhật từ phiếu nhập kho. Chênh lệch: ' || v_variance_summary::text
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
    inventory_item_id,
    sku_id,
    notes
  )
  SELECT
    v_payable_id,
    gri.product_name,
    GREATEST(0, COALESCE(gri.actual_quantity, gri.quantity, 0)),
    gri.unit,
    GREATEST(0, COALESCE(gri.unit_price, 0)),
    GREATEST(0, COALESCE(gri.actual_quantity, gri.quantity, 0)) * GREATEST(0, COALESCE(gri.unit_price, 0)),
    gri.inventory_item_id,
    gri.sku_id,
    NULLIF(concat_ws('; ',
      CASE WHEN gri.line_status IS NOT NULL THEN 'Tình trạng: ' || gri.line_status END,
      CASE WHEN gri.variance_reason IS NOT NULL THEN 'Lý do lệch: ' || gri.variance_reason END,
      CASE WHEN gri.purchase_order_item_id IS NOT NULL THEN 'PO item: ' || gri.purchase_order_item_id::text END
    ), '')
  FROM public.goods_receipt_items gri
  WHERE gri.goods_receipt_id = p_receipt_id
    AND GREATEST(0, COALESCE(gri.actual_quantity, gri.quantity, 0)) > 0
  ORDER BY gri.created_at ASC, gri.id ASC;

  UPDATE public.goods_receipts
  SET status = 'received',
      payable_status = 'generated',
      payment_request_id = v_payable_id,
      finalized_at = now(),
      finalized_by = p_user_id,
      variance_summary = v_variance_summary,
      total_quantity = v_total_quantity,
      updated_at = now()
  WHERE id = p_receipt_id;

  IF v_receipt.purchase_order_id IS NOT NULL THEN
    UPDATE public.purchase_orders
    SET status = CASE WHEN v_has_shortage THEN 'in_transit'::purchase_order_status ELSE 'completed'::purchase_order_status END,
        updated_at = now()
    WHERE id = v_receipt.purchase_order_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'receiptId', p_receipt_id,
    'payableId', v_payable_id,
    'totalAmount', v_total_amount,
    'vatAmount', v_vat_amount,
    'varianceSummary', v_variance_summary
  );
EXCEPTION
  WHEN OTHERS THEN
    -- Any exception aborts this RPC transaction and rolls back inventory, batch, payable, and receipt updates.
    RAISE;
END;
$$;

-- Backfill currently open PO receipt queues from their linked PO image so staff can open
-- the evidence from Phiếu nhập kho without going through Duyệt chi/PO detail.
UPDATE public.goods_receipts gr
SET image_url = po.image_url,
    notes = COALESCE(NULLIF(gr.notes, ''), 'Tự động tạo phiếu chờ kế toán kho xác nhận từ PO; giữ ảnh/chứng từ PO để staff đối chiếu.'),
    updated_at = now()
FROM public.purchase_orders po
WHERE gr.purchase_order_id = po.id
  AND NULLIF(gr.image_url, '') IS NULL
  AND NULLIF(po.image_url, '') IS NOT NULL
  AND gr.status IN ('draft', 'confirmed');

GRANT EXECUTE ON FUNCTION public.ensure_purchase_order_receipt_queue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_purchase_order_receipt_queue(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_goods_receipt(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_goods_receipt(uuid, uuid) TO service_role;
