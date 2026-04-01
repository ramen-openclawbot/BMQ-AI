-- ============================================================================
-- v0.0.34 — RLS Hardening: Replace 78 permissive write policies with
-- role-based access control across 43 business tables.
--
-- STRATEGY:
-- - SELECT (read) policies remain USING(true) — all authenticated users can view
-- - WRITE policies restricted by role using has_role() function
-- - Group 1 (Finance): owner + staff only
-- - Group 2 (Operations): owner + staff + warehouse
-- - Group 3 (Production): owner + staff + warehouse
-- - Group 4 (Drive/Config): owner + staff
-- - Group 5 (CRM): owner + staff
-- - Group 6 (Audit logs): insert-only for all authenticated, no update/delete
--
-- REQUIRES: Run in Supabase SQL Editor
-- ============================================================================

-- Helper: reusable check expressions
-- owner_or_staff:  has_role(auth.uid(), 'owner') OR has_role(auth.uid(), 'staff')
-- owner_staff_wh:  above OR has_role(auth.uid(), 'warehouse')

-- ════════════════════════════════════════════════════════════════════════════
-- GROUP 1: FINANCE TABLES — owner + staff only
-- ════════════════════════════════════════════════════════════════════════════

-- ── cash_fund_topups ──
DROP POLICY IF EXISTS "cash_fund_topups write" ON public.cash_fund_topups;
CREATE POLICY "finance_write_cash_fund_topups"
  ON public.cash_fund_topups FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── ceo_daily_closing_declarations ──
DROP POLICY IF EXISTS "ceo_declarations write" ON public.ceo_daily_closing_declarations;
CREATE POLICY "finance_write_ceo_declarations"
  ON public.ceo_daily_closing_declarations FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── daily_reconciliations ──
DROP POLICY IF EXISTS "daily_reconciliations write" ON public.daily_reconciliations;
CREATE POLICY "finance_write_daily_reconciliations"
  ON public.daily_reconciliations FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── invoices ──
DROP POLICY IF EXISTS "Authenticated users can delete invoices" ON public.invoices;
DROP POLICY IF EXISTS "Authenticated users can insert invoices" ON public.invoices;
DROP POLICY IF EXISTS "Authenticated users can update invoices" ON public.invoices;
CREATE POLICY "finance_write_invoices"
  ON public.invoices FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── invoice_items ──
DROP POLICY IF EXISTS "Authenticated users can delete invoice_items" ON public.invoice_items;
DROP POLICY IF EXISTS "Authenticated users can insert invoice_items" ON public.invoice_items;
DROP POLICY IF EXISTS "Authenticated users can update invoice_items" ON public.invoice_items;
CREATE POLICY "finance_write_invoice_items"
  ON public.invoice_items FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── payment_requests ──
DROP POLICY IF EXISTS "Authenticated users can delete payment_requests" ON public.payment_requests;
DROP POLICY IF EXISTS "Authenticated users can insert payment_requests" ON public.payment_requests;
DROP POLICY IF EXISTS "Authenticated users can update payment_requests" ON public.payment_requests;
CREATE POLICY "finance_write_payment_requests"
  ON public.payment_requests FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── payment_request_items ──
DROP POLICY IF EXISTS "Authenticated users can delete payment_request_items" ON public.payment_request_items;
DROP POLICY IF EXISTS "Authenticated users can insert payment_request_items" ON public.payment_request_items;
DROP POLICY IF EXISTS "Authenticated users can update payment_request_items" ON public.payment_request_items;
CREATE POLICY "finance_write_payment_request_items"
  ON public.payment_request_items FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ════════════════════════════════════════════════════════════════════════════
-- GROUP 2: OPERATIONS TABLES — owner + staff + warehouse
-- ════════════════════════════════════════════════════════════════════════════

-- ── purchase_orders ──
DROP POLICY IF EXISTS "Authenticated users can delete purchase_orders" ON public.purchase_orders;
DROP POLICY IF EXISTS "Authenticated users can insert purchase_orders" ON public.purchase_orders;
DROP POLICY IF EXISTS "Authenticated users can update purchase_orders" ON public.purchase_orders;
CREATE POLICY "ops_write_purchase_orders"
  ON public.purchase_orders FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── purchase_order_items ──
DROP POLICY IF EXISTS "Authenticated users can delete purchase_order_items" ON public.purchase_order_items;
DROP POLICY IF EXISTS "Authenticated users can insert purchase_order_items" ON public.purchase_order_items;
DROP POLICY IF EXISTS "Authenticated users can update purchase_order_items" ON public.purchase_order_items;
CREATE POLICY "ops_write_purchase_order_items"
  ON public.purchase_order_items FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── orders ──
DROP POLICY IF EXISTS "Authenticated users can delete orders" ON public.orders;
DROP POLICY IF EXISTS "Authenticated users can insert orders" ON public.orders;
DROP POLICY IF EXISTS "Authenticated users can update orders" ON public.orders;
CREATE POLICY "ops_write_orders"
  ON public.orders FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── order_items ──
DROP POLICY IF EXISTS "Authenticated users can delete order_items" ON public.order_items;
DROP POLICY IF EXISTS "Authenticated users can insert order_items" ON public.order_items;
DROP POLICY IF EXISTS "Authenticated users can update order_items" ON public.order_items;
CREATE POLICY "ops_write_order_items"
  ON public.order_items FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── goods_receipts ──
DROP POLICY IF EXISTS "Authenticated users can delete goods_receipts" ON public.goods_receipts;
DROP POLICY IF EXISTS "Authenticated users can insert goods_receipts" ON public.goods_receipts;
DROP POLICY IF EXISTS "Authenticated users can update goods_receipts" ON public.goods_receipts;
CREATE POLICY "ops_write_goods_receipts"
  ON public.goods_receipts FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── goods_receipt_items ──
DROP POLICY IF EXISTS "Authenticated users can delete goods_receipt_items" ON public.goods_receipt_items;
DROP POLICY IF EXISTS "Authenticated users can insert goods_receipt_items" ON public.goods_receipt_items;
DROP POLICY IF EXISTS "Authenticated users can update goods_receipt_items" ON public.goods_receipt_items;
CREATE POLICY "ops_write_goods_receipt_items"
  ON public.goods_receipt_items FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── inventory_items ──
DROP POLICY IF EXISTS "Authenticated users can delete inventory_items" ON public.inventory_items;
DROP POLICY IF EXISTS "Authenticated users can insert inventory_items" ON public.inventory_items;
DROP POLICY IF EXISTS "Authenticated users can update inventory_items" ON public.inventory_items;
CREATE POLICY "ops_write_inventory_items"
  ON public.inventory_items FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── inventory_batches ──
DROP POLICY IF EXISTS "Authenticated users can delete inventory_batches" ON public.inventory_batches;
DROP POLICY IF EXISTS "Authenticated users can insert inventory_batches" ON public.inventory_batches;
DROP POLICY IF EXISTS "Authenticated users can update inventory_batches" ON public.inventory_batches;
CREATE POLICY "ops_write_inventory_batches"
  ON public.inventory_batches FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── inventory_movements ──
DROP POLICY IF EXISTS "authenticated_full_access_inventory_movements" ON public.inventory_movements;
CREATE POLICY "ops_write_inventory_movements"
  ON public.inventory_movements FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── product_skus ──
DROP POLICY IF EXISTS "Authenticated users can delete product_skus" ON public.product_skus;
DROP POLICY IF EXISTS "Authenticated users can insert product_skus" ON public.product_skus;
DROP POLICY IF EXISTS "Authenticated users can update product_skus" ON public.product_skus;
CREATE POLICY "ops_write_product_skus"
  ON public.product_skus FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── suppliers ──
DROP POLICY IF EXISTS "Authenticated users can delete suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "Authenticated users can insert suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "Authenticated users can update suppliers" ON public.suppliers;
CREATE POLICY "ops_write_suppliers"
  ON public.suppliers FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── supplier_aliases ──
DROP POLICY IF EXISTS "supplier_aliases_write" ON public.supplier_aliases;
CREATE POLICY "ops_write_supplier_aliases"
  ON public.supplier_aliases FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── sku_formulations ──
DROP POLICY IF EXISTS "Authenticated users can manage sku formulations" ON public.sku_formulations;
CREATE POLICY "ops_write_sku_formulations"
  ON public.sku_formulations FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── warehouse_dispatches ──
DROP POLICY IF EXISTS "authenticated_full_access_warehouse_dispatches" ON public.warehouse_dispatches;
CREATE POLICY "ops_write_warehouse_dispatches"
  ON public.warehouse_dispatches FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── warehouse_dispatch_items ──
DROP POLICY IF EXISTS "authenticated_full_access_warehouse_dispatch_items" ON public.warehouse_dispatch_items;
CREATE POLICY "ops_write_warehouse_dispatch_items"
  ON public.warehouse_dispatch_items FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── customer_po_inbox ──
DROP POLICY IF EXISTS "customer_po_inbox write" ON public.customer_po_inbox;
CREATE POLICY "ops_write_customer_po_inbox"
  ON public.customer_po_inbox FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ════════════════════════════════════════════════════════════════════════════
-- GROUP 3: PRODUCTION TABLES — owner + staff + warehouse
-- ════════════════════════════════════════════════════════════════════════════

-- ── production_orders ──
DROP POLICY IF EXISTS "authenticated_full_access_production_orders" ON public.production_orders;
CREATE POLICY "prod_write_production_orders"
  ON public.production_orders FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── production_order_items ──
DROP POLICY IF EXISTS "authenticated_full_access_production_order_items" ON public.production_order_items;
CREATE POLICY "prod_write_production_order_items"
  ON public.production_order_items FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── production_shifts ──
DROP POLICY IF EXISTS "authenticated_full_access_production_shifts" ON public.production_shifts;
CREATE POLICY "prod_write_production_shifts"
  ON public.production_shifts FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── production_shift_items ──
DROP POLICY IF EXISTS "authenticated_full_access_production_shift_items" ON public.production_shift_items;
CREATE POLICY "prod_write_production_shift_items"
  ON public.production_shift_items FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── qa_inspections ──
DROP POLICY IF EXISTS "authenticated_full_access_qa_inspections" ON public.qa_inspections;
CREATE POLICY "prod_write_qa_inspections"
  ON public.qa_inspections FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ── qa_inspection_items ──
DROP POLICY IF EXISTS "authenticated_full_access_qa_inspection_items" ON public.qa_inspection_items;
CREATE POLICY "prod_write_qa_inspection_items"
  ON public.qa_inspection_items FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff') OR public.has_role((select auth.uid()), 'warehouse'));

-- ════════════════════════════════════════════════════════════════════════════
-- GROUP 4: DRIVE / CONFIG TABLES — owner + staff only
-- ════════════════════════════════════════════════════════════════════════════

-- ── drive_file_index ──
DROP POLICY IF EXISTS "Authenticated users can delete drive_file_index" ON public.drive_file_index;
DROP POLICY IF EXISTS "Authenticated users can insert drive_file_index" ON public.drive_file_index;
DROP POLICY IF EXISTS "Authenticated users can update drive_file_index" ON public.drive_file_index;
CREATE POLICY "config_write_drive_file_index"
  ON public.drive_file_index FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── drive_import_logs ──
DROP POLICY IF EXISTS "Authenticated users can delete drive_import_logs" ON public.drive_import_logs;
DROP POLICY IF EXISTS "Authenticated users can insert drive_import_logs" ON public.drive_import_logs;
DROP POLICY IF EXISTS "Authenticated users can update drive_import_logs" ON public.drive_import_logs;
CREATE POLICY "config_write_drive_import_logs"
  ON public.drive_import_logs FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── drive_sync_config ──
DROP POLICY IF EXISTS "Authenticated users can delete drive_sync_config" ON public.drive_sync_config;
DROP POLICY IF EXISTS "Authenticated users can insert drive_sync_config" ON public.drive_sync_config;
DROP POLICY IF EXISTS "Authenticated users can update drive_sync_config" ON public.drive_sync_config;
CREATE POLICY "config_write_drive_sync_config"
  ON public.drive_sync_config FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ════════════════════════════════════════════════════════════════════════════
-- GROUP 5: CRM TABLES — owner + staff only
-- ════════════════════════════════════════════════════════════════════════════

-- ── mini_crm_customers ──
DROP POLICY IF EXISTS "mini_crm_customers write" ON public.mini_crm_customers;
CREATE POLICY "crm_write_mini_crm_customers"
  ON public.mini_crm_customers FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── mini_crm_customer_emails ──
DROP POLICY IF EXISTS "mini_crm_customer_emails write" ON public.mini_crm_customer_emails;
CREATE POLICY "crm_write_mini_crm_customer_emails"
  ON public.mini_crm_customer_emails FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── mini_crm_customer_contracts ──
DROP POLICY IF EXISTS "Authenticated users can manage customer contracts" ON public.mini_crm_customer_contracts;
CREATE POLICY "crm_write_mini_crm_customer_contracts"
  ON public.mini_crm_customer_contracts FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── mini_crm_customer_price_list ──
DROP POLICY IF EXISTS "Authenticated users can manage customer price list" ON public.mini_crm_customer_price_list;
CREATE POLICY "crm_write_mini_crm_customer_price_list"
  ON public.mini_crm_customer_price_list FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── mini_crm_knowledge_profiles ──
DROP POLICY IF EXISTS "Authenticated users can manage knowledge profiles" ON public.mini_crm_knowledge_profiles;
CREATE POLICY "crm_write_mini_crm_knowledge_profiles"
  ON public.mini_crm_knowledge_profiles FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── mini_crm_knowledge_change_requests ──
DROP POLICY IF EXISTS "Authenticated users can approve KB change requests" ON public.mini_crm_knowledge_change_requests;
DROP POLICY IF EXISTS "Authenticated users can write KB change requests" ON public.mini_crm_knowledge_change_requests;
CREATE POLICY "crm_write_mini_crm_knowledge_change_requests"
  ON public.mini_crm_knowledge_change_requests FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── mini_crm_knowledge_profile_versions ──
DROP POLICY IF EXISTS "Authenticated users can write KB versions" ON public.mini_crm_knowledge_profile_versions;
CREATE POLICY "crm_write_mini_crm_knowledge_profile_versions"
  ON public.mini_crm_knowledge_profile_versions FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── mini_crm_po_templates ──
DROP POLICY IF EXISTS "Authenticated users can manage po templates" ON public.mini_crm_po_templates;
CREATE POLICY "crm_write_mini_crm_po_templates"
  ON public.mini_crm_po_templates FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ── mini_crm_po_template_learning_logs ──
DROP POLICY IF EXISTS "Authenticated users can manage po template learning logs" ON public.mini_crm_po_template_learning_logs;
CREATE POLICY "crm_write_mini_crm_po_template_learning_logs"
  ON public.mini_crm_po_template_learning_logs FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'staff'));

-- ════════════════════════════════════════════════════════════════════════════
-- GROUP 6: AUDIT LOG TABLES — insert-only for all authenticated
-- No UPDATE or DELETE allowed (append-only audit trail)
-- ════════════════════════════════════════════════════════════════════════════

-- ── po_revenue_post_audit ──
-- Already has INSERT-only policy; replace with explicit insert + read-only
DROP POLICY IF EXISTS "Authenticated users can write po revenue audit" ON public.po_revenue_post_audit;
CREATE POLICY "audit_insert_po_revenue_post_audit"
  ON public.po_revenue_post_audit FOR INSERT TO authenticated
  WITH CHECK (true);
-- No UPDATE/DELETE policy → writes blocked by default (RLS deny-by-default)

-- ── mini_crm_agent_ui_audit_logs ──
DROP POLICY IF EXISTS "Authenticated users can write agent ui audit logs" ON public.mini_crm_agent_ui_audit_logs;
CREATE POLICY "audit_insert_mini_crm_agent_ui_audit_logs"
  ON public.mini_crm_agent_ui_audit_logs FOR INSERT TO authenticated
  WITH CHECK (true);
-- No UPDATE/DELETE policy → writes blocked by default

-- ════════════════════════════════════════════════════════════════════════════
-- EXTENSION: Move unaccent to extensions schema
-- ════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS extensions;
ALTER EXTENSION unaccent SET SCHEMA extensions;
