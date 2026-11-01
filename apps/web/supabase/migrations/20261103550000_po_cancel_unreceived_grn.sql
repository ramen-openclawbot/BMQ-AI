-- Huỷ PO bị chặn sai (anh Tâm 01/11, PO-000882 / GRN-000623 "chờ kho xác nhận").
-- Phiếu nhập tạo từ PO được trigger tự điền actual_quantity = SL đặt, nên điều kiện
-- "phiếu có số lượng > 0" chặn huỷ mọi PO đã gửi dù kho chưa nhận gì. Chỉ chặn khi
-- hàng đã thật sự vào kho: phiếu received/finalized, có lô tồn, có dịch chuyển kho,
-- đã trừ kho tự động, hoặc đã có bằng chứng quét. Phiếu chờ xác nhận được xoá như cũ.

CREATE OR REPLACE FUNCTION public.reject_payment_requests_on_po_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_paid text;
  v_blocked_receipts text;
  v_placeholder_ids uuid[];
begin
  if new.status::text = 'cancelled' and old.status::text is distinct from 'cancelled' then
    -- (1) Refuse the cancel when the PO's non-rejected payment requests already
    -- have money leaving. Unchanged from the previous definition.
    select string_agg(pr.request_number, ', ' order by pr.request_number)
      into v_paid
    from public.payment_requests pr
    where pr.purchase_order_id = new.id
      and pr.status::text <> 'rejected'
      and (
        pr.payment_status::text <> 'unpaid'
        or exists (select 1 from public.payment_allocations a where a.payment_request_id = pr.id)
      );
    if v_paid is not null then
      raise exception 'po_cancel_has_payments: Không hủy được PO %: phiếu chi % đã có tiền chi. Xử lý phiếu chi trước.',
        coalesce(new.po_number, new.id::text), v_paid
        using errcode = 'P0001';
    end if;

    -- (2) Refuse the cancel when any goods receipt of the PO is no longer an
    -- empty placeholder: received, finalized, posted to stock (batch or location move), auto-issued,
    -- or already referenced by supplier unit-scan evidence.
    select string_agg(gr.receipt_number, ', ' order by gr.receipt_number)
      into v_blocked_receipts
    from public.goods_receipts gr
    where gr.purchase_order_id = new.id
      and (
        gr.status::text = 'received'
        or gr.finalized_at is not null
        or exists (select 1 from public.inventory_batches b where b.goods_receipt_id = gr.id)
        or exists (select 1 from public.stock_location_moves m where m.goods_receipt_id = gr.id)
        or exists (
          select 1
          from public.goods_receipt_auto_issues ai
          where ai.goods_receipt_id = gr.id
        )
        or exists (
          select 1
          from public.material_supplier_unit_scan_evidence e
          where e.goods_receipt_id = gr.id
        )
      );
    if v_blocked_receipts is not null then
      raise exception 'po_cancel_has_receipt: Không hủy được PO %: phiếu nhập % đã có hàng nhập kho. Xử lý phiếu nhập trước.',
        coalesce(new.po_number, new.id::text), v_blocked_receipts
        using errcode = 'P0001';
    end if;

    -- (3) Reject the still-open payment requests, exactly as before.
    update public.payment_requests
    set status = 'rejected'::payment_request_status,
        rejection_reason = 'PO ' || coalesce(new.po_number, new.id::text) || ' đã hủy',
        approved_by = null,
        approved_at = now(),
        updated_at = now()
    where purchase_order_id = new.id
      and status::text <> 'rejected';

    -- (4) Remove the empty placeholder receipts of that PO. Collect them under
    -- the emptiness conditions first, then clear every reference and delete.
    select array_agg(gr.id)
      into v_placeholder_ids
    from public.goods_receipts gr
    where gr.purchase_order_id = new.id
      and gr.status::text <> 'received'
      and gr.finalized_at is null
      and not exists (select 1 from public.inventory_batches b where b.goods_receipt_id = gr.id)
      and not exists (select 1 from public.stock_location_moves m where m.goods_receipt_id = gr.id)
      and not exists (
        select 1
        from public.goods_receipt_auto_issues ai
        where ai.goods_receipt_id = gr.id
      )
      and not exists (
        select 1
        from public.material_supplier_unit_scan_evidence e
        where e.goods_receipt_id = gr.id
      );

    if v_placeholder_ids is not null then
      update public.payment_requests
      set goods_receipt_id = null
      where goods_receipt_id = any(v_placeholder_ids);

      update public.invoices
      set goods_receipt_id = null
      where goods_receipt_id = any(v_placeholder_ids);

      update public.inventory_batches
      set goods_receipt_id = null
      where goods_receipt_id = any(v_placeholder_ids);

      delete from public.goods_receipt_items
      where goods_receipt_id = any(v_placeholder_ids);

      delete from public.goods_receipts
      where id = any(v_placeholder_ids);
    end if;
  end if;
  return new;
end;
$function$;
