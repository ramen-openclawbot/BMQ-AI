
-- Drop all existing restrictive RLS policies and replace with simple authenticated-user access

-- ============ profiles ============
DROP POLICY IF EXISTS "Users view own profile, staff and owners view all" ON public.profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can insert their own profile" ON public.profiles;

CREATE POLICY "Authenticated users can view all profiles"
ON public.profiles FOR SELECT
USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update profiles"
ON public.profiles FOR UPDATE
USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert profiles"
ON public.profiles FOR INSERT
WITH CHECK (auth.uid() IS NOT NULL);

-- ============ user_roles ============
DROP POLICY IF EXISTS "Authenticated users can view all roles" ON public.user_roles;
DROP POLICY IF EXISTS "Owners can manage roles" ON public.user_roles;

CREATE POLICY "Authenticated users can view all roles"
ON public.user_roles FOR SELECT
USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can manage roles"
ON public.user_roles FOR ALL
USING (auth.uid() IS NOT NULL);

-- ============ suppliers ============
DROP POLICY IF EXISTS "Authenticated users can view suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "Staff and owners can insert suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "Staff and owners can update suppliers" ON public.suppliers;
DROP POLICY IF EXISTS "Owners can delete suppliers" ON public.suppliers;

CREATE POLICY "Authenticated users full access to suppliers"
ON public.suppliers FOR ALL
USING (auth.uid() IS NOT NULL);

-- ============ inventory_items ============
DROP POLICY IF EXISTS "Authenticated users can view inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Staff and owners can insert inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Staff and owners can update inventory" ON public.inventory_items;
DROP POLICY IF EXISTS "Owners can delete inventory" ON public.inventory_items;

CREATE POLICY "Authenticated users full access to inventory"
ON public.inventory_items FOR ALL
USING (auth.uid() IS NOT NULL);

-- ============ invoices ============
DROP POLICY IF EXISTS "Authenticated users can view invoices" ON public.invoices;
DROP POLICY IF EXISTS "Staff and owners can insert invoices" ON public.invoices;
DROP POLICY IF EXISTS "Staff and owners can update invoices" ON public.invoices;
DROP POLICY IF EXISTS "Owners can delete invoices" ON public.invoices;

CREATE POLICY "Authenticated users full access to invoices"
ON public.invoices FOR ALL
USING (auth.uid() IS NOT NULL);

-- ============ invoice_items ============
DROP POLICY IF EXISTS "Authenticated users can view invoice items" ON public.invoice_items;
DROP POLICY IF EXISTS "Staff and owners can manage invoice items" ON public.invoice_items;

CREATE POLICY "Authenticated users full access to invoice_items"
ON public.invoice_items FOR ALL
USING (auth.uid() IS NOT NULL);

-- ============ payment_requests ============
DROP POLICY IF EXISTS "Authenticated users can view payment requests" ON public.payment_requests;
DROP POLICY IF EXISTS "Staff and owners can insert payment requests" ON public.payment_requests;
DROP POLICY IF EXISTS "Owners can update payment requests" ON public.payment_requests;
DROP POLICY IF EXISTS "Staff can update own pending requests" ON public.payment_requests;
DROP POLICY IF EXISTS "Owners can delete payment requests" ON public.payment_requests;

CREATE POLICY "Authenticated users full access to payment_requests"
ON public.payment_requests FOR ALL
USING (auth.uid() IS NOT NULL);

-- ============ payment_request_items ============
DROP POLICY IF EXISTS "Authenticated users can view payment request items" ON public.payment_request_items;
DROP POLICY IF EXISTS "Staff and owners can manage payment request items" ON public.payment_request_items;

CREATE POLICY "Authenticated users full access to payment_request_items"
ON public.payment_request_items FOR ALL
USING (auth.uid() IS NOT NULL);

-- ============ product_skus ============
DROP POLICY IF EXISTS "Authenticated users can view SKUs" ON public.product_skus;
DROP POLICY IF EXISTS "Staff and owners can insert SKUs" ON public.product_skus;
DROP POLICY IF EXISTS "Staff and owners can update SKUs" ON public.product_skus;
DROP POLICY IF EXISTS "Owners can delete SKUs" ON public.product_skus;

CREATE POLICY "Authenticated users full access to product_skus"
ON public.product_skus FOR ALL
USING (auth.uid() IS NOT NULL);

-- ============ orders ============
DROP POLICY IF EXISTS "Authenticated users can view orders" ON public.orders;
DROP POLICY IF EXISTS "Staff and owners can insert orders" ON public.orders;
DROP POLICY IF EXISTS "Staff and owners can update orders" ON public.orders;
DROP POLICY IF EXISTS "Owners can delete orders" ON public.orders;

CREATE POLICY "Authenticated users full access to orders"
ON public.orders FOR ALL
USING (auth.uid() IS NOT NULL);

-- ============ order_items ============
DROP POLICY IF EXISTS "Authenticated users can view order items" ON public.order_items;
DROP POLICY IF EXISTS "Staff and owners can manage order items" ON public.order_items;

CREATE POLICY "Authenticated users full access to order_items"
ON public.order_items FOR ALL
USING (auth.uid() IS NOT NULL);
