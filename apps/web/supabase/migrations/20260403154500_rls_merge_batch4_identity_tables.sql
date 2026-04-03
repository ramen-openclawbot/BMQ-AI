-- ============================================================================
-- v0.0.40 — RLS merge batch 4: identity / permission tables
--
-- Goal:
-- - remove remaining Performance Advisor warnings caused by permissive FOR ALL
--   policies overlapping SELECT
-- - preserve existing semantics for self-access and owner admin access
--
-- Scope:
-- - profiles
-- - user_roles
-- - user_module_permissions
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- profiles
-- Existing issue:
-- - "Authenticated users can select profiles" + owner_write_profiles(FOR ALL)
-- - users_update_own_profile already exists and must stay
-- Fix:
-- - keep one SELECT policy for authenticated
-- - keep self-update policy
-- - split owner admin policy into INSERT / UPDATE / DELETE only
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "owner_write_profiles" ON public.profiles;
DROP POLICY IF EXISTS "Authenticated users can select profiles" ON public.profiles;

CREATE POLICY "profiles_select"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "owner_insert_profiles"
  ON public.profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

CREATE POLICY "owner_update_profiles"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (public.has_role((select auth.uid()), 'owner'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

CREATE POLICY "owner_delete_profiles"
  ON public.profiles
  FOR DELETE
  TO authenticated
  USING (public.has_role((select auth.uid()), 'owner'));

-- users_update_own_profile intentionally remains unchanged

-- ────────────────────────────────────────────────────────────────────────────
-- user_roles
-- Existing issue:
-- - "Authenticated users can select user_roles" + owner_write_user_roles(FOR ALL)
-- Fix:
-- - keep one SELECT policy for authenticated
-- - split owner admin policy into INSERT / UPDATE / DELETE only
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "owner_write_user_roles" ON public.user_roles;
DROP POLICY IF EXISTS "Authenticated users can select user_roles" ON public.user_roles;

CREATE POLICY "user_roles_select"
  ON public.user_roles
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "owner_insert_user_roles"
  ON public.user_roles
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

CREATE POLICY "owner_update_user_roles"
  ON public.user_roles
  FOR UPDATE
  TO authenticated
  USING (public.has_role((select auth.uid()), 'owner'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

CREATE POLICY "owner_delete_user_roles"
  ON public.user_roles
  FOR DELETE
  TO authenticated
  USING (public.has_role((select auth.uid()), 'owner'));

-- ────────────────────────────────────────────────────────────────────────────
-- user_module_permissions
-- Existing issue:
-- - user_module_permissions_select already handles SELECT cleanly
-- - owner_write_module_permissions(FOR ALL) still overlaps SELECT and can
--   trigger advisor warning together with the SELECT policy
-- Fix:
-- - keep SELECT policy unchanged
-- - split owner write policy into INSERT / UPDATE / DELETE only
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "owner_write_module_permissions" ON public.user_module_permissions;

CREATE POLICY "owner_insert_module_permissions"
  ON public.user_module_permissions
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

CREATE POLICY "owner_update_module_permissions"
  ON public.user_module_permissions
  FOR UPDATE
  TO authenticated
  USING (public.has_role((select auth.uid()), 'owner'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

CREATE POLICY "owner_delete_module_permissions"
  ON public.user_module_permissions
  FOR DELETE
  TO authenticated
  USING (public.has_role((select auth.uid()), 'owner'));
