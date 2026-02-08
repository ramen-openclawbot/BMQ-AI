-- Cập nhật RLS policy cho suppliers: thêm warehouse vào SELECT
DROP POLICY IF EXISTS "Owners and staff can view suppliers" ON public.suppliers;

CREATE POLICY "Owners staff and warehouse can view suppliers"
ON public.suppliers
FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'owner'::app_role) OR 
  has_role(auth.uid(), 'staff'::app_role) OR
  has_role(auth.uid(), 'warehouse'::app_role)
);