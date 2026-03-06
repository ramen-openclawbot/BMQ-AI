-- ============================================================================
-- Migration: User Management Tables (v0.0.17)
-- Adds user_module_permissions and user_invitations tables for RBAC UI
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. user_module_permissions — per-user per-module access control
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_module_permissions (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  module_key  text NOT NULL,
  can_view    boolean NOT NULL DEFAULT false,
  can_edit    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, module_key)
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at_user_module_permissions
  BEFORE UPDATE ON public.user_module_permissions
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- RLS
ALTER TABLE public.user_module_permissions ENABLE ROW LEVEL SECURITY;

-- Owner can do everything
CREATE POLICY "owner_full_access_module_permissions"
  ON public.user_module_permissions
  FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

-- Users can read their own permissions (for sidebar filtering)
CREATE POLICY "users_read_own_permissions"
  ON public.user_module_permissions
  FOR SELECT
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. user_invitations — invite new users with a pre-assigned role
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_invitations (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  email       text NOT NULL,
  role        public.app_role NOT NULL DEFAULT 'staff',
  invited_by  uuid NOT NULL REFERENCES auth.users(id),
  token       text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'cancelled')),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER set_updated_at_user_invitations
  BEFORE UPDATE ON public.user_invitations
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- RLS
ALTER TABLE public.user_invitations ENABLE ROW LEVEL SECURITY;

-- Owner can do everything
CREATE POLICY "owner_full_access_invitations"
  ON public.user_invitations
  FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_user_module_permissions_user_id
  ON public.user_module_permissions(user_id);

CREATE INDEX IF NOT EXISTS idx_user_invitations_status
  ON public.user_invitations(status) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_user_invitations_email
  ON public.user_invitations(email);

-- ---------------------------------------------------------------------------
-- 4. Seed default permissions for existing users based on their roles
-- ---------------------------------------------------------------------------
-- This inserts default permissions for all existing users who have roles.
-- Owner users don't need permission rows (they bypass checks), but
-- staff/warehouse/viewer users get sensible defaults.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  _user RECORD;
  _modules text[] := ARRAY[
    'dashboard', 'reports', 'niraan_dashboard',
    'finance_cost', 'finance_revenue', 'crm', 'sales_po_inbox',
    'purchase_orders', 'inventory', 'goods_receipts', 'sku_costs',
    'suppliers', 'invoices', 'payment_requests', 'low_stock', 'settings'
  ];
  _mod text;
  _can_view boolean;
  _can_edit boolean;
BEGIN
  FOR _user IN
    -- JOIN with auth.users to skip orphaned user_roles rows
    -- (user deleted from auth but role record still exists)
    SELECT ur.user_id, ur.role
    FROM public.user_roles ur
    INNER JOIN auth.users au ON au.id = ur.user_id
    WHERE ur.role != 'owner'
  LOOP
    FOREACH _mod IN ARRAY _modules
    LOOP
      -- Default permissions per role
      _can_view := false;
      _can_edit := false;

      IF _user.role = 'staff' THEN
        _can_view := _mod IN ('dashboard','reports','finance_cost','finance_revenue','crm','sales_po_inbox','purchase_orders','inventory','goods_receipts','sku_costs','suppliers','invoices','payment_requests','low_stock','settings');
        _can_edit := _mod IN ('dashboard','finance_cost','finance_revenue','crm','sales_po_inbox','purchase_orders','suppliers','invoices','payment_requests');
      ELSIF _user.role = 'warehouse' THEN
        _can_view := _mod IN ('dashboard','purchase_orders','inventory','goods_receipts','suppliers','invoices','low_stock','settings');
        _can_edit := _mod IN ('inventory','goods_receipts');
      ELSIF _user.role = 'viewer' THEN
        _can_view := _mod IN ('dashboard','inventory','low_stock','settings');
        _can_edit := false;
      END IF;

      INSERT INTO public.user_module_permissions (user_id, module_key, can_view, can_edit)
      VALUES (_user.user_id, _mod, _can_view, _can_edit)
      ON CONFLICT (user_id, module_key) DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
