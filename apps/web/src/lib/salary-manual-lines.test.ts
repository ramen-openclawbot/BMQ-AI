import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManualSalaryIdempotencyKey,
  normalizeManualLines,
  validateManualSalaryPayout,
  MANUAL_SALARY_MAX_AMOUNT,
  MANUAL_SALARY_MAX_LINES,
  MANUAL_SALARY_MAX_TITLE_LENGTH,
  type NormalizedManualSalaryLine,
} from "./salary-manual-lines.ts";

test("accepts a valid manual payout and trims its text", () => {
  const result = validateManualSalaryPayout({
    title: "  Lương lẻ ngoài bếp Q7  ",
    lines: [
      { employee_name: "  Nguyễn Văn A  ", amount: 1_500_000, note: "  Thử việc  " },
      { employee_name: "Trần Thị B", employee_code: "NV02", amount: 2_500_000 },
    ],
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);

  const lines = normalizeManualLines([
    { employee_name: "  Nguyễn Văn A  ", amount: 1_500_000, note: "  Thử việc  " },
    { employee_name: "Trần Thị B", employee_code: "NV02", amount: 2_500_000 },
  ]);
  assert.deepEqual(lines, [
    { employee_name: "Nguyễn Văn A", employee_code: "LL-01", amount: 1_500_000, note: "Thử việc" },
    { employee_name: "Trần Thị B", employee_code: "NV02", amount: 2_500_000, note: null },
  ]);
});

test("rejects an empty line list", () => {
  const empty = validateManualSalaryPayout({ title: "Lương lẻ", lines: [] });
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.some((error) => error.field === "lines"));

  const missing = validateManualSalaryPayout({ title: "Lương lẻ" });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((error) => error.field === "lines"));
});

test("drops fully empty rows but rejects a blank employee name with an amount", () => {
  const lines = normalizeManualLines([
    { employee_name: "", amount: "" },
    { employee_name: "  ", amount: null },
    { employee_name: "  ", amount: 1_000_000 },
  ]);
  assert.equal(lines.length, 1);

  const result = validateManualSalaryPayout({
    title: "Lương lẻ",
    lines: [{ employee_name: "  ", amount: 1_000_000 }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.field === "employee_name" && error.lineIndex === 0));
});

test("rejects zero, fractional and over-limit amounts", () => {
  const cases: Array<{ amount: number; label: string }> = [
    { amount: 0, label: "zero" },
    { amount: 1.5, label: "fractional" },
    { amount: MANUAL_SALARY_MAX_AMOUNT + 1, label: "over" },
  ];

  for (const { amount, label } of cases) {
    const result = validateManualSalaryPayout({
      title: "Lương lẻ",
      lines: [{ employee_name: `Nhân viên ${label}`, amount }],
    });
    assert.equal(result.valid, false, `${label} should be rejected`);
    assert.ok(result.errors.some((error) => error.field === "amount"), `${label} should flag amount`);
  }

  const boundary = validateManualSalaryPayout({
    title: "Lương lẻ",
    lines: [{ employee_name: "Đúng hạn mức", amount: MANUAL_SALARY_MAX_AMOUNT }],
  });
  assert.equal(boundary.valid, true);
});

test("rejects a total above 2,000,000,000", () => {
  const lines = Array.from({ length: 11 }, (_, index) => ({
    employee_name: `Nhân viên ${index + 1}`,
    amount: 200_000_000,
  }));
  const result = validateManualSalaryPayout({ title: "Lương lẻ", lines });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.field === "total"));
});

test("rejects more than 50 lines", () => {
  const lines = Array.from({ length: MANUAL_SALARY_MAX_LINES + 1 }, (_, index) => ({
    employee_name: `Nhân viên ${index + 1}`,
    amount: 1_000,
  }));
  const result = validateManualSalaryPayout({ title: "Lương lẻ", lines });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.field === "lines"));
});

test("rejects a blank or overly long title", () => {
  const blank = validateManualSalaryPayout({
    title: "   ",
    lines: [{ employee_name: "A", amount: 1_000 }],
  });
  assert.equal(blank.valid, false);
  assert.ok(blank.errors.some((error) => error.field === "title"));

  const long = validateManualSalaryPayout({
    title: "x".repeat(MANUAL_SALARY_MAX_TITLE_LENGTH + 1),
    lines: [{ employee_name: "A", amount: 1_000 }],
  });
  assert.equal(long.valid, false);
  assert.ok(long.errors.some((error) => error.field === "title"));

  const boundary = validateManualSalaryPayout({
    title: "x".repeat(MANUAL_SALARY_MAX_TITLE_LENGTH),
    lines: [{ employee_name: "A", amount: 1_000 }],
  });
  assert.equal(boundary.valid, true);
});

test("generates unique LL-01.. codes only for rows without a code", () => {
  const generated = normalizeManualLines([
    { employee_name: "A" },
    { employee_name: "B" },
    { employee_name: "C" },
  ]);
  assert.deepEqual(
    generated.map((line: NormalizedManualSalaryLine) => line.employee_code),
    ["LL-01", "LL-02", "LL-03"],
  );

  const skipsSupplied = normalizeManualLines([
    { employee_name: "A" },
    { employee_name: "B", employee_code: "LL-01" },
  ]);
  assert.deepEqual(
    skipsSupplied.map((line) => line.employee_code),
    ["LL-02", "LL-01"],
  );

  const duplicate = validateManualSalaryPayout({
    title: "Lương lẻ",
    lines: [
      { employee_name: "A", employee_code: "NV1", amount: 1_000 },
      { employee_name: "B", employee_code: "NV1", amount: 1_000 },
    ],
  });
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.errors.some((error) => error.field === "employee_code"));
});

test("parses a numeric string amount and builds a stable idempotency key", () => {
  const lines = normalizeManualLines([{ employee_name: "A", amount: "5000000" }]);
  assert.equal(lines[0].amount, 5_000_000);

  assert.equal(buildManualSalaryIdempotencyKey("session-1"), "salary-manual:session-1");
  assert.equal(buildManualSalaryIdempotencyKey("  session-1  "), "salary-manual:session-1");
  assert.match(buildManualSalaryIdempotencyKey(), /^salary-manual:.+$/);
  assert.notEqual(buildManualSalaryIdempotencyKey(), buildManualSalaryIdempotencyKey());
});
