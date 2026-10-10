import assert from "node:assert/strict";
import test from "node:test";

import {
  CASH_RECEIPT_MAX_AMOUNT,
  CASH_RECEIPT_TOOL,
  isPlaceholderPayeeName,
  normalizeCashReceipt,
} from "./cash-receipt-ocr.ts";

test("normalizes the delivery-app JSON: 81.000đ paid to Siêu Tốc", () => {
  const normalized = normalizeCashReceipt({
    total_amount: "81.000đ",
    payee_name: "Siêu Tốc",
    description: "Ship #26XLO7TD",
  });

  assert.equal(normalized.total_amount, 81_000);
  assert.equal(normalized.supplier_name, "Siêu Tốc");
  assert.equal(normalized.description, "Ship #26XLO7TD");
  assert.deepEqual(normalized.items, [
    { product_name: "Ship #26XLO7TD", quantity: 1, unit: "lần", unit_price: 81_000 },
  ]);
});

test("normalizes 49.000đ and 250.000đ ride-app screenshots", () => {
  assert.equal(normalizeCashReceipt({ total_amount: "49.000đ", payee_name: "Grab" }).total_amount, 49_000);
  assert.equal(normalizeCashReceipt({ total_amount: 250000, payee_name: "Be" }).total_amount, 250_000);
});

test("normalizes the water delivery note 252.000 and keeps description/items", () => {
  const normalized = normalizeCashReceipt({
    total_amount: "252.000đ",
    payee_name: "Nước 2H",
    description: "Nước Bidrico 19L x6",
    invoice_number: "HD-252",
  });

  assert.equal(normalized.total_amount, 252_000);
  assert.equal(normalized.supplier_name, "Nước 2H");
  assert.equal(normalized.invoice_number, "HD-252");
  assert.deepEqual(normalized.items, [
    { product_name: "Nước Bidrico 19L x6", quantity: 1, unit: "lần", unit_price: 252_000 },
  ]);
});

test("accepts Vietnamese number formats: 81.000đ, 81,000, 81000", () => {
  assert.equal(normalizeCashReceipt({ total_amount: "81.000đ" }).total_amount, 81_000);
  assert.equal(normalizeCashReceipt({ total_amount: "81,000" }).total_amount, 81_000);
  assert.equal(normalizeCashReceipt({ total_amount: 81000 }).total_amount, 81_000);
});

test("a placeholder payee 'Không biết' becomes supplier_name null", () => {
  const normalized = normalizeCashReceipt({ total_amount: "81.000đ", payee_name: "Không biết" });

  assert.equal(normalized.supplier_name, null);
  assert.equal(normalized.total_amount, 81_000);
});

test("isPlaceholderPayeeName ignores case/accent variants and blank values", () => {
  for (const value of ["Không biết", "khong biet", "UNKNOWN", "n/a", "-", "", "   "]) {
    assert.equal(isPlaceholderPayeeName(value), true, `expected placeholder: ${JSON.stringify(value)}`);
  }
  assert.equal(isPlaceholderPayeeName("Siêu Tốc"), false);
  assert.equal(isPlaceholderPayeeName("Tài xế Ahamove"), false);
});

test("a missing amount yields total_amount null and items []", () => {
  const normalized = normalizeCashReceipt({ payee_name: "Siêu Tốc", description: "Ship #26XLO7TD" });

  assert.equal(normalized.total_amount, null);
  assert.deepEqual(normalized.items, []);
});

test("rejects non-positive and absurd amounts (> 50.000.000)", () => {
  assert.equal(normalizeCashReceipt({ total_amount: "0" }).total_amount, null);
  assert.equal(normalizeCashReceipt({ total_amount: "-5.000" }).total_amount, null);
  assert.equal(normalizeCashReceipt({ total_amount: "51.000.000" }).total_amount, null);
  assert.equal(normalizeCashReceipt({ total_amount: CASH_RECEIPT_MAX_AMOUNT + 1 }).total_amount, null);
  assert.equal(normalizeCashReceipt({ total_amount: CASH_RECEIPT_MAX_AMOUNT }).total_amount, CASH_RECEIPT_MAX_AMOUNT);
});

test("the tool schema names extract_cash_receipt and requires total_amount", () => {
  assert.equal(CASH_RECEIPT_TOOL.function.name, "extract_cash_receipt");
  assert.deepEqual(CASH_RECEIPT_TOOL.function.parameters.required, ["total_amount"]);
  assert.equal(CASH_RECEIPT_TOOL.function.parameters.properties.total_amount.type, "number");
});
