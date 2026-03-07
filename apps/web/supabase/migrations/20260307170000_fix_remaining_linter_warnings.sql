-- ============================================================================
-- v0.0.24 — Fix remaining 6 Performance Advisor warnings
-- 1. user_module_permissions: merge 2 overlapping SELECT policies → 1 (5 warnings)
-- 2. ceo_daily_closing_declarations: drop duplicate index created in v0.0.22 (1 warning)
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- PHẦN 1: user_module_permissions — gộp 2 SELECT policies thành 1
--
-- Trước đây (v0.0.21): 2 policies riêng biệt:
--   - owner_full_access_module_permissions (FOR ALL) → covers SELECT
--   - users_read_own_permissions (FOR SELECT)
-- → Postgres phải evaluate CẢ 2 cho mọi SELECT query = 5 warnings × 5 roles
--
-- Sau: 1 SELECT policy duy nhất (OR logic) + 1 write policy cho owner
-- ────────────────────────────────────────────────────────────────────────────

-- Drop cả 2 policies cũ (đã được update auth.uid() → (select auth.uid()) ở v0.0.21)
DROP POLICY IF EXISTS "owner_full_access_module_permissions" ON public.user_module_permissions;
DROP POLICY IF EXISTS "users_read_own_permissions" ON public.user_module_permissions;

-- Policy SELECT duy nhất: owner xem tất cả, user xem của mình
CREATE POLICY "user_module_permissions_select"
  ON public.user_module_permissions
  FOR SELECT
  USING (
    (select auth.uid()) = user_id
    OR public.has_role((select auth.uid()), 'owner')
  );

-- Policy WRITE riêng cho owner (INSERT / UPDATE / DELETE)
CREATE POLICY "owner_write_module_permissions"
  ON public.user_module_permissions
  FOR ALL  -- covers INSERT, UPDATE, DELETE (SELECT đã được policy trên handle)
  TO authenticated
  USING (public.has_role((select auth.uid()), 'owner'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

-- ────────────────────────────────────────────────────────────────────────────
-- PHẦN 2: Drop duplicate index trên ceo_daily_closing_declarations
--
-- idx_ceo_daily_closing_declarations_closing_date: đã tồn tại sẵn trên production
-- idx_ceo_declarations_closing_date: do migration v0.0.22 tạo thêm → trùng
-- → Drop cái v0.0.22 tạo, giữ cái cũ (tên đầy đủ hơn)
-- ────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.idx_ceo_declarations_closing_date;

-- ============================================================================
