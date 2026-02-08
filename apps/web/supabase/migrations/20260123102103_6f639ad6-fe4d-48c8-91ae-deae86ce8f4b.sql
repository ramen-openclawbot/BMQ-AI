-- Fix overly permissive RLS policies on operational tables
-- Apply role-based access: owner/staff for most operations, owner-only for deletes
-- Warehouse role gets access to goods_receipts, goods_receipt_items, inventory_items, product_skus

-- ============================================================
-- GOODS_RECEIPTS - warehouse role needs access
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users full access to goods_receipts" ON public.goods_receipts;

CREATE POLICY "Owners staff and warehouse can view goods_receipts"
ON public.goods_receipts FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role));

CREATE POLICY "Owners staff and warehouse can insert goods_receipts"
ON public.goods_receipts FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role));

CREATE POLICY "Owners staff and warehouse can update goods_receipts"
ON public.goods_receipts FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role));

CREATE POLICY "Only owners can delete goods_receipts"
ON public.goods_receipts FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));

-- ============================================================
-- GOODS_RECEIPT_ITEMS - warehouse role needs access
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users full access to goods_receipt_items" ON public.goods_receipt_items;

CREATE POLICY "Owners staff and warehouse can view goods_receipt_items"
ON public.goods_receipt_items FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role));

CREATE POLICY "Owners staff and warehouse can insert goods_receipt_items"
ON public.goods_receipt_items FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role));

CREATE POLICY "Owners staff and warehouse can update goods_receipt_items"
ON public.goods_receipt_items FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role));

CREATE POLICY "Only owners can delete goods_receipt_items"
ON public.goods_receipt_items FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));

-- ============================================================
-- INVENTORY_ITEMS - warehouse role needs access
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users full access to inventory" ON public.inventory_items;

CREATE POLICY "Owners staff and warehouse can view inventory"
ON public.inventory_items FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role));

CREATE POLICY "Owners staff and warehouse can insert inventory"
ON public.inventory_items FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role));

CREATE POLICY "Owners staff and warehouse can update inventory"
ON public.inventory_items FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role));

CREATE POLICY "Only owners can delete inventory"
ON public.inventory_items FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));

-- ============================================================
-- PRODUCT_SKUS - warehouse role needs read access
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users full access to product_skus" ON public.product_skus;

CREATE POLICY "Owners staff and warehouse can view product_skus"
ON public.product_skus FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role)
    OR public.has_role(auth.uid(), 'warehouse'::public.app_role));

CREATE POLICY "Owners and staff can insert product_skus"
ON public.product_skus FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can update product_skus"
ON public.product_skus FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Only owners can delete product_skus"
ON public.product_skus FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));

-- ============================================================
-- PURCHASE_ORDERS - owner/staff only
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users full access to purchase_orders" ON public.purchase_orders;

CREATE POLICY "Owners and staff can view purchase_orders"
ON public.purchase_orders FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can insert purchase_orders"
ON public.purchase_orders FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can update purchase_orders"
ON public.purchase_orders FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Only owners can delete purchase_orders"
ON public.purchase_orders FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));

-- ============================================================
-- PURCHASE_ORDER_ITEMS - owner/staff only
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users full access to purchase_order_items" ON public.purchase_order_items;

CREATE POLICY "Owners and staff can view purchase_order_items"
ON public.purchase_order_items FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can insert purchase_order_items"
ON public.purchase_order_items FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can update purchase_order_items"
ON public.purchase_order_items FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Only owners can delete purchase_order_items"
ON public.purchase_order_items FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));

-- ============================================================
-- PAYMENT_REQUESTS - owner/staff only
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users full access to payment_requests" ON public.payment_requests;

CREATE POLICY "Owners and staff can view payment_requests"
ON public.payment_requests FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can insert payment_requests"
ON public.payment_requests FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can update payment_requests"
ON public.payment_requests FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Only owners can delete payment_requests"
ON public.payment_requests FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));

-- ============================================================
-- PAYMENT_REQUEST_ITEMS - owner/staff only
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users full access to payment_request_items" ON public.payment_request_items;

CREATE POLICY "Owners and staff can view payment_request_items"
ON public.payment_request_items FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can insert payment_request_items"
ON public.payment_request_items FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can update payment_request_items"
ON public.payment_request_items FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Only owners can delete payment_request_items"
ON public.payment_request_items FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));

-- ============================================================
-- ORDERS - owner/staff only
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users full access to orders" ON public.orders;

CREATE POLICY "Owners and staff can view orders"
ON public.orders FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can insert orders"
ON public.orders FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can update orders"
ON public.orders FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Only owners can delete orders"
ON public.orders FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));

-- ============================================================
-- ORDER_ITEMS - owner/staff only
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users full access to order_items" ON public.order_items;

CREATE POLICY "Owners and staff can view order_items"
ON public.order_items FOR SELECT TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can insert order_items"
ON public.order_items FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Owners and staff can update order_items"
ON public.order_items FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role) 
    OR public.has_role(auth.uid(), 'staff'::public.app_role));

CREATE POLICY "Only owners can delete order_items"
ON public.order_items FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));