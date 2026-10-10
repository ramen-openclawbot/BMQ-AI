import { test } from "node:test";
import assert from "node:assert/strict";

import { daysBetween, decideJevStatus, JEV_DUPLICATE_THRESHOLDS, pairFactsFromState, type JevPairFacts } from "./policy.ts";

const facts = (over: Partial<JevPairFacts> = {}): JevPairFacts => ({
  created_older: "2026-07-30", created_newer: "2026-08-10",
  receipt_number_older: "GRN-000443", receipt_number_newer: "GRN-000464",
  receipt_date_older: "2026-07-30", receipt_date_newer: "2026-08-10",
  invoice_older: "INV-260804-GDJA", invoice_newer: "INV-260812-YOWM",
  ...over,
});
const mid = { p_same: 0.39, relation_probability: 0.5 };

test("daysBetween counts calendar days and is null for missing dates", () => {
  assert.equal(daysBetween("2026-07-30", "2026-08-10"), 11);
  assert.equal(daysBetween("2026-09-14", "2026-09-14"), 0);
  assert.equal(daysBetween(null, "2026-09-14"), null);
});

test("Đại Tân Việt: repeat order with separate receipts days apart is auto_clear", () => {
  assert.equal(decideJevStatus({ ...mid, relation: "repeat_order", facts: facts() }), "auto_clear");
  assert.equal(decideJevStatus({ ...mid, relation: "unrelated", facts: facts() }), "auto_clear");
});

test("Thiên An Sinh / Sài Gòn D&P: same-day phiếu always go to the CEO, whatever the relation", () => {
  const sameDay = facts({ created_older: "2026-09-14", created_newer: "2026-09-14", receipt_date_older: "2026-09-14", receipt_date_newer: "2026-09-14", invoice_older: null, invoice_newer: null });
  assert.equal(decideJevStatus({ ...mid, relation: "repeat_order", facts: sameDay }), "needs_review");
  assert.equal(decideJevStatus({ p_same: 0.46, relation: "same_purchase", relation_probability: 0.5, facts: sameDay }), "needs_review");
  // one day apart is still close
  assert.equal(decideJevStatus({ ...mid, relation: "repeat_order", facts: facts({ created_newer: "2026-07-31", receipt_date_newer: "2026-08-05" }) }), "needs_review");
});

test("a same_purchase lean goes to the CEO even when far apart", () => {
  assert.equal(decideJevStatus({ ...mid, relation: "same_purchase", facts: facts() }), "needs_review");
});

test("repeat order is not cleared without two distinct receipts ≥3 days apart", () => {
  assert.equal(decideJevStatus({ ...mid, relation: "repeat_order", facts: facts({ receipt_number_newer: null }) }), "needs_review");
  assert.equal(decideJevStatus({ ...mid, relation: "repeat_order", facts: facts({ receipt_number_newer: "GRN-000443" }) }), "needs_review");
  assert.equal(decideJevStatus({ ...mid, relation: "repeat_order", facts: facts({ receipt_date_newer: "2026-08-01" }) }), "needs_review");
  assert.equal(decideJevStatus({ ...mid, relation: "split_or_partial", facts: facts() }), "needs_review");
});

test("the same invoice number on both phiếu is an auto_flag", () => {
  assert.equal(decideJevStatus({ ...mid, relation: "repeat_order", facts: facts({ invoice_newer: "inv-260804 gdja" }) }), "auto_flag");
});

test("strong Jev answers keep their meaning", () => {
  assert.equal(decideJevStatus({ p_same: 0.9, relation: "same_purchase", relation_probability: JEV_DUPLICATE_THRESHOLDS.relationSamePurchase, facts: facts() }), "auto_flag");
  assert.equal(decideJevStatus({ p_same: 0.9, relation: "same_purchase", relation_probability: 0.5, facts: facts() }), "needs_review");
  assert.equal(decideJevStatus({ p_same: 0.05, relation: "repeat_order", relation_probability: 0.8 }), "auto_clear");
  assert.equal(decideJevStatus({ p_same: 0.05, relation: "same_purchase", relation_probability: 0.8 }), "needs_review");
  assert.equal(decideJevStatus({ p_same: 0.3, relation: "repeat_order", relation_probability: 0.9 }), "needs_review", "no facts, unsure: CEO");
});

test("pairFactsFromState copies the exact state fields", () => {
  const side = (d: string, gr: string | null) => ({ created_date: d, goods_receipt_number: gr, receipt_date: d, invoice_number: null });
  assert.deepEqual(pairFactsFromState({ older: side("2026-07-30", "GRN-1"), newer: side("2026-08-10", "GRN-2") }), {
    created_older: "2026-07-30", created_newer: "2026-08-10", receipt_number_older: "GRN-1", receipt_number_newer: "GRN-2",
    receipt_date_older: "2026-07-30", receipt_date_newer: "2026-08-10", invoice_older: null, invoice_newer: null,
  });
  assert.equal(pairFactsFromState(undefined), undefined);
});
