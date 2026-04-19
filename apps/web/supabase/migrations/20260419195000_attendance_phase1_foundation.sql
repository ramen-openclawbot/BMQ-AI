-- ============================================================================
-- Migration: Attendance Phase 1 foundation
-- Goal: QR-based attendance capture + HR operations baseline
-- ============================================================================

-- 1) Extend module permission seed with attendance module
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'app_role' AND e.enumlabel = 'viewer'
  ) THEN
    RAISE NOTICE 'app_role type missing or unexpected; skipping role assumptions';
  END IF;
END $$;

-- 2) Helper enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_event_type') THEN
    CREATE TYPE public.attendance_event_type AS ENUM ('check_in', 'check_out');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_source_type') THEN
    CREATE TYPE public.attendance_source_type AS ENUM ('qr', 'manual');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_status_type') THEN
    CREATE TYPE public.attendance_status_type AS ENUM (
      'present',
      'late',
      'early_leave',
      'late_early_leave',
      'missing_check_in',
      'missing_check_out',
      'missing_both',
      'absent'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_adjustment_type') THEN
    CREATE TYPE public.attendance_adjustment_type AS ENUM (
      'manual_check_in',
      'manual_check_out',
      'manual_record_edit',
      'forgot_check_in',
      'forgot_check_out',
      'other'
    );
  END IF;
END $$;

-- 3) Core tables
CREATE TABLE IF NOT EXISTS public.attendance_qr_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_code text NOT NULL UNIQUE,
  checkpoint_name text NOT NULL,
  location_label text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.attendance_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_code text NOT NULL UNIQUE,
  shift_name text NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  grace_minutes integer NOT NULL DEFAULT 5,
  early_leave_grace_minutes integer NOT NULL DEFAULT 5,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.attendance_shift_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code text NOT NULL,
  employee_name text,
  shift_id uuid NOT NULL REFERENCES public.attendance_shifts(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  department text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_code, work_date)
);

CREATE TABLE IF NOT EXISTS public.attendance_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code text NOT NULL,
  employee_name text,
  event_type public.attendance_event_type NOT NULL,
  source public.attendance_source_type NOT NULL DEFAULT 'qr',
  event_time timestamptz NOT NULL,
  work_date date NOT NULL,
  checkpoint_id uuid REFERENCES public.attendance_qr_checkpoints(id) ON DELETE SET NULL,
  shift_assignment_id uuid REFERENCES public.attendance_shift_assignments(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code text NOT NULL,
  employee_name text,
  work_date date NOT NULL,
  shift_assignment_id uuid REFERENCES public.attendance_shift_assignments(id) ON DELETE SET NULL,
  shift_id uuid REFERENCES public.attendance_shifts(id) ON DELETE SET NULL,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  actual_check_in timestamptz,
  actual_check_out timestamptz,
  status public.attendance_status_type NOT NULL DEFAULT 'missing_both',
  minutes_late integer NOT NULL DEFAULT 0,
  minutes_early_leave integer NOT NULL DEFAULT 0,
  missing_check_in boolean NOT NULL DEFAULT true,
  missing_check_out boolean NOT NULL DEFAULT true,
  notes text,
  locked_by_hr boolean NOT NULL DEFAULT false,
  finalized_at timestamptz,
  finalized_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_code, work_date)
);

CREATE TABLE IF NOT EXISTS public.attendance_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_record_id uuid NOT NULL REFERENCES public.attendance_records(id) ON DELETE CASCADE,
  adjustment_type public.attendance_adjustment_type NOT NULL,
  old_value jsonb,
  new_value jsonb,
  reason text NOT NULL,
  adjusted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  adjusted_at timestamptz NOT NULL DEFAULT now(),
  notes text
);

CREATE TABLE IF NOT EXISTS public.attendance_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_code text NOT NULL UNIQUE,
  period_name text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'closed')),
  closed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  closed_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 4) updated_at triggers
CREATE TRIGGER set_updated_at_attendance_qr_checkpoints
  BEFORE UPDATE ON public.attendance_qr_checkpoints
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at_attendance_shifts
  BEFORE UPDATE ON public.attendance_shifts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at_attendance_shift_assignments
  BEFORE UPDATE ON public.attendance_shift_assignments
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at_attendance_records
  BEFORE UPDATE ON public.attendance_records
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER set_updated_at_attendance_periods
  BEFORE UPDATE ON public.attendance_periods
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 5) Indexes
CREATE INDEX IF NOT EXISTS idx_attendance_events_employee_date
  ON public.attendance_events(employee_code, work_date, event_time);
CREATE INDEX IF NOT EXISTS idx_attendance_records_work_date
  ON public.attendance_records(work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_records_shift_assignment
  ON public.attendance_records(shift_assignment_id);
CREATE INDEX IF NOT EXISTS idx_attendance_shift_assignments_work_date
  ON public.attendance_shift_assignments(work_date, shift_id);
CREATE INDEX IF NOT EXISTS idx_attendance_periods_range
  ON public.attendance_periods(date_from, date_to);

-- 6) Enable RLS
ALTER TABLE public.attendance_qr_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_shift_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_periods ENABLE ROW LEVEL SECURITY;

-- 7) Helper permission function for module-based RLS
CREATE OR REPLACE FUNCTION public.has_module_permission(_user_id uuid, _module_key text, _permission text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_module_permissions ump
    WHERE ump.user_id = _user_id
      AND ump.module_key = _module_key
      AND (
        (_permission = 'view' AND ump.can_view = true)
        OR (_permission = 'edit' AND ump.can_edit = true)
      )
  );
$$;

-- 8) RLS policies: owner full access, attendance editors manage, viewers can read
CREATE POLICY "owner_full_access_attendance_qr_checkpoints"
  ON public.attendance_qr_checkpoints FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "owner_full_access_attendance_shifts"
  ON public.attendance_shifts FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "owner_full_access_attendance_shift_assignments"
  ON public.attendance_shift_assignments FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "owner_full_access_attendance_events"
  ON public.attendance_events FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "owner_full_access_attendance_records"
  ON public.attendance_records FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "owner_full_access_attendance_adjustments"
  ON public.attendance_adjustments FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "owner_full_access_attendance_periods"
  ON public.attendance_periods FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

CREATE POLICY "attendance_view_access_qr_checkpoints"
  ON public.attendance_qr_checkpoints FOR SELECT
  USING (public.has_role(auth.uid(), 'owner') OR public.has_module_permission(auth.uid(), 'attendance', 'view'));
CREATE POLICY "attendance_view_access_shifts"
  ON public.attendance_shifts FOR SELECT
  USING (public.has_role(auth.uid(), 'owner') OR public.has_module_permission(auth.uid(), 'attendance', 'view'));
CREATE POLICY "attendance_view_access_shift_assignments"
  ON public.attendance_shift_assignments FOR SELECT
  USING (public.has_role(auth.uid(), 'owner') OR public.has_module_permission(auth.uid(), 'attendance', 'view'));
CREATE POLICY "attendance_view_access_events"
  ON public.attendance_events FOR SELECT
  USING (public.has_role(auth.uid(), 'owner') OR public.has_module_permission(auth.uid(), 'attendance', 'view'));
CREATE POLICY "attendance_view_access_records"
  ON public.attendance_records FOR SELECT
  USING (public.has_role(auth.uid(), 'owner') OR public.has_module_permission(auth.uid(), 'attendance', 'view'));
CREATE POLICY "attendance_view_access_adjustments"
  ON public.attendance_adjustments FOR SELECT
  USING (public.has_role(auth.uid(), 'owner') OR public.has_module_permission(auth.uid(), 'attendance', 'view'));
CREATE POLICY "attendance_view_access_periods"
  ON public.attendance_periods FOR SELECT
  USING (public.has_role(auth.uid(), 'owner') OR public.has_module_permission(auth.uid(), 'attendance', 'view'));

CREATE POLICY "attendance_edit_access_qr_checkpoints"
  ON public.attendance_qr_checkpoints FOR ALL
  USING (public.has_module_permission(auth.uid(), 'attendance', 'edit'))
  WITH CHECK (public.has_module_permission(auth.uid(), 'attendance', 'edit'));
CREATE POLICY "attendance_edit_access_shifts"
  ON public.attendance_shifts FOR ALL
  USING (public.has_module_permission(auth.uid(), 'attendance', 'edit'))
  WITH CHECK (public.has_module_permission(auth.uid(), 'attendance', 'edit'));
CREATE POLICY "attendance_edit_access_shift_assignments"
  ON public.attendance_shift_assignments FOR ALL
  USING (public.has_module_permission(auth.uid(), 'attendance', 'edit'))
  WITH CHECK (public.has_module_permission(auth.uid(), 'attendance', 'edit'));
CREATE POLICY "attendance_edit_access_events"
  ON public.attendance_events FOR ALL
  USING (public.has_module_permission(auth.uid(), 'attendance', 'edit'))
  WITH CHECK (public.has_module_permission(auth.uid(), 'attendance', 'edit'));
CREATE POLICY "attendance_edit_access_records"
  ON public.attendance_records FOR ALL
  USING (public.has_module_permission(auth.uid(), 'attendance', 'edit'))
  WITH CHECK (public.has_module_permission(auth.uid(), 'attendance', 'edit'));
CREATE POLICY "attendance_edit_access_adjustments"
  ON public.attendance_adjustments FOR ALL
  USING (public.has_module_permission(auth.uid(), 'attendance', 'edit'))
  WITH CHECK (public.has_module_permission(auth.uid(), 'attendance', 'edit'));
CREATE POLICY "attendance_edit_access_periods"
  ON public.attendance_periods FOR ALL
  USING (public.has_module_permission(auth.uid(), 'attendance', 'edit'))
  WITH CHECK (public.has_module_permission(auth.uid(), 'attendance', 'edit'));

-- 9) Seed attendance defaults into existing non-owner users
INSERT INTO public.user_module_permissions (user_id, module_key, can_view, can_edit)
SELECT ur.user_id,
       'attendance' AS module_key,
       (ur.role IN ('staff')) AS can_view,
       false AS can_edit
FROM public.user_roles ur
JOIN auth.users au ON au.id = ur.user_id
WHERE ur.role <> 'owner'
ON CONFLICT (user_id, module_key) DO NOTHING;

-- 10) Seed sample shifts/checkpoints for initial ops usage
INSERT INTO public.attendance_shifts (shift_code, shift_name, start_time, end_time, grace_minutes, early_leave_grace_minutes)
VALUES
  ('HC-SANG', 'Ca sáng', '08:00', '17:00', 5, 5),
  ('HC-CHIEU', 'Ca chiều', '13:00', '22:00', 5, 5)
ON CONFLICT (shift_code) DO NOTHING;

INSERT INTO public.attendance_qr_checkpoints (checkpoint_code, checkpoint_name, location_label)
VALUES
  ('BMQ-HQ-IN', 'Cổng check-in BMQ', 'BMQ HQ'),
  ('BMQ-HQ-OUT', 'Cổng check-out BMQ', 'BMQ HQ')
ON CONFLICT (checkpoint_code) DO NOTHING;
