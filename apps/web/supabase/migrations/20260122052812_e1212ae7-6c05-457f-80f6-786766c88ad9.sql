-- Ensure new signups get a profile + role
-- 1) Create trigger on auth.users -> public.handle_new_user()
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'on_auth_user_created'
  ) THEN
    CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();
  END IF;
END $$;

-- 2) Backfill profiles for existing users missing them
INSERT INTO public.profiles (user_id, email, full_name)
SELECT u.id, u.email, COALESCE(u.raw_user_meta_data->>'full_name', u.email)
FROM auth.users u
LEFT JOIN public.profiles p ON p.user_id = u.id
WHERE p.user_id IS NULL;

-- 3) Backfill roles for existing users missing them
-- First-ever owner if none exists; otherwise staff.
WITH has_owner AS (
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'owner') AS exists_owner
), missing_roles AS (
  SELECT u.id AS user_id
  FROM auth.users u
  LEFT JOIN public.user_roles r ON r.user_id = u.id
  WHERE r.user_id IS NULL
)
INSERT INTO public.user_roles (user_id, role)
SELECT mr.user_id,
       CASE
         WHEN NOT (SELECT exists_owner FROM has_owner) THEN 'owner'::public.app_role
         ELSE 'staff'::public.app_role
       END AS role
FROM missing_roles mr;

-- If we just assigned an owner above (because none existed), ensure we only have one owner:
-- Keep the earliest created user as owner and downgrade any others to staff.
WITH owners AS (
  SELECT r.user_id, u.created_at
  FROM public.user_roles r
  JOIN auth.users u ON u.id = r.user_id
  WHERE r.role = 'owner'
), keep_owner AS (
  SELECT user_id
  FROM owners
  ORDER BY created_at ASC
  LIMIT 1
)
UPDATE public.user_roles r
SET role = 'staff'::public.app_role
WHERE r.role = 'owner'
  AND r.user_id <> (SELECT user_id FROM keep_owner);
