import assert from "node:assert/strict";
import test from "node:test";

import {
  CASH_PR_MAX_ITEMS,
  CASH_PR_MAX_ITEM_AMOUNT,
  CASH_PR_MAX_TOTAL,
  buildCashPrIdempotencyKey,
  cashLineFromScan,
  isPlaceholderSupplierName,
  validateCashPrForm,
  type CashPrFormInput,
} from "./cash-pr-lines.ts";

test("water delivery note: 6 x 42.000 from supplier Nước 2H becomes one 252.000 khoản", () => {
  const line = cashLineFromScan(
    {
      supplier_name: "Nước 2H",
      items: [{ product_name: "Nước bình 20L", quantity: 6, unit_price: 42_000 }],
    },
    0,
  );

  assert.deepEqual(line, { name: "Nước 2H", amount: 252_000 });
});

test("ride-app screenshot with total 81.000 and a description prefers total_amount", () => {
  const line = cashLineFromScan(
    { total_amount: 81_000, description: "Ship #26XLO7TD", items: [{ product_name: "6 chai", quantity: 6, unit_price: 1_000 }] },
    0,
  );

  assert.deepEqual(line, { name: "Ship #26XLO7TD", amount: 81_000 });
});

test("payee is prefixed to the description and total_amount still wins", () => {
  const line = cashLineFromScan(
    { total_amount: 81_000, supplier_name: "Siêu Tốc", description: "Ship #26XLO7TD" },
    0,
  );

  assert.deepEqual(line, { name: "Siêu Tốc — Ship #26XLO7TD", amount: 81_000 });
});

test("a payee already inside the description is not duplicated", () => {
  const line = cashLineFromScan(
    { total_amount: 49_000, supplier_name: "Siêu Tốc", description: "Ship Siêu Tốc #26XLO7TD" },
    0,
  );

  assert.deepEqual(line, { name: "Ship Siêu Tốc #26XLO7TD", amount: 49_000 });
});

test("placeholder supplier names are ignored in favour of the description", () => {
  const line = cashLineFromScan(
    { total_amount: 81_000, supplier_name: "Không biết", description: "Ship #26XLO7TD" },
    0,
  );

  assert.deepEqual(line, { name: "Ship #26XLO7TD", amount: 81_000 });
});

test("isPlaceholderSupplierName ignores case/accent variants and blank values", () => {
  for (const value of ["Không biết", "khong biet", "UNKNOWN", "n/a", "-", "", "   ", null, undefined]) {
    assert.equal(isPlaceholderSupplierName(value), true, `expected placeholder: ${JSON.stringify(value)}`);
  }
  assert.equal(isPlaceholderSupplierName("Siêu Tốc"), false);
});

test("a payment label as description falls back to the order number (real Siêu Tốc screenshot)", () => {
  const line = cashLineFromScan(
    { total_amount: 49_000, supplier_name: "Siêu Tốc", description: "Tài khoản", invoice_number: "#260WIBK4" },
    0,
  );

  assert.deepEqual(line, { name: "Siêu Tốc — #260WIBK4", amount: 49_000 });
});

test("a payment label without an order number keeps just the payee", () => {
  const line = cashLineFromScan({ total_amount: 49_000, supplier_name: "Siêu Tốc", description: "Tổng tiền" }, 0);

  assert.deepEqual(line, { name: "Siêu Tốc", amount: 49_000 });
});

test("an unreadable result yields a null amount and the invoice fallback name", () => {
  const line = cashLineFromScan({}, 2);

  assert.deepEqual(line, { name: "Hoá đơn 3", amount: null });
});

test("an empty description falls back to the payee name", () => {
  const line = cashLineFromScan(
    { total_amount: 81_000, supplier_name: "Siêu Tốc", description: "   " },
    0,
  );

  assert.deepEqual(line, { name: "Siêu Tốc", amount: 81_000 });
});

test("total_amount is preferred over the summed items", () => {
  const line = cashLineFromScan(
    {
      total_amount: 500_000,
      items: [{ product_name: "Ly", quantity: 2, unit_price: 100_000 }],
    },
    0,
  );

  assert.equal(line.amount, 500_000);
});

test("a cash_receipt envelope with items still prefers total_amount", () => {
  const line = cashLineFromScan(
    {
      total_amount: 252_000,
      supplier_name: "Nước 2H",
      description: "Nước Bidrico 19L x6",
      items: [{ product_name: "Nước Bidrico 19L x6", quantity: 6, unit_price: 42_000 }],
    },
    0,
  );

  assert.deepEqual(line, { name: "Nước 2H — Nước Bidrico 19L x6", amount: 252_000 });
});

test("sums quantity * unit_price when total_amount is missing", () => {
  const line = cashLineFromScan(
    {
      items: [
        { product_name: "Nước", quantity: 6, unit_price: 42_000 },
        { product_name: "Ly", quantity: 1, unit_price: 20_000 },
      ],
    },
    0,
  );

  assert.equal(line.amount, 272_000);
  assert.equal(line.name, "Nước + 1 khoản khác");
});

test("uses the first item name and reports the remaining khoản count", () => {
  const line = cashLineFromScan(
    { items: [{ product_name: "Xăng" }, { product_name: "Bốc vác" }, { product_name: "Vé xe" }] },
    0,
  );

  assert.equal(line.name, "Xăng + 2 khoản khác");
  assert.equal(line.amount, null);
});

test("caps a long name at 200 characters", () => {
  const longName = "A".repeat(250);
  const line = cashLineFromScan({ supplier_name: longName, items: [] }, 0);

  assert.equal(line.name.length, 200);
  assert.equal(line.name, "A".repeat(200));
});

const validForm = (overrides: Partial<CashPrFormInput> = {}): CashPrFormInput => ({
  title: "Chi tiền mặt lặt vặt",
  description: "Nhiều hoá đơn",
  items: [
    { name: "Nước", amount: 252_000 },
    { name: "Vận chuyển", amount: 130_000 },
    { name: "Xăng", amount: 320_000 },
  ],
  ...overrides,
});

test("validateCashPrForm accepts a valid form and returns the total", () => {
  const result = validateCashPrForm(validForm());

  assert.equal(result.ok, true);
  assert.deepEqual(result.messages, []);
  assert.equal(result.total, 702_000);
});

test("validateCashPrForm rejects an empty item list and a blank title", () => {
  const result = validateCashPrForm(validForm({ title: "   ", items: [] }));

  assert.equal(result.ok, false);
  assert.ok(result.messages.some((message) => message.includes("Tiêu đề")));
  assert.ok(result.messages.some((message) => message.includes("ít nhất 1 khoản")));
});

test("validateCashPrForm rejects a blank khoản name", () => {
  const result = validateCashPrForm(
    validForm({ items: [{ name: "  ", amount: 100_000 }] }),
  );

  assert.equal(result.ok, false);
  assert.ok(result.messages.some((message) => message.includes("tên khoản")));
});

test("validateCashPrForm rejects a zero, fractional or oversized amount", () => {
  const zero = validateCashPrForm(validForm({ items: [{ name: "A", amount: 0 }] }));
  assert.equal(zero.ok, false);

  const fractional = validateCashPrForm(validForm({ items: [{ name: "A", amount: 1000.5 }] }));
  assert.equal(fractional.ok, false);

  const tooBig = validateCashPrForm(
    validForm({ items: [{ name: "A", amount: CASH_PR_MAX_ITEM_AMOUNT + 1 }] }),
  );
  assert.equal(tooBig.ok, false);
});

test("validateCashPrForm enforces the item count and total limits", () => {
  const tooMany = validateCashPrForm(
    validForm({
      items: Array.from({ length: CASH_PR_MAX_ITEMS + 1 }, (_, i) => ({
        name: `Khoản ${i + 1}`,
        amount: 1000,
      })),
    }),
  );
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.messages.some((message) => message.includes(`Tối đa ${CASH_PR_MAX_ITEMS}`)));

  // 5 x 50,000,000 = 250,000,000 > 200,000,000 while each line is valid.
  const overTotal = validateCashPrForm(
    validForm({
      items: Array.from({ length: 5 }, (_, i) => ({
        name: `Khoản ${i + 1}`,
        amount: CASH_PR_MAX_ITEM_AMOUNT,
      })),
    }),
  );
  assert.equal(overTotal.ok, false);
  assert.ok(overTotal.messages.some((message) => message.includes("Tổng tiền")));
  assert.ok(overTotal.total > CASH_PR_MAX_TOTAL);
});

test("validateCashPrForm rejects a title over 200 characters", () => {
  const result = validateCashPrForm(validForm({ title: "T".repeat(201) }));

  assert.equal(result.ok, false);
  assert.ok(result.messages.some((message) => message.includes("Tiêu đề")));
});

test("buildCashPrIdempotencyKey is stable for a session id and unique otherwise", () => {
  assert.equal(buildCashPrIdempotencyKey("dialog-1"), "cash-pr:dialog-1");
  assert.equal(buildCashPrIdempotencyKey("dialog-1"), buildCashPrIdempotencyKey("dialog-1"));
  assert.notEqual(buildCashPrIdempotencyKey(), buildCashPrIdempotencyKey());
});
