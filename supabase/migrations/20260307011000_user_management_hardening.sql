-- ============================================================================
-- Migration: User Management hardening (invite/delete/auth-profile sync)
-- ============================================================================

-- 1) Keep only one role row per user, then enforce uniqueness
DO $$
BEGIN
  IF to_regclass('public.user_roles') IS NOT NULL THEN
    -- Deduplicate by physical row order (safe for one-time cleanup)
    DELETE FROM public.user_roles a
    USING public.user_roles b
    WHERE a.user_id = b.user_id
      AND a.ctid < b.ctid;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'ux_user_roles_user_id'
    ) THEN
      CREATE UNIQUE INDEX ux_user_roles_user_id
        ON public.user_roles(user_id);
    END IF;
  END IF;
END $$;

-- 2) Ensure unique permission row per (user,module)
DO $$
BEGIN
  IF to_regclass('public.user_module_permissions') IS NOT NULL THEN
    -- Deduplicate permission duplicates if any
    DELETE FROM public.user_module_permissions a
    USING public.user_module_permissions b
    WHERE a.user_id = b.user_id
      AND a.module_key = b.module_key
      AND a.ctid < b.ctid;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'ux_user_module_permissions_user_module'
    ) THEN
      CREATE UNIQUE INDEX ux_user_module_permissions_user_module
        ON public.user_module_permissions(user_id, module_key);
    END IF;
  END IF;
END $$;

-- 3) Auto-create profile; auto-assign viewer role for @bmq.vn users
CREATE OR REPLACE FUNCTION public.handle_auth_user_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_bmq_email boolean;
BEGIN
  INSERT INTO public.profiles (user_id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'full_name', ''), split_part(COALESCE(NEW.email, ''), '@', 1))
  )
  ON CONFLICT (user_id)
  DO UPDATE SET
    email = EXCLUDED.email;

  _is_bmq_email := lower(COALESCE(NEW.email, '')) LIKE '%@bmq.vn';

  IF _is_bmq_email THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (NEW.id, 'viewer')
    ON CONFLICT (user_id) DO NOTHING;

    INSERT INTO public.user_module_permissions (user_id, module_key, can_view, can_edit)
    VALUES
      (NEW.id, 'dashboard', true, false),
      (NEW.id, 'reports', false, false),
      (NEW.id, 'niraan_dashboard', false, false),
      (NEW.id, 'finance_cost', false, false),
      (NEW.id, 'finance_revenue', false, false),
      (NEW.id, 'crm', false, false),
      (NEW.id, 'sales_po_inbox', false, false),
      (NEW.id, 'purchase_orders', false, false),
      (NEW.id, 'inventory', true, false),
      (NEW.id, 'goods_receipts', false, false),
      (NEW.id, 'sku_costs', false, false),
      (NEW.id, 'suppliers', false, false),
      (NEW.id, 'invoices', false, false),
      (NEW.id, 'payment_requests', false, false),
      (NEW.id, 'low_stock', true, false),
      (NEW.id, 'settings', true, false)
    ON CONFLICT (user_id, module_key) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_auth_user_created();

-- 4) Backfill missing profiles for existing auth users
INSERT INTO public.profiles (user_id, email, full_name)
SELECT
  au.id,
  au.email,
  COALESCE(NULLIF(au.raw_user_meta_data->>'full_name', ''), split_part(COALESCE(au.email, ''), '@', 1))
FROM auth.users au
LEFT JOIN public.profiles p ON p.user_id = au.id
WHERE p.user_id IS NULL;

-- 5) Backfill default viewer role + permissions for existing @bmq.vn users without role
INSERT INTO public.user_roles (user_id, role)
SELECT au.id, 'viewer'::public.app_role
FROM auth.users au
LEFT JOIN public.user_roles ur ON ur.user_id = au.id
WHERE ur.user_id IS NULL
  AND lower(COALESCE(au.email, '')) LIKE '%@bmq.vn';

INSERT INTO public.user_module_permissions (user_id, module_key, can_view, can_edit)
SELECT ur.user_id,
       mod.module_key,
       (mod.module_key IN ('dashboard','inventory','low_stock','settings')) AS can_view,
       false AS can_edit
FROM public.user_roles ur
JOIN auth.users au ON au.id = ur.user_id
CROSS JOIN (
  SELECT unnest(ARRAY[
    'dashboard','reports','niraan_dashboard','finance_cost','finance_revenue','crm',
    'sales_po_inbox','purchase_orders','inventory','goods_receipts','sku_costs',
    'suppliers','invoices','payment_requests','low_stock','settings'
  ]) AS module_key
) mod
WHERE ur.role = 'viewer'
  AND lower(COALESCE(au.email, '')) LIKE '%@bmq.vn'
ON CONFLICT (user_id, module_key) DO NOTHING;
