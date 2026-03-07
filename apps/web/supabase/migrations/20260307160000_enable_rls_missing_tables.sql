-- ============================================================================
-- v0.0.23 — Enable RLS on tables missing Row Level Security
-- Fixes 3 ERROR-level security findings from Supabase Security Advisor
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. supplier_scan_templates
--    Accessed ONLY by edge function scan-invoice via service_role key.
--    service_role bypasses RLS → edge function unaffected.
--    Enable RLS with NO authenticated policy → direct PostgREST calls blocked.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.supplier_scan_templates ENABLE ROW LEVEL SECURITY;

-- No authenticated policy intentional: only service_role (edge functions) should access this table.

-- ────────────────────────────────────────────────────────────────────────────
-- 2. mini_crm_po_template_learning_logs
--    Used by MiniCrm.tsx to log template changes (insert) and review history.
--    Consistent with other mini_crm tables: authenticated users full access.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.mini_crm_po_template_learning_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage po template learning logs"
  ON public.mini_crm_po_template_learning_logs
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. sku_formulations
--    Used by SkuCostsManagement.tsx for full CRUD (read, insert, update, delete).
--    All authenticated users can access.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.sku_formulations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage sku formulations"
  ON public.sku_formulations
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ============================================================================
