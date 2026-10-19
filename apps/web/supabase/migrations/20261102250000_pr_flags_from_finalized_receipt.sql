-- Đề nghị chi gắn phiếu nhập kho đã chốt phải hiện "Đã giao" + "Đã có hóa đơn".
--
-- Từ khi Kho chốt phiếu nhập (finalized_at, công nợ sinh từ phiếu nhập), không còn
-- bước nào bật payment_requests.delivery_status / invoice_created; màn hình đề nghị chi
-- vẫn báo "Chưa giao" + "Chưa có hóa đơn" dù hàng đã nhập (19/10: 33 phiếu, ví dụ
-- PR-ED536F42 ↔ GRN-000580). Hai trigger đồng bộ cờ, kèm backfill một lần.
-- Chỉ đổi hai cờ trạng thái; không đụng tiền, công nợ hay tồn kho.

-- 1) Kho chốt phiếu nhập → cập nhật mọi đề nghị chi đang gắn phiếu đó.
create or replace function public.sync_payment_requests_from_finalized_receipt()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.payment_requests pr
     set delivery_status = 'delivered',
         invoice_created = true
   where pr.goods_receipt_id = new.id
     and pr.status::text <> 'rejected'
     and (pr.delivery_status is distinct from 'delivered'
          or pr.invoice_created is distinct from true);
  return new;
end;
$$;

drop trigger if exists trg_sync_payment_requests_from_finalized_receipt on public.goods_receipts;
create trigger trg_sync_payment_requests_from_finalized_receipt
  after update of finalized_at on public.goods_receipts
  for each row
  when (new.finalized_at is not null and old.finalized_at is null)
  execute function public.sync_payment_requests_from_finalized_receipt();

-- 2) Đề nghị chi được gắn vào một phiếu nhập đã chốt sẵn → bật cờ ngay.
create or replace function public.set_payment_request_flags_from_receipt()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.goods_receipt_id is not null
     and new.status::text <> 'rejected'
     and exists (
       select 1 from public.goods_receipts gr
        where gr.id = new.goods_receipt_id and gr.finalized_at is not null
     ) then
    new.delivery_status := 'delivered';
    new.invoice_created := true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_payment_request_flags_from_receipt on public.payment_requests;
create trigger trg_set_payment_request_flags_from_receipt
  before insert or update of goods_receipt_id on public.payment_requests
  for each row
  execute function public.set_payment_request_flags_from_receipt();

-- 3) Backfill phạm vi chủ duyệt 19/10: đề nghị chi đã thanh toán, gắn phiếu nhập đã chốt,
--    đang báo đỏ "chưa tạo hóa đơn nhập kho" (33 phiếu). 148 phiếu chỉ lệch nhãn
--    "Chưa giao" (134 đã có hóa đơn, 14 chưa thanh toán) chờ chủ duyệt riêng.
update public.payment_requests pr
   set delivery_status = 'delivered',
       invoice_created = true
  from public.goods_receipts gr
 where gr.id = pr.goods_receipt_id
   and gr.finalized_at is not null
   and pr.status::text <> 'rejected'
   and pr.payment_status::text = 'paid'
   and pr.invoice_created is distinct from true
   and pr.requires_receipt is distinct from false;
