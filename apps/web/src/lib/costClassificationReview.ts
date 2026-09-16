/**
 * Pure helpers for the Finance Control cost-classification summary.
 *
 * The Supabase view `cost_classification_monthly_summary` returns one row per
 * (month, category_code, review_status), so the exact money for a status is
 * already present as `total_amount`. The UI must sum those exact status
 * amounts — never estimate pending money with a row-count ratio of the
 * category total. `UNMAPPED_REVIEW` rows are forced to `needs_review` by the
 * view, so summing `needs_review` amounts already includes them exactly once
 * and no extra UNMAPPED branch may be added on top.
 *
 * A status line with a count but no recorded amount is unknown money. It is
 * reported as an incomplete amount (never presented as an exact zero, and
 * never ratio-estimated from the other statuses).
 */

export interface CostClassificationMonthlySummaryView {
  month: string;
  category_code: string;
  category_label: string;
  cost_group: string;
  product_line: string;
  allocation_rule: string;
  review_status: string;
  line_count: number;
  total_amount: number;
}

export interface CostCategoryView {
  code: string;
  label?: string | null;
  cost_group?: string | null;
  product_line?: string | null;
  sort_order?: number | null;
}

export interface CostClassificationDisplayRow extends CostClassificationMonthlySummaryView {
  review_status_counts: Record<string, number>;
  review_status_amounts: Record<string, number>;
  missing_amount_statuses: string[];
}

export interface CostClassificationReviewStats {
  count: number;
  amount: number;
  suggestedCount: number;
  suggestedAmount: number;
  approvedCount: number;
  approvedAmount: number;
  rejectedCount: number;
  rejectedAmount: number;
  otherCount: number;
  otherAmount: number;
  allCount: number;
  allAmount: number;
  unknownAmount: boolean;
  unknownAmountStatuses: string[];
}

const toNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Group per-review-status monthly summary rows into one row per month+category.
 * Amounts are aggregated per status so callers can read exact status money.
 * Non-canonical category codes are dropped only when the category catalog is
 * non-empty, matching the previous UI behaviour.
 */
export function buildClassificationDisplayRows(
  monthlyRows: CostClassificationMonthlySummaryView[],
  categories: CostCategoryView[],
): CostClassificationDisplayRow[] {
  const categoryByCode = new Map(categories.map((category) => [category.code, category]));
  const canonicalCodes = new Set(categoryByCode.keys());
  const grouped = new Map<string, CostClassificationDisplayRow>();

  for (const row of monthlyRows) {
    if (canonicalCodes.size > 0 && !canonicalCodes.has(row.category_code)) continue;
    const key = `${row.month}-${row.category_code}`;
    const category = categoryByCode.get(row.category_code);
    const lineCount = toNumber(row.line_count);
    const amountKnown = row.total_amount !== null && row.total_amount !== undefined && Number.isFinite(Number(row.total_amount));
    const amount = amountKnown ? Number(row.total_amount) : 0;
    const reviewStatus = row.review_status || "needs_review";
    const existing = grouped.get(key);

    if (existing) {
      existing.line_count += lineCount;
      existing.total_amount += amount;
      existing.review_status_counts[reviewStatus] = (existing.review_status_counts[reviewStatus] || 0) + lineCount;
      if (amountKnown) {
        existing.review_status_amounts[reviewStatus] = (existing.review_status_amounts[reviewStatus] || 0) + amount;
      } else if (!existing.missing_amount_statuses.includes(reviewStatus)) {
        existing.missing_amount_statuses.push(reviewStatus);
      }
    } else {
      grouped.set(key, {
        ...row,
        category_label: category?.label || row.category_label || row.category_code,
        cost_group: category?.cost_group || row.cost_group,
        product_line: category?.product_line || row.product_line,
        allocation_rule: "category_code",
        review_status: "note_only",
        line_count: lineCount,
        total_amount: amount,
        review_status_counts: { [reviewStatus]: lineCount },
        review_status_amounts: amountKnown ? { [reviewStatus]: amount } : {},
        missing_amount_statuses: amountKnown ? [] : [reviewStatus],
      });
    }
  }

  return Array.from(grouped.values()).sort((a, b) => {
    const monthCompare = a.month.localeCompare(b.month);
    if (monthCompare !== 0) return monthCompare;
    const aOrder = categoryByCode.get(a.category_code)?.sort_order ?? 9999;
    const bOrder = categoryByCode.get(b.category_code)?.sort_order ?? 9999;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return (a.category_label || a.category_code).localeCompare(b.category_label || b.category_code);
  });
}

/**
 * Exact review totals by status. A status with a count but no recorded amount
 * is unknown money: it contributes 0 to the partial sum but sets
 * `unknownAmount`, so the UI never presents it as an exact zero and never
 * ratio-estimates it from the other statuses.
 */
export function computeClassificationReviewStats(
  rows: CostClassificationDisplayRow[],
): CostClassificationReviewStats {
  const stats: CostClassificationReviewStats = {
    count: 0, amount: 0,
    suggestedCount: 0, suggestedAmount: 0,
    approvedCount: 0, approvedAmount: 0,
    rejectedCount: 0, rejectedAmount: 0,
    otherCount: 0, otherAmount: 0,
    allCount: 0, allAmount: 0,
    unknownAmount: false, unknownAmountStatuses: [],
  };

  for (const row of rows) {
    const counts = row.review_status_counts || {};
    const amounts = row.review_status_amounts || {};
    const missing = new Set(row.missing_amount_statuses || []);
    for (const status of new Set([...Object.keys(counts), ...Object.keys(amounts), ...missing])) {
      const count = toNumber(counts[status]);
      const hasAmount = Object.prototype.hasOwnProperty.call(amounts, status);
      const amount = toNumber(amounts[status]);
      if (count > 0 && !hasAmount) {
        stats.unknownAmount = true;
        if (!stats.unknownAmountStatuses.includes(status)) stats.unknownAmountStatuses.push(status);
      }
      stats.allCount += count;
      stats.allAmount += amount;
      if (status === "needs_review") {
        stats.count += count;
        stats.amount += amount;
      } else if (status === "suggested") {
        stats.suggestedCount += count;
        stats.suggestedAmount += amount;
      } else if (status === "approved") {
        stats.approvedCount += count;
        stats.approvedAmount += amount;
      } else if (status === "rejected") {
        stats.rejectedCount += count;
        stats.rejectedAmount += amount;
      } else {
        stats.otherCount += count;
        stats.otherAmount += amount;
      }
    }
  }

  return stats;
}
