// Engine integration for the surprise mission bonus (2026-10-11).
//
// R1–R9 must not move: with no mission bonus the T08/T09 totals are exactly the
// approved 120.558.000 / 96.681.000. The bonus is added to gross before R5.

import assert from "node:assert/strict";
import test from "node:test";

import { computePayroll } from "./engine.ts";
import { addRational, rational, RATIONAL_ZERO } from "./money.ts";
import { T08_FIXTURE, T08_GROUP_TOTALS } from "./payroll-bn-t08.fixture.ts";
import { T09_FIXTURE, T09_GROUP_TOTALS } from "./payroll-bn-t09.fixture.ts";
import type { PayrollBnFixture } from "./fixture-helpers.ts";

function compute(fixture: PayrollBnFixture, employees = fixture.employees) {
  return computePayroll({
    period: fixture.period,
    employees,
    rows: fixture.rows,
    measures: fixture.measures,
    adjustments: fixture.adjustments,
  });
}

function group(result: ReturnType<typeof computePayroll>, name: string) {
  const line = result.groups.find((item) => item.group === name);
  assert.ok(line, `missing group ${name}`);
  return line!;
}

test("T08/T09 với thưởng 0 giữ nguyên 120.558.000 và 96.681.000", () => {
  const t08 = compute(T08_FIXTURE);
  const t09 = compute(T09_FIXTURE);

  assert.equal(t08.total.netPayRounded, BigInt(T08_GROUP_TOTALS.totalNet));
  assert.equal(t09.total.netPayRounded, BigInt(T09_GROUP_TOTALS.totalNet));
  assert.deepEqual(t08.total.missionBonus, RATIONAL_ZERO);
  assert.deepEqual(t09.total.missionBonus, RATIONAL_ZERO);

  // The total gross still equals the sum of the employee gross amounts.
  for (const fixture of [T08_FIXTURE, T09_FIXTURE]) {
    const result = compute(fixture);
    const sum = result.employees.reduce(
      (total, line) => addRational(total, line.grossPay),
      RATIONAL_ZERO,
    );
    assert.deepEqual(result.total.grossPay, sum);
  }
});

test("Long: +100.000 cộng trước làm tròn, gross 6.252.100 → thực nhận 6.252.000", () => {
  const employees = T09_FIXTURE.employees.map((employee) =>
    employee.code === "BN08" ? { ...employee, missionBonus: 100_000 } : employee,
  );
  const result = compute(T09_FIXTURE, employees);
  const long = result.employees.find((line) => line.employeeCode === "BN08");
  assert.ok(long);

  assert.deepEqual(long!.partTimePay, rational(6_152_100));
  assert.deepEqual(long!.missionBonus, rational(100_000));
  assert.deepEqual(long!.grossPay, rational(6_252_100));
  assert.deepEqual(long!.netPay, rational(6_252_100));
  assert.equal(long!.netPayRounded, 6_252_000n);

  // Old total + the exact bonus (the bonus is added before R5 rounding).
  assert.equal(result.total.netPayRounded, BigInt(T09_GROUP_TOTALS.totalNet + 100_000));
  assert.deepEqual(result.total.missionBonus, rational(100_000));
  assert.deepEqual(group(result, "Bếp bánh").missionBonus, rational(100_000));

  // T08 must stay untouched by the T09 bonus (period isolation).
  const t08 = compute(T08_FIXTURE);
  assert.equal(t08.total.netPayRounded, BigInt(T08_GROUP_TOTALS.totalNet));
  assert.deepEqual(t08.total.missionBonus, RATIONAL_ZERO);
});

test("missionBonus is summed into the group and total lines (SUMMED_FIELDS)", () => {
  const employees = T09_FIXTURE.employees.map((employee) =>
    employee.code === "BN08" ? { ...employee, missionBonus: 100_000 } : employee,
  );
  const result = compute(T09_FIXTURE, employees);

  const groupSum = result.groups.reduce(
    (total, line) => addRational(total, line.missionBonus),
    RATIONAL_ZERO,
  );
  assert.deepEqual(result.total.missionBonus, rational(100_000));
  assert.deepEqual(groupSum, result.total.missionBonus);
});
