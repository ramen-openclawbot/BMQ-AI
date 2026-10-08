-- Trình chi gấp — hỗ trợ CEO upload nhiều ảnh UNC một lần.
--
-- Additive only. The bulk flow reads every UNC image through the existing
-- payment-unc-approve extract mode and stores two extra OCR fields on the
-- server-side draft so the pure matcher (src/lib/payment-unc-bulk-match.ts) can
-- pair a UNC with the right phiếu trình chi:
--   (a) ocr_beneficiary_name — tên người/đơn vị nhận tiền trên ảnh UNC,
--   (b) ocr_transfer_content  — nội dung chuyển khoản/ghi chú giao dịch.
--
-- No RLS / policy / privilege change is needed: the table keeps its existing
-- access rules and its table-level service-role privilege, and PostgreSQL
-- table-level privileges already cover columns added later. Nothing else is
-- redefined and no scheduled job is created.

alter table public.payment_unc_ocr_drafts
  add column if not exists ocr_beneficiary_name text,
  add column if not exists ocr_transfer_content text;

comment on column public.payment_unc_ocr_drafts.ocr_beneficiary_name is
  'OCR: tên người/đơn vị nhận tiền trên ảnh UNC (dùng cho ghép nhiều UNC).';
comment on column public.payment_unc_ocr_drafts.ocr_transfer_content is
  'OCR: nội dung chuyển khoản/ghi chú giao dịch trên ảnh UNC (dùng cho ghép nhiều UNC).';
