-- Drop the existing overly permissive SELECT policy
DROP POLICY IF EXISTS "Authenticated users can view inventory" ON public.inventory_items;

-- Create new policy that restricts SELECT to staff and owners only
CREATE POLICY "Staff and owners can view inventory" 
ON public.inventory_items 
FOR SELECT 
USING (has_role(auth.uid(), 'owner'::app_role) OR has_role(auth.uid(), 'staff'::app_role));