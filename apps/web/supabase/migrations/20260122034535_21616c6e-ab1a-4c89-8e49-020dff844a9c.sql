-- 1) Make first (or first after no owners) signup an owner to avoid lockouts
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

  -- If there are no owners yet, promote this user to owner; otherwise default to viewer.
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'owner') THEN
    assigned_role := 'owner';
  ELSE
    assigned_role := 'viewer';
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, assigned_role);

  RETURN NEW;
END;
$$;

-- 2) Allow any authenticated user to view invoices/invoice items (keep writes restricted)
DO $$
BEGIN
  -- invoices
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='invoices' AND policyname='Staff and owners can view invoices'
  ) THEN
    EXECUTE 'DROP POLICY "Staff and owners can view invoices" ON public.invoices';
  END IF;

  EXECUTE 'CREATE POLICY "Authenticated users can view invoices" ON public.invoices FOR SELECT TO authenticated USING (true)';

  -- invoice_items
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='invoice_items' AND policyname='Staff and owners can view invoice items'
  ) THEN
    EXECUTE 'DROP POLICY "Staff and owners can view invoice items" ON public.invoice_items';
  END IF;

  EXECUTE 'CREATE POLICY "Authenticated users can view invoice items" ON public.invoice_items FOR SELECT TO authenticated USING (true)';
END;
$$;