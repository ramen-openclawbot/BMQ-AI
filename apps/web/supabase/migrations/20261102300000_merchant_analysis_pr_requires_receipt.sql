-- BMQ merchant agent — PR view exposes whether a goods receipt is required.
-- Rent, electricity and other service PRs set requires_receipt = false; without
-- these columns the owner chat counted them as "paid but not received".
-- Columns are appended at the end so create or replace view stays valid.

create or replace view merchant_analysis.payment_requests_v as
select
  pr.id,
  pr.request_number,
  pr.title,
  pr.status,
  pr.payment_status,
  pr.delivery_status,
  pr.payment_method,
  pr.payment_type,
  pr.total_amount,
  pr.vat_amount,
  pr.paid_at,
  pr.approved_at,
  pr.purchase_order_id,
  pr.goods_receipt_id,
  pr.supplier_id,
  pr.invoice_created,
  pr.created_at,
  pr.requires_receipt,
  pr.no_receipt_reason
from public.payment_requests pr;

grant select on merchant_analysis.payment_requests_v to merchant_analyst;

comment on view merchant_analysis.payment_requests_v is
  'Đề nghị thanh toán (PR): mã, trạng thái, phương thức, số tiền, VAT, liên kết PO/phiếu nhập/nhà cung cấp, và requires_receipt (false = khoản không cần phiếu nhập như điện, thuê kho).';
