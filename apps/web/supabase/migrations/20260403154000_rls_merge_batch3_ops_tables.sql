-- ============================================================================
-- v0.0.39 — RLS merge batch 3: operations tables
--
-- Goal:
-- - remove Performance Advisor warnings about multiple permissive policies
--   on authenticated + SELECT for operations tables
-- - preserve current access semantics (read for authenticated, write for
--   owner/staff/warehouse)
--
-- Strategy:
-- - replace broad FOR ALL policies with explicit SELECT + INSERT + UPDATE + DELETE
-- - keep SELECT policy separate so read queries no longer evaluate overlapping
--   permissive write rules
-- ============================================================================

-- Shared write rule for this batch:
-- owner/staff/warehouse only

-- ────────────────────────────────────────────────────────────────────────────
-- orders
-- Existing issue:
-- - "Authenticated users can select orders" + ops_write_orders(FOR ALL)
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "ops_write_orders" ON public.orders;
DROP POLICY IF EXISTS "Authenticated users can select orders" ON public.orders;

CREATE POLICY "orders_select"
  ON public.orders
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "ops_insert_orders"
  ON public.orders
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.has_role((select auth.uid()), 'warehouse')
  );

CREATE POLICY "ops_update_orders"
  ON public.orders
  FOR UPDATE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.has_role((select auth.uid()), 'warehouse')
  )
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.has_role((select auth.uid()), 'warehouse')
  );

CREATE POLICY "ops_delete_orders"
  ON public.orders
  FOR DELETE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.has_role((select auth.uid()), 'warehouse')
  );

-- ────────────────────────────────────────────────────────────────────────────
-- order_items
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "ops_write_order_items" ON public.order_items;
DROP POLICY IF EXISTS "Authenticated users can select order_items" ON public.order_items;

CREATE POLICY "order_items_select"
  ON public.order_items
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "ops_insert_order_items"
  ON public.order_items
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.has_role((select auth.uid()), 'warehouse')
  );

CREATE POLICY "ops_update_order_items"
  ON public.order_items
  FOR UPDATE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.has_role((select auth.uid()), 'warehouse')
  )
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.has_role((select auth.uid()), 'warehouse')
  );

CREATE POLICY "ops_delete_order_items"
  ON public.order_items
  FOR DELETE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.has_role((select auth.uid()), 'warehouse')
  );

-- ────────────────────────────────────────────────────────────────────────────
-- suppliers
-- ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "ops_write_suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "Authenticated users can select suppliers" ON public.suppliers;

CREATE POLICY "suppliers_select"
  ON public.suppliers
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "ops_insert_suppliers"
  ON public.suppliers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.has_role((select auth.uid()), 'warehouse')
  );

CREATE POLICY "ops_update_suppliers"
  ON public.suppliers
  FOR UPDATE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.has_role((select auth.uid()), 'warehouse')
  )
  WITH CHECK (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.has_role((select auth.uid()), 'warehouse')
  );

CREATE POLICY "ops_delete_suppliers"
  ON public.suppliers
  FOR DELETE
  TO authenticated
  USING (
    public.has_role((select auth.uid()), 'owner')
    OR public.has_role((select auth.uid()), 'staff')
    OR public.has_role((select auth.uid()), 'warehouse')
  );
