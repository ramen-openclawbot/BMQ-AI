-- ============================================================================
-- Migration: Attendance Phase 2A — Shift roster planner
-- Goal: extend attendance_shift_assignments for weekly roster UX,
--       add night shift seed, and create helper RPC for bulk roster operations.
-- ============================================================================

-- 1) Assignment status enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_assignment_status') THEN
    CREATE TYPE public.attendance_assignment_status AS ENUM (
      'scheduled',
      'cancelled',
      'swapped'
    );
  END IF;
END $$;

-- 2) Extend attendance_shift_assignments with status + assigned_by audit
ALTER TABLE public.attendance_shift_assignments
  ADD COLUMN IF NOT EXISTS status public.attendance_assignment_status NOT NULL DEFAULT 'scheduled';

ALTER TABLE public.attendance_shift_assignments
  ADD COLUMN IF NOT EXISTS assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.attendance_shift_assignments
  ADD COLUMN IF NOT EXISTS swapped_with uuid REFERENCES public.attendance_shift_assignments(id) ON DELETE SET NULL;

-- 3) Indexes for planner grid queries (employee × date range, date × shift)
CREATE INDEX IF NOT EXISTS idx_attendance_shift_assignments_employee_date
  ON public.attendance_shift_assignments(employee_code, work_date);

CREATE INDEX IF NOT EXISTS idx_attendance_shift_assignments_status
  ON public.attendance_shift_assignments(status);

-- 4) Seed extra standard shift (night) if missing — used by many bakery flows
INSERT INTO public.attendance_shifts (shift_code, shift_name, start_time, end_time, grace_minutes, early_leave_grace_minutes)
VALUES
  ('HC-DEM', 'Ca đêm', '22:00', '06:00', 10, 10)
ON CONFLICT (shift_code) DO NOTHING;

-- 5) RPC: copy roster from a source week to a target week for a list of employees
--    Skips work_dates inside locked/closed attendance periods.
CREATE OR REPLACE FUNCTION public.attendance_copy_week_roster(
  _source_from date,
  _target_from date,
  _employee_codes text[] DEFAULT NULL
)
RETURNS TABLE(inserted_count integer, skipped_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_row record;
  v_target_date date;
  period_status_value text;
BEGIN
  -- Guard: only owners or attendance editors can run this
  IF NOT (
    public.has_role(auth.uid(), 'owner')
    OR public.has_module_permission(auth.uid(), 'attendance', 'edit')
  ) THEN
    RAISE EXCEPTION 'insufficient_privilege: attendance edit required';
  END IF;

  FOR v_row IN
    SELECT a.employee_code, a.employee_name, a.shift_id, a.department, a.notes, a.work_date
    FROM public.attendance_shift_assignments a
    WHERE a.work_date >= _source_from
      AND a.work_date < _source_from + INTERVAL '7 days'
      AND a.status = 'scheduled'
      AND (_employee_codes IS NULL OR a.employee_code = ANY(_employee_codes))
  LOOP
    v_target_date := _target_from + (v_row.work_date - _source_from);

    -- Check if target date is inside a locked/closed period
    SELECT status INTO period_status_value
    FROM public.attendance_periods
    WHERE v_target_date BETWEEN date_from AND date_to
    ORDER BY date_from DESC
    LIMIT 1;

    IF period_status_value IN ('locked', 'closed') THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.attendance_shift_assignments(
      employee_code, employee_name, shift_id, work_date, department, notes, status, assigned_by
    )
    VALUES (
      v_row.employee_code, v_row.employee_name, v_row.shift_id, v_target_date,
      v_row.department, v_row.notes, 'scheduled', auth.uid()
    )
    ON CONFLICT (employee_code, work_date) DO UPDATE
      SET shift_id   = EXCLUDED.shift_id,
          department = COALESCE(EXCLUDED.department, public.attendance_shift_assignments.department),
          status     = 'scheduled',
          assigned_by = auth.uid(),
          updated_at = now();

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN QUERY SELECT v_inserted, v_skipped;
END;
$$;

COMMENT ON FUNCTION public.attendance_copy_week_roster(date, date, text[])
  IS 'Copy a week of shift assignments (scheduled only) to a new target week. Skips days in locked/closed periods.';

-- 6) RPC: bulk upsert roster rows from a CSV/JSON payload (used by BulkAssignDialog)
CREATE OR REPLACE FUNCTION public.attendance_bulk_upsert_roster(_rows jsonb)
RETURNS TABLE(inserted_count integer, skipped_count integer, error_messages text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_errors text[] := ARRAY[]::text[];
  v_row jsonb;
  v_employee_code text;
  v_employee_name text;
  v_work_date date;
  v_shift_code text;
  v_shift_id uuid;
  v_department text;
  period_status_value text;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'owner')
    OR public.has_module_permission(auth.uid(), 'attendance', 'edit')
  ) THEN
    RAISE EXCEPTION 'insufficient_privilege: attendance edit required';
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(_rows)
  LOOP
    BEGIN
      v_employee_code := NULLIF(trim(v_row->>'employee_code'), '');
      v_employee_name := NULLIF(trim(v_row->>'employee_name'), '');
      v_work_date     := (v_row->>'work_date')::date;
      v_shift_code    := NULLIF(trim(v_row->>'shift_code'), '');
      v_department    := NULLIF(trim(v_row->>'department'), '');

      IF v_employee_code IS NULL OR v_work_date IS NULL OR v_shift_code IS NULL THEN
        v_skipped := v_skipped + 1;
        v_errors  := array_append(v_errors, format('missing fields for row: %s', v_row::text));
        CONTINUE;
      END IF;

      SELECT id INTO v_shift_id FROM public.attendance_shifts WHERE shift_code = v_shift_code AND is_active;
      IF v_shift_id IS NULL THEN
        v_skipped := v_skipped + 1;
        v_errors  := array_append(v_errors, format('shift_code not found: %s', v_shift_code));
        CONTINUE;
      END IF;

      SELECT status INTO period_status_value
      FROM public.attendance_periods
      WHERE v_work_date BETWEEN date_from AND date_to
      ORDER BY date_from DESC
      LIMIT 1;

      IF period_status_value IN ('locked', 'closed') THEN
        v_skipped := v_skipped + 1;
        v_errors  := array_append(v_errors, format('locked period for %s / %s', v_employee_code, v_work_date));
        CONTINUE;
      END IF;

      INSERT INTO public.attendance_shift_assignments(
        employee_code, employee_name, shift_id, work_date, department, status, assigned_by
      )
      VALUES (
        v_employee_code, v_employee_name, v_shift_id, v_work_date, v_department, 'scheduled', auth.uid()
      )
      ON CONFLICT (employee_code, work_date) DO UPDATE
        SET shift_id   = EXCLUDED.shift_id,
            employee_name = COALESCE(EXCLUDED.employee_name, public.attendance_shift_assignments.employee_name),
            department = COALESCE(EXCLUDED.department, public.attendance_shift_assignments.department),
            status     = 'scheduled',
            assigned_by = auth.uid(),
            updated_at = now();

      v_inserted := v_inserted + 1;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped + 1;
      v_errors  := array_append(v_errors, format('row error: %s (%s)', v_row::text, SQLERRM));
    END;
  END LOOP;

  RETURN QUERY SELECT v_inserted, v_skipped, v_errors;
END;
$$;

COMMENT ON FUNCTION public.attendance_bulk_upsert_roster(jsonb)
  IS 'Bulk upsert roster rows. Input: JSON array of {employee_code, employee_name, work_date, shift_code, department}.';

-- 7) Grant execute on new RPCs
GRANT EXECUTE ON FUNCTION public.attendance_copy_week_roster(date, date, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attendance_bulk_upsert_roster(jsonb) TO authenticated;
