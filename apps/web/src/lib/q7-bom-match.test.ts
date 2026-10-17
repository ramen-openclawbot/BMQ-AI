// Node tests for the Q7 BOM ↔ kitchen-count matching data layer.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  factorPrompt,
  parseQ7BomCatchUpResult,
  parseQ7BomMismatchLine,
  parseQ7BomMismatchReview,
  parseQ7BomResolveResult,
  projectedBalance,
} from "./q7-bom-match.ts";

const REVIEW_ROW = {
  canonical_material_id: "11111111-1111-1111-1111-111111111111",
  canonical_material: {
    id: "11111111-1111-1111-1111-111111111111",
    code: "NVL-DUONG",
    name: "Đường",
    default_unit: "g",
  },
  source_unit: "g",
  current_mapping: {
    q7_mapping_id: "22222222-2222-2222-2222-222222222222",
    kitchen_inventory_item_id: "33333333-3333-3333-3333-333333333333",
    item_code: "Q7-OLD",
    name: "Đường cũ",
    unit: "g",
    conversion_factor: 1,
  },
  planned_qty_total: 1250.5,
  planned_by_issue_date: [
    { issue_date: "2026-10-17", planned_qty: 1000 },
    { issue_date: "2026-10-18", planned_qty: 250.5 },
  ],
  latest_issue_date: "2026-10-18",
  current_balance: 900,
  projected_balance: -350.5,
  has_count_since_cutover: true,
  item_class: "raw_material",
  open: true,
  resolved: false,
  excluded: false,
  decision: null,
  candidates: [
    {
      kitchen_inventory_item_id: "44444444-4444-4444-4444-444444444444",
      item_code: "Q7-8EBB689B5977C1D6DF8A",
      name: "Đường tinh luyện",
      unit: "g",
      counted_balance: 18400,
      similarity: 0.82,
    },
  ],
};

test("parseQ7BomMismatchLine keeps the review fields the resolver needs", () => {
  const row = parseQ7BomMismatchLine(REVIEW_ROW);
  assert.equal(row.canonical_material.code, "NVL-DUONG");
  assert.equal(row.source_unit, "g");
  assert.equal(row.current_mapping?.item_code, "Q7-OLD");
  assert.equal(row.planned_qty_total, 1250.5);
  assert.equal(row.planned_by_issue_date.length, 2);
  assert.equal(row.planned_by_issue_date[1].planned_qty, 250.5);
  assert.equal(row.current_balance, 900);
  assert.equal(row.projected_balance, -350.5);
  assert.equal(row.has_count_since_cutover, true);
  assert.equal(row.open, true);
  assert.equal(row.candidates[0].item_code, "Q7-8EBB689B5977C1D6DF8A");
  assert.equal(row.candidates[0].counted_balance, 18400);
});

test("parseQ7BomMismatchLine accepts an excluded line and a missing mapping", () => {
  const row = parseQ7BomMismatchLine({
    ...REVIEW_ROW,
    current_mapping: null,
    open: false,
    resolved: false,
    excluded: true,
    decision: {
      id: "55555555-5555-5555-5555-555555555555",
      action: "not_tracked",
      new_kitchen_item_id: null,
      conversion_factor: null,
      note: "Nước đá không phải NVL",
      created_at: "2026-10-17T05:40:00+00:00",
    },
    candidates: [],
  });
  assert.equal(row.current_mapping, null);
  assert.equal(row.open, false);
  assert.equal(row.excluded, true);
  assert.equal(row.decision?.action, "not_tracked");
  assert.deepEqual(row.candidates, []);
});

test("parseQ7BomMismatchReview drops only garbled rows", () => {
  const rows = parseQ7BomMismatchReview([
    REVIEW_ROW,
    { canonical_material_id: "not-a-row" },
    { ...REVIEW_ROW, source_unit: "kg", open: false },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].source_unit, "kg");
  assert.equal(rows[1].open, false);
});

test("parseQ7BomMismatchReview treats a non-array payload as empty", () => {
  assert.deepEqual(parseQ7BomMismatchReview(null), []);
  assert.deepEqual(parseQ7BomMismatchReview({ rows: [] }), []);
});

test("parseQ7BomResolveResult understands a remap replay", () => {
  const row = parseQ7BomResolveResult({
    status: "resolved",
    replay: true,
    decision_id: "66666666-6666-6666-6666-666666666666",
    action: "remap",
    canonical_material_id: "11111111-1111-1111-1111-111111111111",
    source_unit: "g",
    old_kitchen_item_id: "33333333-3333-3333-3333-333333333333",
    new_kitchen_item_id: "44444444-4444-4444-4444-444444444444",
    conversion_factor: 1,
    note: "Đường tinh luyện",
    created_at: "2026-10-17T05:40:00+00:00",
  });
  assert.equal(row.replay, true);
  assert.equal(row.action, "remap");
  assert.equal(row.new_kitchen_item_id, "44444444-4444-4444-4444-444444444444");
  assert.equal(row.conversion_factor, 1);
});

test("parseQ7BomResolveResult rejects an unknown action", () => {
  assert.throws(
    () =>
      parseQ7BomResolveResult({
        status: "resolved",
        replay: false,
        decision_id: "66666666-6666-6666-6666-666666666666",
        action: "delete",
        canonical_material_id: "11111111-1111-1111-1111-111111111111",
        source_unit: "g",
        old_kitchen_item_id: null,
        new_kitchen_item_id: null,
        conversion_factor: null,
        note: null,
        created_at: "2026-10-17T05:40:00+00:00",
      }),
    /action is invalid/,
  );
});

test("parseQ7BomCatchUpResult reads every action and counter", () => {
  const result = parseQ7BomCatchUpResult({
    status: "ok",
    dry_run: false,
    cutover_date: "2026-10-16",
    issues: [
      {
        issue_id: "77777777-7777-7777-7777-777777777777",
        issue_number: "PXK-NVL-Q7-20261017-001",
        issue_date: "2026-10-17",
        action: "posted",
        movements: 3,
        skipped: 1,
      },
      {
        issue_id: "88888888-8888-8888-8888-888888888888",
        issue_number: "PXK-NVL-Q7-20261018-001",
        issue_date: "2026-10-18",
        action: "already_posted",
        movements: 0,
        skipped: 0,
      },
    ],
    posted: 1,
    already_posted: 1,
    regenerated: 0,
    skipped_open_mismatch: 0,
  });
  assert.equal(result.cutover_date, "2026-10-16");
  assert.equal(result.issues.length, 2);
  assert.equal(result.issues[0].action, "posted");
  assert.equal(result.issues[0].movements, 3);
  assert.equal(result.issues[1].action, "already_posted");
  assert.equal(result.posted, 1);
});

test("parseQ7BomCatchUpResult rejects an unknown action", () => {
  assert.throws(
    () =>
      parseQ7BomCatchUpResult({
        status: "ok",
        dry_run: false,
        cutover_date: "2026-10-16",
        issues: [
          {
            issue_id: "77777777-7777-7777-7777-777777777777",
            issue_number: "PXK-NVL-Q7-20261017-001",
            issue_date: "2026-10-17",
            action: "deleted",
            movements: 0,
            skipped: 0,
          },
        ],
      }),
    /action is invalid/,
  );
});

test("factorPrompt asks for target units per one source unit", () => {
  assert.equal(factorPrompt("g", "g"), "1 g = ? g");
  assert.equal(factorPrompt(" g ", "thùng"), "1 g = ? thùng");
  assert.equal(factorPrompt("", ""), "1 đơn vị nguồn = ? đơn vị kho");
});

test("projectedBalance subtracts pending usage and rounds to 3 decimals", () => {
  assert.equal(projectedBalance(10, 4), 6);
  assert.equal(projectedBalance(1, 1.0004), 0);
  assert.equal(projectedBalance(0.1, 0.2), -0.1);
  assert.equal(projectedBalance(Number.NaN, 1), 0);
  assert.equal(projectedBalance(10, Number.POSITIVE_INFINITY), 0);
});
