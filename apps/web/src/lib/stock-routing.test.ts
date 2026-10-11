import assert from "node:assert/strict";
import test from "node:test";

import {
  MATERIAL_CATEGORY_LABELS,
  materialCategoryLabel,
  parseStockRoutingJevResponse,
  parseStockRoutingReview,
  shouldAutoApplyCategory,
  shouldAutoApplyRouting,
  stockRoutingLocationLabel,
  STOCK_ROUTING_LOCATION_LABELS,
  STOCK_ROUTING_CATEGORY_THRESHOLD,
  STOCK_ROUTING_ROUTE_THRESHOLD,
} from "./stock-routing.ts";

test("routing auto-applies only at >= 0.9 with an agreeing rule_hint", () => {
  assert.equal(STOCK_ROUTING_ROUTE_THRESHOLD, 0.9);
  assert.equal(shouldAutoApplyRouting(0.89, "q7", "q7"), false);
  assert.equal(shouldAutoApplyRouting(0.9, "q7", "q7"), true);
  assert.equal(shouldAutoApplyRouting(0.95, null, "tan_tao"), true);
  assert.equal(shouldAutoApplyRouting(0.95, "q7", "tan_tao"), false, "a conflict must not auto-apply");
  assert.equal(shouldAutoApplyRouting(Number.NaN, null, "q7"), false);
});

test("category auto-applies only at >= 0.85", () => {
  assert.equal(STOCK_ROUTING_CATEGORY_THRESHOLD, 0.85);
  assert.equal(shouldAutoApplyCategory(0.84), false);
  assert.equal(shouldAutoApplyCategory(0.85), true);
  assert.equal(shouldAutoApplyCategory(0.99), true);
  assert.equal(shouldAutoApplyCategory(Number.NaN), false);
});

test("Vietnamese labels cover every location and category", () => {
  for (const location of ["q7", "tan_tao", "non_stock"] as const) {
    assert.ok(STOCK_ROUTING_LOCATION_LABELS[location].length > 0);
    assert.equal(stockRoutingLocationLabel(location), STOCK_ROUTING_LOCATION_LABELS[location]);
  }
  assert.equal(stockRoutingLocationLabel(null), "");
  for (const code of ["flour", "dairy_fat", "eggs", "sugar_additives", "meat_filling", "cheese", "vegetables", "packaging", "supplies", "service", "other"]) {
    assert.ok(MATERIAL_CATEGORY_LABELS[code].length > 0, `missing label ${code}`);
    assert.equal(materialCategoryLabel(code), MATERIAL_CATEGORY_LABELS[code]);
  }
  assert.equal(materialCategoryLabel(null), "");
});

const VALID_REVIEW = {
  supplier_pending: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      supplier_id: "22222222-2222-4222-8222-222222222222",
      supplier_name: "NCC A",
      category: "Flour",
      proposed_location: "q7",
      probability: 0.95,
      evidence: { rule_hint: "q7", receipt_count: 3 },
      rule_hint: "q7",
      conflict: false,
      prompt_version: "jev-stock-routing-2026-10-17.1",
      cost: 0.001,
      created_at: "2026-10-17T00:00:00.000Z",
    },
  ],
  supplier_recent: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      supplier_id: "22222222-2222-4222-8222-222222222222",
      supplier_name: "NCC A",
      proposed_location: "tan_tao",
      probability: 0.91,
      status: "applied",
      applied_at: "2026-10-17T00:00:00.000Z",
      created_at: "2026-10-17T00:00:00.000Z",
      previous_location: null,
      previous_exempt: false,
    },
  ],
  supplier_counts: { q7: 4, tan_tao: 2, non_stock: 1, none: 3 },
  material_pending: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      material_id: "55555555-5555-4555-8555-555555555555",
      material_code: "NVL-BOT-MI",
      canonical_name: "Bột mì 888",
      current_category: null,
      proposed_category: "flour",
      proposed_label: "Bột và ngũ cốc",
      probability: 0.9,
      prompt_version: "jev-stock-routing-2026-10-17.1",
      cost: 0.001,
      created_at: "2026-10-17T00:00:00.000Z",
    },
  ],
  material_category_counts: { flour: 3, unclassified: 1 },
  categories: [{ code: "flour", label_vi: "Bột và ngũ cốc", sort_order: 10 }],
  jev_usage: { usage_date: "2026-10-17", calls: 5, cost: 0.005, call_limit: 600 },
};

test("parseStockRoutingReview accepts the RPC payload", () => {
  const review = parseStockRoutingReview(VALID_REVIEW);
  assert.equal(review.supplier_pending.length, 1);
  assert.equal(review.supplier_pending[0].proposed_location, "q7");
  assert.equal(review.supplier_pending[0].rule_hint, "q7");
  assert.equal(review.supplier_counts.non_stock, 1);
  assert.equal(review.material_pending[0].proposed_category, "flour");
  assert.equal(review.material_category_counts.unclassified, 1);
  assert.equal(review.jev_usage.call_limit, 600);
  assert.equal(review.categories[0].label_vi, "Bột và ngũ cốc");
});

test("parseStockRoutingReview rejects malformed payloads", () => {
  assert.throws(() => parseStockRoutingReview(null));
  assert.throws(() => parseStockRoutingReview({}));
  assert.throws(() => parseStockRoutingReview({ ...VALID_REVIEW, supplier_pending: "nope" }));
  assert.throws(() =>
    parseStockRoutingReview({
      ...VALID_REVIEW,
      supplier_pending: [{ ...VALID_REVIEW.supplier_pending[0], proposed_location: "somewhere" }],
    }),
  );
  assert.throws(() =>
    parseStockRoutingReview({
      ...VALID_REVIEW,
      supplier_pending: [{ ...VALID_REVIEW.supplier_pending[0], probability: 1.5 }],
    }),
  );
  assert.throws(() =>
    parseStockRoutingReview({
      ...VALID_REVIEW,
      supplier_recent: [{ ...VALID_REVIEW.supplier_recent[0], status: "pending" }],
    }),
  );
  assert.throws(() =>
    parseStockRoutingReview({
      ...VALID_REVIEW,
      material_pending: [{ ...VALID_REVIEW.material_pending[0], probability: "high" }],
    }),
  );
});

const VALID_EDGE = {
  mode: "suppliers",
  candidates: 2,
  suggestions: 2,
  applied: 1,
  pending: 1,
  failed: 0,
  calls: 2,
  cost: 0.002,
  usage: { date: "2026-10-17", calls: 2, limit: 600 },
  stopped: null,
};

test("parseStockRoutingJevResponse accepts the edge payload", () => {
  const parsed = parseStockRoutingJevResponse(VALID_EDGE);
  assert.equal(parsed.mode, "suppliers");
  assert.equal(parsed.applied, 1);
  assert.equal(parsed.stopped, null);

  const stopped = parseStockRoutingJevResponse({ ...VALID_EDGE, mode: "materials", stopped: "daily_limit" });
  assert.equal(stopped.mode, "materials");
  assert.equal(stopped.stopped, "daily_limit");
});

test("parseStockRoutingJevResponse rejects malformed payloads", () => {
  assert.throws(() => parseStockRoutingJevResponse(null));
  assert.throws(() => parseStockRoutingJevResponse({ mode: "delete" }));
  assert.throws(() => parseStockRoutingJevResponse({ ...VALID_EDGE, stopped: "later" }));
  assert.throws(() => parseStockRoutingJevResponse({ ...VALID_EDGE, usage: { date: "2026-10-17" } }));
});
