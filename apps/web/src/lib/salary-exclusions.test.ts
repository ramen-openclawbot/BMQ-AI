import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPayoutSelection,
  exclusionErrorText,
  toExclusionPayload,
  validateExclusionReason,
  EXCLUSION_NO_EMPLOYEES_MESSAGE,
  EXCLUSION_REASON_MAX_LENGTH,
  EXCLUSION_REASON_REQUIRED_MESSAGE,
  EXCLUSION_REASON_TOO_LONG_MESSAGE,
  type SalaryPayoutPeriodLine,
} from "./salary-exclusions.ts";

const LINES: SalaryPayoutPeriodLine[] = [
  { employee_code: "SMK01", employee_name: "Smoke A", net_pay: 5_000_000 },
  { employee_code: "SMK02", employee_name: "Smoke B", net_pay: 6_000_000 },
  { employee_code: "SMK03", employee_name: "Smoke C", net_pay: 7_000_000 },
];

test("no exclusion keeps every line and the full total", () => {
  const result = buildPayoutSelection(LINES, {});

  assert.equal(result.included.length, 3);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.employeeCount, 3);
  assert.equal(result.totalAmount, 18_000_000);
  assert.deepEqual(result.errors, []);
});

test("one exclusion drops only that employee from the count and total", () => {
  const result = buildPayoutSelection(LINES, { SMK02: "Nghỉ không lương" });

  assert.deepEqual(
    result.included.map((line) => line.employee_code),
    ["SMK01", "SMK03"],
  );
  assert.deepEqual(
    result.excluded.map((line) => line.employee_code),
    ["SMK02"],
  );
  assert.equal(result.excluded[0].reason, "Nghỉ không lương");
  assert.equal(result.employeeCount, 2);
  assert.equal(result.totalAmount, 12_000_000);
  assert.deepEqual(result.errors, []);
});

test("several exclusions sum only the remaining employees", () => {
  const result = buildPayoutSelection(LINES, {
    SMK01: "Đã tạm ứng",
    SMK03: "Chuyển khoản riêng",
  });

  assert.deepEqual(
    result.included.map((line) => line.employee_code),
    ["SMK02"],
  );
  assert.equal(result.employeeCount, 1);
  assert.equal(result.totalAmount, 6_000_000);
  assert.equal(result.errors.length, 0);
});

test("a missing or too-short reason is reported per excluded employee", () => {
  const missing = buildPayoutSelection(LINES, { SMK01: "" });
  assert.equal(missing.errors.length, 1);
  assert.equal(missing.errors[0].employee_code, "SMK01");
  assert.equal(missing.errors[0].message, EXCLUSION_REASON_REQUIRED_MESSAGE);

  const short = buildPayoutSelection(LINES, { SMK01: "ab" });
  assert.equal(short.errors[0].message, EXCLUSION_REASON_REQUIRED_MESSAGE);
});

test("a reason longer than 200 characters is rejected but whitespace is trimmed", () => {
  const trimmed = validateExclusionReason("  Nghỉ phép  ");
  assert.equal(trimmed.valid, true);
  assert.equal(trimmed.message, "");

  const tooShort = validateExclusionReason("  a  ");
  assert.equal(tooShort.valid, false);
  assert.equal(tooShort.message, EXCLUSION_REASON_REQUIRED_MESSAGE);

  const tooLong = validateExclusionReason("x".repeat(EXCLUSION_REASON_MAX_LENGTH + 1));
  assert.equal(tooLong.valid, false);
  assert.equal(tooLong.message, EXCLUSION_REASON_TOO_LONG_MESSAGE);

  const boundaryMin = validateExclusionReason("abc");
  assert.equal(boundaryMin.valid, true);

  const boundaryMax = validateExclusionReason("x".repeat(EXCLUSION_REASON_MAX_LENGTH));
  assert.equal(boundaryMax.valid, true);

  const paddedBoundary = validateExclusionReason(`  ${"x".repeat(EXCLUSION_REASON_MAX_LENGTH)}  `);
  assert.equal(paddedBoundary.valid, true, "trim before the length check");
});

test("excluding everyone reports the keep-one-employee error", () => {
  const result = buildPayoutSelection(LINES, {
    SMK01: "Nghỉ phép",
    SMK02: "Nghỉ phép",
    SMK03: "Nghỉ phép",
  });

  assert.equal(result.included.length, 0);
  assert.equal(result.employeeCount, 0);
  assert.equal(result.totalAmount, 0);
  assert.ok(
    result.errors.some(
      (error) => error.employee_code === null && error.message === EXCLUSION_NO_EMPLOYEES_MESSAGE,
    ),
  );
});

test("an unknown excluded code is ignored in the totals", () => {
  const result = buildPayoutSelection(LINES, { NOPE: "Không có trong kỳ" });

  assert.equal(result.employeeCount, 3);
  assert.equal(result.totalAmount, 18_000_000);
  assert.equal(result.excluded.length, 0);
  assert.deepEqual(result.errors, []);
});

test("toExclusionPayload trims reasons and orders by employee_code", () => {
  const payload = toExclusionPayload({
    SMK03: "  Chuyển khoản riêng  ",
    SMK01: " Đã tạm ứng ",
  });

  assert.deepEqual(payload, [
    { employee_code: "SMK01", reason: "Đã tạm ứng" },
    { employee_code: "SMK03", reason: "Chuyển khoản riêng" },
  ]);

  assert.deepEqual(toExclusionPayload(null), []);
  assert.deepEqual(toExclusionPayload(undefined), []);
});

test("error text covers every server code, unknown codes fall back", () => {
  const codes = [
    "invalid_exclusions",
    "reason_required",
    "unknown_employee_code",
    "no_employees_left",
  ] as const;

  for (const code of codes) {
    const message = exclusionErrorText(code);
    assert.ok(message.length > 0, `${code} should map to a message`);
    assert.notEqual(message, exclusionErrorText("does_not_exist"));
  }

  assert.equal(exclusionErrorText("no_employees_left"), EXCLUSION_NO_EMPLOYEES_MESSAGE);
  assert.ok(exclusionErrorText("does_not_exist").length > 0);
  assert.ok(exclusionErrorText(null).length > 0);
  assert.equal(exclusionErrorText("does_not_exist"), exclusionErrorText(null));
});
