-- ============================================================================
-- Migration: Payroll Phase 2B — engine for monthly / hourly / per-shift wages
-- Goal: Consume attendance_records to produce payroll_runs + payroll_lines,
--       maintain employee_wage_profiles, and support adjustments.
-- ============================================================================

-- 1) Enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payroll_wage_type') THEN
    CREATE TYPE public.payroll_wage_type AS ENUM ('monthly', 'hourly', 'per_shift');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payroll_run_status') THEN
    CREATE TYPE public.payroll_run_status AS ENUM (
      'draft',
      'calculated',
      'approved',
      'locked'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payroll_adjustment_type') THEN
    CREATE TYPE public.payroll_adjustment_type AS ENUM (
      'bonus',
      'deduction',
      'advance',
      'correction',
      'other'
    );
  END IF;
END $$;

-- 2) employee_wage_profiles — versioned wage contracts keyed by employee_code
CREATE TABLE IF NOT EXISTS public.employee_wage_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code text NOT NULL,
  employee_name text,
  wage_type public.payroll_wage_type NOT NULL,
  base_monthly_salary numeric(15,2) NOT NULL DEFAULT 0,
  hourly_rate numeric(12,2) NOT NULL DEFAULT 0,
  per_shift_rate numeric(12,2) NOT NULL DEFAULT 0,
  standard_days_per_month integer NOT NULL DEFAULT 26,
  standard_hours_per_day numeric(5,2) NOT NULL DEFAULT 8,
  late_penalty_per_hour numeric(12,2) NOT NULL DEFAULT 0,
  partial_shift_floor numeric(4,2) NOT NULL DEFAULT 0.5,
  department text,
  currency text NOT NULL DEFAULT 'VND',
  effective_from date NOT NULL,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_wage_profiles_employee
  ON public.employee_wage_profiles(employee_code, effective_from);

CREATE INDEX IF NOT EXISTS idx_employee_wage_profiles_active
  ON public.employee_wage_profiles(is_active, effective_from);

CREATE TRIGGER set_updated_at_employee_wage_profiles
  BEFORE UPDATE ON public.employee_wage_profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 3) payroll_runs — header table for a calculation cycle
CREATE TABLE IF NOT EXISTS public.payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_code text NOT NULL UNIQUE,
  period_name text NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  attendance_period_id uuid REFERENCES public.attendance_periods(id) ON DELETE SET NULL,
  status public.payroll_run_status NOT NULL DEFAULT 'draft',
  calculated_at timestamptz,
  calculated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  locked_at timestamptz,
  locked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes text,
  total_gross numeric(18,2) NOT NULL DEFAULT 0,
  total_deductions numeric(18,2) NOT NULL DEFAULT 0,
  total_net numeric(18,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_status
  ON public.payroll_runs(status, period_from);

CREATE TRIGGER set_updated_at_payroll_runs
  BEFORE UPDATE ON public.payroll_runs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 4) payroll_lines — one row per employee per run
CREATE TABLE IF NOT EXISTS public.payroll_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id uuid NOT NULL REFERENCES public.payroll_runs(id) ON DELETE CASCADE,
  employee_code text NOT NULL,
  employee_name text,
  department text,
  wage_type_snapshot public.payroll_wage_type NOT NULL,
  wage_profile_id uuid REFERENCES public.employee_wage_profiles(id) ON DELETE SET NULL,
  total_days_present integer NOT NULL DEFAULT 0,
  total_days_scheduled integer NOT NULL DEFAULT 0,
  total_hours_worked numeric(10,2) NOT NULL DEFAULT 0,
  total_hours_scheduled numeric(10,2) NOT NULL DEFAULT 0,
  total_minutes_late integer NOT NULL DEFAULT 0,
  total_minutes_early_leave integer NOT NULL DEFAULT 0,
  total_shifts_full integer NOT NULL DEFAULT 0,
  total_shifts_partial integer NOT NULL DEFAULT 0,
  base_amount numeric(15,2) NOT NULL DEFAULT 0,
  late_deduction numeric(15,2) NOT NULL DEFAULT 0,
  adjustment_total numeric(15,2) NOT NULL DEFAULT 0,
  gross_amount numeric(15,2) NOT NULL DEFAULT 0,
  net_amount numeric(15,2) NOT NULL DEFAULT 0,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payroll_run_id, employee_code)
);

CREATE INDEX IF NOT EXISTS idx_payroll_lines_run
  ON public.payroll_lines(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_lines_employee
  ON public.payroll_lines(employee_code, payroll_run_id);

CREATE TRIGGER set_updated_at_payroll_lines
  BEFORE UPDATE ON public.payroll_lines
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 5) payroll_adjustments — per-line manual adjustments
CREATE TABLE IF NOT EXISTS public.payroll_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_line_id uuid NOT NULL REFERENCES public.payroll_lines(id) ON DELETE CASCADE,
  adjustment_type public.payroll_adjustment_type NOT NULL,
  amount numeric(15,2) NOT NULL,
  reason text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_line
  ON public.payroll_adjustments(payroll_line_id);

-- 6) Enable RLS
ALTER TABLE public.employee_wage_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_adjustments ENABLE ROW LEVEL SECURITY;

-- Owner full access
CREATE POLICY "owner_full_access_employee_wage_profiles"
  ON public.employee_wage_profiles FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "owner_full_access_payroll_runs"
  ON public.payroll_runs FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "owner_full_access_payroll_lines"
  ON public.payroll_lines FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "owner_full_access_payroll_adjustments"
  ON public.payroll_adjustments FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

-- Viewer access
CREATE POLICY "payroll_view_employee_wage_profiles"
  ON public.employee_wage_profiles FOR SELECT
  USING (public.has_role(auth.uid(), 'owner') OR public.has_module_permission(auth.uid(), 'payroll', 'view'));
CREATE POLICY "payroll_view_payroll_runs"
  ON public.payroll_runs FOR SELECT
  USING (public.has_role(auth.uid(), 'owner') OR public.has_module_permission(auth.uid(), 'payroll', 'view'));
CREATE POLICY "payroll_view_payroll_lines"
  ON public.payroll_lines FOR SELECT
  USING (public.has_role(auth.uid(), 'owner') OR public.has_module_permission(auth.uid(), 'payroll', 'view'));
CREATE POLICY "payroll_view_payroll_adjustments"
  ON public.payroll_adjustments FOR SELECT
  USING (public.has_role(auth.uid(), 'owner') OR public.has_module_permission(auth.uid(), 'payroll', 'view'));

-- Editor access
CREATE POLICY "payroll_edit_employee_wage_profiles"
  ON public.employee_wage_profiles FOR ALL
  USING (public.has_module_permission(auth.uid(), 'payroll', 'edit'))
  WITH CHECK (public.has_module_permission(auth.uid(), 'payroll', 'edit'));
CREATE POLICY "payroll_edit_payroll_runs"
  ON public.payroll_runs FOR ALL
  USING (public.has_module_permission(auth.uid(), 'payroll', 'edit'))
  WITH CHECK (public.has_module_permission(auth.uid(), 'payroll', 'edit'));
CREATE POLICY "payroll_edit_payroll_lines"
  ON public.payroll_lines FOR ALL
  USING (public.has_module_permission(auth.uid(), 'payroll', 'edit'))
  WITH CHECK (public.has_module_permission(auth.uid(), 'payroll', 'edit'));
CREATE POLICY "payroll_edit_payroll_adjustments"
  ON public.payroll_adjustments FOR ALL
  USING (public.has_module_permission(auth.uid(), 'payroll', 'edit'))
  WITH CHECK (public.has_module_permission(auth.uid(), 'payroll', 'edit'));

-- 7) RPC: resolve the active wage profile for an employee on a given date
CREATE OR REPLACE FUNCTION public.payroll_resolve_wage_profile(
  _employee_code text,
  _as_of date
)
RETURNS SETOF public.employee_wage_profiles
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT *
  FROM public.employee_wage_profiles
  WHERE employee_code = _employee_code
    AND is_active
    AND effective_from <= _as_of
    AND (effective_to IS NULL OR effective_to >= _as_of)
  ORDER BY effective_from DESC
  LIMIT 1;
$$;

-- 8) RPC: calculate a payroll run
-- Reads attendance_records in [period_from, period_to], applies wage profile per row,
-- then upserts payroll_lines. Does NOT touch locked runs.
CREATE OR REPLACE FUNCTION public.payroll_calculate_run(_run_id uuid)
RETURNS TABLE(processed_employees integer, lines_written integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.payroll_runs%ROWTYPE;
  v_processed integer := 0;
  v_written integer := 0;
  v_uid uuid;
  v_emp record;
  v_profile public.employee_wage_profiles%ROWTYPE;
  v_days_present integer;
  v_days_scheduled integer;
  v_hours_worked numeric(10,2);
  v_hours_scheduled numeric(10,2);
  v_minutes_late integer;
  v_minutes_early integer;
  v_shifts_full integer;
  v_shifts_partial integer;
  v_base numeric(15,2);
  v_late_ded numeric(15,2);
  v_adjust_total numeric(15,2);
  v_gross numeric(15,2);
  v_net numeric(15,2);
  v_snapshot jsonb;
  v_line_id uuid;
BEGIN
  v_uid := auth.uid();

  IF NOT (
    public.has_role(v_uid, 'owner')
    OR public.has_module_permission(v_uid, 'payroll', 'edit')
  ) THEN
    RAISE EXCEPTION 'insufficient_privilege: payroll edit required';
  END IF;

  SELECT * INTO v_run FROM public.payroll_runs WHERE id = _run_id;
  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'payroll_run not found: %', _run_id;
  END IF;

  IF v_run.status IN ('approved', 'locked') THEN
    RAISE EXCEPTION 'payroll_run is % and cannot be recalculated', v_run.status;
  END IF;

  FOR v_emp IN
    SELECT DISTINCT r.employee_code, r.employee_name
    FROM public.attendance_records r
    WHERE r.work_date BETWEEN v_run.period_from AND v_run.period_to
  LOOP
    v_processed := v_processed + 1;

    SELECT * INTO v_profile
    FROM public.payroll_resolve_wage_profile(v_emp.employee_code, v_run.period_to);

    IF v_profile.id IS NULL THEN
      -- No active wage profile: write a stub line so HR can fix it.
      INSERT INTO public.payroll_lines (
        payroll_run_id, employee_code, employee_name, wage_type_snapshot,
        notes, snapshot
      ) VALUES (
        _run_id, v_emp.employee_code, v_emp.employee_name, 'monthly',
        'No active wage profile for this employee during the run period.',
        jsonb_build_object('missing_wage_profile', true)
      )
      ON CONFLICT (payroll_run_id, employee_code) DO UPDATE
        SET notes = EXCLUDED.notes,
            snapshot = EXCLUDED.snapshot,
            updated_at = now();
      v_written := v_written + 1;
      CONTINUE;
    END IF;

    -- Aggregate attendance metrics for this employee in period
    SELECT
      COUNT(*) FILTER (WHERE r.status IN ('present','late','early_leave','late_early_leave')),
      COUNT(*),
      COALESCE(SUM(
        CASE
          WHEN r.actual_check_in IS NOT NULL AND r.actual_check_out IS NOT NULL
          THEN EXTRACT(EPOCH FROM (r.actual_check_out - r.actual_check_in))/3600.0
          ELSE 0
        END
      ), 0)::numeric(10,2),
      COALESCE(SUM(
        CASE
          WHEN r.scheduled_start IS NOT NULL AND r.scheduled_end IS NOT NULL
          THEN EXTRACT(EPOCH FROM (r.scheduled_end - r.scheduled_start))/3600.0
          ELSE 0
        END
      ), 0)::numeric(10,2),
      COALESCE(SUM(r.minutes_late), 0),
      COALESCE(SUM(r.minutes_early_leave), 0),
      COUNT(*) FILTER (WHERE r.status = 'present' AND r.minutes_late = 0 AND r.minutes_early_leave = 0),
      COUNT(*) FILTER (WHERE r.status IN ('late','early_leave','late_early_leave'))
    INTO
      v_days_present, v_days_scheduled, v_hours_worked, v_hours_scheduled,
      v_minutes_late, v_minutes_early, v_shifts_full, v_shifts_partial
    FROM public.attendance_records r
    WHERE r.employee_code = v_emp.employee_code
      AND r.work_date BETWEEN v_run.period_from AND v_run.period_to;

    v_base := 0;
    v_late_ded := 0;

    IF v_profile.wage_type = 'monthly' THEN
      v_base := ROUND(
        v_profile.base_monthly_salary *
        (v_days_present::numeric / NULLIF(v_profile.standard_days_per_month, 0)),
        2
      );
      -- late penalty derived from base/(std_days*std_hours)
      v_late_ded := ROUND(
        (v_profile.base_monthly_salary /
          NULLIF(v_profile.standard_days_per_month * v_profile.standard_hours_per_day * 60, 0))
        * v_minutes_late,
        2
      );
    ELSIF v_profile.wage_type = 'hourly' THEN
      v_base := ROUND(v_profile.hourly_rate * v_hours_worked, 2);
      v_late_ded := 0; -- hourly already trimmed by actual hours
    ELSIF v_profile.wage_type = 'per_shift' THEN
      -- full shifts full rate, partial shifts at floor fraction
      v_base := ROUND(
        (v_profile.per_shift_rate * v_shifts_full)
        + (v_profile.per_shift_rate * v_profile.partial_shift_floor * v_shifts_partial),
        2
      );
      v_late_ded := 0;
    END IF;

    v_snapshot := jsonb_build_object(
      'employee_code', v_emp.employee_code,
      'wage_type', v_profile.wage_type,
      'base_monthly_salary', v_profile.base_monthly_salary,
      'hourly_rate', v_profile.hourly_rate,
      'per_shift_rate', v_profile.per_shift_rate,
      'standard_days_per_month', v_profile.standard_days_per_month,
      'standard_hours_per_day', v_profile.standard_hours_per_day,
      'partial_shift_floor', v_profile.partial_shift_floor
    );

    INSERT INTO public.payroll_lines (
      payroll_run_id, employee_code, employee_name, department,
      wage_type_snapshot, wage_profile_id,
      total_days_present, total_days_scheduled,
      total_hours_worked, total_hours_scheduled,
      total_minutes_late, total_minutes_early_leave,
      total_shifts_full, total_shifts_partial,
      base_amount, late_deduction,
      gross_amount, net_amount, snapshot
    ) VALUES (
      _run_id, v_emp.employee_code,
      COALESCE(v_emp.employee_name, v_profile.employee_name),
      v_profile.department,
      v_profile.wage_type, v_profile.id,
      v_days_present, v_days_scheduled,
      v_hours_worked, v_hours_scheduled,
      v_minutes_late, v_minutes_early,
      v_shifts_full, v_shifts_partial,
      v_base, v_late_ded,
      GREATEST(v_base - v_late_ded, 0),
      GREATEST(v_base - v_late_ded, 0),
      v_snapshot
    )
    ON CONFLICT (payroll_run_id, employee_code) DO UPDATE
      SET employee_name = EXCLUDED.employee_name,
          department = EXCLUDED.department,
          wage_type_snapshot = EXCLUDED.wage_type_snapshot,
          wage_profile_id = EXCLUDED.wage_profile_id,
          total_days_present = EXCLUDED.total_days_present,
          total_days_scheduled = EXCLUDED.total_days_scheduled,
          total_hours_worked = EXCLUDED.total_hours_worked,
          total_hours_scheduled = EXCLUDED.total_hours_scheduled,
          total_minutes_late = EXCLUDED.total_minutes_late,
          total_minutes_early_leave = EXCLUDED.total_minutes_early_leave,
          total_shifts_full = EXCLUDED.total_shifts_full,
          total_shifts_partial = EXCLUDED.total_shifts_partial,
          base_amount = EXCLUDED.base_amount,
          late_deduction = EXCLUDED.late_deduction,
          snapshot = EXCLUDED.snapshot,
          updated_at = now()
      RETURNING id INTO v_line_id;

    -- Reapply adjustments total (preserved across recalculations)
    SELECT COALESCE(SUM(
      CASE WHEN adjustment_type IN ('deduction','advance') THEN -amount ELSE amount END
    ), 0)
    INTO v_adjust_total
    FROM public.payroll_adjustments
    WHERE payroll_line_id = v_line_id;

    v_gross := GREATEST(v_base - v_late_ded, 0);
    v_net   := GREATEST(v_gross + v_adjust_total, 0);

    UPDATE public.payroll_lines
      SET adjustment_total = v_adjust_total,
          gross_amount = v_gross,
          net_amount = v_net
      WHERE id = v_line_id;

    v_written := v_written + 1;
  END LOOP;

  -- Refresh run totals
  UPDATE public.payroll_runs
    SET status = 'calculated',
        calculated_at = now(),
        calculated_by = v_uid,
        total_gross = COALESCE((SELECT SUM(gross_amount) FROM public.payroll_lines WHERE payroll_run_id = _run_id), 0),
        total_deductions = COALESCE((SELECT SUM(late_deduction) FROM public.payroll_lines WHERE payroll_run_id = _run_id), 0),
        total_net = COALESCE((SELECT SUM(net_amount) FROM public.payroll_lines WHERE payroll_run_id = _run_id), 0),
        updated_at = now()
    WHERE id = _run_id;

  RETURN QUERY SELECT v_processed, v_written;
END;
$$;

COMMENT ON FUNCTION public.payroll_calculate_run(uuid)
  IS 'Recalculate a payroll run from attendance_records. Blocked on approved/locked runs.';

-- 9) Grants
GRANT EXECUTE ON FUNCTION public.payroll_resolve_wage_profile(text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_calculate_run(uuid) TO authenticated;

-- 10) Seed payroll permission for existing non-owner users (view only by default)
INSERT INTO public.user_module_permissions (user_id, module_key, can_view, can_edit)
SELECT ur.user_id,
       'payroll' AS module_key,
       false AS can_view,
       false AS can_edit
FROM public.user_roles ur
JOIN auth.users au ON au.id = ur.user_id
WHERE ur.role <> 'owner'
ON CONFLICT (user_id, module_key) DO NOTHING;
