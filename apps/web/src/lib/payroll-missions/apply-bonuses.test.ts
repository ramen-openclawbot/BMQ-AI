// Mission bonus wiring tests — draft table, Excel export and payslips.
//
// THUONG_FIXTURE = 100.000 đồng is a FIXTURE value, not a real reward level.
// Long (BN08) part-time pay 6.152.100 + 100.000 → gross 6.252.100 and net
// 6.252.000, in the draft, the export and the payslip alike. With no bonus the
// T08/T09 totals must stay 120.558.000 / 96.681.000 and no mission line appears.

import assert from "node:assert/strict";
import test from "node:test";

import { computePayroll } from "../payroll-bn/engine.ts";
import { buildPayrollExportRows } from "../payroll-bn/export.ts";
import { buildPayrollNotes } from "../payroll-bn/notes.ts";
import { buildPayslips } from "../payroll-bn/payslip.ts";
import type { PayrollBnFixture } from "../payroll-bn/fixture-helpers.ts";
import { T08_FIXTURE, T08_GROUP_TOTALS } from "../payroll-bn/payroll-bn-t08.fixture.ts";
import { T09_FIXTURE, T09_GROUP_TOTALS } from "../payroll-bn/payroll-bn-t09.fixture.ts";
import type { AdjustmentField } from "../payroll-bn/types.ts";
import { applyMissionBonuses } from "./bonus.ts";
import type { MissionBonusAmount } from "./bonus.ts";

const THUONG_FIXTURE = 100_000;
const LONG_CODE = "BN08";
const BONUSES: MissionBonusAmount[] = [
  { employeeCode: LONG_CODE, missionCode: "T-DUNGGIO", amountVnd: THUONG_FIXTURE },
];

const LABELS: Record<AdjustmentField, string> = {
  work_days: "NC thực tế",
  paid_work_days: "NC tính lương",
  part_time_hours: "Giờ part-time",
  overtime_hours: "Giờ tăng ca",
  exclude_overtime: "Không tính tăng ca",
  exclude_holiday: "Không tính ngày lễ",
  net_pay: "Thực nhận",
};

function computeWithBonuses(fixture: PayrollBnFixture, bonuses: readonly MissionBonusAmount[]) {
  const { employees, missionCodesByEmployee } = applyMissionBonuses(fixture.employees, bonuses);
  const result = computePayroll({
    period: fixture.period,
    employees,
    rows: fixture.rows,
    measures: fixture.measures,
    adjustments: fixture.adjustments,
  });
  const notes = buildPayrollNotes(result.employees, fixture.adjustments, LABELS, missionCodesByEmployee);
  return { employees, result, notes, missionCodesByEmployee };
}

test("Long +100.000: nháp, export và phiếu lương đều 6.252.000; ghi chú có mã nhiệm vụ", () => {
  const { employees, result, notes } = computeWithBonuses(T09_FIXTURE, BONUSES);

  const long = result.employees.find((line) => line.employeeCode === LONG_CODE);
  assert.ok(long);
  assert.deepEqual(long!.missionBonus, { n: BigInt(THUONG_FIXTURE), d: 1n });
  assert.equal(long!.netPayRounded, 6_252_000n);

  // Draft / notes: the mission code is listed.
  assert.ok(notes.get(LONG_CODE)?.some((note) => note.includes("T-DUNGGIO")));

  // Export: bonus column (12) and net (14).
  const rows = buildPayrollExportRows(T09_FIXTURE.period, result, notes);
  const exportLong = rows.find((row) => row[0] === LONG_CODE);
  assert.ok(exportLong);
  assert.equal(exportLong![12], THUONG_FIXTURE);
  assert.equal(exportLong![14], 6_252_000);

  // Payslip: same 6.252.000 and a mission_bonus line.
  const payslips = buildPayslips(T09_FIXTURE.period, employees, result, notes);
  const payslipLong = payslips.find((payslip) => payslip.employee_code === LONG_CODE);
  assert.ok(payslipLong);
  assert.equal(payslipLong!.net_pay, 6_252_000);
  const bonusLine = payslipLong!.lines.find((line) => line.key === "mission_bonus");
  assert.ok(bonusLine);
  assert.equal(bonusLine!.value, THUONG_FIXTURE);
});

test("không có thưởng → T08/T09 giữ nguyên và phiếu lương không có dòng mission_bonus", () => {
  const cases: [PayrollBnFixture, number][] = [
    [T08_FIXTURE, T08_GROUP_TOTALS.totalNet],
    [T09_FIXTURE, T09_GROUP_TOTALS.totalNet],
  ];

  for (const [fixture, expectedNet] of cases) {
    const { employees, result, notes } = computeWithBonuses(fixture, []);
    assert.deepEqual(employees, fixture.employees);
    assert.equal(result.total.netPayRounded, BigInt(expectedNet));

    const payslips = buildPayslips(fixture.period, employees, result, notes);
    for (const payslip of payslips) {
      assert.ok(
        !payslip.lines.some((line) => line.key === "mission_bonus"),
        `${payslip.employee_code} unexpectedly has a mission_bonus line`,
      );
    }
  }
});

test("một khoản 0 đồng không tạo dòng và không đổi thực nhận", () => {
  const zero: MissionBonusAmount[] = [
    { employeeCode: LONG_CODE, missionCode: "T-DUNGGIO", amountVnd: 0 },
  ];
  const { employees, result } = computeWithBonuses(T09_FIXTURE, zero);
  assert.deepEqual(employees, T09_FIXTURE.employees);
  assert.equal(result.total.netPayRounded, BigInt(T09_GROUP_TOTALS.totalNet));
});
