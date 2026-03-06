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

-- 3) Auto-create profile when auth user is created
CREATE OR REPLACE FUNCTION public.handle_auth_user_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
