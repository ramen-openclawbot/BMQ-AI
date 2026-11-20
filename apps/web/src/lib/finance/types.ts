export type FinanceMonthKey = string;

export type FinancePnlSection =
  | "revenue"
  | "cogs"
  | "selling"
  | "operating"
  | "unclassified"
  | "capex";

export type FinanceVarianceSection = FinancePnlSection | "summary";

export interface FinancePnlLine {
  section: FinancePnlSection;
  line_code: string;
  label: string;
  amounts: Record<FinanceMonthKey, number | null>;
}

export interface FinancePnlTotals {
  revenue: number | null;
  cogs: number | null;
  gross_profit: number | null;
  gross_margin: number | null;
  selling: number | null;
  operating: number | null;
  unclassified: number | null;
  ebitda: number | null;
  ebitda_margin: number | null;
  capex: number | null;
}

export interface FinanceProductLine {
  revenue: number | null;
  direct_costs: number | null;
  contribution: number | null;
}

export interface FinancePnlProductLines {
  bmq_bread: FinanceProductLine;
  sweet_kitchen: FinanceProductLine;
  shared_costs: number | null;
}

export interface FinanceCoverage {
  expense_total: number | null;
  classified_amount: number | null;
  classified_pct: number | null;
  suggested_amount: number | null;
  approved_amount: number | null;
}

export interface FinanceFlag {
  code: string;
  month: FinanceMonthKey;
  detail_en: string;
}

export interface FinancePnl {
  from: string;
  to: string;
  currency: "VND";
  months: FinanceMonthKey[];
  lines: FinancePnlLine[];
  totals: Record<FinanceMonthKey, FinancePnlTotals>;
  by_product_line: Record<FinanceMonthKey, FinancePnlProductLines>;
  coverage: Record<FinanceMonthKey, FinanceCoverage>;
  flags: FinanceFlag[];
}

export interface FinanceVarianceDriver {
  counterparty: string;
  current: number | null;
  prior: number | null;
  delta: number | null;
}

export interface FinanceVarianceLine {
  level: "leaf" | "subtotal";
  section: FinanceVarianceSection;
  line_code: string;
  label: string;
  current: number | null;
  prior: number | null;
  delta: number | null;
  delta_pct: number | null;
  budget: null;
  budget_status: "not_set";
  flagged: boolean;
  flag_reason: "always" | "no_prior" | "material" | "below_materiality";
  drivers: FinanceVarianceDriver[];
  driver_text: string | null;
}

export interface FinanceVariance {
  month: FinanceMonthKey;
  prior_month: FinanceMonthKey;
  currency: "VND";
  materiality: {
    pct: number;
    floor_vnd: number;
  };
  lines: FinanceVarianceLine[];
  summary: string;
  flags: string[];
}

export interface FinanceApRollforwardLine {
  code: "opening" | "additions" | "payments" | "adjustments" | "closing_computed" | "closing_actual";
  label: string;
  amount: number;
  ties_to: string;
}

export interface FinanceApAgingBucket {
  bucket: "0-30" | "31-60" | "61-90" | "90+";
  count: number;
  amount: number;
}

export interface FinanceApSupplier {
  supplier_id: string | null;
  supplier_name: string;
  amount: number;
  count: number;
}

export interface FinanceApOverdue {
  days_threshold: number;
  count: number;
  amount: number;
}

export interface FinanceApFoot {
  pass: boolean;
  diff: number;
  unexplained_delta: number;
}

export interface FinanceApRollforward {
  month: FinanceMonthKey;
  currency: "VND";
  opening: number;
  additions: number;
  payments: number;
  adjustments: number;
  closing_computed: number;
  closing_actual: number;
  lines: FinanceApRollforwardLine[];
  foot: FinanceApFoot;
  aging: FinanceApAgingBucket[];
  top_suppliers: FinanceApSupplier[];
  overdue: FinanceApOverdue;
  flags: string[];
}

export interface FinanceDraftJournalEntry {
  debit: string;
  credit: string;
  amount: number;
  memo: string;
}

export type FinanceAccrualBasisMethod = "trailing_3m_avg" | "payroll_last_month";

export interface FinanceAccrualPolicy {
  code: string;
  name_en: string;
  category_code: string;
  basis_method: FinanceAccrualBasisMethod;
  basis: number | null;
  months_used: FinanceMonthKey[];
  already_booked: number;
  accrual: number | null;
  support: string;
  draft_je: FinanceDraftJournalEntry | null;
  status: "draft — not posted";
  flags: Array<"no_history" | "future_period" | "no_current_bookings">;
}

export interface FinanceAccrualSchedule {
  month: FinanceMonthKey;
  currency: "VND";
  policies: FinanceAccrualPolicy[];
}

export type FinanceCheckStatus = "pass" | "warn" | "fail" | "info";

export interface FinanceCloseCheck {
  code: string;
  title_en: string;
  status: FinanceCheckStatus;
  value: unknown;
  detail_en: string;
}

export interface FinanceCloseChecklist {
  month: FinanceMonthKey;
  checks: FinanceCloseCheck[];
}

export interface FinanceFxMonth {
  month: FinanceMonthKey;
  vndPerUsd: number | null;
  days: number;
  source: string | null;
}

export type FinanceAccrualSource =
  | "revenue_ledger"
  | "goods_receipt"
  | "approved_request_without_receipt"
  | "supplier_bread_order"
  | "payroll_period"
  | "accrual_policy";

export interface FinancePnlAccrualLine {
  section: FinancePnlSection;
  line_code: string;
  label: string;
  amount: number;
  source: FinanceAccrualSource | string;
  is_estimate: boolean;
  counterparty?: string;
  note?: string;
}

export interface FinancePnlAccrualTotals {
  revenue: number;
  cogs: number;
  gross_profit: number;
  gross_margin: number | null;
  selling: number;
  operating: number;
  unclassified: number;
  ebitda: number;
  ebitda_margin: number | null;
  estimate_total: number;
  estimate_lines: number;
  depreciation: number;
  ebit: number;
  interest: number;
  other_below_ebitda: number;
  ebt: number;
  cit: number;
  cit_is_estimate: boolean;
  net_profit: number;
  net_margin: number | null;
}

export type FinanceManualAdjustmentKind =
  | "opex"
  | "depreciation"
  | "interest"
  | "other_below_ebitda"
  | "cit"
  | "revenue_deduction";

export interface FinanceManualAdjustment {
  id: string;
  kind: FinanceManualAdjustmentKind;
  category_code: string | null;
  label: string;
  period_from: string;
  period_to: string;
  total_amount: number;
  source_ref: string | null;
  note: string | null;
  status: "active" | "void";
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FinancePnlAccrual {
  month: FinanceMonthKey;
  lines: FinancePnlAccrualLine[];
  totals: FinancePnlAccrualTotals;
  goods_receipts?: { count: number; amount: number; rejected_excluded: number; without_payment_request: number };
  bread_supplier?: {
    accrued_amount: number;
    paid_amount: number;
    variance_vs_paid: number;
    que_quantity: number;
    que_unit_price: number | null;
    vietjet_quantity: number;
    vietjet_unit_price: number | null;
  };
  inventory?: { status: string; note: string };
  below_ebitda?: { line_code: string; label: string; amount: number; source: string; is_estimate: boolean; note?: string }[];
  flags: { code: string; detail_en: string; amount?: number }[];
}
