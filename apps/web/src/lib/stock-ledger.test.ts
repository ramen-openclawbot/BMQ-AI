import assert from "node:assert/strict";
import test from "node:test";

import {
  isLowStock,
  lowStockList,
  NORMALIZE_STOCK_ITEM_NAME_TEST_CASES,
  normalizeStockItemName,
  parseStockLedgerOverview,
  STOCK_ITEM_DIACRITICS_FROM,
  STOCK_ITEM_DIACRITICS_TO,
} from "./stock-ledger.ts";

test("diacritic tables are aligned and share length", () => {
  assert.equal(
    Array.from(STOCK_ITEM_DIACRITICS_FROM).length,
    Array.from(STOCK_ITEM_DIACRITICS_TO).length,
  );
  assert.equal(Array.from(STOCK_ITEM_DIACRITICS_FROM).length, 74);
});

test("normalizeStockItemName matches the shared table", () => {
  for (const [input, expected] of NORMALIZE_STOCK_ITEM_NAME_TEST_CASES) {
    assert.equal(normalizeStockItemName(input), expected, `normalize(${input})`);
  }
});

test("normalizeStockItemName collapses spaces, units and suffixes", () => {
  assert.equal(normalizeStockItemName("  Bánh   mì   lớn  "), "banh mi lon");
  assert.equal(normalizeStockItemName("Tỏi ngày11"), "toi");
  assert.equal(normalizeStockItemName("Bánh mì tươi (que)"), "banh mi tuoi");
  assert.equal(normalizeStockItemName("Pate 500g"), "pate 500g");
});

test("normalizeStockItemName returns empty string for blank input", () => {
  assert.equal(normalizeStockItemName("   "), "");
  assert.equal(normalizeStockItemName(null), "");
  assert.equal(normalizeStockItemName(undefined), "");
});

test("isLowStock uses three times the average daily outgoing quantity", () => {
  assert.equal(isLowStock(5, 70), true);
  assert.equal(isLowStock(30, 70), false);
  assert.equal(isLowStock(0, 0), false);
  assert.equal(isLowStock(Number.NaN, 70), false);
});

test("parseStockLedgerOverview accepts the RPC payload", () => {
  const overview = parseStockLedgerOverview({
    location: "q7",
    location_name: "Kho NVL Q7",
    as_of: "2026-10-13",
    cutover_date: "2026-10-01",
    items: [
      {
        item_id: "11111111-1111-4111-8111-111111111111",
        item_code: "NVL-001",
        item_name: "Tỏi",
        unit: "kg",
        current_qty: 5,
        in_qty_7d: 12,
        out_qty_7d: 70,
        last_count_date: "2026-10-12",
        last_count_difference: -1.5,
        is_low_stock: true,
      },
    ],
    pending_aliases: [
      {
        goods_receipt_item_id: "22222222-2222-4222-8222-222222222222",
        receipt_number: "PN-001",
        supplier: "NCC A",
        product_name: "Tỏi ngày 10",
        normalized_name: "toi",
        quantity: 3,
        receipt_date: "2026-10-10",
      },
    ],
  });

  assert.equal(overview.location, "q7");
  assert.equal(overview.cutover_date, "2026-10-01");
  assert.equal(overview.items.length, 1);
  assert.equal(overview.items[0].is_low_stock, true);
  assert.equal(overview.items[0].active, true, "missing active defaults to true");
  assert.equal(overview.pending_aliases[0].normalized_name, "toi");
});

test("parseStockLedgerOverview reads material pass_through and defaults it to false", () => {
  const material = (id: string, name: string, extra: Record<string, unknown>) => ({
    item_id: id,
    item_code: id.toUpperCase(),
    item_name: name,
    unit: "kg",
    current_qty: 0,
    in_qty_7d: 0,
    out_qty_7d: 70,
    last_count_date: null,
    last_count_difference: null,
    is_low_stock: true,
    ...extra,
  });
  const overview = parseStockLedgerOverview({
    location: "tan_tao",
    location_name: "Kho Tân Tạo",
    as_of: "2026-10-20",
    cutover_date: "2026-10-16",
    items: [],
    materials: [
      material("m1", "Bánh mì Q7", { pass_through: true }),
      material("m2", "Bột mì", {}),
      material("m3", "Món đã ngưng", { active: false }),
    ],
    pending_aliases: [],
  });

  assert.equal(overview.materials[0].pass_through, true);
  assert.equal(overview.materials[1].pass_through, false);
  assert.equal(overview.materials[0].is_low_stock, true);
  assert.equal(overview.materials[0].active, true, "missing active defaults to true");
  assert.equal(overview.materials[2].active, false);
});

test("parseStockLedgerOverview rejects malformed payloads", () => {
  assert.throws(() => parseStockLedgerOverview(null));
  assert.throws(() => parseStockLedgerOverview({ location: "hcm" }));
  assert.throws(() =>
    parseStockLedgerOverview({
      location: "q7",
      location_name: "x",
      as_of: "2026-10-13",
      cutover_date: null,
      items: [{ item_code: "a" }],
      pending_aliases: [],
    }),
  );
});

test("lowStockList reads Q7 items and Tân Tạo materials, soonest first", () => {
  const row = (id: string, name: string, current: number, out7: number, low: boolean) => ({
    item_id: id,
    item_code: id.toUpperCase(),
    item_name: name,
    unit: "kg",
    current_qty: current,
    in_qty_7d: 0,
    out_qty_7d: out7,
    last_count_date: null,
    last_count_difference: null,
    is_low_stock: low,
    active: true,
  });
  const base = { location_name: "x", as_of: "2026-10-20", cutover_date: "2026-10-16", pending_aliases: [] };
  const q7 = lowStockList({
    ...base,
    location: "q7",
    items: [
      row("a", "Tỏi", 2, 14, true),
      row("b", "Gan", 0, 7, true),
      row("c", "Cà rốt", 40, 28, false),
      { ...row("off", "Món đã ngưng", 0, 70, true), active: false },
    ],
    materials: [row("m", "Bột mì", 1, 70, true)],
  });
  assert.deepEqual(q7.map((r) => r.item_id), ["b", "a"]);
  assert.equal(q7[0].days_left, 0);
  assert.equal(q7[1].daily_usage, 2);
  assert.equal(q7[1].days_left, 1);

  const tt = lowStockList({
    ...base,
    location: "tan_tao",
    items: [
      row("sku", "Bánh mì", 1, 70, true),
      { ...row("sku-off", "Bánh mì đã ngưng", 0, 70, true), active: false },
    ],
    materials: [
      row("m1", "Bột mì", 5, 70, true),
      row("m2", "Đường", -3, 7, true),
      { ...row("m3", "Bánh mì Q7", 0, 70, true), pass_through: true },
      { ...row("m4", "Món đã ngưng", 0, 70, true), active: false },
    ],
  });
  assert.deepEqual(tt.map((r) => r.item_id), ["m2", "m1"]);
  assert.equal(tt[0].days_left, 0, "negative balance counts as nothing left");
  assert.equal(tt[1].days_left, 0.5);
});
