import assert from "node:assert/strict";
import test from "node:test";

import {
  itemClassLabel,
  normalizeStockUnit,
  normalizeTokens,
  parseStockCatalogReview,
  STOCK_CATALOG_STATUS_LABELS,
  STOCK_ITEM_CLASSES,
  STOCK_UNIT_FACTOR_TEST_CASES,
  stockCatalogStatusLabel,
  stockUnitFactor,
  tokenJaccard,
} from "./stock-catalog.ts";
import { normalizeStockItemName } from "./stock-ledger.ts";

test("stockUnitFactor matches the shared SQL test-case table", () => {
  for (const [from, to, expected] of STOCK_UNIT_FACTOR_TEST_CASES) {
    assert.equal(stockUnitFactor(from, to), expected, `stockUnitFactor(${from}, ${to})`);
  }
});

test("stockUnitFactor converts mass and volume, refuses mixed dimensions", () => {
  assert.equal(stockUnitFactor("kg", "g"), 1000);
  assert.equal(stockUnitFactor("g", "kg"), 0.001);
  assert.equal(stockUnitFactor("l", "ml"), 1000);
  assert.equal(stockUnitFactor("ml", "l"), 0.001);
  assert.equal(stockUnitFactor("Quả", "g"), null);
  assert.equal(stockUnitFactor("chai", "chai"), 1);
  assert.equal(stockUnitFactor("kg", "KG"), 1);
  assert.equal(stockUnitFactor("quả", "hộp"), null);
  assert.equal(stockUnitFactor("", "g"), null);
  assert.equal(normalizeStockUnit("Lít"), "l");
  assert.equal(normalizeStockUnit("Kilogram"), "kg");
  assert.equal(normalizeStockUnit("  "), null);
});

test("tokenJaccard ignores numbers and units", () => {
  assert.ok(tokenJaccard("Bột mì 888", "Bột mì 888 (25kg)") >= 0.6);
  assert.deepEqual(normalizeTokens("Bột mì 888 (25kg)"), ["bot", "mi"]);
  assert.equal(tokenJaccard("chai", "hộp"), 0);
});

test("Bột mì 888 and Bột mì 999 pair because the normalized names are equal", () => {
  // The trailing number is stripped by normalize_stock_item_name, so the pair is
  // created by the SQL equality rule; Jev is the one that decides they differ.
  assert.equal(normalizeStockItemName("Bột mì 888"), normalizeStockItemName("Bột mì 999"));
  assert.ok(tokenJaccard("Bột mì 888", "Bột mì 999") >= 0.6);
});

test("Vietnamese labels cover the four classes and the statuses", () => {
  for (const itemClass of STOCK_ITEM_CLASSES) {
    assert.ok(itemClassLabel(itemClass).length > 0);
    assert.notEqual(itemClassLabel(itemClass), "Chưa phân loại");
  }
  assert.equal(itemClassLabel(null), "Chưa phân loại");
  assert.equal(stockCatalogStatusLabel("pending"), STOCK_CATALOG_STATUS_LABELS.pending);
  assert.equal(stockCatalogStatusLabel("applied"), "Đã gộp");
});

const VALID_REVIEW = {
  pending_suggestions: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      kind: "merge",
      item_id: "11111111-1111-4111-8111-111111111111",
      item_name: "Bột mì 888",
      item_unit: "kg",
      other_item_id: "22222222-2222-4222-8222-222222222222",
      other_item_name: "Bột mì 999",
      other_item_unit: "kg",
      proposed_target_id: "11111111-1111-4111-8111-111111111111",
      target_name: "Bột mì 888",
      target_unit: "kg",
      probability: 0.9,
      proposed_factor: 1,
      factor_source: "unit_rule",
      proposed_class: null,
      prompt_version: "jev-stock-catalog-2026-10-15.1",
      cost: 0.0001,
      created_at: "2026-10-15T00:00:00.000Z",
      item_issue_count_90d: 54,
      other_issue_count_90d: 0,
    },
  ],
  recent_merges: [
    {
      merge_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      source_id: "33333333-3333-4333-8333-333333333333",
      source_name: "Bột mì 999",
      target_id: "11111111-1111-4111-8111-111111111111",
      target_name: "Bột mì 888",
      factor: 1000,
      status: "applied",
      applied_at: "2026-10-15T00:00:00.000Z",
      reverted_at: null,
      can_revert: true,
    },
  ],
  item_class_counts: { raw_material: 3, unclassified: 1 },
  jev_usage: { usage_date: "2026-10-15", calls: 12, cost: 0.02, call_limit: 600 },
};

test("parseStockCatalogReview accepts the RPC payload", () => {
  const review = parseStockCatalogReview(VALID_REVIEW);
  assert.equal(review.pending_suggestions.length, 1);
  assert.equal(review.pending_suggestions[0].kind, "merge");
  assert.equal(review.pending_suggestions[0].factor_source, "unit_rule");
  assert.equal(review.recent_merges[0].can_revert, true);
  assert.equal(review.item_class_counts.raw_material, 3);
  assert.equal(review.jev_usage.call_limit, 600);
});

test("parseStockCatalogReview rejects malformed payloads", () => {
  assert.throws(() => parseStockCatalogReview(null));
  assert.throws(() => parseStockCatalogReview({}));
  assert.throws(() => parseStockCatalogReview({ ...VALID_REVIEW, pending_suggestions: "nope" }));
  assert.throws(() =>
    parseStockCatalogReview({
      ...VALID_REVIEW,
      pending_suggestions: [{ ...VALID_REVIEW.pending_suggestions[0], kind: "delete" }],
    }),
  );
  assert.throws(() =>
    parseStockCatalogReview({
      ...VALID_REVIEW,
      pending_suggestions: [{ ...VALID_REVIEW.pending_suggestions[0], probability: 1.7 }],
    }),
  );
  assert.throws(() =>
    parseStockCatalogReview({
      ...VALID_REVIEW,
      recent_merges: [{ ...VALID_REVIEW.recent_merges[0], can_revert: "yes" }],
    }),
  );
  assert.throws(() => parseStockCatalogReview({ ...VALID_REVIEW, item_class_counts: { raw_material: "nhiều" } }));
  assert.throws(() => parseStockCatalogReview({ ...VALID_REVIEW, jev_usage: { usage_date: "2026-10-15" } }));
});
