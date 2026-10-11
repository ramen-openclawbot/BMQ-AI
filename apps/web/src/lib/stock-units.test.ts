// Node tests for the standard stock units shared with the SQL seed.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeStockUnit,
  STOCK_UNIT_ALIASES,
  STOCK_UNIT_NORMALIZE_TEST_CASES,
  STOCK_UNITS,
  stockUnitCode,
  stockUnitConversion,
  stockUnitLabel,
} from "./stock-units.ts";

test("the shared case table normalizes like public.normalize_stock_unit", () => {
  for (const [input, expected] of STOCK_UNIT_NORMALIZE_TEST_CASES) {
    assert.equal(normalizeStockUnit(input), expected, `normalizeStockUnit(${JSON.stringify(input)})`);
  }
});

test("the seed lists every required standard unit", () => {
  const codes = new Set(STOCK_UNITS.map((unit) => unit.code));
  for (const code of [
    "g", "kg", "ml", "l", "cái", "hộp", "cuộn", "chai", "bịch", "gói",
    "can", "bao", "quả", "tờ", "con", "cây", "thùng", "khối", "bình", "nắp",
  ]) {
    assert.ok(codes.has(code), `missing standard unit ${code}`);
  }
  assert.equal(STOCK_UNITS.length, 20);
});

test("kg and l collapse to the base unit while the code is kept", () => {
  assert.equal(stockUnitCode("Kg"), "kg");
  assert.equal(stockUnitCode("lít"), "l");
  assert.equal(normalizeStockUnit("Kg"), "g");
  assert.equal(normalizeStockUnit("lít"), "ml");
});

test("ambiguous spellings are never guessed", () => {
  for (const ambiguous of ["PACK", "CỐI (PACK)", "CŨI (PACK)", "định", "đệnh", "lần"]) {
    assert.equal(normalizeStockUnit(ambiguous), null, ambiguous);
    assert.equal(stockUnitCode(ambiguous), null, ambiguous);
  }
  assert.equal("pack" in STOCK_UNIT_ALIASES, false);
});

test("aliases are case-insensitive after trimming", () => {
  assert.equal(normalizeStockUnit("  GR  "), "g");
  assert.equal(normalizeStockUnit("  CAN LỚN "), "can");
  assert.equal(normalizeStockUnit("Chiếc"), "cái");
});

test("a document line keeps its own unit, only the spelling is fixed", () => {
  assert.equal(stockUnitLabel("KG"), "kg");
  assert.equal(stockUnitLabel("Gr"), "g");
  assert.equal(stockUnitLabel("lít"), "l");
  assert.equal(stockUnitLabel("Cuôn"), "cuộn");
  assert.equal(stockUnitLabel("Hộp"), "hộp");
  assert.equal(stockUnitLabel("PACK"), null);
});

test("the item conversion mirrors public.stock_unit_item_conversion", () => {
  assert.deepEqual(stockUnitConversion("Kg"), { newUnit: "g", factor: 1000 });
  assert.deepEqual(stockUnitConversion("L"), { newUnit: "ml", factor: 1000 });
  assert.deepEqual(stockUnitConversion("Hộp"), { newUnit: "hộp", factor: 1 });
  assert.deepEqual(stockUnitConversion("can lớn"), { newUnit: "can", factor: 1 });
  assert.equal(stockUnitConversion("g"), null);
  assert.equal(stockUnitConversion("PACK"), null);
});
