-- BMQ merchant agent — GĐ2 procurement read views for merchant_analysis.
-- Adds read-only PO/PR/goods-receipt views next to the GĐ1 analysis views.
-- This migration is intentionally NOT applied by the coding agent.

create or replace view merchant_analysis.purchase_orders_v as
select
  po.id,
  po.po_number,
  po.order_date,
  po.expected_date,
  po.status,
  po.total_amount,
  po.vat_amount,
  po.notes,
  po.supplier_id,
  po.created_at
from public.purchase_orders po;

create or replace view merchant_analysis.purchase_order_lines_v as
select
  i.id,
  i.purchase_order_id,
  i.product_name,
  i.quantity,
  i.unit,
  i.unit_price,
  i.line_total,
  i.sku_id
from public.purchase_order_items i;

create or replace view merchant_analysis.suppliers_v as
select
  s.id,
  s.name,
  s.short_code,
  s.category,
  s.payment_terms_days,
  s.vat_included_in_price,
  s.default_receiving_location
from public.suppliers s;

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
  pr.created_at
from public.payment_requests pr;

create or replace view merchant_analysis.goods_receipts_v as
select
  gr.id,
  gr.receipt_number,
  gr.receipt_date,
  gr.status,
  gr.payable_status,
  gr.purchase_order_id,
  gr.payment_request_id,
  gr.supplier_id,
  gr.receiving_location,
  gr.total_quantity,
  gr.finalized_at,
  gr.created_at
from public.goods_receipts gr;

create or replace view merchant_analysis.goods_receipt_lines_v as
select
  grl.id,
  grl.goods_receipt_id,
  grl.purchase_order_item_id,
  grl.product_name,
  grl.ordered_quantity,
  grl.quantity,
  grl.actual_quantity,
  grl.unit,
  grl.unit_price,
  grl.line_status,
  grl.variance_reason,
  grl.sku_id
from public.goods_receipt_items grl;

grant select on merchant_analysis.purchase_orders_v to merchant_analyst;
grant select on merchant_analysis.purchase_order_lines_v to merchant_analyst;
grant select on merchant_analysis.suppliers_v to merchant_analyst;
grant select on merchant_analysis.payment_requests_v to merchant_analyst;
grant select on merchant_analysis.goods_receipts_v to merchant_analyst;
grant select on merchant_analysis.goods_receipt_lines_v to merchant_analyst;

comment on view merchant_analysis.purchase_orders_v is
  'Đơn mua hàng (PO): mã PO, ngày đặt/dự kiến, trạng thái, tổng tiền, VAT và nhà cung cấp.';
comment on view merchant_analysis.purchase_order_lines_v is
  'Dòng hàng của đơn mua hàng: sản phẩm, số lượng, đơn giá và thành tiền.';
comment on view merchant_analysis.suppliers_v is
  'Nhà cung cấp: tên, mã ngắn, nhóm, điều khoản thanh toán và nơi nhận hàng; không có thông tin ngân hàng/liên hệ.';
comment on view merchant_analysis.payment_requests_v is
  'Đề nghị thanh toán (PR): mã, trạng thái, phương thức, số tiền, VAT và liên kết PO/phiếu nhập/nhà cung cấp.';
comment on view merchant_analysis.goods_receipts_v is
  'Phiếu nhập hàng: mã phiếu, ngày nhập, trạng thái, số lượng và liên kết PO/PR/nhà cung cấp.';
comment on view merchant_analysis.goods_receipt_lines_v is
  'Dòng hàng của phiếu nhập: sản phẩm, số lượng đặt/thực nhận, đơn giá và chênh lệch.';
