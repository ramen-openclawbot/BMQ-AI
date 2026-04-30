-- Fix Kingfoodmart PO row-item template column mapping.
-- Export-PO-Data.xlsx layout:
--   A  Mã chi nhánh
--   D  Mã PO
--   L  Ngày giao hàng dự kiến
--   O  Barcode / SKU
--   P  Tên sản phẩm
--   Q  Đơn vị
--   R  Số lượng
--   U  Đơn giá NCC chào
--   AE Thành tiền (-VAT)
--   AG Tổng tiền PO (-VAT)
--   AH Tổng thuế
--   AI Tổng tiền PO (+VAT)

update public.mini_crm_po_templates t
set parser_config = jsonb_set(
    jsonb_set(
      jsonb_set(
        coalesce(t.parser_config, '{}'::jsonb),
        '{rowItemColumns,skuColumnIndex}',
        '15'::jsonb,
        true
      ),
      '{rowItemColumns,lineTotalColumnIndex}',
      '31'::jsonb,
      true
    ),
    '{totalsColumns}',
    '{"subtotalColumnIndex":33,"vatColumnIndex":34,"totalColumnIndex":35,"qtyTotalColumnIndex":37,"itemCountColumnIndex":38}'::jsonb,
    true
  ),
  confirmation_snapshot = jsonb_set(
    coalesce(t.confirmation_snapshot, '{}'::jsonb),
    '{autoParseValidation}',
    '{"senderEmail":"dathang@kingfoodmart.com","attachmentName":"Export-PO-Data.xlsx","skuColumn":"Barcode","status":"validated_against_kingfood_samples_2026_04"}'::jsonb,
    true
  ),
  parse_confidence = greatest(coalesce(t.parse_confidence, 0), 1),
  updated_at = now()
from public.mini_crm_customers c
where t.customer_id = c.id
  and c.customer_code = 'b2b-kfm'
  and t.file_name = 'Export-PO-Data.xlsx'
  and t.is_active = true;
