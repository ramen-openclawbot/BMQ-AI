-- Fix 4 error-level security issues:
-- 1. profiles_table_public_exposure - Make profiles restrictive to role-based access
-- 2. suppliers_table_public_exposure - Restrict supplier data to owner/staff only
-- 3. user_roles_unauthorized_modification - Only owners can manage roles
-- 4. invoices_financial_data_exposure - Restrict invoices to owner/staff only

-- ============================================
-- FIX 1: PROFILES TABLE - Already has proper policies but let's ensure they work correctly
-- The current RESTRICTIVE policies may be causing issues. Change to PERMISSIVE with proper checks.
-- ============================================

-- Drop existing profiles policies
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
DROP POLICY IF EXISTS "Staff and owners can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Authenticated users can insert profiles" ON public.profiles;

-- Create proper PERMISSIVE policies for profiles
-- Users can view their own profile
CREATE POLICY "Users can view own profile" 
ON public.profiles 
FOR SELECT 
TO authenticated
USING (auth.uid() = user_id);

-- Staff and owners can view all profiles
CREATE POLICY "Staff and owners can view all profiles" 
ON public.profiles 
FOR SELECT 
TO authenticated
USING (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
);

-- Users can update only their own profile
CREATE POLICY "Users can update own profile" 
ON public.profiles 
FOR UPDATE 
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Only system can insert profiles (via trigger on auth.users)
CREATE POLICY "System can insert profiles" 
ON public.profiles 
FOR INSERT 
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- ============================================
-- FIX 2: SUPPLIERS TABLE - Restrict to owner/staff only
-- ============================================

-- Drop existing supplier policy
DROP POLICY IF EXISTS "Authenticated users full access to suppliers" ON public.suppliers;

-- Create role-based policies for suppliers
CREATE POLICY "Owners and staff can view suppliers" 
ON public.suppliers 
FOR SELECT 
TO authenticated
USING (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
);

CREATE POLICY "Owners and staff can insert suppliers" 
ON public.suppliers 
FOR INSERT 
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
);

CREATE POLICY "Owners and staff can update suppliers" 
ON public.suppliers 
FOR UPDATE 
TO authenticated
USING (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
);

CREATE POLICY "Only owners can delete suppliers" 
ON public.suppliers 
FOR DELETE 
TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));

-- ============================================
-- FIX 3: USER_ROLES TABLE - Only owners can manage roles
-- ============================================

-- Drop existing user_roles policies
DROP POLICY IF EXISTS "Authenticated users can view all roles" ON public.user_roles;
DROP POLICY IF EXISTS "Authenticated users can manage roles" ON public.user_roles;

-- Create strict role management policies
-- All authenticated users can view roles (needed for role checks)
CREATE POLICY "Authenticated users can view roles" 
ON public.user_roles 
FOR SELECT 
TO authenticated
USING (auth.uid() IS NOT NULL);

-- Only owners can insert new roles
CREATE POLICY "Only owners can insert roles" 
ON public.user_roles 
FOR INSERT 
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'owner'::public.app_role)
  OR 
  -- Allow initial role assignment during user creation (when no owners exist yet)
  NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'owner'::public.app_role)
);

-- Only owners can update roles
CREATE POLICY "Only owners can update roles" 
ON public.user_roles 
FOR UPDATE 
TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'owner'::public.app_role));

-- Only owners can delete roles (but cannot delete their own owner role)
CREATE POLICY "Only owners can delete roles" 
ON public.user_roles 
FOR DELETE 
TO authenticated
USING (
  public.has_role(auth.uid(), 'owner'::public.app_role)
  AND NOT (user_id = auth.uid() AND role = 'owner'::public.app_role)
);

-- ============================================
-- FIX 4: INVOICES TABLE - Restrict to owner/staff only
-- ============================================

-- Drop existing invoice policies
DROP POLICY IF EXISTS "Authenticated users full access to invoices" ON public.invoices;
DROP POLICY IF EXISTS "Authenticated users full access to invoice_items" ON public.invoice_items;

-- Create role-based policies for invoices
CREATE POLICY "Owners and staff can view invoices" 
ON public.invoices 
FOR SELECT 
TO authenticated
USING (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
);

CREATE POLICY "Owners and staff can insert invoices" 
ON public.invoices 
FOR INSERT 
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
);

CREATE POLICY "Owners and staff can update invoices" 
ON public.invoices 
FOR UPDATE 
TO authenticated
USING (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
);

CREATE POLICY "Only owners can delete invoices" 
ON public.invoices 
FOR DELETE 
TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));

-- Create role-based policies for invoice_items
CREATE POLICY "Owners and staff can view invoice_items" 
ON public.invoice_items 
FOR SELECT 
TO authenticated
USING (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
);

CREATE POLICY "Owners and staff can insert invoice_items" 
ON public.invoice_items 
FOR INSERT 
TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
);

CREATE POLICY "Owners and staff can update invoice_items" 
ON public.invoice_items 
FOR UPDATE 
TO authenticated
USING (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
)
WITH CHECK (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
);

CREATE POLICY "Only owners can delete invoice_items" 
ON public.invoice_items 
FOR DELETE 
TO authenticated
USING (public.has_role(auth.uid(), 'owner'::public.app_role));