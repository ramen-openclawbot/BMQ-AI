-- ============================================================================
-- v0.0.41 — Allow CRM KB approval/apply for module editors
--
-- Problem:
-- - Mini CRM KB approval flow writes to:
--   * mini_crm_knowledge_profiles
--   * mini_crm_knowledge_profile_versions
--   * mini_crm_knowledge_change_requests
-- - Current RLS only allows owner/staff writes.
-- - Users who can legitimately edit CRM / Sales PO screens may see the approve
--   button but fail with RLS when applying KB.
--
-- Fix:
-- - keep owner/staff access
-- - additionally allow users with can_edit=true on module `crm` or
--   `sales_po_inbox` to write these KB tables
-- ============================================================================

create or replace function public.can_edit_module(p_user_id uuid, p_module_key text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.user_module_permissions ump
    where ump.user_id = p_user_id
      and ump.module_key = p_module_key
      and ump.can_edit = true
  );
$$;

-- mini_crm_knowledge_profiles
DROP POLICY IF EXISTS "crm_write_mini_crm_knowledge_profiles" ON public.mini_crm_knowledge_profiles;
CREATE POLICY "crm_write_mini_crm_knowledge_profiles"
  ON public.mini_crm_knowledge_profiles FOR ALL TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.can_edit_module((select auth.uid()), 'crm')
    OR public.can_edit_module((select auth.uid()), 'sales_po_inbox')
  )
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.can_edit_module((select auth.uid()), 'crm')
    OR public.can_edit_module((select auth.uid()), 'sales_po_inbox')
  );

-- mini_crm_knowledge_change_requests
DROP POLICY IF EXISTS "crm_write_mini_crm_knowledge_change_requests" ON public.mini_crm_knowledge_change_requests;
CREATE POLICY "crm_write_mini_crm_knowledge_change_requests"
  ON public.mini_crm_knowledge_change_requests FOR ALL TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.can_edit_module((select auth.uid()), 'crm')
    OR public.can_edit_module((select auth.uid()), 'sales_po_inbox')
  )
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.can_edit_module((select auth.uid()), 'crm')
    OR public.can_edit_module((select auth.uid()), 'sales_po_inbox')
  );

-- mini_crm_knowledge_profile_versions
DROP POLICY IF EXISTS "crm_write_mini_crm_knowledge_profile_versions" ON public.mini_crm_knowledge_profile_versions;
CREATE POLICY "crm_write_mini_crm_knowledge_profile_versions"
  ON public.mini_crm_knowledge_profile_versions FOR ALL TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.can_edit_module((select auth.uid()), 'crm')
    OR public.can_edit_module((select auth.uid()), 'sales_po_inbox')
  )
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.can_edit_module((select auth.uid()), 'crm')
    OR public.can_edit_module((select auth.uid()), 'sales_po_inbox')
  );
