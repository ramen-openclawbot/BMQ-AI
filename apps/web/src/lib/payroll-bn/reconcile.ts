// Cell-by-cell reconciliation between a hand-made payroll sheet and the
// engine result. The reconciler is reporting-only: it never changes the engine
// output and never writes money to a log.

import {
  compareRational,
  isRational,
  rational,
  rationalFromNumber,
  roundHalfUpToStep,
  subRational,
  type Rational,
} from "./money.ts";
import type { PayrollEmployeeLine, PayrollGroupLine } from "./types.ts";

export type ReconcileFieldKind = "money" | "quantity";

export interface ReconcileFieldDefinition {
  key: string;
  kind: ReconcileFieldKind;
  engine: (line: PayrollEmployeeLine | PayrollGroupLine) => Rational;
}

export const DEFAULT_RECONCILE_FIELDS: ReconcileFieldDefinition[] = [
  { key: "work_days", kind: "quantity", engine: (line) => line.workDays },
  { key: "actual_work_days", kind: "quantity", engine: (line) => line.actualWorkDays },
  { key: "part_time_hours", kind: "quantity", engine: (line) => line.partTimeHours },
  { key: "overtime_hours", kind: "quantity", engine: (line) => line.overtimeHours },
  { key: "day_pay", kind: "money", engine: (line) => line.dayPay },
  { key: "part_time_pay", kind: "money", engine: (line) => line.partTimePay },
  { key: "overtime_pay", kind: "money", engine: (line) => line.overtimePay },
  { key: "allowance", kind: "money", engine: (line) => line.allowance },
  { key: "gross_pay", kind: "money", engine: (line) => line.grossPay },
  { key: "net_pay", kind: "money", engine: (line) => rational(line.netPayRounded) },
];

export type ReconcileCellStatus = "match" | "mismatch" | "missing_manual" | "missing_engine";

export interface ManualPayrollRow {
  employeeCode?: string | null;
  employeeName?: string | null;
  group?: string | null;
  fields: Record<string, number | string | null | undefined>;
}

export interface ReconcileCell {
  key: string;
  employeeCode: string | null;
  group: string | null;
  field: string;
  kind: ReconcileFieldKind;
  manual: string | null;
  engine: string | null;
  delta: string | null;
  status: ReconcileCellStatus;
}

export interface EmployeeReconcileReport {
  employeeCode: string;
  employeeName: string | null;
  group: string | null;
  cells: ReconcileCell[];
  matched: number;
  mismatched: number;
  missing: number;
}

export interface ReconcileReport {
  periodCode: string;
  fields: string[];
  cells: ReconcileCell[];
  perEmployee: EmployeeReconcileReport[];
  matchedCells: number;
  mismatchedCells: number;
  missingCells: number;
  totalCells: number;
  fullyMatched: boolean;
}

export interface ReconcileInput {
  periodCode: string;
  employees: readonly PayrollEmployeeLine[];
  groups?: readonly PayrollGroupLine[];
  manual: readonly ManualPayrollRow[];
  fields?: ReconcileFieldDefinition[];
}

function parseManualValue(
  value: number | string | null | undefined,
  kind: ReconcileFieldKind,
): Rational | null {
  if (value === null || value === undefined || value === "") return null;
  if (isRational(value as unknown as Rational)) return value as unknown as Rational;
  if (typeof value === "bigint") return rational(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? rationalFromNumber(value) : null;
  }
  const text = String(value).trim().replace(/\s/g, "");
  const cleaned = kind === "money" ? text.replace(/\./g, "").replace(/,/g, ".") : text.replace(/,/g, ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? rationalFromNumber(parsed) : null;
}

function normaliseForCompare(value: Rational, kind: ReconcileFieldKind): bigint | Rational {
  if (kind === "money") return roundHalfUpToStep(value, 1n);
  return value;
}

function formatEngine(value: Rational, kind: ReconcileFieldKind): string {
  if (kind === "money") return roundHalfUpToStep(value, 1n).toString();
  return `${value.n}/${value.d}`;
}

function formatManual(value: Rational | null, kind: ReconcileFieldKind): string | null {
  if (value === null) return null;
  if (kind === "money") return roundHalfUpToStep(value, 1n).toString();
  return `${value.n}/${value.d}`;
}

function compareCell(
  manual: Rational | null,
  engine: Rational,
  kind: ReconcileFieldKind,
): { status: ReconcileCellStatus; delta: string | null } {
  if (manual === null) return { status: "missing_manual", delta: null };
  const left = normaliseForCompare(manual, kind);
  const right = normaliseForCompare(engine, kind);
  if (kind === "money") {
    const a = left as bigint;
    const b = right as bigint;
    return { status: a === b ? "match" : "mismatch", delta: (a - b).toString() };
  }
  const a = left as Rational;
  const b = right as Rational;
  const diff = subRational(a, b);
  return {
    status: compareRational(a, b) === 0 ? "match" : "mismatch",
    delta: `${diff.n}/${diff.d}`,
  };
}

function reconcileRow(
  periodCode: string,
  fields: ReconcileFieldDefinition[],
  manualRow: ManualPayrollRow | undefined,
  engineLine: PayrollEmployeeLine | PayrollGroupLine,
  employeeCode: string | null,
): ReconcileCell[] {
  return fields.map((field) => {
    const engineValue = field.engine(engineLine);
    const manualValue = parseManualValue(manualRow?.fields?.[field.key], field.kind);
    const { status, delta } = compareCell(manualValue, engineValue, field.kind);
    return {
      key: employeeCode ?? engineLine.group ?? "",
      employeeCode,
      group: engineLine.group ?? null,
      field: field.key,
      kind: field.kind,
      manual: formatManual(manualValue, field.kind),
      engine: formatEngine(engineValue, field.kind),
      delta,
      status,
    };
  });
}

/** Reconcile hand-made employee (and optional group) rows with the engine. */
export function reconcilePayroll(input: ReconcileInput): ReconcileReport {
  const fields = input.fields ?? DEFAULT_RECONCILE_FIELDS;
  const manualByCode = new Map<string, ManualPayrollRow>();
  const manualByGroup = new Map<string, ManualPayrollRow>();
  for (const row of input.manual) {
    if (row.employeeCode) manualByCode.set(row.employeeCode, row);
    else if (row.group) manualByGroup.set(row.group, row);
  }

  const cells: ReconcileCell[] = [];
  const perEmployee: EmployeeReconcileReport[] = [];

  for (const line of input.employees) {
    const rowCells = reconcileRow(input.periodCode, fields, manualByCode.get(line.employeeCode), line, line.employeeCode);
    cells.push(...rowCells);
    const matched = rowCells.filter((cell) => cell.status === "match").length;
    const mismatched = rowCells.filter((cell) => cell.status === "mismatch").length;
    const missing = rowCells.filter((cell) => cell.status !== "match" && cell.status !== "mismatch").length;
    perEmployee.push({
      employeeCode: line.employeeCode,
      employeeName: line.employeeName,
      group: line.group,
      cells: rowCells,
      matched,
      mismatched,
      missing,
    });
  }

  const groupReports: EmployeeReconcileReport[] = [];
  for (const line of input.groups ?? []) {
    const rowCells = reconcileRow(input.periodCode, fields, manualByGroup.get(line.group), line, null);
    cells.push(...rowCells);
    groupReports.push({
      employeeCode: `group:${line.group}`,
      employeeName: null,
      group: line.group,
      cells: rowCells,
      matched: rowCells.filter((cell) => cell.status === "match").length,
      mismatched: rowCells.filter((cell) => cell.status === "mismatch").length,
      missing: rowCells.filter((cell) => cell.status !== "match" && cell.status !== "mismatch").length,
    });
  }

  const matchedCells = cells.filter((cell) => cell.status === "match").length;
  const mismatchedCells = cells.filter((cell) => cell.status === "mismatch").length;
  const missingCells = cells.filter((cell) => cell.status !== "match" && cell.status !== "mismatch").length;

  return {
    periodCode: input.periodCode,
    fields: fields.map((field) => field.key),
    cells,
    perEmployee: [...perEmployee, ...groupReports],
    matchedCells,
    mismatchedCells,
    missingCells,
    totalCells: cells.length,
    fullyMatched: mismatchedCells === 0 && missingCells === 0,
  };
}
