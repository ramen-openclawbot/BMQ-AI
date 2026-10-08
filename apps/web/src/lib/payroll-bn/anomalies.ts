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
  const holidaySet = new Set(period.holidays);
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
    } else if (!row.checkIn && !row.checkOut) {
      anomalies.push(
        anomaly(
          "no_machine_data",
          row,
          `${row.employeeCode} ${row.date}: có dòng chấm công nhưng máy không có số liệu giờ.`,
        ),
      );
    }

    if (holidaySet.has(row.date)) {
      anomalies.push(
        anomaly("holiday_attendance", row, `${row.employeeCode} ${row.date}: có chấm công ngày lễ.`),
      );
    }
  }

  // Same in/out pair on the same day for two different employees.
  const bySlot = new Map<string, AttendanceRow[]>();
  for (const row of rows) {
    if (!row.checkIn || !row.checkOut) continue;
    const key = `${row.date}|${row.checkIn}|${row.checkOut}`;
    const list = bySlot.get(key) ?? [];
    list.push(row);
    bySlot.set(key, list);
  }
  for (const [, list] of bySlot) {
    const codes = Array.from(new Set(list.map((row) => row.employeeCode))).sort();
    if (codes.length < 2) continue;
    for (const row of list) {
      anomalies.push(
        anomaly(
          "duplicate_time",
          row,
          `${row.employeeCode} ${row.date}: trùng giờ vào/ra với ${codes.filter((code) => code !== row.employeeCode).join(", ")}.`,
          codes,
        ),
      );
    }
  }

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
