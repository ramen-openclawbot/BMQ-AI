-- 1) Update the signup trigger: new users become 'staff' (owner if first user)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  assigned_role public.app_role;
BEGIN
  INSERT INTO public.profiles (user_id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email)
  );

  -- First user = owner; everyone else = staff (no more viewer default)
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'owner') THEN
    assigned_role := 'owner';
  ELSE
    assigned_role := 'staff';
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, assigned_role);

  RETURN NEW;
END;
$$;

-- 2) Allow all authenticated users to SELECT on key tables (removes viewer block)

-- inventory_items
DROP POLICY IF EXISTS "Staff and owners can view inventory" ON public.inventory_items;
CREATE POLICY "Authenticated users can view inventory"
  ON public.inventory_items FOR SELECT TO authenticated USING (true);

-- suppliers
DROP POLICY IF EXISTS "Owners and staff can view suppliers" ON public.suppliers;
CREATE POLICY "Authenticated users can view suppliers"
  ON public.suppliers FOR SELECT TO authenticated USING (true);

-- payment_requests
DROP POLICY IF EXISTS "Staff and owners can view payment requests" ON public.payment_requests;
CREATE POLICY "Authenticated users can view payment requests"
  ON public.payment_requests FOR SELECT TO authenticated USING (true);

-- payment_request_items
DROP POLICY IF EXISTS "Staff and owners can view payment request items" ON public.payment_request_items;
CREATE POLICY "Authenticated users can view payment request items"
  ON public.payment_request_items FOR SELECT TO authenticated USING (true);