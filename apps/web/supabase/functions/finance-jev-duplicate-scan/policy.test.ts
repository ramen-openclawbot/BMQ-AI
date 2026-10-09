import { test } from "node:test";
import assert from "node:assert/strict";

import { decideJevStatus, JEV_DUPLICATE_THRESHOLDS } from "./policy.ts";

test("auto_flags only a strong same-purchase answer with a decisive relation", () => {
  assert.equal(decideJevStatus({ p_same: 0.9, relation: "same_purchase", relation_probability: 0.7 }), "auto_flag");
  // strong p_same but a weak same_purchase relation stays with the CEO
  assert.equal(decideJevStatus({ p_same: 0.9, relation: "same_purchase", relation_probability: 0.5 }), "needs_review");
  // strong p_same but another relation stays with the CEO
  assert.equal(decideJevStatus({ p_same: 0.9, relation: "split_or_partial", relation_probability: 0.7 }), "needs_review");
  // exact boundary values
  assert.equal(
    decideJevStatus({
      p_same: JEV_DUPLICATE_THRESHOLDS.autoFlag,
      relation: "same_purchase",
      relation_probability: JEV_DUPLICATE_THRESHOLDS.relationSamePurchase,
    }),
    "auto_flag",
  );
});

test("auto_clears only a strong different answer without a same_purchase relation", () => {
  assert.equal(decideJevStatus({ p_same: 0.05, relation: "repeat_order", relation_probability: 0.8 }), "auto_clear");
  assert.equal(decideJevStatus({ p_same: 0.05, relation: "unrelated", relation_probability: 0.9 }), "auto_clear");
  // p_same low but the model still leans same_purchase -> CEO
  assert.equal(decideJevStatus({ p_same: 0.05, relation: "same_purchase", relation_probability: 0.8 }), "needs_review");
  // exact boundary value
  assert.equal(
    decideJevStatus({
      p_same: JEV_DUPLICATE_THRESHOLDS.autoClear,
      relation: "repeat_order",
      relation_probability: 0.8,
    }),
    "auto_clear",
  );
});

test("everything in the middle goes to the CEO", () => {
  assert.equal(decideJevStatus({ p_same: 0.5, relation: "same_purchase", relation_probability: 0.5 }), "needs_review");
  assert.equal(decideJevStatus({ p_same: 0.3, relation: "repeat_order", relation_probability: 0.9 }), "needs_review");
  assert.equal(decideJevStatus({ p_same: 0.16, relation: "unrelated", relation_probability: 0.9 }), "needs_review");
});
