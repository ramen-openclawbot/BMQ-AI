-- Allow approved old-order payment requests to open a warehouse receiving queue.
-- Previously the "Đánh dấu đã giao" action only marked delivery_status and did not
-- create goods_receipts, so old-order/cong-no requests never appeared in Nhập kho.

CREATE OR REPLACE FUNCTION public.ensure_payment_request_receipt_queue(p_payment_request_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request public.payment_requests%ROWTYPE;
  v_receipt_id uuid;
  v_receipt_number text;
  v_total_quantity numeric;
BEGIN
  SELECT *
  INTO v_request
  FROM public.payment_requests
  WHERE id = p_payment_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment request % not found', p_payment_request_id;
  END IF;

  IF v_request.goods_receipt_id IS NOT NULL THEN
    RETURN v_request.goods_receipt_id;
  END IF;

  SELECT id
  INTO v_receipt_id
  FROM public.goods_receipts
  WHERE payment_request_id = p_payment_request_id
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE;

  IF v_receipt_id IS NULL THEN
    SELECT COALESCE(sum(quantity), 0)
    INTO v_total_quantity
    FROM public.payment_request_items
    WHERE payment_request_id = p_payment_request_id;

    v_receipt_number := public.generate_receipt_number();

    INSERT INTO public.goods_receipts (
      receipt_number,
      supplier_id,
      receipt_date,
      image_url,
      status,
      total_quantity,
      purchase_order_id,
      payment_request_id,
      payable_status,
      variance_summary,
      notes,
      created_by
    ) VALUES (
      v_receipt_number,
      v_request.supplier_id,
      COALESCE((v_request.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, CURRENT_DATE),
      v_request.image_url,
      'confirmed',
      v_total_quantity,
      v_request.purchase_order_id,
      p_payment_request_id,
      CASE WHEN v_request.payment_status = 'paid' THEN 'paid' ELSE 'not_generated' END,
      '{}'::jsonb,
      'Tự động tạo phiếu nhập kho từ đề nghị chi đơn cũ/công nợ; kế toán kho xác nhận số thực nhận.',
      v_request.created_by
    )
    RETURNING id INTO v_receipt_id;
  END IF;

  -- Keep the receiving lines aligned to the payment request until warehouse finalizes.
  DELETE FROM public.goods_receipt_items
  WHERE goods_receipt_id = v_receipt_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.goods_receipts gr
      WHERE gr.id = v_receipt_id
        AND gr.status = 'received'
    );

  IF EXISTS (SELECT 1 FROM public.goods_receipts WHERE id = v_receipt_id AND status <> 'received') THEN
    INSERT INTO public.goods_receipt_items (
      goods_receipt_id,
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
      pri.product_name,
      pri.quantity,
      NULL,
      0,
      pri.unit,
      pri.unit_price,
      pri.sku_id,
      NULLIF(concat_ws('; ', 'Từ đề nghị chi: ' || v_request.request_number, pri.notes), '')
    FROM public.payment_request_items pri
    WHERE pri.payment_request_id = p_payment_request_id
    ORDER BY pri.created_at ASC;
  END IF;

  UPDATE public.payment_requests
  SET goods_receipt_id = v_receipt_id,
      updated_at = now()
  WHERE id = p_payment_request_id;

  RETURN v_receipt_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_payment_request_receipt_queue(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_payment_request_receipt_queue(uuid) TO service_role;
