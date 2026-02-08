-- Fix 1: Ensure has_role() function exists (recreate if needed)
-- This function is required by storage bucket RLS policies
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

COMMENT ON FUNCTION public.has_role(uuid, app_role) IS 'Check if a user has a specific role - used by RLS policies';

-- Fix 2: Update profiles RLS policies to be more restrictive
-- Drop overly permissive policies
DROP POLICY IF EXISTS "Authenticated users can view all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Authenticated users can update profiles" ON public.profiles;

-- Users can view their own profile
CREATE POLICY "Users can view own profile"
ON public.profiles FOR SELECT
USING (auth.uid() = user_id);

-- Staff and owners can view all profiles (for team management)
CREATE POLICY "Staff and owners can view all profiles"
ON public.profiles FOR SELECT
USING (
  public.has_role(auth.uid(), 'owner'::public.app_role) OR 
  public.has_role(auth.uid(), 'staff'::public.app_role)
);

-- Users can only update their own profile
CREATE POLICY "Users can update own profile"
ON public.profiles FOR UPDATE
USING (auth.uid() = user_id);