-- Backfill nhãn giao hàng, chủ duyệt 19/10: đề nghị chi gắn phiếu nhập đã chốt nhưng còn
-- "Chưa giao" (148 phiếu: 134 đã thanh toán + đã có hóa đơn, 14 chưa thanh toán).
-- Chỉ đổi delivery_status; không đụng invoice_created, tiền, công nợ hay tồn kho.
-- Phiếu mới do trigger của 20261102250000 xử lý.
update public.payment_requests pr
   set delivery_status = 'delivered'
  from public.goods_receipts gr
 where gr.id = pr.goods_receipt_id
   and gr.finalized_at is not null
   and pr.status::text <> 'rejected'
   and pr.delivery_status is distinct from 'delivered';
