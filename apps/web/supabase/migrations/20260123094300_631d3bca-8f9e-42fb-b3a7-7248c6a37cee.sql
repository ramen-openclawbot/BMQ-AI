-- ================================================================
-- SECURITY FIX: Remove PROTOTYPE MODE public access policies
-- ================================================================

-- Drop all public_full_access policies from all tables
DROP POLICY IF EXISTS "public_full_access" ON public.profiles;
DROP POLICY IF EXISTS "public_full_access" ON public.user_roles;
DROP POLICY IF EXISTS "public_full_access" ON public.suppliers;
DROP POLICY IF EXISTS "public_full_access" ON public.inventory_items;
DROP POLICY IF EXISTS "public_full_access" ON public.invoices;
DROP POLICY IF EXISTS "public_full_access" ON public.invoice_items;
DROP POLICY IF EXISTS "public_full_access" ON public.payment_requests;
DROP POLICY IF EXISTS "public_full_access" ON public.payment_request_items;
DROP POLICY IF EXISTS "public_full_access" ON public.product_skus;
DROP POLICY IF EXISTS "public_full_access" ON public.orders;
DROP POLICY IF EXISTS "public_full_access" ON public.order_items;
DROP POLICY IF EXISTS "public_full_access" ON public.goods_receipts;
DROP POLICY IF EXISTS "public_full_access" ON public.goods_receipt_items;
DROP POLICY IF EXISTS "public_full_access" ON public.purchase_orders;
DROP POLICY IF EXISTS "public_full_access" ON public.purchase_order_items;

-- ================================================================
-- SECURITY FIX: Secure storage buckets
-- ================================================================

-- Make all storage buckets private
UPDATE storage.buckets SET public = false WHERE id = 'contracts';
UPDATE storage.buckets SET public = false WHERE id = 'invoices';
UPDATE storage.buckets SET public = false WHERE id = 'purchase-orders';

-- Drop all overly permissive storage policies
DROP POLICY IF EXISTS "Anyone can upload contracts" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can read contracts" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can update contracts" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can delete contracts" ON storage.objects;
DROP POLICY IF EXISTS "public_invoices_bucket_access" ON storage.objects;

-- Create restrictive storage policies for contracts bucket
CREATE POLICY "Staff and owners can upload contracts"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'contracts' AND
  (public.has_role(auth.uid(), 'owner'::public.app_role) OR public.has_role(auth.uid(), 'staff'::public.app_role))
);

CREATE POLICY "Authenticated users can view contracts"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'contracts' AND
  auth.uid() IS NOT NULL
);

CREATE POLICY "Staff and owners can update contracts"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'contracts' AND
  (public.has_role(auth.uid(), 'owner'::public.app_role) OR public.has_role(auth.uid(), 'staff'::public.app_role))
);

CREATE POLICY "Owners can delete contracts"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'contracts' AND
  public.has_role(auth.uid(), 'owner'::public.app_role)
);

-- Create restrictive storage policies for invoices bucket
CREATE POLICY "Staff and owners can upload invoices"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'invoices' AND
  (public.has_role(auth.uid(), 'owner'::public.app_role) OR public.has_role(auth.uid(), 'staff'::public.app_role))
);

CREATE POLICY "Authenticated users can view invoices"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'invoices' AND
  auth.uid() IS NOT NULL
);

CREATE POLICY "Staff and owners can update invoices"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'invoices' AND
  (public.has_role(auth.uid(), 'owner'::public.app_role) OR public.has_role(auth.uid(), 'staff'::public.app_role))
);

CREATE POLICY "Owners can delete invoices"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'invoices' AND
  public.has_role(auth.uid(), 'owner'::public.app_role)
);

-- Create restrictive storage policies for purchase-orders bucket
CREATE POLICY "Staff and owners can upload purchase orders"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'purchase-orders' AND
  (public.has_role(auth.uid(), 'owner'::public.app_role) OR public.has_role(auth.uid(), 'staff'::public.app_role))
);

CREATE POLICY "Authenticated users can view purchase orders"
ON storage.objects FOR SELECT
USING (
  bucket_id = 'purchase-orders' AND
  auth.uid() IS NOT NULL
);

CREATE POLICY "Staff and owners can update purchase orders"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'purchase-orders' AND
  (public.has_role(auth.uid(), 'owner'::public.app_role) OR public.has_role(auth.uid(), 'staff'::public.app_role))
);

CREATE POLICY "Owners can delete purchase orders"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'purchase-orders' AND
  public.has_role(auth.uid(), 'owner'::public.app_role)
);