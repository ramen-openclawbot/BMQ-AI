// Node tests for the Kho 2D warehouse-game parsers and unitConversionFor.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseChangeStockItemUnitResult,
  parseRenameStockItemResult,
  parseSetItemPastryQ7Result,
  parseWarehouseGameSnapshot,
  parseWarehouseGameTransfers,
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
        pastry_q7: true,
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
        pastry_q7: false,
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
        raw_unit: "PACK",
        raw_units: [
          { unit: "PACK", line_count: 2 },
          { unit: "kg", line_count: 1 },
        ],
      },
    ],
    transfers: [
      {
        transfer_number: "CK-20261012-AB12CD",
        transfer_date: "2026-10-12",
        item_id: "11111111-1111-1111-1111-111111111111",
        item_name: "Bột mì",
        quantity: 12.5,
        unit: "kg",
        receipt_number: "GRN-001",
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
  assert.equal(snapshot.items[0].pastry_q7, true);
  assert.equal(snapshot.items[1].pastry_q7, false);
  assert.equal(snapshot.skus[0].sku_code, "BMQ-001");
  assert.equal(snapshot.pending[0].normalized_name, "bot mi");
  assert.equal(snapshot.pending[0].raw_unit, "PACK");
  assert.deepEqual(snapshot.pending[0].raw_units, [
    { unit: "PACK", line_count: 2 },
    { unit: "kg", line_count: 1 },
  ]);
  assert.equal(snapshot.transfers.length, 1);
  assert.equal(snapshot.transfers[0].transfer_number, "CK-20261012-AB12CD");
  assert.equal(snapshot.transfers[0].receipt_number, "GRN-001");
  assert.deepEqual(snapshot.counts, { raw_material: 1, unclassified: 1 });
  assert.equal(snapshot.can_edit, true);
});

test("parseWarehouseGameSnapshot defaults a missing pastry_q7 / transfers", () => {
  const raw = validSnapshot();
  delete (raw.items as Record<string, unknown>[])[0].pastry_q7;
  delete raw.transfers;
  const snapshot = parseWarehouseGameSnapshot(raw);
  assert.equal(snapshot.items[0].pastry_q7, false);
  assert.deepEqual(snapshot.transfers, []);
  raw.transfers = null;
  assert.deepEqual(parseWarehouseGameSnapshot(raw).transfers, []);
});

test("parseWarehouseGameSnapshot defaults missing pending raw_unit / raw_units", () => {
  const raw = validSnapshot();
  const pending = (raw.pending as Record<string, unknown>[])[0];
  delete pending.raw_unit;
  delete pending.raw_units;
  const snapshot = parseWarehouseGameSnapshot(raw);
  assert.equal(snapshot.pending[0].raw_unit, null);
  assert.deepEqual(snapshot.pending[0].raw_units, []);
});

test("parseWarehouseGameTransfers validates the transfer rows", () => {
  assert.deepEqual(parseWarehouseGameTransfers(null), []);
  assert.equal(parseWarehouseGameTransfers(validSnapshot().transfers).length, 1);
  assert.throws(() => parseWarehouseGameTransfers({}), TypeError);
  assert.throws(
    () => parseWarehouseGameTransfers([{ transfer_number: "CK-1" }]),
    TypeError,
  );
});

test("parseSetItemPastryQ7Result reads the flag result", () => {
  assert.deepEqual(
    parseSetItemPastryQ7Result({
      item_id: "11111111-1111-1111-1111-111111111111",
      pastry_q7: true,
    }),
    { item_id: "11111111-1111-1111-1111-111111111111", pastry_q7: true },
  );
  assert.throws(() => parseSetItemPastryQ7Result({ item_id: "x" }), TypeError);
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
