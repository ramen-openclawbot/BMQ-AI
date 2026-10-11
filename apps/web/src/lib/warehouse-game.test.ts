// Node tests for the Kho 2D warehouse-game parsers and unitConversionFor.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseChangeStockItemUnitResult,
  parseRenameStockItemResult,
  parseWarehouseGameSnapshot,
  unitConversionFor,
} from "./warehouse-game.ts";

test("unitConversionFor converts a weight / volume pair by the to_base ratio", () => {
  assert.equal(unitConversionFor("g", "kg"), 0.001);
  assert.equal(unitConversionFor("kg", "g"), 1000);
  assert.equal(unitConversionFor("l", "ml"), 1000);
  assert.equal(unitConversionFor("ml", "l"), 0.001);
  assert.equal(unitConversionFor("KG", "g"), 1000);
  assert.equal(unitConversionFor("Gr", "kg"), 0.001);
  assert.equal(unitConversionFor("lít", "ml"), 1000);
});

test("unitConversionFor returns 1 for the same unit and null otherwise", () => {
  assert.equal(unitConversionFor("kg", "kg"), 1);
  assert.equal(unitConversionFor("hộp", "cái"), null);
  assert.equal(unitConversionFor("kg", "l"), null);
  assert.equal(unitConversionFor("PACK", "g"), null);
  assert.equal(unitConversionFor(null, "g"), null);
  assert.equal(unitConversionFor("g", undefined), null);
});

function validSnapshot(): Record<string, unknown> {
  return {
    location: "tan_tao",
    cutover_date: "2026-10-01",
    items: [
      {
        id: "11111111-1111-1111-1111-111111111111",
        code: "NVL-001",
        name: "Bột mì",
        unit: "kg",
        item_class: "raw_material",
        on_hand: 12.5,
        last_count_date: null,
        aliases: [
          {
            normalized_name: "bot mi",
            status: "auto",
            line_class: "stock",
            supplier_name: "Nhà cung cấp A",
          },
        ],
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        code: "NVL-002",
        name: "Chưa phân loại",
        unit: "g",
        item_class: "unclassified",
        on_hand: 0,
        last_count_date: "2026-10-10",
        aliases: [],
      },
    ],
    skus: [
      {
        id: "33333333-3333-3333-3333-333333333333",
        sku_code: "BMQ-001",
        product_name: "Bánh mì que Pate",
        unit: "gói",
        on_hand: 4,
      },
    ],
    pending: [
      {
        normalized_name: "bot mi",
        raw_name: "BỘT MÌ",
        line_count: 3,
        supplier_id: null,
        supplier_name: "Nhà cung cấp A",
        last_receipt_date: "2026-10-09",
        top_candidate: null,
        jev_item_id: null,
        jev_item_name: null,
        jev_unit: null,
        jev_probability: null,
        jev_line_type: null,
        jev_source: null,
        jev_is_sku: false,
      },
    ],
    counts: { raw_material: 1, unclassified: 1 },
    can_edit: true,
  };
}

test("parseWarehouseGameSnapshot reads the full payload", () => {
  const snapshot = parseWarehouseGameSnapshot(validSnapshot());
  assert.equal(snapshot.location, "tan_tao");
  assert.equal(snapshot.cutover_date, "2026-10-01");
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.items[0].item_class, "raw_material");
  assert.equal(snapshot.items[0].aliases[0].supplier_name, "Nhà cung cấp A");
  assert.equal(snapshot.skus[0].sku_code, "BMQ-001");
  assert.equal(snapshot.pending[0].normalized_name, "bot mi");
  assert.deepEqual(snapshot.counts, { raw_material: 1, unclassified: 1 });
  assert.equal(snapshot.can_edit, true);
});

test("parseWarehouseGameSnapshot tolerates a null cutover and empty skus", () => {
  const raw = validSnapshot();
  raw.cutover_date = null;
  raw.skus = [];
  const snapshot = parseWarehouseGameSnapshot(raw);
  assert.equal(snapshot.cutover_date, null);
  assert.deepEqual(snapshot.skus, []);
});

test("parseWarehouseGameSnapshot rejects a malformed payload", () => {
  assert.throws(() => parseWarehouseGameSnapshot(null), TypeError);
  const badLocation = validSnapshot();
  badLocation.location = "hq";
  assert.throws(() => parseWarehouseGameSnapshot(badLocation), TypeError);
  const badItems = validSnapshot();
  badItems.items = {};
  assert.throws(() => parseWarehouseGameSnapshot(badItems), TypeError);
  const badClass = validSnapshot();
  (badClass.items as Record<string, unknown>[])[0].item_class = "unknown";
  assert.throws(() => parseWarehouseGameSnapshot(badClass), TypeError);
  const badCounts = validSnapshot();
  badCounts.counts = { raw_material: "one" };
  assert.throws(() => parseWarehouseGameSnapshot(badCounts), TypeError);
});

test("parseRenameStockItemResult requires the three names", () => {
  assert.deepEqual(
    parseRenameStockItemResult({
      item_id: "11111111-1111-1111-1111-111111111111",
      old_name: "Bột mì",
      new_name: "Bột mì số 1",
    }),
    {
      item_id: "11111111-1111-1111-1111-111111111111",
      old_name: "Bột mì",
      new_name: "Bột mì số 1",
    },
  );
  assert.throws(() => parseRenameStockItemResult({ item_id: "x" }), TypeError);
});

test("parseChangeStockItemUnitResult keeps a nullable merge_id", () => {
  assert.deepEqual(
    parseChangeStockItemUnitResult({
      item_id: "11111111-1111-1111-1111-111111111111",
      old_unit: "g",
      new_unit: "kg",
      factor: 0.001,
      merge_id: null,
    }),
    {
      item_id: "11111111-1111-1111-1111-111111111111",
      old_unit: "g",
      new_unit: "kg",
      factor: 0.001,
      merge_id: null,
    },
  );
  const merged = parseChangeStockItemUnitResult({
    item_id: "22222222-2222-2222-2222-222222222222",
    old_unit: "g",
    new_unit: "kg",
    factor: 0.001,
    merge_id: "44444444-4444-4444-4444-444444444444",
  });
  assert.equal(merged.merge_id, "44444444-4444-4444-4444-444444444444");
  assert.throws(
    () =>
      parseChangeStockItemUnitResult({
        item_id: "x",
        old_unit: "g",
        new_unit: "kg",
        factor: "many",
        merge_id: null,
      }),
    TypeError,
  );
});
