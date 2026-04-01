-- ============================================================================
-- v0.0.32 — Thêm địa chỉ giao hàng vào bảng mini_crm_customers
-- Dùng để tự động điền địa chỉ giao hàng trong phiếu xuất kho
-- ============================================================================

ALTER TABLE public.mini_crm_customers
  ADD COLUMN IF NOT EXISTS address text;

COMMENT ON COLUMN public.mini_crm_customers.address IS
  'Địa chỉ giao hàng mặc định của khách hàng, tự động điền vào phiếu xuất kho';
