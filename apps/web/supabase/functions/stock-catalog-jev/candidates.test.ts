import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildClassifyState,
  buildSameItemState,
  candidatePairKey,
  normalizeUnit,
  selectPrimaryItem,
  unitRank,
  type StockCatalogCandidate,
} from "./candidates.ts";

const LEFT_ID = "11111111-1111-4111-8111-111111111111";
const RIGHT_ID = "22222222-2222-4222-8222-222222222222";

function candidate(overrides: Partial<StockCatalogCandidate> = {}): StockCatalogCandidate {
  return {
    left_id: LEFT_ID,
    right_id: RIGHT_ID,
    left_name: "Bột mì 888",
    right_name: "Bột mì 888 (25kg)",
    left_unit: "kg",
    right_unit: "g",
    left_item_type: "ingredient",
    right_item_type: "ingredient",
    left_issue_count_90d: 3,
    right_issue_count_90d: 1,
    left_movement_count_90d: 5,
    right_movement_count_90d: 2,
    left_canonical_material_id: "33333333-3333-4333-8333-333333333333",
    right_canonical_material_id: null,
    left_canonical_material_code: "MI-888",
    right_canonical_material_code: null,
    left_to_right_factor: 1000,
    right_to_left_factor: 0.001,
    ...overrides,
  };
}

test("candidatePairKey is canonical regardless of argument order", () => {
  assert.equal(candidatePairKey("a", "b"), "a:b");
  assert.equal(candidatePairKey("b", "a"), "a:b");
});

test("unitRank and normalizeUnit use only the smaller mass/volume units", () => {
  assert.equal(normalizeUnit("Lít"), "lit");
  assert.equal(unitRank("g"), 0);
  assert.equal(unitRank("ml"), 0);
  assert.equal(unitRank("kg"), 1);
  assert.equal(unitRank("lít"), 1);
  assert.equal(unitRank("hộp"), 2);
});

test("the Jev state never carries ids or financial data", () => {
  const state = buildSameItemState(candidate());
  const flat = JSON.stringify(state);
  assert.ok(!flat.includes(LEFT_ID));
  assert.ok(!flat.includes(RIGHT_ID));
  assert.ok(!flat.includes("33333333-3333-4333-8333-333333333333"));
  for (const forbidden of ["\"id\"", "\"item_id\"", "\"left_id\"", "\"right_id\"", "\"amount\"", "\"price\"", "\"cost\"", "\"canonical_material_id\""]) {
    assert.ok(!flat.includes(forbidden), `state must not contain ${forbidden}`);
  }
  assert.ok(flat.includes("MI-888"), "the canonical material code stays available to Jev");
});

test("the classify state never carries ids or financial data", () => {
  const state = buildClassifyState({
    id: LEFT_ID,
    name: "Bột mì 888",
    unit: "kg",
    item_type: "ingredient",
    issue_count_90d: 4,
    movement_count_90d: 7,
    canonical_material_id: "33333333-3333-4333-8333-333333333333",
    canonical_material_code: "MI-888",
  });
  const flat = JSON.stringify(state);
  assert.ok(!flat.includes(LEFT_ID));
  assert.ok(!flat.includes("33333333-3333-4333-8333-333333333333"));
  assert.ok(!flat.includes("\"id\""));
  assert.ok(!flat.includes("\"cost\""));
});

test("the kept item is the side with more issue lines", () => {
  const selection = selectPrimaryItem(candidate({ left_issue_count_90d: 3, right_issue_count_90d: 8 }));
  assert.equal(selection.target.id, RIGHT_ID);
  assert.equal(selection.source.id, LEFT_ID);
  // target right, so the factor is left -> right.
  assert.equal(selection.factor, 1000);
});

test("on equal issue lines the side with the smaller mass/volume unit is kept", () => {
  const selection = selectPrimaryItem(candidate({
    left_issue_count_90d: 2,
    right_issue_count_90d: 2,
    left_unit: "kg",
    right_unit: "g",
  }));
  assert.equal(selection.target.id, RIGHT_ID, "g is smaller than kg");
  assert.equal(selection.source.id, LEFT_ID);
  assert.equal(selection.factor, 1000);
});

test("a full tie falls back to the smaller id deterministically", () => {
  const selection = selectPrimaryItem(candidate({
    left_issue_count_90d: 2,
    right_issue_count_90d: 2,
    left_unit: "kg",
    right_unit: "kg",
  }));
  assert.equal(selection.target.id, LEFT_ID);
  assert.equal(selection.source.id, RIGHT_ID);
});

test("a missing conversion factor stays null so the reviewer must enter it", () => {
  const selection = selectPrimaryItem(candidate({
    left_issue_count_90d: 9,
    right_issue_count_90d: 1,
    left_unit: "quả",
    right_unit: "g",
    left_to_right_factor: null,
    right_to_left_factor: null,
  }));
  assert.equal(selection.target.id, LEFT_ID);
  assert.equal(selection.factor, null);
});
