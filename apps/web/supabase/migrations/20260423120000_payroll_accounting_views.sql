-- ============================================================================
-- Migration: Phase 2D — Accounting export views
-- Goal: Expose payroll and labor-cost data in shapes ready for accounting
--       ingestion. Uses generic Vietnamese Accounting Standard (VAS) accounts.
--
-- Account mapping (simplified, adjustable per company chart of accounts):
--   6420 — Chi phí quản lý doanh nghiệp / Lương nhân viên   (Debit, expense)
--   3341 — Phải trả người lao động                         (Credit, payable)
--   3388 — Phải trả, phải nộp khác                         (Credit, withholdings)
-- ============================================================================

-- 1) Period summary — per payroll_run, totals + employee count
CREATE OR REPLACE VIEW public.v_payroll_period_summary AS
SELECT
  pr.id                    AS payroll_run_id,
  pr.period_code,
  pr.period_name,
  pr.period_from,
  pr.period_to,
  pr.status,
  pr.calculated_at,
  pr.approved_at,
  pr.locked_at,
  COUNT(pl.id)             AS employee_count,
  COALESCE(SUM(pl.base_amount), 0)        AS total_base,
  COALESCE(SUM(pl.late_deduction), 0)     AS total_late_deduction,
  COALESCE(SUM(pl.adjustment_total), 0)   AS total_adjustments,
  COALESCE(SUM(pl.gross_amount), 0)       AS total_gross,
  COALESCE(SUM(pl.net_amount), 0)         AS total_net,
  COALESCE(SUM(pl.gross_amount - pl.net_amount), 0) AS total_withholdings
FROM public.payroll_runs pr
LEFT JOIN public.payroll_lines pl ON pl.payroll_run_id = pr.id
GROUP BY pr.id;

COMMENT ON VIEW public.v_payroll_period_summary
  IS 'One row per payroll_run — top-line totals ready for accounting close.';

-- 2) Journal draft — each payroll_line explodes into debit/credit entries
CREATE OR REPLACE VIEW public.v_payroll_journal_draft AS
WITH base AS (
  SELECT
    pr.id            AS payroll_run_id,
    pr.period_code,
    pr.period_from,
    pr.period_to,
    pr.status,
    pl.id            AS payroll_line_id,
    pl.employee_code,
    pl.employee_name,
    pl.department,
    pl.gross_amount,
    pl.net_amount,
    GREATEST(pl.gross_amount - pl.net_amount, 0) AS withholding_amount
  FROM public.payroll_runs pr
  JOIN public.payroll_lines pl ON pl.payroll_run_id = pr.id
)
-- Debit 6420 — recognize labor expense at gross
SELECT
  payroll_run_id,
  period_code,
  period_from,
  period_to,
  status,
  payroll_line_id,
  employee_code,
  employee_name,
  department,
  '6420'::text    AS account_code,
  'Chi phí quản lý - Lương nhân viên'::text AS account_name,
  'debit'::text   AS entry_type,
  gross_amount    AS amount,
  1               AS entry_order
FROM base
WHERE gross_amount <> 0
UNION ALL
-- Credit 3341 — salary payable at net
SELECT
  payroll_run_id, period_code, period_from, period_to, status,
  payroll_line_id, employee_code, employee_name, department,
  '3341'::text,
  'Phải trả người lao động'::text,
  'credit'::text,
  net_amount,
  2
FROM base
WHERE net_amount <> 0
UNION ALL
-- Credit 3388 — withholdings (gross - net). Only when positive.
SELECT
  payroll_run_id, period_code, period_from, period_to, status,
  payroll_line_id, employee_code, employee_name, department,
  '3388'::text,
  'Phải trả, phải nộp khác'::text,
  'credit'::text,
  withholding_amount,
  3
FROM base
WHERE withholding_amount > 0;

COMMENT ON VIEW public.v_payroll_journal_draft
  IS 'Draft journal entries ready for accounting export. 3 lines per employee.';

-- 3) Labor cost by SKU — same numbers as v_sku_labor_cost_monthly but tagged
--    with accounting account_code so it can be fed into a WIP/COGS reclass.
CREATE OR REPLACE VIEW public.v_labor_cost_by_sku AS
SELECT
  m.sku_id,
  m.sku_code,
  m.product_name,
  m.period_month,
  to_char(m.period_month, 'YYYY-MM') AS period_code,
  m.total_qty_produced,
  m.total_labor_cost,
  m.cost_per_unit,
  '6420'::text  AS source_account_code,   -- where it was booked
  '154'::text   AS target_account_code,   -- WIP / production cost absorption
  'Chi phí sản xuất dở dang - Nhân công'::text AS target_account_name
FROM public.v_sku_labor_cost_monthly_enriched m
WHERE COALESCE(m.total_labor_cost, 0) > 0;

COMMENT ON VIEW public.v_labor_cost_by_sku
  IS 'Per-SKU labor cost with accounting reclass hint (6420 -> 154).';

-- 4) Security — views inherit RLS from the underlying payroll_* tables.
-- Explicit grant so accounting role can SELECT via PostgREST.
GRANT SELECT ON public.v_payroll_period_summary TO authenticated;
GRANT SELECT ON public.v_payroll_journal_draft  TO authenticated;
GRANT SELECT ON public.v_labor_cost_by_sku      TO authenticated;

-- 5) Optional helper function for downloadable CSV from a single call
-- (apps can alternatively query the views and build CSV client-side)
CREATE OR REPLACE FUNCTION public.payroll_journal_export(_period_code text)
RETURNS TABLE (
  period_code text,
  employee_code text,
  employee_name text,
  department text,
  account_code text,
  account_name text,
  entry_type text,
  amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT period_code, employee_code, employee_name, department,
         account_code, account_name, entry_type, amount
  FROM public.v_payroll_journal_draft
  WHERE period_code = _period_code
  ORDER BY employee_code, entry_order;
$$;

COMMENT ON FUNCTION public.payroll_journal_export(text)
  IS 'Scoped journal export for a single period_code. Respects caller RLS.';
