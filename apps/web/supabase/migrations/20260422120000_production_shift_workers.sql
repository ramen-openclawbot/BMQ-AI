-- ============================================================================
-- Migration: Phase 2C — Cost-to-SKU bridge
-- Goal: Link production shifts to workers so labor cost can be attributed to
--       the SKUs actually produced. Provides views that roll up per-shift
--       labor cost into per-SKU labor cost per month.
-- ============================================================================

-- 1) Junction table: which workers actually worked each production shift
CREATE TABLE IF NOT EXISTS public.production_shift_workers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id        uuid NOT NULL REFERENCES public.production_shifts(id) ON DELETE CASCADE,
  employee_code   text NOT NULL,
  employee_name   text,
  role            text,                     -- e.g. operator, packer, supervisor
  minutes_worked  integer,                  -- NULL = full shift standard
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shift_id, employee_code)
);

CREATE INDEX IF NOT EXISTS idx_production_shift_workers_shift
  ON public.production_shift_workers(shift_id);
CREATE INDEX IF NOT EXISTS idx_production_shift_workers_employee
  ON public.production_shift_workers(employee_code);

CREATE TRIGGER set_updated_at_production_shift_workers
  BEFORE UPDATE ON public.production_shift_workers
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 2) RLS
ALTER TABLE public.production_shift_workers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_full_access_production_shift_workers"
  ON public.production_shift_workers FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

CREATE POLICY "production_view_shift_workers"
  ON public.production_shift_workers FOR SELECT
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_module_permission(auth.uid(), 'production', 'view')
    OR public.has_module_permission(auth.uid(), 'payroll', 'view')
  );

CREATE POLICY "production_edit_shift_workers"
  ON public.production_shift_workers FOR ALL
  USING (public.has_module_permission(auth.uid(), 'production', 'edit'))
  WITH CHECK (public.has_module_permission(auth.uid(), 'production', 'edit'));

-- 3) View: per (shift, worker) cost estimate based on active wage profile
-- ------------------------------------------------------------------------
-- For each worker assigned to a production shift we:
--   * resolve the wage profile active on that shift_date
--   * count how many shifts the worker is on that same day so we can
--     split a monthly daily-rate fairly if a worker is on multiple shifts
--   * compute estimated_cost based on wage_type:
--       monthly  -> (base_monthly_salary / std_days_per_month) / shifts_same_day
--       hourly   -> hourly_rate * hours_worked (minutes_worked or std_hours_per_day)
--       per_shift-> per_shift_rate
-- ------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_shift_worker_cost AS
WITH shift_base AS (
  SELECT
    ps.id                AS shift_id,
    ps.shift_date,
    ps.shift_type,
    psw.employee_code,
    psw.employee_name,
    psw.role,
    psw.minutes_worked
  FROM public.production_shifts ps
  JOIN public.production_shift_workers psw ON psw.shift_id = ps.id
),
with_day_count AS (
  SELECT
    sb.*,
    COUNT(*) OVER (PARTITION BY sb.employee_code, sb.shift_date) AS shifts_same_day
  FROM shift_base sb
),
with_profile AS (
  SELECT
    wdc.*,
    ewp.wage_type,
    ewp.base_monthly_salary,
    ewp.hourly_rate,
    ewp.per_shift_rate,
    COALESCE(ewp.standard_days_per_month, 26) AS std_days_per_month,
    COALESCE(ewp.standard_hours_per_day, 8)   AS std_hours_per_day
  FROM with_day_count wdc
  LEFT JOIN LATERAL (
    SELECT *
    FROM public.employee_wage_profiles p
    WHERE p.employee_code = wdc.employee_code
      AND p.effective_from <= wdc.shift_date
      AND (p.effective_to IS NULL OR p.effective_to >= wdc.shift_date)
    ORDER BY p.effective_from DESC
    LIMIT 1
  ) ewp ON TRUE
)
SELECT
  shift_id,
  shift_date,
  shift_type,
  employee_code,
  employee_name,
  role,
  wage_type,
  shifts_same_day,
  minutes_worked,
  CASE
    WHEN wage_type = 'monthly' AND base_monthly_salary IS NOT NULL THEN
      (base_monthly_salary / NULLIF(std_days_per_month, 0)) / NULLIF(shifts_same_day, 0)
    WHEN wage_type = 'hourly' AND hourly_rate IS NOT NULL THEN
      hourly_rate * COALESCE(minutes_worked / 60.0, std_hours_per_day)
    WHEN wage_type = 'per_shift' AND per_shift_rate IS NOT NULL THEN
      per_shift_rate
    ELSE 0
  END::numeric(15,2) AS estimated_cost
FROM with_profile;

-- 4) View: total labor cost per shift
CREATE OR REPLACE VIEW public.v_shift_total_labor_cost AS
SELECT
  shift_id,
  shift_date,
  shift_type,
  COUNT(*)           AS worker_count,
  SUM(estimated_cost) AS total_labor_cost
FROM public.v_shift_worker_cost
GROUP BY shift_id, shift_date, shift_type;

-- 5) View: per SKU actual labor cost (attributed by production_shift_items.actual_qty)
CREATE OR REPLACE VIEW public.v_sku_labor_cost_actual AS
WITH shift_sku AS (
  SELECT
    psi.production_shift_id AS shift_id,
    psi.sku_id,
    psi.actual_qty,
    SUM(psi.actual_qty) OVER (PARTITION BY psi.production_shift_id) AS shift_total_qty
  FROM public.production_shift_items psi
  WHERE psi.actual_qty > 0
)
SELECT
  ss.sku_id,
  ps.shift_date,
  date_trunc('month', ps.shift_date)::date AS period_month,
  ss.actual_qty,
  ss.shift_total_qty,
  (ss.actual_qty / NULLIF(ss.shift_total_qty, 0))                     AS shift_share,
  vltc.total_labor_cost                                               AS shift_labor_cost,
  (ss.actual_qty / NULLIF(ss.shift_total_qty, 0)) * COALESCE(vltc.total_labor_cost, 0)
                                                                      AS attributed_labor_cost
FROM shift_sku ss
JOIN public.production_shifts ps ON ps.id = ss.shift_id
LEFT JOIN public.v_shift_total_labor_cost vltc ON vltc.shift_id = ss.shift_id;

-- 6) View: monthly aggregate per SKU
CREATE OR REPLACE VIEW public.v_sku_labor_cost_monthly AS
SELECT
  sku_id,
  period_month,
  SUM(actual_qty)               AS total_qty_produced,
  SUM(attributed_labor_cost)    AS total_labor_cost,
  CASE
    WHEN SUM(actual_qty) > 0
      THEN SUM(attributed_labor_cost) / SUM(actual_qty)
    ELSE 0
  END                            AS cost_per_unit
FROM public.v_sku_labor_cost_actual
GROUP BY sku_id, period_month;

-- 7) Convenience view joining SKU metadata (name, sku_code) for UI
CREATE OR REPLACE VIEW public.v_sku_labor_cost_monthly_enriched AS
SELECT
  m.sku_id,
  ps.sku_code,
  ps.product_name,
  m.period_month,
  m.total_qty_produced,
  m.total_labor_cost,
  m.cost_per_unit
FROM public.v_sku_labor_cost_monthly m
LEFT JOIN public.product_skus ps ON ps.id = m.sku_id;

-- 8) Grants — views inherit from underlying table RLS; explicit grant for authenticated
GRANT SELECT ON public.v_shift_worker_cost         TO authenticated;
GRANT SELECT ON public.v_shift_total_labor_cost    TO authenticated;
GRANT SELECT ON public.v_sku_labor_cost_actual     TO authenticated;
GRANT SELECT ON public.v_sku_labor_cost_monthly    TO authenticated;
GRANT SELECT ON public.v_sku_labor_cost_monthly_enriched TO authenticated;

-- 9) Backfill: seed production_shift_workers from production_shifts.assigned_to
-- The legacy `assigned_to` text column is free-form. Skip auto-backfill here
-- (unsafe), but record a no-op so the migration is idempotent.
DO $$
BEGIN
  PERFORM 1;
END $$;

COMMENT ON TABLE  public.production_shift_workers        IS 'Workers actually staffed for each production shift. Drives SKU labor cost attribution.';
COMMENT ON VIEW   public.v_shift_worker_cost             IS 'Estimated cost per worker per shift based on active wage profile.';
COMMENT ON VIEW   public.v_shift_total_labor_cost        IS 'Total labor cost per production shift (sum of workers).';
COMMENT ON VIEW   public.v_sku_labor_cost_actual         IS 'Labor cost attributed to each SKU per shift, weighted by actual_qty share.';
COMMENT ON VIEW   public.v_sku_labor_cost_monthly        IS 'Aggregated labor cost per SKU per month (cost_per_unit ready for SKU costing).';
COMMENT ON VIEW   public.v_sku_labor_cost_monthly_enriched IS 'Same as v_sku_labor_cost_monthly, joined with SKU metadata for UI.';
