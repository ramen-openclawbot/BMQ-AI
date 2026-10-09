// Adapter: payroll AttendanceRow (+ anomalies.ts flags) → MissionAttendanceRow.
//
// The payroll parser keeps the machine columns the engine ignores (Ca / Trễ /
// Sớm); anomalies.ts already knows the reviewable problems. This module only
// merges the two — it never invents a new flag and never edits a row.
//
// Only the four mission flags are read; unknown_employee, missing_attendance and
// holiday_attendance are review concerns outside a mission's judgment.

import type { Anomaly, AnomalyCode } from "../payroll-bn/anomalies.ts";
import type { AttendanceRow } from "../payroll-bn/types.ts";
import type { MissionAttendanceFlag, MissionAttendanceRow } from "./types.ts";

const FLAG_BY_ANOMALY: Partial<Record<AnomalyCode, MissionAttendanceFlag>> = {
  missing_check_in: "missing_check_in",
  missing_check_out: "missing_check_out",
  no_machine_data: "no_machine_data",
  duplicate_time: "duplicate_time",
};

function keyOf(employeeCode: string, date: string | null): string {
  return `${employeeCode}|${date ?? ""}`;
}

/**
 * Build the mission attendance rows of one period. Anomalies without a date (or
 * of an unmapped code) are ignored; a row with no anomaly gets an empty flags
 * list.
 */
export function toMissionAttendanceRows(
  rows: readonly AttendanceRow[],
  anomalies: readonly Anomaly[],
): MissionAttendanceRow[] {
  const flagsByKey = new Map<string, MissionAttendanceFlag[]>();
  for (const anomaly of anomalies) {
    const flag = FLAG_BY_ANOMALY[anomaly.code];
    if (!flag || !anomaly.date) continue;
    const key = keyOf(anomaly.employeeCode, anomaly.date);
    const list = flagsByKey.get(key) ?? [];
    if (!list.includes(flag)) list.push(flag);
    flagsByKey.set(key, list);
  }

  return rows.map((row) => ({
    employeeCode: row.employeeCode,
    employeeName: row.employeeName,
    date: row.date,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    shift: row.shift ?? null,
    lateMinutes: row.lateMinutes ?? null,
    earlyMinutes: row.earlyMinutes ?? null,
    flags: flagsByKey.get(keyOf(row.employeeCode, row.date)) ?? [],
  }));
}
