import assert from "node:assert/strict";
import test from "node:test";

import { computePayroll } from "./engine.ts";
import { buildPayrollExportRows } from "./export.ts";
import { buildPayrollNotes } from "./notes.ts";
import { rational, rationalFromNumber, RATIONAL_ZERO } from "./money.ts";
import { T09_FIXTURE, T09_GROUP_TOTALS } from "./payroll-bn-t09.fixture.ts";
import {
  DELIVERY_EMPLOYEES,
  DELIVERY_T09_EXPECTED,
  DELIVERY_T09_EXTRAS,
  DELIVERY_T09_PERIOD,
  DELIVERY_T09_UNITS,
  DELIVERY_T10_EXPECTED,
  DELIVERY_T10_EXTRAS,
  DELIVERY_T10_PERIOD,
  DELIVERY_T10_UNITS,
} from "./payroll-bn-delivery.fixture.ts";
import type {
  AdjustmentField,
  PayrollAdjustment,
  PayrollEmployee,
  PayrollEmployeeLine,
} from "./types.ts";

function lineFor(lines: readonly PayrollEmployeeLine[], code: string): PayrollEmployeeLine {
  const line = lines.find((item) => item.employeeCode === code);
  assert.ok(line, `missing line for ${code}`);
  return line;
}

test("T09 delivery payroll matches the owner's expected net amounts", () => {
  const result = computePayroll({
    period: DELIVERY_T09_PERIOD,
    employees: DELIVERY_EMPLOYEES,
    deliveryUnits: DELIVERY_T09_UNITS,
    deliveryExtras: DELIVERY_T09_EXTRAS,
  });

  for (const [code, expected] of Object.entries(DELIVERY_T09_EXPECTED)) {
    assert.equal(Number(lineFor(result.employees, code).netPayRounded), expected, code);
  }
  assert.equal(Object.keys(DELIVERY_T09_EXPECTED).length, 4);
});

test("T10 delivery payroll uses the 31 calendar days of October", () => {
  const result = computePayroll({
    period: DELIVERY_T10_PERIOD,
    employees: DELIVERY_EMPLOYEES,
    deliveryUnits: DELIVERY_T10_UNITS,
    deliveryExtras: DELIVERY_T10_EXTRAS,
  });

  for (const [code, expected] of Object.entries(DELIVERY_T10_EXPECTED)) {
    assert.equal(Number(lineFor(result.employees, code).netPayRounded), expected, code);
  }
});

test("a delivery line carries units, unit rate, fixed pay, unit pay, extras and gross", () => {
  const result = computePayroll({
    period: DELIVERY_T09_PERIOD,
    employees: DELIVERY_EMPLOYEES,
    deliveryUnits: DELIVERY_T09_UNITS,
    deliveryExtras: DELIVERY_T09_EXTRAS,
  });

  const duyen = lineFor(result.employees, "DUYEN");
  assert.deepEqual(duyen.deliveryUnits, rational(26));
  assert.deepEqual(duyen.deliveryUnitRate, rationalFromNumber(2_000_000));
  assert.deepEqual(duyen.fixedPay, rationalFromNumber(2_000_000));
  assert.deepEqual(duyen.deliveryUnitPay, rational(5_200_000, 3));
  assert.deepEqual(duyen.deliveryExtras, RATIONAL_ZERO);
  assert.deepEqual(duyen.grossPay, rational(11_200_000, 3));
  assert.equal(Number(duyen.netPayRounded), 3_733_000);
  assert.ok(duyen.flags.includes("delivery"));
  // R1–R9 fields stay empty on a delivery line.
  assert.deepEqual(duyen.standardDays, RATIONAL_ZERO);
  assert.deepEqual(duyen.actualWorkDays, RATIONAL_ZERO);
  assert.deepEqual(duyen.workDays, RATIONAL_ZERO);
  assert.deepEqual(duyen.holidayPayDays, RATIONAL_ZERO);
  assert.deepEqual(duyen.overtimePay, RATIONAL_ZERO);

  const chat = lineFor(result.employees, "CHAT");
  assert.deepEqual(chat.deliveryUnits, rational(85, 4));
  assert.deepEqual(chat.deliveryUnitPay, rational(17_000_000, 6));
  assert.deepEqual(chat.deliveryExtras, rationalFromNumber(990_000));
  assert.deepEqual(chat.grossPay, rational(82_940_000, 6));
  assert.equal(Number(chat.netPayRounded), 13_823_000);
});

test("a null delivery unit base pays only the fixed salary", () => {
  const result = computePayroll({
    period: DELIVERY_T09_PERIOD,
    employees: DELIVERY_EMPLOYEES,
    deliveryUnits: { ...DELIVERY_T09_UNITS, BINH: 12 },
  });
  const binh = lineFor(result.employees, "BINH");
  assert.deepEqual(binh.deliveryUnitRate, RATIONAL_ZERO);
  assert.deepEqual(binh.deliveryUnitPay, RATIONAL_ZERO);
  assert.deepEqual(binh.fixedPay, rationalFromNumber(13_400_000));
  assert.equal(Number(binh.netPayRounded), 13_400_000);
});

test("delivery skips R1–R9: standard days, holidays and attendance cannot change it", () => {
  const periodWithHolidays = {
    ...DELIVERY_T09_PERIOD,
    standardDaysByGroup: { "Giao hàng": 0 },
    holidays: ["2026-09-01", "2026-09-02"],
  };
  const withAttendance = computePayroll({
    period: periodWithHolidays,
    employees: DELIVERY_EMPLOYEES,
    rows: [
      {
        employeeCode: "DUYEN",
        employeeName: "Duyên",
        date: "2026-09-01",
        checkIn: "08:00:00",
        checkOut: "17:00:00",
        department: "Giao hàng",
      },
    ],
    deliveryUnits: DELIVERY_T09_UNITS,
    deliveryExtras: DELIVERY_T09_EXTRAS,
  });
  const duyen = lineFor(withAttendance.employees, "DUYEN");
  assert.equal(Number(duyen.netPayRounded), 3_733_000);
});

test("the old T09 group result is unchanged at 96.681.000", () => {
  const result = computePayroll({
    period: T09_FIXTURE.period,
    employees: T09_FIXTURE.employees,
    measures: T09_FIXTURE.measures,
    adjustments: T09_FIXTURE.adjustments,
  });
  assert.equal(Number(result.total.netPayRounded), T09_GROUP_TOTALS.totalNet);
  assert.equal(Number(result.total.netPayRounded), 96_681_000);
  for (const line of result.employees) {
    assert.deepEqual(line.deliveryUnits, RATIONAL_ZERO, line.employeeCode);
    assert.deepEqual(line.deliveryUnitPay, RATIONAL_ZERO, line.employeeCode);
    assert.deepEqual(line.fixedPay, RATIONAL_ZERO, line.employeeCode);
    assert.deepEqual(line.deliveryExtras, RATIONAL_ZERO, line.employeeCode);
  }
});


test("delivery totals attached to the period employee row are used by default", () => {
  const employees: PayrollEmployee[] = DELIVERY_EMPLOYEES.map((employee) => ({
    ...employee,
    deliveryUnits: employee.code === "DUYEN"
      ? 26
      : employee.code === "CHAT"
        ? 21.25
        : 0,
    deliveryExtras: employee.code === "CHAT" ? 990_000 : 0,
  }));
  const result = computePayroll({ period: DELIVERY_T09_PERIOD, employees });
  assert.equal(Number(lineFor(result.employees, "DUYEN").netPayRounded), 3_733_000);
  assert.equal(Number(lineFor(result.employees, "CHAT").netPayRounded), 13_823_000);
});

test("a delivery line still pays allowance and a confirmed mission bonus", () => {
  const employees: PayrollEmployee[] = DELIVERY_EMPLOYEES.map((employee) =>
    employee.code === "DUYEN"
      ? { ...employee, allowance: 100_000, missionBonus: 300_000 }
      : employee
  );
  const result = computePayroll({
    period: DELIVERY_T09_PERIOD,
    employees,
    deliveryUnits: DELIVERY_T09_UNITS,
  });
  const duyen = lineFor(result.employees, "DUYEN");
  assert.deepEqual(duyen.allowance, rationalFromNumber(100_000));
  assert.deepEqual(duyen.missionBonus, rationalFromNumber(300_000));
  assert.deepEqual(duyen.grossPay, rational(12_400_000, 3));
  assert.equal(Number(duyen.netPayRounded), 4_133_000);
});

test("a driver who joins mid-month has the fixed salary prorated", () => {
  const employees: PayrollEmployee[] = DELIVERY_EMPLOYEES.map((employee) =>
    employee.code === "DUYEN"
      ? { ...employee, startDate: "2026-09-16" }
      : employee
  );
  const result = computePayroll({
    period: DELIVERY_T09_PERIOD,
    employees,
    deliveryUnits: { ...DELIVERY_T09_UNITS, DUYEN: 0 },
  });
  const duyen = lineFor(result.employees, "DUYEN");
  // 16..30/09 = 15 of 30 calendar days → 2.000.000 / 2.
  assert.deepEqual(duyen.fixedPay, rationalFromNumber(1_000_000));
  assert.equal(Number(duyen.netPayRounded), 1_000_000);
  assert.ok(duyen.flags.includes("delivery_prorated"));
});

test("a delivery line honours net_pay and surfaces inapplicable adjustments", () => {
  const adjustments: PayrollAdjustment[] = [
    {
      employeeCode: "DUYEN",
      field: "work_days",
      value: 20,
      reason: "not applicable to delivery",
      actor: "owner",
      at: "2026-09-30T00:00:00.000Z",
    },
    {
      employeeCode: "DUYEN",
      field: "net_pay",
      value: 1_000_000,
      reason: "manual net",
      actor: "owner",
      at: "2026-09-30T00:00:00.000Z",
    },
  ];
  const result = computePayroll({
    period: DELIVERY_T09_PERIOD,
    employees: DELIVERY_EMPLOYEES,
    deliveryUnits: DELIVERY_T09_UNITS,
    adjustments,
  });
  const duyen = lineFor(result.employees, "DUYEN");
  assert.equal(Number(duyen.netPayRounded), 1_000_000);
  assert.ok(duyen.flags.includes("net_pay_adjusted"));
  assert.ok(result.warnings.includes("delivery_adjustment_ignored:DUYEN:work_days"));
});

test("delivery inputs on a non-delivery employee are surfaced, not silently paid", () => {
  const result = computePayroll({
    period: T09_FIXTURE.period,
    employees: T09_FIXTURE.employees,
    measures: T09_FIXTURE.measures,
    adjustments: T09_FIXTURE.adjustments,
    deliveryExtras: { BN02: 100_000 },
  });
  assert.ok(result.warnings.includes("delivery_input_without_delivery:BN02"));
  assert.ok(lineFor(result.employees, "BN02").flags.includes("delivery_input_ignored"));
  assert.equal(Number(lineFor(result.employees, "BN02").netPayRounded), 9_600_000);
});


test("the Giao hàng export subtotal uses the same columns as its employee rows", () => {
  const result = computePayroll({
    period: DELIVERY_T09_PERIOD,
    employees: DELIVERY_EMPLOYEES,
    deliveryUnits: DELIVERY_T09_UNITS,
    deliveryExtras: DELIVERY_T09_EXTRAS,
  });
  const rows = buildPayrollExportRows(DELIVERY_T09_PERIOD, result, new Map());
  const employees = rows.filter((row) =>
    ["DUYEN", "TUAN", "CHAT", "BINH"].includes(String(row[0]))
  );
  const group = rows.find((row) => row[1] === "Nhóm Giao hàng");
  assert.ok(group);
  for (const column of [4, 6, 9, 11, 12, 13, 14]) {
    assert.equal(
      group![column],
      employees.reduce((total, row) => total + Number(row[column] ?? 0), 0),
      `column ${column}`,
    );
  }
  const total = rows.at(-1)!;
  assert.equal(total[1], "Tổng cộng");
  assert.equal(total[14], 3_733_000 + 3_667_000 + 13_823_000 + 13_400_000);
});


test("missing delivery base/salary and unmatched codes are surfaced in warnings", () => {
  const employees: PayrollEmployee[] = DELIVERY_EMPLOYEES.map((employee) =>
    employee.code === "TUAN" ? { ...employee, monthlySalary: null } : employee
  );
  const result = computePayroll({
    period: DELIVERY_T09_PERIOD,
    employees,
    deliveryUnits: { ...DELIVERY_T09_UNITS, GHOST: 5 },
  });
  assert.ok(result.warnings.includes("delivery_unit_base_missing:BINH"));
  assert.ok(result.warnings.includes("delivery_salary_missing:TUAN"));
  assert.ok(result.warnings.includes("delivery_units_without_employee:GHOST"));
});


test("a delivery adjustment that cannot apply is called out in the payroll note", () => {
  const adjustments: PayrollAdjustment[] = [{
    employeeCode: "DUYEN",
    field: "work_days",
    value: 20,
    reason: "manual days",
    actor: "owner",
    at: "2026-09-30T00:00:00.000Z",
  }];
  const result = computePayroll({
    period: DELIVERY_T09_PERIOD,
    employees: DELIVERY_EMPLOYEES,
    deliveryUnits: DELIVERY_T09_UNITS,
    adjustments,
  });
  const labels: Record<AdjustmentField, string> = {
    work_days: "NC thực tế",
    paid_work_days: "NC tính lương",
    part_time_hours: "Giờ part-time",
    overtime_hours: "Giờ tăng ca",
    exclude_overtime: "Không tính tăng ca",
    exclude_holiday: "Không tính ngày lễ",
    net_pay: "Thực nhận",
  };
  const notes = buildPayrollNotes(result.employees, adjustments, labels);
  assert.match(notes.get("DUYEN")?.join("; ") ?? "", /Không áp dụng cho Giao hàng/);
});

test("a driver starting after the period is not paid and gets no payslip (T11 stays on Lương lẻ)", async () => {
  const { buildPayslips } = await import("./payslip.ts");
  const employees: PayrollEmployee[] = DELIVERY_EMPLOYEES.map((employee) =>
    employee.code === "DUYEN" ? { ...employee, startDate: "2026-10-01" } : employee
  );
  const result = computePayroll({
    period: DELIVERY_T09_PERIOD,
    employees,
    deliveryUnits: DELIVERY_T09_UNITS,
    deliveryExtras: { DUYEN: 500_000 },
  });
  const duyen = lineFor(result.employees, "DUYEN");
  assert.ok(duyen.flags.includes("not_in_period"));
  assert.equal(Number(duyen.netPayRounded), 0);
  assert.deepEqual(duyen.deliveryUnitPay, RATIONAL_ZERO);
  assert.equal(Number(lineFor(result.employees, "TUAN").netPayRounded), 3_667_000);
  const payslips = buildPayslips(DELIVERY_T09_PERIOD, employees, result);
  assert.equal(payslips.some((slip) => slip.employee_code === "DUYEN"), false);
  assert.equal(payslips.some((slip) => slip.employee_code === "TUAN"), true);
});
