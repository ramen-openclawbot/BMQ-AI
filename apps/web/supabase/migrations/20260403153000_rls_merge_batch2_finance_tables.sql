-- ============================================================================
-- v0.0.38 — RLS merge batch 2: finance tables
--
-- Goal:
-- - remove Performance Advisor warnings about multiple permissive policies
--   on authenticated + SELECT for high-traffic finance tables
-- - preserve current access semantics (read for authenticated, write for owner/staff)
--
-- Strategy:
-- - replace broad FOR ALL policies with explicit SELECT + INSERT + UPDATE + DELETE
-- - keep SELECT policy separate so read queries no longer evaluate overlapping
--   permissive write rules
-- ============================================================================

-- Shared write rule for this batch:
-- owner/staff only

-- ────────────────────────────────────────────────────────────────────────────
-- invoices
-- Existing issue:
-- - "Authenticated users can select invoices" + finance_write_invoices(FOR ALL)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "finance_write_invoices" ON public.invoices;
DROP POLICY IF EXISTS "Authenticated users can select invoices" ON public.invoices;

CREATE POLICY "invoices_select"
  ON public.invoices
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "finance_insert_invoices"
  ON public.invoices
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

CREATE POLICY "finance_update_invoices"
  ON public.invoices
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

CREATE POLICY "finance_delete_invoices"
  ON public.invoices
  FOR DELETE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

-- ────────────────────────────────────────────────────────────────────────────
-- invoice_items
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "finance_write_invoice_items" ON public.invoice_items;
DROP POLICY IF EXISTS "Authenticated users can select invoice_items" ON public.invoice_items;

CREATE POLICY "invoice_items_select"
  ON public.invoice_items
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "finance_insert_invoice_items"
  ON public.invoice_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

CREATE POLICY "finance_update_invoice_items"
  ON public.invoice_items
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

CREATE POLICY "finance_delete_invoice_items"
  ON public.invoice_items
  FOR DELETE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

-- ────────────────────────────────────────────────────────────────────────────
-- payment_requests
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "finance_write_payment_requests" ON public.payment_requests;
DROP POLICY IF EXISTS "Authenticated users can select payment_requests" ON public.payment_requests;

CREATE POLICY "payment_requests_select"
  ON public.payment_requests
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "finance_insert_payment_requests"
  ON public.payment_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

CREATE POLICY "finance_update_payment_requests"
  ON public.payment_requests
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

CREATE POLICY "finance_delete_payment_requests"
  ON public.payment_requests
  FOR DELETE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

-- ────────────────────────────────────────────────────────────────────────────
-- payment_request_items
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "finance_write_payment_request_items" ON public.payment_request_items;
DROP POLICY IF EXISTS "Authenticated users can select payment_request_items" ON public.payment_request_items;

CREATE POLICY "payment_request_items_select"
  ON public.payment_request_items
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "finance_insert_payment_request_items"
  ON public.payment_request_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );

CREATE POLICY "finance_update_payment_request_items"
  ON public.payment_request_items
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

CREATE POLICY "finance_delete_payment_request_items"
  ON public.payment_request_items
  FOR DELETE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
  );
