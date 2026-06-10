-- Do not create a new Duyet chi row when finalizing a PO-linked goods receipt.
-- Inventory posting remains atomic; PO-time payment requests are only linked/reconciled, never recreated or reset.

-- Prevent goods receipt finalization from overwriting paid/approved PO payment requests.
-- Receipt payables are generated from actual received goods and must stay distinct from
-- PO-time advances/reconciliation rows.

-- Keep PO-time payment requests separate from receipt-generated payables.
-- A row is safe to update during finalization only when it is an unpaid receipt payable,
-- not a paid/approved PO advance.
-- paid/approved guards include payment_status IN ('paid', 'partial') and status IN ('approved', 'completed').

CREATE OR REPLACE FUNCTION public.is_receipt_payable_request(p_request public.payment_requests)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    p_request.goods_receipt_id IS NOT NULL
    AND COALESCE(p_request.payment_type::text, 'old_order') = 'old_order'
    AND COALESCE(p_request.delivery_status::text, 'delivered') = 'delivered'
    AND COALESCE(p_request.status::text, 'pending') NOT IN ('approved', 'completed')
    AND COALESCE(p_request.payment_status::text, 'unpaid') NOT IN ('paid', 'partial')
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

  v_payable_id := NULL;

  -- PO-linked receipt finalization never creates a new Duyệt chi / payment request.
  -- Correct flow: PO mua hàng -> Duyệt chi PO -> Phiếu nhập kho -> Nhập kho.
  -- The warehouse action posts inventory and reconciles against the existing PO-time request only.
  IF v_receipt.purchase_order_id IS NOT NULL THEN
    IF v_receipt.payment_request_id IS NOT NULL THEN
      SELECT id
      INTO v_payable_id
      FROM public.payment_requests
      WHERE id = v_receipt.payment_request_id
        AND purchase_order_id = v_receipt.purchase_order_id
      LIMIT 1
      FOR UPDATE;
    END IF;

    IF v_payable_id IS NULL THEN
      SELECT id
      INTO v_payable_id
      FROM public.payment_requests
      WHERE purchase_order_id = v_receipt.purchase_order_id
        AND goods_receipt_id = p_receipt_id
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE;
    END IF;

    -- If historical data is missing the PO-time request link, do not create a duplicate
    -- Công nợ nhập kho row on the receipt date. The receipt is still allowed to post stock;
    -- accounting can repair/link the missing PO Duyệt chi separately with audit.
  ELSE
    -- Non-PO/manual receipts may still create or update an unpaid receipt-payable row.
    IF v_receipt.payment_request_id IS NOT NULL THEN
      SELECT id
      INTO v_payable_id
      FROM public.payment_requests
      WHERE id = v_receipt.payment_request_id
        AND public.is_receipt_payable_request(payment_requests)
      LIMIT 1
      FOR UPDATE;
    END IF;

    IF v_payable_id IS NULL THEN
      SELECT id
      INTO v_payable_id
      FROM public.payment_requests
      WHERE goods_receipt_id = p_receipt_id
        AND public.is_receipt_payable_request(payment_requests)
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE;
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
        NULL,
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
        'Tự động tạo từ phiếu nhập kho không liên kết PO. Chênh lệch: ' || v_variance_summary::text
      )
      RETURNING id INTO v_payable_id;
    ELSE
      UPDATE public.payment_requests
      SET supplier_id = v_receipt.supplier_id,
          purchase_order_id = NULL,
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
          notes = 'Tự động tạo/cập nhật từ phiếu nhập kho không liên kết PO. Chênh lệch: ' || v_variance_summary::text
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
        CASE WHEN gri.variance_reason IS NOT NULL THEN 'Lý do lệch: ' || gri.variance_reason END
      ), '')
    FROM public.goods_receipt_items gri
    WHERE gri.goods_receipt_id = p_receipt_id
      AND GREATEST(0, COALESCE(gri.actual_quantity, gri.quantity, 0)) > 0
    ORDER BY gri.created_at ASC, gri.id ASC;
  END IF;

  UPDATE public.goods_receipts
  SET status = 'received',
      payable_status = CASE WHEN v_payable_id IS NULL THEN 'not_generated' ELSE 'generated' END,
      payment_request_id = COALESCE(v_payable_id, payment_request_id),
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



GRANT EXECUTE ON FUNCTION public.is_receipt_payable_request(public.payment_requests) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_receipt_payable_request(public.payment_requests) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_goods_receipt(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_goods_receipt(uuid, uuid) TO service_role;
