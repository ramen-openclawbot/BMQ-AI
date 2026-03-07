-- ============================================================================
-- v0.0.25 — Security Hardening: Critical RLS fixes + Function search_path
-- Based on Supabase Security Advisor (94 warnings)
--
-- WHAT WE FIX:
-- 1. user_roles   — privilege escalation risk: any user could grant themselves owner
-- 2. app_settings — any user could change global app config
-- 3. profiles     — any user could modify another user's profile
-- 4. 14 functions — mutable search_path vulnerability
--
-- INTENTIONALLY DEFERRED (75 warnings):
-- Business tables (payment_requests, orders, suppliers, etc.) use USING(true)
-- write policies — this is intentional for an internal app with trusted staff.
-- Restricting per-role would require deep business logic analysis and risks
-- breaking existing workflows.
--
-- REQUIRES DASHBOARD ACTION:
-- Auth → Password settings → Enable "Leaked password protection" (HaveIBeenPwned)
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- PHẦN 1: CRITICAL — user_roles (privilege escalation risk)
-- Any authenticated user could INSERT a row to grant themselves 'owner' role.
-- Fix: Only owner can write to user_roles.
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can insert user_roles" ON public.user_roles;
DROP POLICY IF EXISTS "Authenticated users can update user_roles" ON public.user_roles;
DROP POLICY IF EXISTS "Authenticated users can delete user_roles" ON public.user_roles;

CREATE POLICY "owner_write_user_roles"
  ON public.user_roles
  FOR ALL
  TO authenticated
  USING (public.has_role((select auth.uid()), 'owner'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

-- ────────────────────────────────────────────────────────────────────────────
-- PHẦN 2: HIGH — app_settings
-- Any user could change global configuration visible to all.
-- Fix: Only owner can INSERT/UPDATE/DELETE.
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can insert app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Authenticated users can update app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Authenticated users can delete app_settings" ON public.app_settings;

CREATE POLICY "owner_write_app_settings"
  ON public.app_settings
  FOR ALL
  TO authenticated
  USING (public.has_role((select auth.uid()), 'owner'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

-- ────────────────────────────────────────────────────────────────────────────
-- PHẦN 3: HIGH — profiles
-- Any user could modify another user's profile data.
-- Fix: Users can only UPDATE their own profile; owner has full access.
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can insert profiles" ON public.profiles;
DROP POLICY IF EXISTS "Authenticated users can update profiles" ON public.profiles;
DROP POLICY IF EXISTS "Authenticated users can delete profiles" ON public.profiles;

-- Users update only their own profile
CREATE POLICY "users_update_own_profile"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

-- Owner has full write access (for admin management)
CREATE POLICY "owner_write_profiles"
  ON public.profiles
  FOR ALL
  TO authenticated
  USING (public.has_role((select auth.uid()), 'owner'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

-- ────────────────────────────────────────────────────────────────────────────
-- PHẦN 4: Fix mutable search_path on 14 functions
-- Pins search_path to 'public' to prevent search_path injection attacks.
-- All functions reference objects in public schema so SET search_path = public is safe.
-- ────────────────────────────────────────────────────────────────────────────

-- Trigger functions (no args, returns trigger)
ALTER FUNCTION public.set_updated_at()                           SET search_path = public;
ALTER FUNCTION public.touch_updated_at()                         SET search_path = public;
ALTER FUNCTION public.handle_updated_at()                        SET search_path = public;
ALTER FUNCTION public.update_updated_at_column()                 SET search_path = public;
ALTER FUNCTION public.normalize_email_before_write()             SET search_path = public;
ALTER FUNCTION public.set_mini_crm_po_templates_updated_at()     SET search_path = public;
ALTER FUNCTION public.set_mini_crm_customer_price_list_updated_at() SET search_path = public;
ALTER FUNCTION public.set_mini_crm_knowledge_profiles_updated_at()  SET search_path = public;
ALTER FUNCTION public.enforce_goods_receipt_raw_material_sku()   SET search_path = public;
ALTER FUNCTION public.guard_inventory_batch_expiry_once()        SET search_path = public;
ALTER FUNCTION public.set_supplier_alias_key()                   SET search_path = public;

-- Functions with arguments
ALTER FUNCTION public.normalize_storage_path(text, text)         SET search_path = public;
ALTER FUNCTION public.increment_supplier_template_hit(text)      SET search_path = public;
ALTER FUNCTION public.cleanup_expired_rate_limits()              SET search_path = public;

-- ============================================================================
-- REMINDER (manual action required):
-- Go to Supabase Dashboard → Authentication → Sign In / Up → Password
-- → Enable "Leaked Password Protection" (HaveIBeenPwned check)
-- ============================================================================
