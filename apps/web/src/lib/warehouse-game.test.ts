// Node tests for the Kho 2D warehouse-game parsers and unitConversionFor.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildQ7FinishedGoodsLines,
  manualTransferErrorText,
  parseChangeStockItemUnitResult,
  parseManualTransferResult,
  parseRenameStockItemResult,
  parseSetItemPastryQ7Result,
  parseWarehouseGameSnapshot,
  parseWarehouseGameTransfers,
  unitConversionFor,
  validateQ7Issue,
  type Q7FinishedGoodsPlannedLine,
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

test("parseWarehouseGameTransfers keeps the new manual transfer fields", () => {
  const rows = parseWarehouseGameTransfers([
    {
      transfer_number: "CK-20261031-AB12CD",
      transfer_date: "2026-10-31",
      item_id: "11111111-1111-1111-1111-111111111111",
      item_name: "Bột mì",
      quantity: 4,
      unit: "kg",
      receipt_number: null,
      source: "manual",
      slip_id: "55555555-5555-5555-5555-555555555555",
      slip_number: "CKP-20261031-AB12CD",
      note: "Chuyển kho thủ công",
    },
    {
      transfer_number: "CK-20261012-AB12CD",
      transfer_date: "2026-10-12",
      item_id: "11111111-1111-1111-1111-111111111111",
      item_name: "Bột mì",
      quantity: 12.5,
      unit: "kg",
      receipt_number: "GRN-001",
    },
  ]);
  assert.equal(rows[0].source, "manual");
  assert.equal(rows[0].slip_id, "55555555-5555-5555-5555-555555555555");
  assert.equal(rows[0].slip_number, "CKP-20261031-AB12CD");
  assert.equal(rows[0].note, "Chuyển kho thủ công");
  assert.equal(rows[1].source, null);
  assert.equal(rows[1].slip_id, null);
  assert.equal(rows[1].slip_number, null);
  assert.equal(rows[1].note, null);
  assert.equal(rows[1].receipt_number, "GRN-001");
});

function validManualTransferResult(): Record<string, unknown> {
  return {
    slip_id: "55555555-5555-5555-5555-555555555555",
    slip_number: "CKP-20261031-AB12CD",
    transfer_date: "2026-10-31",
    lines: [
      {
        transfer_id: "66666666-6666-6666-6666-666666666666",
        transfer_number: "CK-20261031-AAAAAA",
        item_id: "11111111-1111-1111-1111-111111111111",
        item_name: "Bột mì",
        quantity: 4,
        unit: "kg",
      },
      {
        transfer_id: "77777777-7777-7777-7777-777777777777",
        transfer_number: "CK-20261031-BBBBBB",
        item_id: "22222222-2222-2222-2222-222222222222",
        item_name: "Đường",
        quantity: 3,
        unit: "kg",
      },
    ],
  };
}

test("parseManualTransferResult reads the slip and its lines", () => {
  const result = parseManualTransferResult(validManualTransferResult());
  assert.equal(result.slip_id, "55555555-5555-5555-5555-555555555555");
  assert.equal(result.slip_number, "CKP-20261031-AB12CD");
  assert.equal(result.transfer_date, "2026-10-31");
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[1].transfer_number, "CK-20261031-BBBBBB");
  assert.equal(result.lines[1].item_name, "Đường");
  assert.equal(result.lines[1].quantity, 3);
});

test("parseManualTransferResult rejects a malformed payload", () => {
  assert.throws(() => parseManualTransferResult(null), TypeError);
  const noLines = validManualTransferResult();
  delete noLines.lines;
  assert.throws(() => parseManualTransferResult(noLines), TypeError);
  const notArray = validManualTransferResult();
  notArray.lines = {};
  assert.throws(() => parseManualTransferResult(notArray), TypeError);
  const noSlip = validManualTransferResult();
  delete noSlip.slip_id;
  assert.throws(() => parseManualTransferResult(noSlip), TypeError);
  const noNumber = validManualTransferResult();
  delete noNumber.slip_number;
  assert.throws(() => parseManualTransferResult(noNumber), TypeError);
  const badLine = validManualTransferResult();
  (badLine.lines as Record<string, unknown>[])[0].quantity = "many";
  assert.throws(() => parseManualTransferResult(badLine), TypeError);
});

test("manualTransferErrorText maps known codes with a generic fallback", () => {
  assert.match(manualTransferErrorText("stock_insufficient"), /Tồn kho/);
  assert.match(manualTransferErrorText("transfer_forbidden"), /quyền/);
  assert.match(manualTransferErrorText("ledger_not_started"), /Sổ kho/);
  assert.match(manualTransferErrorText("duplicate_item"), /lặp/);
  assert.match(manualTransferErrorText("too_many_lines"), /30/);
  assert.ok(manualTransferErrorText("does_not_exist").length > 0);
  assert.equal(manualTransferErrorText(null), manualTransferErrorText("does_not_exist"));
  // A Supabase message that embeds the code still maps.
  assert.equal(
    manualTransferErrorText("quantity_invalid: must be > 0"),
    manualTransferErrorText("quantity_invalid"),
  );
});

function plannedLine(
  productionOrderItemId: string,
  skuId: string,
  skuCode = "BMQ-001",
): Q7FinishedGoodsPlannedLine {
  return {
    production_order_item_id: productionOrderItemId,
    sku_id: skuId,
    sku_code: skuCode,
    product_name: "Bánh mì que Pate",
    unit: "gói",
    planned_qty: 100,
    already_received: 0,
  };
}

test("buildQ7FinishedGoodsLines drops blank/zero and keeps the rest in order", () => {
  const planned = [
    plannedLine("poi-1", "sku-1"),
    plannedLine("poi-2", "sku-2", "BMQ-002"),
    plannedLine("poi-3", "sku-3", "PATE-500G"),
  ];
  const lines = buildQ7FinishedGoodsLines(planned, {
    "poi-1": 12,
    "poi-2": "3.5",
    "poi-3": 0,
  });
  assert.deepEqual(lines, [
    { sku_id: "sku-1", quantity: 12, production_order_item_id: "poi-1" },
    { sku_id: "sku-2", quantity: 3.5, production_order_item_id: "poi-2" },
  ]);

  assert.deepEqual(buildQ7FinishedGoodsLines(planned, {}), []);
  assert.deepEqual(
    buildQ7FinishedGoodsLines(planned, { "poi-1": "", "poi-2": "   ", "poi-3": null }),
    [],
  );
});

test("buildQ7FinishedGoodsLines merges duplicate sku + order item", () => {
  const planned = [
    plannedLine("poi-1", "sku-1"),
    plannedLine("poi-1", "sku-1"),
    plannedLine("poi-2", "sku-1"),
  ];
  const lines = buildQ7FinishedGoodsLines(planned, { "poi-1": 2, "poi-2": 5 });
  assert.deepEqual(lines, [
    { sku_id: "sku-1", quantity: 4, production_order_item_id: "poi-1" },
    { sku_id: "sku-1", quantity: 5, production_order_item_id: "poi-2" },
  ]);
});

test("buildQ7FinishedGoodsLines rejects negative and non-numeric entries", () => {
  const planned = [plannedLine("poi-1", "sku-1")];
  assert.throws(() => buildQ7FinishedGoodsLines(planned, { "poi-1": -1 }), TypeError);
  assert.throws(() => buildQ7FinishedGoodsLines(planned, { "poi-1": "abc" }), TypeError);
  assert.throws(() => buildQ7FinishedGoodsLines(planned, { "poi-1": Number.NaN }), TypeError);
});

test("validateQ7Issue accepts enough stock and sums duplicate SKUs", () => {
  const lines = [
    { sku_id: "sku-1", quantity: 2 },
    { sku_id: "sku-2", quantity: 5 },
  ];
  assert.deepEqual(validateQ7Issue(lines, { "sku-1": 2, "sku-2": 10 }), []);

  const duplicate = [
    { sku_id: "sku-1", quantity: 2 },
    { sku_id: "sku-1", quantity: 2 },
  ];
  const errors = validateQ7Issue(duplicate, { "sku-1": 3 });
  assert.equal(errors.length, 2);
  assert.equal(errors[0].index, 0);
  assert.match(errors[0].message, /Không đủ tồn/);
  assert.match(errors[0].message, /3/);
});

test("validateQ7Issue flags non-positive quantities and leaves unknown SKUs lenient", () => {
  const errors = validateQ7Issue(
    [
      { sku_id: "sku-1", quantity: 0 },
      { sku_id: "sku-1", quantity: Number.NaN },
      { sku_id: "unknown", quantity: 4 },
    ],
    { "sku-1": 10 },
  );
  assert.equal(errors.length, 2);
  assert.equal(errors[0].index, 0);
  assert.equal(errors[1].index, 1);
  assert.match(errors[0].message, /lớn hơn 0/);
});
