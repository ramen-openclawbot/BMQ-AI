// Catalogue suggestions for a Bếp BN payroll period.
//
// When a new attendance file is imported, some employee codes are not yet in
// the period catalogue. This module proposes which ones to add (reusing the
// previous period's row when the code was already known) and which employees
// on the catalogue have no attendance at all. It never deletes anyone: a
// maybeLeft suggestion only carries an end date for a human to confirm.
//
// Pure and dependency-free so it can be unit-tested with node:test.

import type { AttendanceRow, PayrollEmployee, PayrollGroup, PayrollPeriod } from "./types.ts";

export type CatalogSuggestionSource = "previous_period" | "attendance_file";

export type CatalogMissingField = "group" | "salary" | "hourly_rate";

export interface CatalogSuggestion {
  code: string;
  employee: PayrollEmployee;
  source: CatalogSuggestionSource;
  /** What a human still has to fill in before the payroll is exact. */
  missing: CatalogMissingField[];
  /** Distinct days with a check-in or check-out for this code. */
  attendanceDays: number;
}

export interface CatalogSyncInput {
  period: PayrollPeriod;
  rows: readonly AttendanceRow[];
  employees: readonly PayrollEmployee[];
  previousEmployees: readonly PayrollEmployee[];
}

export interface CatalogSyncResult {
  add: CatalogSuggestion[];
  maybeLeft: CatalogSuggestion[];
}

const PAYROLL_GROUPS: readonly string[] = ["Văn phòng", "Bếp bánh", "Kho BN"];

function normalizeGroup(department: string | null | undefined): PayrollGroup | null {
  if (typeof department !== "string") return null;
  const trimmed = department.trim();
  return (PAYROLL_GROUPS as readonly string[]).includes(trimmed) ? (trimmed as PayrollGroup) : null;
}

function hasTime(row: AttendanceRow): boolean {
  return Boolean(row.checkIn) || Boolean(row.checkOut);
}

function dayBeforeIso(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function missingFields(employee: PayrollEmployee): CatalogMissingField[] {
  const missing: CatalogMissingField[] = [];
  if (employee.monthlySalary === null || employee.monthlySalary === undefined) {
    if (employee.employmentType === "official") missing.push("salary");
  }
  if (employee.hourlyRate === null || employee.hourlyRate === undefined) {
    if (employee.employmentType === "part_time") missing.push("hourly_rate");
  }
  return missing;
}

/**
 * Suggest catalogue additions and possible leavers for one period.
 *
 * Rules:
 *  * add — every distinct code in `rows` that is missing from `employees`.
 *    A code known in `previousEmployees` reuses that row (endDate dropped).
 *    Otherwise the name/department/start date come from the attendance file.
 *  * maybeLeft — active catalogue employees (no endDate, not terminated) with
 *    no attendance day; the suggestion only sets endDate to the day before the
 *    period starts. No one is ever suggested for deletion.
 *  * No rows at all means both lists are empty.
 */
export function suggestCatalogSync(input: CatalogSyncInput): CatalogSyncResult {
  const { period, rows, employees, previousEmployees } = input;
  if (rows.length === 0) return { add: [], maybeLeft: [] };

  const daysByCode = new Map<string, Set<string>>();
  const rowsByCode = new Map<string, AttendanceRow[]>();
  for (const row of rows) {
    const days = daysByCode.get(row.employeeCode) ?? new Set<string>();
    if (hasTime(row)) days.add(row.date);
    daysByCode.set(row.employeeCode, days);
    const list = rowsByCode.get(row.employeeCode) ?? [];
    list.push(row);
    rowsByCode.set(row.employeeCode, list);
  }

  const attendanceDaysFor = (code: string): number => daysByCode.get(code)?.size ?? 0;

  const knownCodes = new Set(employees.map((employee) => employee.code));
  const previousByCode = new Map(previousEmployees.map((employee) => [employee.code, employee]));

  const add: CatalogSuggestion[] = [];
  for (const code of rowsByCode.keys()) {
    if (knownCodes.has(code)) continue;
    const codeRows = rowsByCode.get(code) ?? [];
    const previous = previousByCode.get(code);
    let employee: PayrollEmployee;
    let source: CatalogSuggestionSource;

    if (previous) {
      employee = {
        code,
        name: previous.name,
        group: previous.group,
        employmentType: previous.employmentType,
        monthlySalary: previous.monthlySalary ?? null,
        hourlyRate: previous.hourlyRate ?? null,
        overtimeRate: previous.overtimeRate ?? null,
        allowance: previous.allowance ?? null,
        startDate: previous.startDate ?? null,
        // The previous row's end date does not carry over to the new period.
        endDate: null,
      };
      source = "previous_period";
    } else {
      const name = codeRows.map((row) => row.employeeName.trim()).find((value) => value !== "") ?? "";
      const department = codeRows
        .map((row) => row.department)
        .find((value): value is string => typeof value === "string" && value.trim() !== "");
      const group = normalizeGroup(department) ?? "Bếp bánh";
      const firstDate = codeRows
        .filter(hasTime)
        .map((row) => row.date)
        .sort()[0];
      employee = {
        code,
        name,
        group,
        employmentType: "official",
        monthlySalary: null,
        hourlyRate: null,
        overtimeRate: null,
        allowance: null,
        startDate: firstDate ?? null,
        endDate: null,
      };
      source = "attendance_file";
    }

    const missing = missingFields(employee);
    if (source === "attendance_file" && employee.group === "Bếp bánh") {
      const department = codeRows
        .map((row) => row.department)
        .find((value): value is string => typeof value === "string" && value.trim() !== "");
      if (normalizeGroup(department) === null) missing.unshift("group");
    }

    add.push({ code, employee, source, missing, attendanceDays: attendanceDaysFor(code) });
  }
  add.sort((left, right) => left.code.localeCompare(right.code));

  const maybeLeft: CatalogSuggestion[] = employees
    .filter(
      (employee) =>
        !employee.terminated &&
        !employee.endDate &&
        attendanceDaysFor(employee.code) === 0,
    )
    .map((employee) => ({
      code: employee.code,
      employee: { ...employee, endDate: dayBeforeIso(period.dateFrom) },
      source: "attendance_file" as const,
      missing: [] as CatalogMissingField[],
      attendanceDays: 0,
    }))
    .sort((left, right) => left.code.localeCompare(right.code));

  return { add, maybeLeft };
}
