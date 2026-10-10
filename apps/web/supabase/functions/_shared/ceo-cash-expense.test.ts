import assert from "node:assert/strict";
import test from "node:test";

import {
  CEO_CASH_MAX_DESCRIPTION_LENGTH,
  CEO_CASH_MAX_PRODUCT_NAME_LENGTH,
  CEO_CASH_UNMAPPED_CATEGORY,
  normalizeCeoCashExpenseOcr,
  normalizeCostCategory,
  parseVnAmount,
  parseVnDate,
  truncateText,
} from "./ceo-cash-expense.ts";

const ALLOWED = [
  "COGS_BMQ_BREAD",
  "COGS_SWEET_KITCHEN",
  "PACKAGING_SALES",
  "OPEX_GENERAL",
  "KITCHEN_SUPPLY_REPAIR",
  "CAPEX_ASSET_PROJECT",
  CEO_CASH_UNMAPPED_CATEGORY,
];

test("parses Vietnamese amount formats", () => {
  assert.equal(parseVnAmount("1.250.000"), 1_250_000);
  assert.equal(parseVnAmount("1,250,000đ"), 1_250_000);
  assert.equal(parseVnAmount("1tr2"), 1_200_000);
  assert.equal(parseVnAmount("50k"), 50_000);
  assert.equal(parseVnAmount("2,5tr"), 2_500_000);
  assert.equal(parseVnAmount("1.250.000,50"), 1_250_001);
  assert.equal(parseVnAmount("5000000 VND"), 5_000_000);
  assert.equal(parseVnAmount(3000000), 3_000_000);
  assert.equal(parseVnAmount(""), null);
  assert.equal(parseVnAmount("0"), null);
  assert.equal(parseVnAmount("không rõ"), null);
});

test("parses dd/mm/yyyy and ISO dates, rejecting impossible dates", () => {
  assert.equal(parseVnDate("07/10/2026"), "2026-10-07");
  assert.equal(parseVnDate("7/10/2026"), "2026-10-07");
  assert.equal(parseVnDate("2026-10-07"), "2026-10-07");
  assert.equal(parseVnDate("07-10-2026"), "2026-10-07");
  assert.equal(parseVnDate("31/02/2026"), null);
  assert.equal(parseVnDate(""), null);
  assert.equal(parseVnDate(null), null);
});

test("forces an unknown cost category to UNMAPPED_REVIEW", () => {
  assert.equal(normalizeCostCategory("opex_general", ALLOWED), "OPEX_GENERAL");
  assert.equal(normalizeCostCategory("KHONG_CO", ALLOWED), CEO_CASH_UNMAPPED_CATEGORY);
  assert.equal(normalizeCostCategory(null, ALLOWED), CEO_CASH_UNMAPPED_CATEGORY);
});

test("truncates long strings", () => {
  assert.equal(truncateText("  a   b  ", 100), "a b");
  assert.equal(truncateText("x".repeat(20), 5), "xxxxx");
  assert.equal(truncateText(null, 5), "");
});

test("normalizes a full OCR payload", () => {
  const result = normalizeCeoCashExpenseOcr({
    payee_name: "  Chị   Hoa ",
    expense_date: "07/10/2026",
    total_amount: "1.250.000đ",
    description: "Mua nguyên liệu",
    cost_category_code: "opex_general",
    items: [
      { product_name: "Bột mì", quantity: 2, unit_price: "500000", cost_category_code: "COGS_BMQ_BREAD" },
      { product_name: "Bao bì", quantity: 1, unit_price: "250000", cost_category_code: "sai_ma" },
    ],
  }, ALLOWED);

  assert.equal(result.payee_name, "Chị Hoa");
  assert.equal(result.expense_date, "2026-10-07");
  assert.equal(result.amount, 1_250_000);
  assert.equal(result.cost_category_code, "OPEX_GENERAL");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].cost_category_code, "COGS_BMQ_BREAD");
  assert.equal(result.items[0].line_total, 1_000_000);
  // An unmapped item falls back to the header category when it is valid.
  assert.equal(result.items[1].cost_category_code, "OPEX_GENERAL");
});

test("caps long fields and tolerates a failing OCR payload", () => {
  const longName = "N".repeat(CEO_CASH_MAX_PRODUCT_NAME_LENGTH + 50);
  const longDescription = "D".repeat(CEO_CASH_MAX_DESCRIPTION_LENGTH + 50);
  const result = normalizeCeoCashExpenseOcr(
    { description: longDescription, items: [{ product_name: longName, unit_price: 1000 }] },
    ALLOWED,
  );
  assert.equal(result.description.length, CEO_CASH_MAX_DESCRIPTION_LENGTH);
  assert.equal(result.items[0].product_name.length, CEO_CASH_MAX_PRODUCT_NAME_LENGTH);

  const empty = normalizeCeoCashExpenseOcr(null, ALLOWED);
  assert.equal(empty.amount, 0);
  assert.equal(empty.payee_name, null);
  assert.equal(empty.expense_date, null);
  assert.equal(empty.cost_category_code, CEO_CASH_UNMAPPED_CATEGORY);
  assert.deepEqual(empty.items, []);
});
