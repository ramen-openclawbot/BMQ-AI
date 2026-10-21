import assert from "node:assert/strict";
import test from "node:test";

import { checkScanTotals } from "./scan-total-check.ts";

/**
 * The 10 lines of Ngọc Trân HD019586.01 as read correctly: they sum to the
 * printed pre-VAT subtotal of 7.355.000.
 */
const ngocTranItems = () => [
  { product_name: "BAO PE 15X25 (kg)", quantity: 2, unit_price: 55_000, line_total: 110_000 },
  { product_name: "BAO TAY Y TẾ TRẮNG SIZE M (HỘP 100 CÁI)", quantity: 7, unit_price: 90_000, line_total: 630_000 },
  { product_name: "MÀNG PVC -ST 612-30CM (CUỘN)", quantity: 1, unit_price: 185_000, line_total: 185_000 },
  { product_name: "GVS PREMIER JUMBO 700GR (CUỘN)", quantity: 2, unit_price: 35_000, line_total: 70_000 },
  { product_name: "BAO TAY Y TẾ ĐEN SIZE L (HỘP 100 CÁI)", quantity: 7, unit_price: 90_000, line_total: 630_000 },
  { product_name: "THỐ B BĂNG KEO VÀNG -VP (Bao 100 Cái)", quantity: 30, unit_price: 135_000, line_total: 4_050_000 },
  { product_name: "BAO XỐP ZIN TRẮNG 30 (kg)", quantity: 5, unit_price: 48_000, line_total: 240_000 },
  { product_name: "BAO XỐP ZIN TRẮNG 35 (kg)", quantity: 10, unit_price: 48_000, line_total: 480_000 },
  { product_name: "BAO XỐP ZIN TRẮNG 40 (kg)", quantity: 15, unit_price: 48_000, line_total: 720_000 },
  { product_name: "BAO XỐP ZIN TRẮNG 50 (kg)", quantity: 5, unit_price: 48_000, line_total: 240_000 },
];

test("(a) read correctly: 10 lines sum to the printed subtotal, no warnings", () => {
  const result = checkScanTotals({
    items: ngocTranItems(),
    subtotal_amount: 7_355_000,
    vat_amount: 588_400,
    total_amount: 7_943_400,
  });

  assert.deepEqual(result.warnings, []);
  assert.equal(result.subtotal_amount, 7_355_000);
});

test("(b) extra 'Gạo nếp 1kg' line reports the 220.000 document difference", () => {
  const result = checkScanTotals({
    items: [
      ...ngocTranItems(),
      { product_name: "Gạo nếp 1kg", quantity: 1, unit_price: 220_000, line_total: 220_000 },
    ],
    subtotal_amount: 7_355_000,
    vat_amount: 588_400,
    total_amount: 7_943_400,
  });

  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].kind, "subtotal_mismatch");
  assert.equal(result.warnings[0].difference, 220_000);
  assert.match(result.warnings[0].message, /7\.575\.000/);
  assert.match(result.warnings[0].message, /7\.355\.000/);
  assert.match(result.warnings[0].message, /220\.000/);
});

test("(c) quantity * unit_price differing from line_total flags that line", () => {
  const result = checkScanTotals({
    items: [
      { product_name: "BAO PE 15X25 (kg)", quantity: 2, unit_price: 55_000, line_total: 110_000 },
      // OCR glued the next row's total onto this one (HD019586.01, 10/10)
      { product_name: "BAO TAY Y TẾ TRẮNG SIZE M (HỘP 100 CÁI)", quantity: 7, unit_price: 90_000, line_total: 70_000 },
    ],
  });

  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].kind, "line_mismatch");
  assert.equal(result.warnings[0].line_index, 1);
  assert.equal(result.warnings[0].expected, 630_000);
  assert.equal(result.warnings[0].actual, 70_000);
  assert.equal(result.warnings[0].difference, 560_000);
});

test("(d) missing subtotal falls back to total_amount - vat_amount", () => {
  const result = checkScanTotals({
    items: ngocTranItems(),
    total_amount: 7_943_400,
    vat_amount: 588_400,
  });

  assert.deepEqual(result.warnings, []);
  assert.equal(result.subtotal_amount, 7_355_000);
});

test("(e) no totals at all skips the document check", () => {
  const result = checkScanTotals({ items: ngocTranItems() });

  assert.deepEqual(result.warnings, []);
  assert.equal(result.subtotal_amount, null);
});

test("(f) rounding differences within 1.000 VND do not warn", () => {
  const result = checkScanTotals({
    items: [{ product_name: "Bơ", quantity: 1, unit_price: 100_000, line_total: 100_500 }],
    subtotal_amount: 100_800,
  });

  assert.deepEqual(result.warnings, []);
  assert.equal(result.subtotal_amount, 100_800);
});

test("missing line_total falls back to quantity * unit_price and does not warn", () => {
  const result = checkScanTotals({
    items: [
      { product_name: "Bột mì 888 Cam", quantity: 10, unit_price: 250_000 },
      { product_name: "Đường cát trắng", quantity: 5, unit_price: 320_000, line_total: 1_600_000 },
    ],
    subtotal_amount: 4_100_000,
  });

  assert.deepEqual(result.warnings, []);
});
