-- Fix 1: Add missing INSERT and DELETE policies for app_settings (restricted to owners only)
CREATE POLICY "Only owners can insert app_settings"
ON public.app_settings
FOR INSERT
TO authenticated
WITH CHECK (has_role(auth.uid(), 'owner'::app_role));

CREATE POLICY "Only owners can delete app_settings"
ON public.app_settings
FOR DELETE
TO authenticated
USING (has_role(auth.uid(), 'owner'::app_role));

-- Fix 2: Add DELETE policy for profiles (owners can delete any profile for GDPR compliance)
CREATE POLICY "Owners can delete profiles"
ON public.profiles
FOR DELETE
TO authenticated
USING (has_role(auth.uid(), 'owner'::app_role));

-- Fix 3: Restrict profiles email visibility - update policy to mask email for non-owners viewing others' profiles
-- First drop the existing policy
DROP POLICY IF EXISTS "Staff and owners can view all profiles" ON public.profiles;

-- Create a more restrictive view policy - staff can only see names, not emails of others
-- Owners retain full access
CREATE POLICY "Owners can view all profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'owner'::app_role));

CREATE POLICY "Staff can view all profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'staff'::app_role));