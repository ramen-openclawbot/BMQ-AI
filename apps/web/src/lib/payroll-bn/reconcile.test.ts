import assert from "node:assert/strict";
import test from "node:test";

import { computePayroll } from "./engine.ts";
import { reconcilePayroll, DEFAULT_RECONCILE_FIELDS } from "./reconcile.ts";
import { resolveRulesConfig } from "./rules-config.ts";
import type { AttendanceRow, PayrollEmployee, PayrollPeriod } from "./types.ts";

const period: PayrollPeriod = {
  code: "T-REC",
  name: "test reconcile",
  dateFrom: "2026-08-01",
  dateTo: "2026-08-31",
  standardDaysByGroup: { "Bếp bánh": 26, "Kho BN": 26 },
  defaultStandardDays: 26,
  holidays: [],
  rules: resolveRulesConfig(),
  status: "draft",
};

function official(code: string, name: string, group: PayrollEmployee["group"], monthlySalary: number): PayrollEmployee {
  return {
    code,
    name,
    group,
    employmentType: "official",
    monthlySalary,
    hourlyRate: null,
    allowance: null,
    overtimeRate: null,
    startDate: "2025-01-01",
  };
}

const employees: PayrollEmployee[] = [
  official("E1", "Bếp 1", "Bếp bánh", 10_400_000), // 400.000 / ngày
  official("E2", "Kho 1", "Kho BN", 9_100_000), // 350.000 / ngày
  official("E3", "Bếp 2", "Bếp bánh", 10_400_000),
];

function row(employee: PayrollEmployee, date: string): AttendanceRow {
  return {
    employeeCode: employee.code,
    employeeName: employee.name,
    date,
    checkIn: "08:00:00",
    checkOut: "17:00:00",
    department: null,
  };
}

const rows: AttendanceRow[] = [
  row(employees[0], "2026-08-01"),
  row(employees[0], "2026-08-02"),
  row(employees[1], "2026-08-01"),
  row(employees[1], "2026-08-02"),
];

const FIELDS = DEFAULT_RECONCILE_FIELDS.filter((field) =>
  ["work_days", "day_pay", "net_pay"].includes(field.key),
);

test("reconcile matches exact cells and flags mismatches and missing cells", () => {
  const result = computePayroll({ period, employees, rows });
  const report = reconcilePayroll({
    periodCode: period.code,
    employees: result.employees,
    fields: FIELDS,
    manual: [
      // E1: all three cells correct.
      { employeeCode: "E1", fields: { work_days: 2, day_pay: 800_000, net_pay: 800_000 } },
      // E2: day_pay is wrong, net_pay is absent from the hand-made sheet.
      { employeeCode: "E2", fields: { work_days: 2, day_pay: 999_999 } },
      // E3 has no manual row at all.
    ],
  });

  assert.equal(report.totalCells, 9);
  assert.equal(report.matchedCells, 4);
  assert.equal(report.mismatchedCells, 1);
  assert.equal(report.missingCells, 4);
  assert.equal(report.fullyMatched, false);

  const e1 = report.perEmployee.find((item) => item.employeeCode === "E1")!;
  assert.deepEqual([e1.matched, e1.mismatched, e1.missing], [3, 0, 0]);

  const e2 = report.perEmployee.find((item) => item.employeeCode === "E2")!;
  assert.deepEqual([e2.matched, e2.mismatched, e2.missing], [1, 1, 1]);
  const e2Day = e2.cells.find((cell) => cell.field === "day_pay")!;
  assert.equal(e2Day.status, "mismatch");
  assert.equal(e2Day.engine, "700000");
  assert.equal(e2Day.manual, "999999");
  assert.equal(e2Day.delta, "299999");

  const e3 = report.perEmployee.find((item) => item.employeeCode === "E3")!;
  assert.deepEqual([e3.matched, e3.mismatched, e3.missing], [0, 0, 3]);
  assert.equal(e3.cells.every((cell) => cell.status === "missing_manual"), true);
});

test("reconcile can compare group rows against a hand-made group summary", () => {
  const result = computePayroll({ period, employees, rows });
  const report = reconcilePayroll({
    periodCode: period.code,
    employees: result.employees,
    groups: result.groups,
    fields: FIELDS,
    manual: [
      { employeeCode: "E1", fields: { work_days: 2, day_pay: 800_000, net_pay: 800_000 } },
      { employeeCode: "E2", fields: { work_days: 2, day_pay: 700_000, net_pay: 700_000 } },
      { employeeCode: "E3", fields: { work_days: 0, day_pay: 0, net_pay: 0 } },
      // Group sheet: Bếp bánh = E1 800.000 + E3 0 = 800.000; Kho BN = 700.000.
      { group: "Bếp bánh", fields: { work_days: 2, day_pay: 800_000, net_pay: 800_000 } },
      { group: "Kho BN", fields: { work_days: 2, day_pay: 700_000, net_pay: 700_000 } },
    ],
  });

  assert.equal(report.fullyMatched, true);
  assert.equal(report.mismatchedCells, 0);
  assert.equal(report.missingCells, 0);
  const groupRow = report.perEmployee.find((item) => item.employeeCode === "group:Bếp bánh")!;
  assert.equal(groupRow.group, "Bếp bánh");
  assert.equal(groupRow.cells.every((cell) => cell.status === "match"), true);
});
