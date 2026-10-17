// Node tests for the 16/10 stock-count unit questions data layer.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canSubmit,
  computeCountedQty,
  factorPrompt,
  parseStockCountUnitQuestion,
  parseStockCountUnitQuestions,
  type StockCountUnitQuestion,
} from "./count-unit-questions.ts";

function question(overrides: Partial<StockCountUnitQuestion> = {}): StockCountUnitQuestion {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    batch: "2026-10-16",
    location: "tan_tao",
    sort_order: 7,
    file_label: "Băng keo lớn",
    file_qty: 8,
    file_unit: "cây",
    suggested_item_id: "22222222-2222-2222-2222-222222222222",
    suggested_factor: 6,
    status: "open",
    item_id: null,
    factor: null,
    counted_qty: null,
    record_result: null,
    note: null,
    answered_by: null,
    answered_at: null,
    suggested_item: {
      id: "22222222-2222-2222-2222-222222222222",
      code: "NVL-083",
      name: "Băng keo lớn",
      unit: "cuộn",
    },
    chosen_item: null,
    item_units: [{ code: "cây", label: "cây" }],
    replay: false,
    ...overrides,
  };
}

test("computeCountedQty multiplies and rounds to 3 decimals", () => {
  assert.equal(computeCountedQty(8, 6), 48);
  assert.equal(computeCountedQty(1, 5000), 5000);
  assert.equal(computeCountedQty(8500, 1), 8500);
  assert.equal(computeCountedQty(4.5, 7), 31.5);
  assert.equal(computeCountedQty(4.5, 1.2345), 5.555);
  assert.equal(computeCountedQty(4.5, 0.3333), 1.5);
  assert.equal(computeCountedQty(2, 3.3333), 6.667);
  assert.ok(Number.isNaN(computeCountedQty(Number.NaN, 2)));
});

test("factorPrompt asks for the unit conversion", () => {
  assert.equal(factorPrompt("cây", "cuộn"), "1 cây = ? cuộn");
  assert.equal(factorPrompt(" bình ", " thùng "), "1 bình = ? thùng");
  assert.equal(factorPrompt("", ""), "1 ? = ? ?");
});

test("parseStockCountUnitQuestion reads the RPC row", () => {
  const parsed = parseStockCountUnitQuestion({
    id: "11111111-1111-1111-1111-111111111111",
    batch: "2026-10-16",
    location: "q7",
    sort_order: 1,
    file_label: "Nước uống Bidrico",
    file_qty: 3,
    file_unit: "bình",
    suggested_item_id: "22222222-2222-2222-2222-222222222222",
    suggested_factor: null,
    status: "open",
    item_id: null,
    factor: null,
    counted_qty: null,
    record_result: null,
    note: null,
    answered_by: null,
    answered_at: null,
    suggested_item: {
      id: "22222222-2222-2222-2222-222222222222",
      code: "Q7-EE8D4E85B686C8A318AA",
      name: "Nước uống Bidrico",
      unit: "bình",
    },
    chosen_item: null,
    item_units: [{ code: "bình", label: "bình" }],
  });

  assert.equal(parsed.location, "q7");
  assert.equal(parsed.file_qty, 3);
  assert.equal(parsed.suggested_item?.code, "Q7-EE8D4E85B686C8A318AA");
  assert.equal(parsed.chosen_item, null);
  assert.equal(parsed.item_units[0].code, "bình");
  assert.equal(parsed.replay, false);

  const replayed = parseStockCountUnitQuestion({
    ...question(),
    status: "answered",
    item_id: "33333333-3333-3333-3333-333333333333",
    factor: 6,
    counted_qty: 48,
    record_result: { status: "recorded", location: "tan_tao" },
    replay: true,
  });
  assert.equal(replayed.status, "answered");
  assert.equal(replayed.counted_qty, 48);
  assert.equal(replayed.record_result?.status, "recorded");
  assert.equal(replayed.replay, true);
});

test("parseStockCountUnitQuestions tolerates the bare array and empty payloads", () => {
  assert.deepEqual(parseStockCountUnitQuestions(null), []);
  assert.deepEqual(parseStockCountUnitQuestions([]), []);
  const parsed = parseStockCountUnitQuestions([question({ sort_order: 7 }), question({ sort_order: 8 })]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].sort_order, 8);
  assert.throws(() => parseStockCountUnitQuestions([{ status: "open" }]), TypeError);
});

test("canSubmit accepts a chosen item or a new item with a positive factor", () => {
  const row = question();

  assert.equal(canSubmit(row, { itemId: row.suggested_item_id ?? undefined, factor: 6 }), true);
  assert.equal(
    canSubmit(row, {
      newItemName: "Băng keo lớn",
      newItemUnit: "cuộn",
      factor: 6,
    }),
    true,
  );
  assert.equal(canSubmit(row, { skip: true }), true);

  assert.equal(canSubmit(row, { itemId: row.suggested_item_id, factor: 0 }), false);
  assert.equal(canSubmit(row, { itemId: row.suggested_item_id, factor: null }), false);
  assert.equal(canSubmit(row, { factor: 6 }), false);
  assert.equal(
    canSubmit(row, {
      itemId: row.suggested_item_id,
      newItemName: "Băng keo lớn",
      factor: 6,
    }),
    false,
  );
  assert.equal(canSubmit(row, { newItemName: "Băng keo lớn", factor: 6 }), false);
  assert.equal(canSubmit(question({ status: "skipped" }), { skip: true }), false);
  assert.equal(canSubmit(question({ status: "answered" }), { skip: true }), false);
});
