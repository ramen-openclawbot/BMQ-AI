import assert from "node:assert/strict";
import test from "node:test";

import {
  isLowStock,
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
  assert.equal(overview.pending_aliases[0].normalized_name, "toi");
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
