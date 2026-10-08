// Owner rules confirmed on 2026-10-09:
//   * ca ngắn — a day with both punches is worth 1 công from 6h, 0,5 from 4h
//     and 0 below 4h; a day with a single punch keeps the old full credit.
//   * chốt lương — an official employee who left during the period gets no paid
//     holiday and no paid overtime.
//
// The real T09 rows live in payroll-bn-t09-real.fixture.ts and must not change.

import assert from "node:assert/strict";
import test from "node:test";

import { aggregateAttendance, computePayroll } from "./engine.ts";
import { rational, rationalFromNumber } from "./money.ts";
import { resolveRulesConfig, type RulesConfig } from "./rules-config.ts";
import {
  T09_REAL_EMPLOYEES,
  T09_REAL_EXPECTED,
  T09_REAL_ROWS,
} from "./payroll-bn-t09-real.fixture.ts";
import type {
  AttendanceRow,
  PayrollEmployee,
  PayrollEmployeeLine,
  PayrollPeriod,
} from "./types.ts";

const REAL_PERIOD: PayrollPeriod = {
  code: "T09.2026",
  name: "Kỳ lương tháng 09/2026 — Bếp BN (real rows)",
  dateFrom: "2026-09-01",
  dateTo: "2026-09-30",
  standardDaysByGroup: { "Bếp bánh": 26, "Kho BN": 26, "Văn phòng": 22 },
  defaultStandardDays: 26,
  holidays: ["2026-09-01", "2026-09-02"],
  rules: resolveRulesConfig(),
  status: "draft",
};

const SYNTHETIC_EMPLOYEE: PayrollEmployee = {
  code: "E1",
  name: "Test",
  group: "Bếp bánh",
  employmentType: "official",
  monthlySalary: 7_800_000,
  hourlyRate: null,
  allowance: null,
  overtimeRate: null,
  startDate: "2025-01-01",
  endDate: null,
  terminated: false,
};

function syntheticPeriod(overrides: Partial<PayrollPeriod> = {}): PayrollPeriod {
  return {
    code: "T-SYN",
    name: "synthetic",
    dateFrom: "2026-09-01",
    dateTo: "2026-09-30",
    standardDaysByGroup: { "Bếp bánh": 26 },
    defaultStandardDays: 26,
    holidays: [],
    rules: resolveRulesConfig(),
    status: "draft",
    ...overrides,
  };
}

function rowAt(date: string, checkIn: string | null, checkOut: string | null): AttendanceRow {
  return { employeeCode: "E1", employeeName: "Test", date, checkIn, checkOut, department: null };
}

function dayLine(checkIn: string | null, checkOut: string | null, period = syntheticPeriod()): PayrollEmployeeLine {
  return computePayroll({
    period,
    employees: [SYNTHETIC_EMPLOYEE],
    rows: [rowAt("2026-09-03", checkIn, checkOut)],
  }).employees[0];
}

test("real T09 attendance: short shift + chốt lương match the owner figures", () => {
  const result = computePayroll({
    period: REAL_PERIOD,
    employees: T09_REAL_EMPLOYEES,
    rows: T09_REAL_ROWS,
  });
  const byCode = new Map(result.employees.map((line) => [line.employeeCode, line]));

  const an = byCode.get("00025")!;
  const anExpected = T09_REAL_EXPECTED["00025"];
  assert.deepEqual(an.actualWorkDays, rationalFromNumber(anExpected.actualWorkDays));
  assert.deepEqual(an.holidayPayDays, rationalFromNumber(anExpected.holidayPayDays));
  assert.deepEqual(an.workDays, rationalFromNumber(anExpected.workDays));
  assert.deepEqual(an.dayPay, rationalFromNumber(anExpected.dayPay));
  assert.deepEqual(an.overtimePay, rationalFromNumber(anExpected.overtimePay));
  assert.equal(an.netPayRounded, BigInt(anExpected.netPay));
  // 02/09 is a paid holiday worked only 5h → half a công on top of 24 full days.
  assert.ok(an.flags.includes("short_shift"));

  const trang = byCode.get("00011")!;
  const trangExpected = T09_REAL_EXPECTED["00011"];
  assert.deepEqual(trang.actualWorkDays, rationalFromNumber(trangExpected.actualWorkDays));
  assert.deepEqual(trang.holidayPayDays, rationalFromNumber(trangExpected.holidayPayDays));
  assert.deepEqual(trang.workDays, rationalFromNumber(trangExpected.workDays));
  assert.deepEqual(trang.overtimePay, rationalFromNumber(trangExpected.overtimePay));
  assert.equal(trang.netPayRounded, BigInt(trangExpected.netPay));
  assert.ok(trang.flags.includes("left_in_period"));
});

test("aggregateAttendance exposes exact short-shift credits and affected dates", () => {
  const rows: AttendanceRow[] = [
    rowAt("2026-09-03", "08:00:00", "14:00:00"), // 6h00 → 1
    rowAt("2026-09-04", "08:00:00", "12:00:00"), // 4h00 → 0,5
    rowAt("2026-09-05", "08:00:00", "11:00:00"), // 3h00 → 0
  ];
  const aggregate = aggregateAttendance(rows, syntheticPeriod());
  assert.deepEqual(aggregate.nonHolidayDayCredit, rational(3, 2));
  assert.deepEqual(aggregate.holidayDayCredit, rational(0));
  assert.deepEqual(aggregate.shortShiftDates, ["2026-09-04", "2026-09-05"]);
  // The raw date lists and worked seconds stay exactly as before.
  assert.deepEqual(aggregate.nonHolidayDates, ["2026-09-03", "2026-09-04", "2026-09-05"]);
});

test("short shift: 3h59 → 0, 4h00 → 0,5, 5h59 → 0,5, 6h00 → 1, one punch → 1", () => {
  assert.deepEqual(dayLine("08:00:00", "11:59:00").actualWorkDays, rational(0));
  assert.deepEqual(dayLine("08:00:00", "12:00:00").actualWorkDays, rational(1, 2));
  assert.deepEqual(dayLine("08:00:00", "13:59:00").actualWorkDays, rational(1, 2));
  assert.deepEqual(dayLine("08:00:00", "14:00:00").actualWorkDays, rational(1));
  assert.deepEqual(dayLine("08:00:00", "15:59:00").actualWorkDays, rational(1));
  assert.deepEqual(dayLine("08:00:00", null).actualWorkDays, rational(1));
  assert.ok(dayLine("08:00:00", "11:59:00").flags.includes("short_shift"));
  assert.ok(!dayLine("08:00:00", "14:00:00").flags.includes("short_shift"));
});

test("short shift on a paid holiday: 0,5 worked day plus the paid holiday", () => {
  const line = dayLine("08:00:00", "12:00:00", syntheticPeriod({ holidays: ["2026-09-03"] }));
  assert.deepEqual(line.actualWorkDays, rational(1, 2));
  assert.deepEqual(line.holidayPayDays, rational(1));
  assert.deepEqual(line.workDays, rational(3, 2));
  assert.ok(line.flags.includes("short_shift"));
});

test("shortShift disabled reproduces the old date count", () => {
  const dates = ["2026-09-03", "2026-09-04", "2026-09-05"];
  const rows = dates.map((date) => rowAt(date, "08:00:00", "11:00:00")); // 3h each

  const enabled = computePayroll({
    period: syntheticPeriod(),
    employees: [SYNTHETIC_EMPLOYEE],
    rows,
  }).employees[0];
  assert.deepEqual(enabled.actualWorkDays, rational(0));
  assert.ok(enabled.flags.includes("short_shift"));

  const rules: RulesConfig = resolveRulesConfig({
    shortShift: { enabled: false, fullDayMinHours: 6, halfDayMinHours: 4 },
  });
  const disabled = computePayroll({
    period: syntheticPeriod({ rules }),
    employees: [SYNTHETIC_EMPLOYEE],
    rows,
  }).employees[0];
  assert.deepEqual(disabled.actualWorkDays, rational(3));
  assert.ok(!disabled.flags.includes("short_shift"));
});

test("endDate equal to the period end is not 'left_in_period'", () => {
  const full = computePayroll({
    period: syntheticPeriod({ holidays: ["2026-09-01", "2026-09-02"] }),
    employees: [{ ...SYNTHETIC_EMPLOYEE, endDate: "2026-09-30" }],
    measures: { E1: { actualWorkDays: { value: 20, source: "manual" } } },
  }).employees[0];
  assert.equal(full.flags.includes("left_in_period"), false);
  assert.deepEqual(full.holidayPayDays, rational(2));
  assert.deepEqual(full.workDays, rational(22));

  const left = computePayroll({
    period: syntheticPeriod({ holidays: ["2026-09-01", "2026-09-02"] }),
    employees: [{ ...SYNTHETIC_EMPLOYEE, endDate: "2026-09-29" }],
    measures: { E1: { actualWorkDays: { value: 20, source: "manual" } } },
  }).employees[0];
  assert.ok(left.flags.includes("left_in_period"));
  assert.deepEqual(left.holidayPayDays, rational(0));
  assert.deepEqual(left.workDays, rational(20));
});

test("a terminated employee keeps the empty row behaviour", () => {
  const line = computePayroll({
    period: syntheticPeriod({ holidays: ["2026-09-01", "2026-09-02"] }),
    employees: [{ ...SYNTHETIC_EMPLOYEE, endDate: "2026-09-15", terminated: true }],
  }).employees[0];
  assert.ok(line.flags.includes("terminated"));
  assert.equal(line.flags.includes("left_in_period"), false);
  assert.deepEqual(line.workDays, rational(0));
  assert.deepEqual(line.grossPay, rational(0));
  assert.equal(line.netPayRounded, 0n);
});
