// Attendance anomalies for the Bếp BN payroll.
//
// This module only flags — it never edits, fills in or drops data. Every flag
// is returned with the employee/date context so a human can review it before
// the payroll is locked.

import type { AttendanceRow, PayrollEmployee, PayrollPeriod } from "./types.ts";

export type AnomalyCode =
  | "missing_check_out"
  | "missing_check_in"
  | "no_machine_data"
  | "duplicate_time"
  | "unknown_employee"
  | "missing_attendance"
  | "holiday_attendance";

export type AnomalySeverity = "warning" | "error";

export interface Anomaly {
  code: AnomalyCode;
  severity: AnomalySeverity;
  employeeCode: string;
  employeeName: string | null;
  date: string | null;
  detail: string;
  relatedEmployeeCodes?: string[];
}

export interface AnomalyInput {
  period: PayrollPeriod;
  employees: readonly PayrollEmployee[];
  rows: readonly AttendanceRow[];
}

function severityFor(code: AnomalyCode): AnomalySeverity {
  switch (code) {
    case "unknown_employee":
    case "duplicate_time":
      return "error";
    default:
      return "warning";
  }
}

function anomaly(
  code: AnomalyCode,
  row: { employeeCode: string; employeeName?: string | null; date?: string | null },
  detail: string,
  relatedEmployeeCodes?: string[],
): Anomaly {
  return {
    code,
    severity: severityFor(code),
    employeeCode: row.employeeCode,
    employeeName: row.employeeName ?? null,
    date: row.date ?? null,
    detail,
    ...(relatedEmployeeCodes ? { relatedEmployeeCodes } : {}),
  };
}

/** Detect anomalies without mutating the parsed rows or the employee catalog. */
export function detectAnomalies(input: AnomalyInput): Anomaly[] {
  const { period, employees, rows } = input;
  const anomalies: Anomaly[] = [];

  const knownEmployees = new Map(employees.map((employee) => [employee.code, employee]));
  const attendanceKeys = new Set<string>();

  for (const row of rows) {
    attendanceKeys.add(`${row.employeeCode}|${row.date}`);

    if (!knownEmployees.has(row.employeeCode)) {
      anomalies.push(
        anomaly(
          "unknown_employee",
          row,
          `Mã ${row.employeeCode} không có trong danh mục nhân viên kỳ ${period.code}.`,
        ),
      );
    }

    if (row.checkIn && !row.checkOut) {
      anomalies.push(
        anomaly("missing_check_out", row, `${row.employeeCode} ${row.date}: có giờ vào, thiếu giờ ra.`),
      );
    } else if (!row.checkIn && row.checkOut) {
      anomalies.push(
        anomaly("missing_check_in", row, `${row.employeeCode} ${row.date}: có giờ ra, thiếu giờ vào.`),
      );
    }
    // A row without any time is a day off in the machine export, not an issue.
    // ("no_machine_data" needs the machine's Công/Tổng giờ columns, which the
    // parser deliberately ignores, so it is not raised from in/out times.)

  }

  // Shared shift times across employees are normal. Holiday work is handled
  // by payroll rules, not review flags. Same-employee/day duplicates remain
  // protected by the parser/import validation and database constraints.

  // Catalog codes without any attendance row.
  for (const employee of employees) {
    const hasRow = rows.some((row) => row.employeeCode === employee.code);
    if (!hasRow) {
      anomalies.push(
        anomaly(
          "missing_attendance",
          { employeeCode: employee.code, employeeName: employee.name, date: null },
          `${employee.code} không có chấm công trong kỳ ${period.code}.`,
        ),
      );
    }
  }

  return anomalies;
}

/** Convenience counters used by the review surface. */
export function summarizeAnomalies(anomalies: readonly Anomaly[]): Record<AnomalyCode, number> {
  const summary: Record<AnomalyCode, number> = {
    missing_check_out: 0,
    missing_check_in: 0,
    no_machine_data: 0,
    duplicate_time: 0,
    unknown_employee: 0,
    missing_attendance: 0,
    holiday_attendance: 0,
  };
  for (const item of anomalies) summary[item.code] += 1;
  return summary;
}
