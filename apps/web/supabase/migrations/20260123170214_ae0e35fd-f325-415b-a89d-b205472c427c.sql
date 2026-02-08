-- Fix user_roles RLS policy to restrict role viewing
-- Drop the overly permissive policy
DROP POLICY IF EXISTS "Authenticated users can view roles" ON public.user_roles;

-- Create restrictive policies
-- Users can view their own role
CREATE POLICY "Users can view own role"
ON public.user_roles FOR SELECT
USING (auth.uid() = user_id);

-- Only owners can view all roles (for team management)
CREATE POLICY "Owners can view all roles"
ON public.user_roles FOR SELECT
USING (has_role(auth.uid(), 'owner'::app_role));