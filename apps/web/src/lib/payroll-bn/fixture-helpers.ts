// Small builders shared by the T08 / T09 payroll fixtures.
//
// The fixtures encode the per-employee figures of the approved payroll sheets
// (see the task spec sections 4.1 / 4.2). They never copy the original
// attendance/payroll workbooks into the repository, and the expected manual
// numbers below are written independently of the engine under test.

import type { ManualPayrollRow } from "./reconcile.ts";
import type {
  AttendanceRow,
  PayrollAdjustment,
  PayrollEmployee,
  PayrollEmployeeMeasures,
  PayrollPeriod,
} from "./types.ts";

export interface PayrollBnFixture {
  code: string;
  status: "standard" | "provisional";
  source: string;
  period: PayrollPeriod;
  employees: PayrollEmployee[];
  /** Direct payroll-sheet figures (engine mode a). */
  measures: Record<string, PayrollEmployeeMeasures>;
  /** Synthetic attendance rows (engine mode b / reconciliation tests). */
  rows: AttendanceRow[];
  adjustments: PayrollAdjustment[];
  manual: ManualPayrollRow[];
  reconcileFields: string[];
}

export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

/** Collect `count` dates from `start`, skipping any date in `skip`. */
export function collectDates(start: string, count: number, skip: string[] = []): string[] {
  const out: string[] = [];
  let cursor = start;
  while (out.length < count) {
    if (!skip.includes(cursor)) out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

export function attendanceRows(
  employee: PayrollEmployee,
  dates: string[],
  checkIn: string,
  checkOut: string,
  department: string | null = null,
): AttendanceRow[] {
  return dates.map((date) => ({
    employeeCode: employee.code,
    employeeName: employee.name,
    date,
    checkIn,
    checkOut,
    department,
  }));
}

/** Direct payroll-sheet figure with its provenance. */
export function manual(value: number): { value: number; source: "manual" } {
  return { value, source: "manual" };
}

/** Attendance-derived figure, resolved from the parsed rows by the engine. */
export function fromAttendance(value = 0): { value: number; source: "attendance" } {
  return { value, source: "attendance" };
}

/** Manual expected row; the fixture only reconciles the listed fields. */
export function manualRow(
  employee: PayrollEmployee,
  fields: Record<string, number>,
): ManualPayrollRow {
  return {
    employeeCode: employee.code,
    employeeName: employee.name,
    group: employee.group,
    fields: { ...fields },
  };
}

export function adjustment(
  employeeCode: string,
  field: PayrollAdjustment["field"],
  value: number | string | null,
  reason: string,
  actor = "owner@fixture",
  at = "2026-09-30T17:00:00+07:00",
): PayrollAdjustment {
  return { employeeCode, field, value, reason, actor, at };
}
