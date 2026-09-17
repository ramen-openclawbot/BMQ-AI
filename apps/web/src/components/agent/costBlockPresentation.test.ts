import test from "node:test";
import assert from "node:assert/strict";
import type { CostLineBlock } from "../../lib/bmqAnalytics";
import { COST_BLOCK_LABELS, costBlockExplanationSummary, costBlockHeading, costBlockVisibleWarning } from "./costBlockPresentation.ts";

const base: CostLineBlock = {
  v: 1, kind: "cost_line", mode: "example", month: "2026-09",
  line: {
    classificationId: "c2", sourceNumber: "PR-2026-09-000002", sourceDate: "2026-09-14",
    supplierName: "Thiên An Sinh", productName: "Chà lụa lá TVP XL", amount: 5940000,
    categoryLabel: "Chi phí bánh mì", categoryCode: "COGS_BMQ_BREAD", reviewStatus: "needs_review",
    confidence: "0", classificationSource: "fallback",
  },
  evidence: { stored: true, rule: null, alias: null, aliasStatus: null },
  notes: ["Không có rule nào được gắn với phân loại này; lý do lịch sử không có sẵn và hệ thống không tự suy diễn."],
  source: {
    name: "Supabase.cost_classification_line_details", observedAt: "2026-09-16T21:37:45Z", snapshotId: "snap-2026-09-16",
    semanticVersion: "bmq-cost-classification-v2", selectionRule: "largest_line_amount_then_source_date_then_classification_id",
    matchCount: 17, truncated: true, disclaimer: "Không phải báo cáo đã kiểm toán.",
  },
  followUp: "line_explanation",
};

const rule = { name: "BMQ bread keywords", scope: "supplier_and_item", priority: "100", confidence: "0.90", effectiveFrom: "2026-01-01", effectiveTo: null };

test("the example card warns only when stored evidence is actually unavailable", () => {
  assert.equal(costBlockVisibleWarning({ ...base }, "vi"), null);
  const noEvidence = costBlockVisibleWarning({ ...base, evidence: { stored: false, rule: null, alias: null, aliasStatus: null } }, "vi");
  assert.match(noEvidence ?? "", /Chưa lấy được bằng chứng phân loại đã lưu/);
  assert.match(costBlockVisibleWarning({ ...base, evidence: { stored: false, rule: null, alias: null, aliasStatus: null } }, "en") ?? "", /evidence is unavailable/);
  // A stored snapshot without a linked rule is not a missing-evidence warning.
  assert.equal(costBlockVisibleWarning({ ...base, evidence: { stored: true, rule: null, alias: null, aliasStatus: null } }, "vi"), null);
});

test("the explanation heading is descriptive, never a why-review inference", () => {
  assert.equal(costBlockHeading({ ...base, mode: "explanation" }, "vi"), "CẦN KIỂM TRA");
  assert.equal(costBlockHeading({ ...base, mode: "explanation", line: { ...base.line, reviewStatus: "suggested" } }, "vi"), "CĂN CỨ PHÂN LOẠI");
  assert.equal(costBlockHeading({ ...base, mode: "explanation" }, "en"), "NEEDS REVIEW");
  for (const value of Object.values(COST_BLOCK_LABELS)) {
    assert.doesNotMatch(value.headingNeedsReview, /vì sao|why/i);
    assert.doesNotMatch(value.headingBasis, /vì sao|why/i);
  }
});

test("the explanation summary states only what the stored evidence proves", () => {
  const noRule = costBlockExplanationSummary({ ...base, mode: "explanation" }, "vi");
  assert.deepEqual(noRule, ["Chưa đủ căn cứ để kết luận nguyên nhân."]);
  // No linked rule must never be turned into a stated cause of the review status.
  assert.doesNotMatch(noRule.join(" "), /rule|quy tắc|vì|do /i);

  const linked = costBlockExplanationSummary({ ...base, mode: "explanation", evidence: { stored: true, rule, alias: null, aliasStatus: null } }, "vi");
  assert.deepEqual(linked, ["Có liên kết quy tắc đã lưu; chưa đủ để kết luận nguyên nhân lịch sử."]);
  assert.doesNotMatch(linked.join(" "), /đã gây|nguyên nhân là|vì rule/i);

  const unavailable = costBlockExplanationSummary({ ...base, mode: "explanation", evidence: { stored: false, rule: null, alias: null, aliasStatus: null } }, "vi");
  assert.deepEqual(unavailable, ["Chưa đủ căn cứ để kết luận nguyên nhân."]);

  assert.deepEqual(costBlockExplanationSummary({ ...base, mode: "explanation", evidence: { stored: true, rule, alias: null, aliasStatus: null } }, "en"), ["A stored rule link exists; still not enough to conclude the historical cause."]);
  assert.deepEqual(costBlockExplanationSummary({ ...base, mode: "explanation" }, "en"), ["Not enough evidence to conclude the cause."]);
});
