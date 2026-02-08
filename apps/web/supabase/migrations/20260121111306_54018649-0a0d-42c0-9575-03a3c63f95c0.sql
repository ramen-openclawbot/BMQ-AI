-- Drop the existing overly permissive SELECT policy
DROP POLICY IF EXISTS "Authenticated users can view suppliers" ON public.suppliers;

-- Create new restrictive SELECT policy for owners and staff only
CREATE POLICY "Owners and staff can view suppliers"
ON public.suppliers
FOR SELECT
USING (
  has_role(auth.uid(), 'owner'::app_role) OR 
  has_role(auth.uid(), 'staff'::app_role)
);