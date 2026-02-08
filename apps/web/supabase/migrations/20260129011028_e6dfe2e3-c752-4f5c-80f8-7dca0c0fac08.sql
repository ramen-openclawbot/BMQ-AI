-- =====================================================
-- MIGRATION: Remove RBAC - Prototype Mode
-- All authenticated users have full access
-- =====================================================

-- 1. Drop all existing policies on app_settings
DROP POLICY IF EXISTS "Anyone can read app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Only owners can delete app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Only owners can insert app_settings" ON public.app_settings;
DROP POLICY IF EXISTS "Only owners can update app_settings" ON public.app_settings;

-- 2. Drop all existing policies on drive_file_index
DROP POLICY IF EXISTS "Only owners can delete drive_file_index" ON public.drive_file_index;
DROP POLICY IF EXISTS "Owners and staff can insert drive_file_index" ON public.drive_file_index;
DROP POLICY IF EXISTS "Owners and staff can update drive_file_index" ON public.drive_file_index;
DROP POLICY IF EXISTS "Owners and staff can view drive_file_index" ON public.drive_file_index;

-- 3. Drop all existing policies on drive_import_logs
DROP POLICY IF EXISTS "Only owners can delete drive_import_logs" ON public.drive_import_logs;
DROP POLICY IF EXISTS "Owners and staff can insert drive_import_logs" ON public.drive_import_logs;
DROP POLICY IF EXISTS "Owners and staff can view drive_import_logs" ON public.drive_import_logs;

-- 4. Drop all existing policies on drive_sync_config
DROP POLICY IF EXISTS "Only owners can delete drive_sync_config" ON public.drive_sync_config;
DROP POLICY IF EXISTS "Only owners can insert drive_sync_config" ON public.drive_sync_config;
DROP POLICY IF EXISTS "Only owners can update drive_sync_config" ON public.drive_sync_config;
DROP POLICY IF EXISTS "Owners and staff can view drive_sync_config" ON public.drive_sync_config;

-- 5. Drop all existing policies on goods_receipt_items
DROP POLICY IF EXISTS "Only owners can delete goods_receipt_items" ON public.goods_receipt_items;
DROP POLICY IF EXISTS "Owners staff and warehouse can insert goods_receipt_items" ON public.goods_receipt_items;
DROP POLICY IF EXISTS "Owners staff and warehouse can update goods_receipt_items" ON public.goods_receipt_items;
DROP POLICY IF EXISTS "Owners staff and warehouse can view goods_receipt_items" ON public.goods_receipt_items;

-- 6. Drop all existing policies on goods_receipts
DROP POLICY IF EXISTS "Only owners can delete goods_receipts" ON public.goods_receipts;
DROP POLICY IF EXISTS "Owners staff and warehouse can insert goods_receipts" ON public.goods_receipts;
DROP POLICY IF EXISTS "Owners staff and warehouse can update goods_receipts" ON public.goods_receipts;
DROP POLICY IF EXISTS "Owners staff and warehouse can view goods_receipts" ON public.goods_receipts;

-- 7. Drop all existing policies on inventory_items
DROP POLICY IF EXISTS "Only owners can delete inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Owners staff and warehouse can insert inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Owners staff and warehouse can update inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Owners staff and warehouse can view inventory" ON public.inventory_items;

-- 8. Drop all existing policies on invoice_items
DROP POLICY IF EXISTS "Only owners can delete invoice_items" ON public.invoice_items;
DROP POLICY IF EXISTS "Owners and staff can insert invoice_items" ON public.invoice_items;
DROP POLICY IF EXISTS "Owners and staff can update invoice_items" ON public.invoice_items;
DROP POLICY IF EXISTS "Owners and staff can view invoice_items" ON public.invoice_items;

-- 9. Drop all existing policies on invoices
DROP POLICY IF EXISTS "Only owners can delete invoices" ON public.invoices;
DROP POLICY IF EXISTS "Owners and staff can insert invoices" ON public.invoices;
DROP POLICY IF EXISTS "Owners and staff can update invoices" ON public.invoices;
DROP POLICY IF EXISTS "Owners and staff can view invoices" ON public.invoices;

-- 10. Drop all existing policies on order_items
DROP POLICY IF EXISTS "Only owners can delete order_items" ON public.order_items;
DROP POLICY IF EXISTS "Owners and staff can insert order_items" ON public.order_items;
DROP POLICY IF EXISTS "Owners and staff can update order_items" ON public.order_items;
DROP POLICY IF EXISTS "Owners and staff can view order_items" ON public.order_items;

-- 11. Drop all existing policies on orders
DROP POLICY IF EXISTS "Only owners can delete orders" ON public.orders;
DROP POLICY IF EXISTS "Owners and staff can insert orders" ON public.orders;
DROP POLICY IF EXISTS "Owners and staff can update orders" ON public.orders;
DROP POLICY IF EXISTS "Owners and staff can view orders" ON public.orders;

-- 12. Drop all existing policies on payment_request_items
DROP POLICY IF EXISTS "Only owners can delete payment_request_items" ON public.payment_request_items;
DROP POLICY IF EXISTS "Owners and staff can insert payment_request_items" ON public.payment_request_items;
DROP POLICY IF EXISTS "Owners and staff can update payment_request_items" ON public.payment_request_items;
DROP POLICY IF EXISTS "Owners and staff can view payment_request_items" ON public.payment_request_items;

-- 13. Drop all existing policies on payment_requests
DROP POLICY IF EXISTS "Only owners can delete payment_requests" ON public.payment_requests;
DROP POLICY IF EXISTS "Owners and staff can insert payment_requests" ON public.payment_requests;
DROP POLICY IF EXISTS "Owners and staff can update payment_requests" ON public.payment_requests;
DROP POLICY IF EXISTS "Owners and staff can view payment_requests" ON public.payment_requests;

-- 14. Drop all existing policies on product_skus
DROP POLICY IF EXISTS "Only owners can delete product_skus" ON public.product_skus;
DROP POLICY IF EXISTS "Owners and staff can insert product_skus" ON public.product_skus;
DROP POLICY IF EXISTS "Owners and staff can update product_skus" ON public.product_skus;
DROP POLICY IF EXISTS "Owners staff and warehouse can view product_skus" ON public.product_skus;

-- 15. Drop all existing policies on profiles
DROP POLICY IF EXISTS "Owners can delete profiles" ON public.profiles;
DROP POLICY IF EXISTS "Owners can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Staff can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "System can insert profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;

-- 16. Drop all existing policies on purchase_order_items
DROP POLICY IF EXISTS "Only owners can delete purchase_order_items" ON public.purchase_order_items;
DROP POLICY IF EXISTS "Owners and staff can insert purchase_order_items" ON public.purchase_order_items;
DROP POLICY IF EXISTS "Owners and staff can update purchase_order_items" ON public.purchase_order_items;
DROP POLICY IF EXISTS "Owners and staff can view purchase_order_items" ON public.purchase_order_items;

-- 17. Drop all existing policies on purchase_orders
DROP POLICY IF EXISTS "Only owners can delete purchase_orders" ON public.purchase_orders;
DROP POLICY IF EXISTS "Owners and staff can insert purchase_orders" ON public.purchase_orders;
DROP POLICY IF EXISTS "Owners and staff can update purchase_orders" ON public.purchase_orders;
DROP POLICY IF EXISTS "Owners and staff can view purchase_orders" ON public.purchase_orders;

-- 18. Drop all existing policies on suppliers
DROP POLICY IF EXISTS "Only owners can delete suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "Owners and staff can insert suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "Owners and staff can update suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "Owners staff and warehouse can view suppliers" ON public.suppliers;

-- 19. Drop all existing policies on user_roles
DROP POLICY IF EXISTS "Only owners can delete roles" ON public.user_roles;
DROP POLICY IF EXISTS "Only owners can insert roles" ON public.user_roles;
DROP POLICY IF EXISTS "Only owners can update roles" ON public.user_roles;
DROP POLICY IF EXISTS "Owners can view all roles" ON public.user_roles;
DROP POLICY IF EXISTS "Users can view own role" ON public.user_roles;

-- =====================================================
-- CREATE NEW SIMPLE POLICIES: Authenticated users can do everything
-- =====================================================

-- app_settings
CREATE POLICY "Authenticated users can select app_settings" ON public.app_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert app_settings" ON public.app_settings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update app_settings" ON public.app_settings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete app_settings" ON public.app_settings FOR DELETE TO authenticated USING (true);

-- drive_file_index
CREATE POLICY "Authenticated users can select drive_file_index" ON public.drive_file_index FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert drive_file_index" ON public.drive_file_index FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update drive_file_index" ON public.drive_file_index FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete drive_file_index" ON public.drive_file_index FOR DELETE TO authenticated USING (true);

-- drive_import_logs
CREATE POLICY "Authenticated users can select drive_import_logs" ON public.drive_import_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert drive_import_logs" ON public.drive_import_logs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update drive_import_logs" ON public.drive_import_logs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete drive_import_logs" ON public.drive_import_logs FOR DELETE TO authenticated USING (true);

-- drive_sync_config
CREATE POLICY "Authenticated users can select drive_sync_config" ON public.drive_sync_config FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert drive_sync_config" ON public.drive_sync_config FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update drive_sync_config" ON public.drive_sync_config FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete drive_sync_config" ON public.drive_sync_config FOR DELETE TO authenticated USING (true);

-- goods_receipt_items
CREATE POLICY "Authenticated users can select goods_receipt_items" ON public.goods_receipt_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert goods_receipt_items" ON public.goods_receipt_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update goods_receipt_items" ON public.goods_receipt_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete goods_receipt_items" ON public.goods_receipt_items FOR DELETE TO authenticated USING (true);

-- goods_receipts
CREATE POLICY "Authenticated users can select goods_receipts" ON public.goods_receipts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert goods_receipts" ON public.goods_receipts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update goods_receipts" ON public.goods_receipts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete goods_receipts" ON public.goods_receipts FOR DELETE TO authenticated USING (true);

-- inventory_items
CREATE POLICY "Authenticated users can select inventory_items" ON public.inventory_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert inventory_items" ON public.inventory_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update inventory_items" ON public.inventory_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete inventory_items" ON public.inventory_items FOR DELETE TO authenticated USING (true);

-- invoice_items
CREATE POLICY "Authenticated users can select invoice_items" ON public.invoice_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert invoice_items" ON public.invoice_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update invoice_items" ON public.invoice_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete invoice_items" ON public.invoice_items FOR DELETE TO authenticated USING (true);

-- invoices
CREATE POLICY "Authenticated users can select invoices" ON public.invoices FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert invoices" ON public.invoices FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update invoices" ON public.invoices FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete invoices" ON public.invoices FOR DELETE TO authenticated USING (true);

-- order_items
CREATE POLICY "Authenticated users can select order_items" ON public.order_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert order_items" ON public.order_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update order_items" ON public.order_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete order_items" ON public.order_items FOR DELETE TO authenticated USING (true);

-- orders
CREATE POLICY "Authenticated users can select orders" ON public.orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert orders" ON public.orders FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update orders" ON public.orders FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete orders" ON public.orders FOR DELETE TO authenticated USING (true);

-- payment_request_items
CREATE POLICY "Authenticated users can select payment_request_items" ON public.payment_request_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert payment_request_items" ON public.payment_request_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update payment_request_items" ON public.payment_request_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete payment_request_items" ON public.payment_request_items FOR DELETE TO authenticated USING (true);

-- payment_requests
CREATE POLICY "Authenticated users can select payment_requests" ON public.payment_requests FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert payment_requests" ON public.payment_requests FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update payment_requests" ON public.payment_requests FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete payment_requests" ON public.payment_requests FOR DELETE TO authenticated USING (true);

-- product_skus
CREATE POLICY "Authenticated users can select product_skus" ON public.product_skus FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert product_skus" ON public.product_skus FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update product_skus" ON public.product_skus FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete product_skus" ON public.product_skus FOR DELETE TO authenticated USING (true);

-- profiles
CREATE POLICY "Authenticated users can select profiles" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert profiles" ON public.profiles FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update profiles" ON public.profiles FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete profiles" ON public.profiles FOR DELETE TO authenticated USING (true);

-- purchase_order_items
CREATE POLICY "Authenticated users can select purchase_order_items" ON public.purchase_order_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert purchase_order_items" ON public.purchase_order_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update purchase_order_items" ON public.purchase_order_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete purchase_order_items" ON public.purchase_order_items FOR DELETE TO authenticated USING (true);

-- purchase_orders
CREATE POLICY "Authenticated users can select purchase_orders" ON public.purchase_orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert purchase_orders" ON public.purchase_orders FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update purchase_orders" ON public.purchase_orders FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete purchase_orders" ON public.purchase_orders FOR DELETE TO authenticated USING (true);

-- suppliers
CREATE POLICY "Authenticated users can select suppliers" ON public.suppliers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert suppliers" ON public.suppliers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update suppliers" ON public.suppliers FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete suppliers" ON public.suppliers FOR DELETE TO authenticated USING (true);

-- user_roles (keep for future, but open access)
CREATE POLICY "Authenticated users can select user_roles" ON public.user_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert user_roles" ON public.user_roles FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update user_roles" ON public.user_roles FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete user_roles" ON public.user_roles FOR DELETE TO authenticated USING (true);

-- =====================================================
-- DELETE MAINTENANCE MODE SETTINGS
-- =====================================================
DELETE FROM public.app_settings WHERE key IN ('maintenance_mode', 'maintenance_message');