import assert from "node:assert/strict";
import test from "node:test";

import {
  CEO_CASH_MAX_AMOUNT,
  ceoCashExpenseErrorMessage,
  ceoCashExpenseIdempotencyKey,
  daysBetweenIso,
  parseCeoCashExpenseErrorCode,
  validateCeoCashExpenseForm,
  vietnamToday,
  type CeoCashExpenseFormFields,
} from "./ceo-cash-expense.ts";

const NOW = new Date("2026-10-07T05:00:00.000Z"); // 12:00 2026-10-07 in Vietnam

const fields = (overrides: Partial<CeoCashExpenseFormFields> = {}): CeoCashExpenseFormFields => ({
  amount: 1_250_000,
  expense_date: "2026-10-01",
  cost_category_code: "OPEX_GENERAL",
  description: "Chi mua nguyên liệu",
  ...overrides,
});

test("computes the Vietnam day regardless of host timezone", () => {
  assert.equal(vietnamToday(NOW), "2026-10-07");
  // 18:00Z on 2026-10-06 is already 2026-10-07 in Vietnam.
  assert.equal(vietnamToday(new Date("2026-10-06T18:00:00.000Z")), "2026-10-07");
});

test("counts whole days between ISO dates", () => {
  assert.equal(daysBetweenIso("2026-10-01", "2026-10-07"), 6);
  assert.equal(daysBetweenIso("2026-07-09", "2026-10-07"), 90);
});

test("builds a stable idempotency key per draft", () => {
  assert.equal(ceoCashExpenseIdempotencyKey("abc"), "ceo-cash:abc");
  assert.equal(ceoCashExpenseIdempotencyKey(" abc "), "ceo-cash:abc");
});

test("accepts a valid form", () => {
  assert.deepEqual(validateCeoCashExpenseForm(fields(), { now: NOW }), { ok: true });
});

test("rejects a non-positive or fractional amount", () => {
  for (const amount of [0, -1, 1000.5, Number.NaN]) {
    const result = validateCeoCashExpenseForm(fields({ amount }), { now: NOW });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid_amount");
  }
});

test("rejects an amount above the cash limit", () => {
  const ok = validateCeoCashExpenseForm(fields({ amount: CEO_CASH_MAX_AMOUNT }), { now: NOW });
  assert.equal(ok.ok, true);
  const over = validateCeoCashExpenseForm(fields({ amount: CEO_CASH_MAX_AMOUNT + 1 }), { now: NOW });
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.code, "amount_over_cash_limit");
});

test("rejects a future or too-old expense date", () => {
  const future = validateCeoCashExpenseForm(fields({ expense_date: "2026-10-08" }), { now: NOW });
  assert.equal(future.ok, false);
  if (!future.ok) assert.equal(future.code, "date_out_of_range");

  const boundary = validateCeoCashExpenseForm(fields({ expense_date: "2026-07-09" }), { now: NOW });
  assert.equal(boundary.ok, true);

  const tooOld = validateCeoCashExpenseForm(fields({ expense_date: "2026-07-08" }), { now: NOW });
  assert.equal(tooOld.ok, false);
  if (!tooOld.ok) assert.equal(tooOld.code, "date_out_of_range");

  const malformed = validateCeoCashExpenseForm(fields({ expense_date: "07/10/2026" }), { now: NOW });
  assert.equal(malformed.ok, false);
});

test("rejects a missing category or description", () => {
  const noCategory = validateCeoCashExpenseForm(fields({ cost_category_code: "  " }), { now: NOW });
  assert.equal(noCategory.ok, false);
  if (!noCategory.ok) assert.equal(noCategory.code, "invalid_category");

  const noDescription = validateCeoCashExpenseForm(fields({ description: "" }), { now: NOW });
  assert.equal(noDescription.ok, false);
  if (!noDescription.ok) assert.equal(noDescription.code, "description_required");
});

test("maps RPC error codes to short Vietnamese sentences", () => {
  assert.match(ceoCashExpenseErrorMessage("not_owner"), /chủ sở hữu/i);
  assert.match(ceoCashExpenseErrorMessage("amount_over_cash_limit"), /50\.000\.000/);
  assert.match(ceoCashExpenseErrorMessage("date_out_of_range"), /90 ngày/);
  assert.match(ceoCashExpenseErrorMessage("duplicate"), /đã được ghi nhận/);
  assert.match(ceoCashExpenseErrorMessage("unknown_thing"), /Vui lòng thử lại/);
});

test("extracts a known code from a raw Postgres message", () => {
  assert.equal(parseCeoCashExpenseErrorCode("ERROR: amount_over_cash_limit"), "amount_over_cash_limit");
  assert.equal(parseCeoCashExpenseErrorCode("not_owner"), "not_owner");
  assert.equal(parseCeoCashExpenseErrorCode("something else"), "record_failed");
});
