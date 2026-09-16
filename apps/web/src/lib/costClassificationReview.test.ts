import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClassificationDisplayRows,
  computeClassificationReviewStats,
  type CostClassificationMonthlySummaryView,
  type CostCategoryView,
} from "./costClassificationReview.ts";

const CATEGORIES: CostCategoryView[] = [
  { code: "COGS_BMQ_BREAD", label: "Chi phí bánh mì", cost_group: "cogs", product_line: "bmq_bread", sort_order: 10 },
  { code: "COGS_SWEET_KITCHEN", label: "Chi phí bếp bánh ngọt", cost_group: "cogs", product_line: "sweet_kitchen", sort_order: 20 },
  { code: "OPEX_GENERAL", label: "Chi phí vận hành chung", cost_group: "opex", product_line: "general", sort_order: 40 },
  { code: "UNMAPPED_REVIEW", label: "Chưa phân loại / cần review", cost_group: "unmapped", product_line: "general", sort_order: 70 },
];

const row = (
  category_code: string,
  review_status: string,
  line_count: number,
  total_amount: number,
  month = "2026-04-01",
): CostClassificationMonthlySummaryView => ({
  month,
  category_code,
  category_label: category_code,
  cost_group: "cogs",
  product_line: "general",
  allocation_rule: "none",
  review_status,
  line_count,
  total_amount,
});

const statsFor = (rows: CostClassificationMonthlySummaryView[], categories = CATEGORIES) =>
  computeClassificationReviewStats(buildClassificationDisplayRows(rows, categories));

test("April 2026 regression: pending money is the exact needs_review sum, not a row-count ratio", () => {
  // Real reviewed April fixture: bread needs_review 12/18344200, suggested 8/53566997, approved 0.
  const rows = [
    row("COGS_BMQ_BREAD", "needs_review", 12, 18_344_200),
    row("COGS_BMQ_BREAD", "suggested", 8, 53_566_997),
  ];
  const stats = statsFor(rows);
  assert.equal(stats.count, 12);
  assert.equal(stats.amount, 18_344_200);
  assert.equal(stats.suggestedCount, 8);
  assert.equal(stats.suggestedAmount, 53_566_997);
  assert.equal(stats.approvedCount, 0);
  assert.equal(stats.approvedAmount, 0);
  assert.equal(stats.allCount, 20);
  assert.equal(stats.allAmount, 71_911_197);
  assert.equal(stats.unknownAmount, false);
  // The defect this fix removes: total_amount * pendingCount / lineCount.
  const erroneous = 71_911_197 * (12 / 20);
  assert.ok(Math.abs(erroneous - 43_146_718.2) < 0.001);
  assert.notEqual(stats.amount, erroneous);
});

test("September 2026 regression: UNMAPPED_REVIEW needs_review 6 counted once, suggested 7, approved 0", () => {
  // Real reviewed September fixture. Synthetic values must not be substituted.
  const rows = [
    row("UNMAPPED_REVIEW", "needs_review", 6, 23_618_280, "2026-09-01"),
    row("COGS_BMQ_BREAD", "suggested", 5, 10_513_500, "2026-09-01"),
    row("COGS_SWEET_KITCHEN", "suggested", 1, 997_500, "2026-09-01"),
    row("OPEX_GENERAL", "suggested", 1, 3_795_000, "2026-09-01"),
  ];
  const stats = statsFor(rows);
  assert.equal(stats.approvedCount, 0);
  assert.equal(stats.approvedAmount, 0);
  assert.equal(stats.count, 6);
  assert.equal(stats.amount, 23_618_280);
  assert.equal(stats.suggestedCount, 7);
  assert.equal(stats.suggestedAmount, 15_306_000);
  assert.equal(stats.allCount, 13);
  assert.equal(stats.allAmount, 38_924_280);
  assert.equal(stats.amount, stats.allAmount - stats.suggestedAmount, "UNMAPPED needs_review must not be added twice");
});

test("synthetic mixed statuses with unequal amounts never use an average per line", () => {
  const rows = [
    row("COGS_BMQ_BREAD", "needs_review", 1, 90_000_000),
    row("COGS_BMQ_BREAD", "approved", 9, 9_000_000),
    row("OPEX_GENERAL", "needs_review", 4, 1_000_000),
    row("OPEX_GENERAL", "suggested", 2, 55_000_000),
  ];
  const stats = statsFor(rows);
  assert.equal(stats.count, 5);
  assert.equal(stats.amount, 91_000_000);
  assert.equal(stats.suggestedCount, 2);
  assert.equal(stats.suggestedAmount, 55_000_000);
  assert.equal(stats.approvedCount, 9);
  assert.equal(stats.approvedAmount, 9_000_000);
  assert.equal(stats.allCount, 16);
  assert.equal(stats.allAmount, 155_000_000);
  // Ratio would be 100_000_000 * 5 / 16 = 31_250_000, which must never appear.
  assert.notEqual(stats.amount, 100_000_000 * (5 / 16));
});

test("UNMAPPED_REVIEW needs_review money is counted exactly once", () => {
  const rows = [
    row("UNMAPPED_REVIEW", "needs_review", 3, 5_000_000),
  ];
  const stats = statsFor(rows);
  assert.equal(stats.count, 3);
  assert.equal(stats.amount, 5_000_000);
  assert.equal(stats.allAmount, 5_000_000);
  assert.equal(stats.amount, stats.allAmount, "UNMAPPED must not be added twice");
});

test("empty input and empty category catalog produce zeroed stats", () => {
  assert.deepEqual(statsFor([]), {
    count: 0, amount: 0,
    suggestedCount: 0, suggestedAmount: 0,
    approvedCount: 0, approvedAmount: 0,
    rejectedCount: 0, rejectedAmount: 0,
    otherCount: 0, otherAmount: 0,
    allCount: 0, allAmount: 0,
    unknownAmount: false, unknownAmountStatuses: [],
  });
});

test("non-canonical categories are excluded only when a catalog is supplied", () => {
  const rows = [
    row("COGS_BMQ_BREAD", "needs_review", 1, 100),
    row("LEGACY_UNKNOWN", "needs_review", 4, 9_999_999),
  ];
  const filtered = statsFor(rows);
  assert.equal(filtered.count, 1);
  assert.equal(filtered.amount, 100);
  const unfiltered = statsFor(rows, []);
  assert.equal(unfiltered.count, 5);
  assert.equal(unfiltered.amount, 10_000_099);
});

test("a status with a count but no recorded amount is unknown, not an exact zero", () => {
  const display = buildClassificationDisplayRows([
    row("COGS_BMQ_BREAD", "needs_review", 5, 50_000_000),
  ], CATEGORIES);
  delete display[0].review_status_amounts.needs_review;
  display[0].missing_amount_statuses = ["needs_review"];
  const stats = computeClassificationReviewStats(display);
  assert.equal(stats.count, 5);
  assert.equal(stats.amount, 0);
  assert.equal(stats.unknownAmount, true);
  assert.deepEqual(stats.unknownAmountStatuses, ["needs_review"]);
  assert.equal(stats.allAmount, 0, "money is only reported from recorded per-status amounts");
});

test("a display row with a non-numeric amount marks the status unknown instead of zero", () => {
  const missing = { ...row("COGS_BMQ_BREAD", "needs_review", 2, 0), total_amount: undefined as unknown as number };
  const display = buildClassificationDisplayRows([missing, row("COGS_BMQ_BREAD", "approved", 1, 30)], CATEGORIES);
  assert.deepEqual(display[0].missing_amount_statuses, ["needs_review"]);
  assert.equal(display[0].review_status_amounts.needs_review, undefined);
  const stats = computeClassificationReviewStats(display);
  assert.equal(stats.unknownAmount, true);
  assert.deepEqual(stats.unknownAmountStatuses, ["needs_review"]);
  assert.equal(stats.amount, 0);
  assert.equal(stats.approvedAmount, 30);
});

test("display rows carry canonical labels and exact per-status amounts", () => {
  const display = buildClassificationDisplayRows([
    row("COGS_BMQ_BREAD", "needs_review", 2, 10),
    row("COGS_BMQ_BREAD", "approved", 3, 30),
  ], CATEGORIES);
  assert.equal(display.length, 1);
  assert.equal(display[0].category_label, "Chi phí bánh mì");
  assert.equal(display[0].cost_group, "cogs");
  assert.equal(display[0].allocation_rule, "category_code");
  assert.deepEqual(display[0].review_status_counts, { needs_review: 2, approved: 3 });
  assert.deepEqual(display[0].review_status_amounts, { needs_review: 10, approved: 30 });
  assert.deepEqual(display[0].missing_amount_statuses, []);
  assert.equal(display[0].total_amount, 40);
});
