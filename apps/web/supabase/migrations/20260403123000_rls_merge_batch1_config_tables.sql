-- ============================================================================
-- v0.0.37 — RLS merge batch 1: config / drive tables
--
-- Goal:
-- - remove Performance Advisor warnings about multiple permissive policies
--   on authenticated + SELECT for Batch 1 tables
-- - preserve existing access semantics
--
-- Strategy:
-- - replace broad FOR ALL policies with explicit SELECT + INSERT + UPDATE + DELETE
-- - keep read access open to authenticated users where it already existed
-- - keep write access restricted to owner/staff (or owner for app_settings)
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- app_settings
-- Existing issue:
-- - "Authenticated users can select app_settings" + owner_write_app_settings(FOR ALL)
-- Result:
-- - SELECT hits two permissive policies
-- Fix:
-- - keep one SELECT policy for authenticated
-- - split owner write policy into INSERT / UPDATE / DELETE only
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "owner_write_app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Authenticated users can select app_settings" ON public.app_settings;

CREATE POLICY "app_settings_select"
  ON public.app_settings
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "owner_insert_app_settings"
  ON public.app_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

CREATE POLICY "owner_update_app_settings"
  ON public.app_settings
  FOR UPDATE
  TO authenticated
  USING (public.has_role((select auth.uid()), 'owner'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner'));

CREATE POLICY "owner_delete_app_settings"
  ON public.app_settings
  FOR DELETE
  TO authenticated
  USING (public.has_role((select auth.uid()), 'owner'));

-- ────────────────────────────────────────────────────────────────────────────
-- drive_file_index
-- Existing issue:
-- - "Authenticated users can select drive_file_index" + config_write_drive_file_index(FOR ALL)
-- Fix:
-- - keep one SELECT policy for authenticated
-- - split owner/staff write policy into INSERT / UPDATE / DELETE only
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "config_write_drive_file_index" ON public.drive_file_index;
DROP POLICY IF EXISTS "Authenticated users can select drive_file_index" ON public.drive_file_index;

CREATE POLICY "drive_file_index_select"
  ON public.drive_file_index
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "config_insert_drive_file_index"
  ON public.drive_file_index
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

CREATE POLICY "config_update_drive_file_index"
  ON public.drive_file_index
  FOR UPDATE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  )
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

CREATE POLICY "config_delete_drive_file_index"
  ON public.drive_file_index
  FOR DELETE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

-- ────────────────────────────────────────────────────────────────────────────
-- drive_import_logs
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "config_write_drive_import_logs" ON public.drive_import_logs;
DROP POLICY IF EXISTS "Authenticated users can select drive_import_logs" ON public.drive_import_logs;

CREATE POLICY "drive_import_logs_select"
  ON public.drive_import_logs
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "config_insert_drive_import_logs"
  ON public.drive_import_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

CREATE POLICY "config_update_drive_import_logs"
  ON public.drive_import_logs
  FOR UPDATE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  )
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

CREATE POLICY "config_delete_drive_import_logs"
  ON public.drive_import_logs
  FOR DELETE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

-- ────────────────────────────────────────────────────────────────────────────
-- drive_sync_config
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "config_write_drive_sync_config" ON public.drive_sync_config;
DROP POLICY IF EXISTS "Authenticated users can select drive_sync_config" ON public.drive_sync_config;

CREATE POLICY "drive_sync_config_select"
  ON public.drive_sync_config
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "config_insert_drive_sync_config"
  ON public.drive_sync_config
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

CREATE POLICY "config_update_drive_sync_config"
  ON public.drive_sync_config
  FOR UPDATE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  )
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

CREATE POLICY "config_delete_drive_sync_config"
  ON public.drive_sync_config
  FOR DELETE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );
