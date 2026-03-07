-- ============================================================================
-- v0.0.21 — Supabase Performance Advisor Linter Fixes
-- Fix: RLS InitPlan (5 policies), Multiple Permissive Policies (11 tables),
--       Duplicate Indexes (inventory_batches)
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- PHẦN 1: Fix auth_rls_initplan — auth.uid() → (select auth.uid())
-- Prevents per-row re-evaluation of auth functions in RLS policies
-- ────────────────────────────────────────────────────────────────────────────

-- 1a. user_module_permissions — owner_full_access_module_permissions
DROP POLICY IF EXISTS "owner_full_access_module_permissions" ON public.user_module_permissions;
CREATE POLICY "owner_full_access_module_permissions"
  ON public.user_module_permissions
  FOR ALL
  USING (public.has_role((select auth.uid()), 'owner'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

-- 1b. user_module_permissions — users_read_own_permissions
DROP POLICY IF EXISTS "users_read_own_permissions" ON public.user_module_permissions;
CREATE POLICY "users_read_own_permissions"
  ON public.user_module_permissions
  FOR SELECT
  USING ((select auth.uid()) = user_id);

-- 1c. user_invitations — owner_full_access_invitations
DROP POLICY IF EXISTS "owner_full_access_invitations" ON public.user_invitations;
CREATE POLICY "owner_full_access_invitations"
  ON public.user_invitations
  FOR ALL
  USING (public.has_role((select auth.uid()), 'owner'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

-- 1d. audit_logs — Owners can read audit logs
DROP POLICY IF EXISTS "Owners can read audit logs" ON public.audit_logs;
CREATE POLICY "Owners can read audit logs"
  ON public.audit_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = (select auth.uid())
        AND user_roles.role = 'owner'
    )
  );

-- 1e. ai_function_rate_limits — Owners can view rate limits
DROP POLICY IF EXISTS "Owners can view rate limits" ON public.ai_function_rate_limits;
CREATE POLICY "Owners can view rate limits"
  ON public.ai_function_rate_limits FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = (select auth.uid())
        AND user_roles.role = 'owner'
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- PHẦN 2: Fix multiple_permissive_policies — Drop redundant SELECT policies
-- When a table has FOR ALL + FOR SELECT policies, FOR ALL already covers SELECT
-- ────────────────────────────────────────────────────────────────────────────

-- 2a. mini_crm tables (6 tables — "read" policy redundant with "manage" FOR ALL)
DROP POLICY IF EXISTS "Authenticated users can read customer contracts" ON public.mini_crm_customer_contracts;
DROP POLICY IF EXISTS "Authenticated users can read customer price list" ON public.mini_crm_customer_price_list;
DROP POLICY IF EXISTS "Authenticated users can read po templates" ON public.mini_crm_po_templates;
DROP POLICY IF EXISTS "Authenticated users can read knowledge profiles" ON public.mini_crm_knowledge_profiles;
DROP POLICY IF EXISTS "mini_crm_customer_emails read" ON public.mini_crm_customer_emails;
DROP POLICY IF EXISTS "mini_crm_customers read" ON public.mini_crm_customers;

-- 2b. Other tables (4 tables — "read" policy redundant with "write" FOR ALL)
DROP POLICY IF EXISTS "cash_fund_topups read" ON public.cash_fund_topups;
DROP POLICY IF EXISTS "ceo_declarations read" ON public.ceo_daily_closing_declarations;
DROP POLICY IF EXISTS "customer_po_inbox read" ON public.customer_po_inbox;
DROP POLICY IF EXISTS "daily_reconciliations read" ON public.daily_reconciliations;

-- 2c. supplier_aliases — "read" redundant with "write" FOR ALL
DROP POLICY IF EXISTS "supplier_aliases_read" ON public.supplier_aliases;

-- NOTE: user_module_permissions keeps both policies (owner_full_access + users_read_own)
-- because they have DIFFERENT logic (owner sees all vs user sees own). This is intentional.

-- ────────────────────────────────────────────────────────────────────────────
-- PHẦN 3: Drop duplicate indexes on inventory_batches
-- ────────────────────────────────────────────────────────────────────────────

-- Keep idx_inventory_batches_expiry_date, drop the shorter-named duplicate
DROP INDEX IF EXISTS public.idx_inventory_batches_expiry;

-- Keep idx_inventory_batches_inventory_item_id, drop the shorter-named duplicate
DROP INDEX IF EXISTS public.idx_inventory_batches_inventory_item;

-- ============================================================================
COMMENT ON TABLE public.ai_function_rate_limits IS 'Rate limit tracking cho AI scan functions (v0.0.19, RLS fixed v0.0.21)';
