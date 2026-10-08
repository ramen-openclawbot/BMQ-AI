// Ghi chú tests (2026-10-09).
//
// One shared builder feeds the draft table, the Excel/PDF export and the
// published payslips. It must reproduce the old adjustment text, add the
// short-shift dates with their credit and the chốt-lương reason, and never
// change any computed amount.
//
// The real T09 rows live in payroll-bn-t09-real.fixture.ts and must not change.

import assert from "node:assert/strict";
import test from "node:test";

import { computePayroll } from "./engine.ts";
import { buildPayrollNotes } from "./notes.ts";
import { buildPayrollExportRows } from "./export.ts";
import { buildPayslips } from "./payslip.ts";
import { resolveRulesConfig } from "./rules-config.ts";
import {
  T09_REAL_EMPLOYEES,
  T09_REAL_ROWS,
} from "./payroll-bn-t09-real.fixture.ts";
import type {
  AdjustmentField,
  AttendanceRow,
  PayrollAdjustment,
  PayrollEmployee,
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

const LABELS: Record<AdjustmentField, string> = {
  work_days: "NC thực tế",
  paid_work_days: "NC tính lương",
  part_time_hours: "Giờ part-time",
  overtime_hours: "Giờ tăng ca",
  exclude_overtime: "Không tính tăng ca",
  exclude_holiday: "Không tính ngày lễ",
  net_pay: "Thực nhận",
};

function realLines(adjustments: PayrollAdjustment[] = []) {
  return computePayroll({
    period: REAL_PERIOD,
    employees: T09_REAL_EMPLOYEES,
    rows: T09_REAL_ROWS,
    adjustments,
  }).employees;
}

test("real T09: An gets only the short-shift note, Trang only the chốt-lương note", () => {
  const lines = realLines();
  const notes = buildPayrollNotes(lines, [], LABELS);
  const an = lines.find((line) => line.employeeCode === "00025")!;
  const trang = lines.find((line) => line.employeeCode === "00011")!;

  assert.deepEqual(an.shortShiftDays, [{ date: "2026-09-02", credit: 0.5 }]);
  assert.deepEqual(notes.get("00025"), ["Ca ngắn: 02/09 (0,5 công)"]);

  assert.deepEqual(trang.shortShiftDays, []);
  assert.deepEqual(notes.get("00011"), ["Nghỉ việc trong kỳ: không tính ngày lễ, tăng ca"]);

  // Employees with no note are absent from the map.
  assert.equal(notes.size, 2);
});

test("an adjustment keeps its text and comes before the short-shift note", () => {
  const adjustments: PayrollAdjustment[] = [
    {
      employeeCode: "00025",
      field: "overtime_hours",
      value: 3,
      reason: "Theo bảng",
      actor: "owner@fixture",
      at: "2026-09-30T17:00:00+07:00",
    },
  ];
  const lines = realLines(adjustments);
  const notes = buildPayrollNotes(lines, adjustments, LABELS);
  assert.deepEqual(notes.get("00025"), ["Giờ tăng ca: Theo bảng", "Ca ngắn: 02/09 (0,5 công)"]);
});

test("a synthetic 3h shift is reported as 0 công", () => {
  const employee: PayrollEmployee = {
    code: "E1",
    name: "Test",
    group: "Bếp bánh",
    employmentType: "official",
    monthlySalary: 7_800_000,
    hourlyRate: null,
    allowance: null,
    overtimeRate: null,
    standardDaysOverride: null,
    startDate: null,
    endDate: null,
    terminated: false,
  };
  const rows: AttendanceRow[] = [
    {
      employeeCode: "E1",
      employeeName: "Test",
      date: "2026-09-03",
      checkIn: "08:00:00",
      checkOut: "11:00:00",
      department: null,
    },
  ];
  const lines = computePayroll({ period: REAL_PERIOD, employees: [employee], rows }).employees;

  assert.deepEqual(lines[0].shortShiftDays, [{ date: "2026-09-03", credit: 0 }]);
  assert.deepEqual(buildPayrollNotes(lines, [], LABELS).get("E1"), ["Ca ngắn: 03/09 (0 công)"]);
});

test("a manual actualWorkDays measure keeps shortShiftDays empty", () => {
  const lines = computePayroll({
    period: REAL_PERIOD,
    employees: T09_REAL_EMPLOYEES,
    rows: T09_REAL_ROWS,
    measures: { "00025": { actualWorkDays: { value: 24, source: "manual" } } },
  }).employees;
  const an = lines.find((line) => line.employeeCode === "00025")!;

  assert.deepEqual(an.shortShiftDays, []);
  assert.equal(buildPayrollNotes(lines, [], LABELS).get("00025"), undefined);
});


test("internal T09 reconciliation reference is hidden without changing audit or amounts", () => {
  const adjustments: PayrollAdjustment[] = ["00025", "00011", "00024"].map((employeeCode) => ({
    employeeCode, field: "overtime_hours", value: 3,
    reason: "Theo bảng lương DIEU CHINH T09", actor: "owner@fixture", at: "2026-09-30T17:00:00+07:00",
  }));
  const before = structuredClone(adjustments);
  const result = computePayroll({ period: REAL_PERIOD, employees: T09_REAL_EMPLOYEES, rows: T09_REAL_ROWS, adjustments });
  const resultBefore = structuredClone(result);
  const notes = buildPayrollNotes(result.employees, adjustments, LABELS);
  assert.deepEqual(notes.get("00025"), ["Ca ngắn: 02/09 (0,5 công)"]);
  assert.deepEqual(notes.get("00011"), ["Nghỉ việc trong kỳ: không tính ngày lễ, tăng ca"]);
  assert.equal(notes.has("00024"), false);
  const withoutNotes = buildPayrollExportRows(REAL_PERIOD, result, new Map());
  const withNotes = buildPayrollExportRows(REAL_PERIOD, result, notes);
  assert.deepEqual(withNotes.map((row) => row.slice(0, 14)), withoutNotes.map((row) => row.slice(0, 14)));
  assert.equal(JSON.stringify(withNotes).includes("DIEU CHINH"), false);
  const payslips = buildPayslips(REAL_PERIOD, T09_REAL_EMPLOYEES, result, notes);
  assert.equal(JSON.stringify(payslips).includes("DIEU CHINH"), false);
  assert.deepEqual(payslips.map(({ note, ...rest }) => rest), buildPayslips(REAL_PERIOD, T09_REAL_EMPLOYEES, result).map(({ note, ...rest }) => rest));
  assert.deepEqual(adjustments, before);
  assert.deepEqual(result, resultBefore);
});

test("meaningful overtime reasons and other adjustment fields remain visible", () => {
  const adjustments: PayrollAdjustment[] = [
    { employeeCode: "00025", field: "overtime_hours", value: 3, reason: "Bổ sung 30 phút tăng ca ngày 05/09", actor: "owner@fixture", at: "2026-09-30" },
    { employeeCode: "00025", field: "net_pay", value: 1000, reason: "Theo bảng lương DIEU CHINH T09", actor: "owner@fixture", at: "2026-09-30" },
  ];
  assert.deepEqual(buildPayrollNotes(realLines(), adjustments, LABELS).get("00025"), [
    "Giờ tăng ca: Bổ sung 30 phút tăng ca ngày 05/09",
    "Thực nhận: Theo bảng lương DIEU CHINH T09",
    "Ca ngắn: 02/09 (0,5 công)",
  ]);
});
