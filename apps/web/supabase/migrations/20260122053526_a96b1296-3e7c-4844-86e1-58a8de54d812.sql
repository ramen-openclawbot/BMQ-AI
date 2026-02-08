-- Fix profiles table RLS: restrict SELECT to own profile OR staff/owner for team management
DROP POLICY IF EXISTS "Authenticated users can view all profiles" ON public.profiles;

CREATE POLICY "Users view own profile, staff and owners view all"
ON public.profiles FOR SELECT
USING (
  auth.uid() = user_id OR 
  has_role(auth.uid(), 'owner'::app_role) OR 
  has_role(auth.uid(), 'staff'::app_role)
);