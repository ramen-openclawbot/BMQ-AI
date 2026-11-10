// Pure mapping between the payroll_bn_* tables and the Bếp BN domain types.
//
// Kept free of Supabase/React imports so the conversions can be unit-tested
// with node:test. The generated Database type does not know the new
// payroll_bn_* tables yet, so the row shapes live here instead.
//
// Money is only ever *read* from the DB here (number | numeric-as-string);
// no arithmetic happens in this module.

import { resolveRulesConfig } from "./rules-config.ts";
import type { RulesConfig } from "./rules-config.ts";
import type { AnomalyCode } from "./anomalies.ts";
import type { IssueDecision, IssueReview } from "./issue-review.ts";
import type {
  AdjustmentField,
  AttendanceImportSource,
  AttendanceRow,
  AttendanceShift,
  EmploymentType,
  GpsAttendanceImportResult,
  GpsAttendancePreview,
  GpsAttendancePreviewRow,
  PayrollAdjustment,
  PayrollEmployee,
  PayrollGroup,
  PayrollPeriod,
  PayrollPeriodStatus,
  PeriodScheduleDetail,
  PeriodScheduleDetailKind,
  PeriodScheduleEmployee,
  PeriodScheduleSummary,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Raw table rows (snake_case, as returned by PostgREST)
// ---------------------------------------------------------------------------

export interface PayrollBnPeriodRow {
  id: string;
  period_code: string;
  period_name: string;
  date_from: string;
  date_to: string;
  default_standard_days?: number | string | null;
  standard_days_by_group?: unknown;
  holidays?: unknown;
  rules_config?: Partial<RulesConfig> | null;
  status?: string | null;
  attendance_approved_at?: string | null;
  attendance_approved_by?: string | null;
}

export interface PayrollBnPeriodInsertRow {
  period_code: string;
  period_name: string;
  date_from: string;
  date_to: string;
  standard_days_by_group: Record<string, number>;
  holidays: string[];
}

export interface PayrollBnEmployeeRow {
  id?: string;
  period_id: string;
  employee_code: string;
  employee_name: string;
  group_name?: string | null;
  employment_type: string;
  monthly_salary?: number | string | null;
  hourly_rate?: number | string | null;
  overtime_rate?: number | string | null;
  allowance?: number | string | null;
  standard_days_override?: number | string | null;
  start_date?: string | null;
  end_date?: string | null;
}

export interface PayrollBnEmployeeUpsertRow {
  period_id: string;
  employee_code: string;
  employee_name: string;
  group_name: string;
  employment_type: EmploymentType;
  monthly_salary: number | null;
  hourly_rate: number | null;
  overtime_rate: number | null;
  allowance: number | null;
  standard_days_override: number | null;
  start_date: string | null;
  end_date: string | null;
}

export interface PayrollBnAttendanceRow {
  id?: string;
  import_id?: string;
  period_id: string;
  employee_code: string;
  employee_name?: string | null;
  work_date: string;
  check_in?: string | null;
  check_out?: string | null;
  department?: string | null;
  shift?: string | null;
  late_minutes?: number | string | null;
  early_minutes?: number | string | null;
}

export interface PayrollBnAttendanceInsertRow {
  employee_code: string;
  employee_name: string | null;
  work_date: string;
  check_in: string | null;
  check_out: string | null;
  department: string | null;
  shift: string | null;
  late_minutes: number | null;
  early_minutes: number | null;
}

export interface PayrollBnAttendanceImportRow {
  id: string;
  period_id: string;
  file_name: string;
  sha256: string;
  row_count?: number | string | null;
  imported_at: string;
  source?: string | null;
}

export interface PayrollBnGpsAttendanceRow {
  employee_code: string;
  employee_name?: string | null;
  department?: string | null;
  work_date: string;
  check_in?: string | null;
  check_out?: string | null;
  shift?: string | null;
  late_minutes?: number | string | null;
  early_minutes?: number | string | null;
  scheduled_shift_code?: string | null;
  scheduled_start?: string | null;
  has_override?: boolean | null;
  already_in_period?: boolean | null;
}

export interface PayrollBnAdjustmentRow {
  id?: string;
  period_id: string;
  employee_code: string;
  field: string;
  old_value?: unknown;
  new_value?: unknown;
  reason: string;
  actor?: string | null;
  created_at: string;
}

export interface PayrollBnAdjustmentInsertRow {
  period_id: string;
  employee_code: string;
  field: AdjustmentField;
  old_value?: number | string | null;
  new_value: number | string | null;
  reason: string;
}

export interface PayrollBnIssueReviewRow {
  id?: string;
  period_id: string;
  employee_code: string;
  work_date: string;
  issue_code: string;
  decision: string;
  note?: string | null;
  actor?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PayrollBnIssueReviewUpsertRow {
  period_id: string;
  employee_code: string;
  work_date: string;
  issue_code: AnomalyCode;
  decision: IssueDecision;
  note: string | null;
}

/** Input accepted by createPeriod (matches BepBnPeriodInput in the UI contract). */
export interface PayrollBnPeriodInput {
  code: string;
  name: string;
  dateFrom: string;
  dateTo: string;
  standardDaysByGroup: Record<PayrollGroup, number>;
  holidays: string[];
}

// ---------------------------------------------------------------------------
// Small value normalisers
// ---------------------------------------------------------------------------

const PAYROLL_GROUPS: readonly PayrollGroup[] = ["Văn phòng", "Bếp bánh", "Kho BN"];

const ADJUSTMENT_FIELDS: readonly AdjustmentField[] = [
  "work_days",
  "paid_work_days",
  "part_time_hours",
  "overtime_hours",
  "exclude_overtime",
  "exclude_holiday",
  "net_pay",
];

/** Read a numeric column (number, or numeric returned as a string) or null. */
export function toOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toHolidayList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function toStandardDaysByGroup(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [group, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed = toOptionalNumber(raw);
    if (parsed !== null) result[group] = parsed;
  }
  return result;
}

function toTimeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

/** A locked period can never go back to draft; anything else reads as draft. */
export function normalizePeriodStatus(value: unknown): PayrollPeriodStatus {
  return value === "locked" ? "locked" : "draft";
}

/** The DB check constraint limits group_name to three values; fall back defensively. */
export function normalizeGroup(value: unknown): PayrollGroup {
  return typeof value === "string" && (PAYROLL_GROUPS as readonly string[]).includes(value)
    ? (value as PayrollGroup)
    : "Bếp bánh";
}

export function normalizeEmploymentType(value: unknown): EmploymentType {
  return value === "part_time" ? "part_time" : "official";
}

/** The machine shift is HC or V; anything else (including absent) reads null. */
export function normalizeAttendanceShift(value: unknown): AttendanceShift {
  return value === "HC" || value === "V" ? (value as AttendanceShift) : null;
}

/** Validate an adjustment field coming from the DB. */
export function normalizeAdjustmentField(value: unknown): AdjustmentField {
  if (typeof value === "string" && (ADJUSTMENT_FIELDS as readonly string[]).includes(value)) {
    return value as AdjustmentField;
  }
  throw new Error(`Trường điều chỉnh không hợp lệ: ${String(value)}`);
}

const ISSUE_CODES: readonly AnomalyCode[] = [
  "missing_check_out",
  "missing_check_in",
  "no_machine_data",
  "duplicate_time",
  "unknown_employee",
  "missing_attendance",
  "holiday_attendance",
];

/** Validate an issue code coming from the DB. */
export function normalizeIssueCode(value: unknown): AnomalyCode {
  if (typeof value === "string" && (ISSUE_CODES as readonly string[]).includes(value)) {
    return value as AnomalyCode;
  }
  throw new Error(`Mã bất thường không hợp lệ: ${String(value)}`);
}

/** Anything that is not an explicit exclusion is treated as an acceptance. */
export function normalizeIssueDecision(value: unknown): IssueDecision {
  return value === "excluded" ? "excluded" : "accepted";
}

/** jsonb values used by the engine are numbers or strings; everything else reads null. */
export function toAdjustmentValue(value: unknown): number | string | null {
  if (typeof value === "number" || typeof value === "string") return value;
  return null;
}

/** UI shows a short actor id rather than the full uuid. */
export function shortenActor(actor: unknown): string {
  if (typeof actor !== "string" || actor === "") return "";
  return actor.slice(0, 8);
}

// ---------------------------------------------------------------------------
// DB row -> domain
// ---------------------------------------------------------------------------

export function mapPeriodRow(row: PayrollBnPeriodRow): PayrollPeriod {
  return {
    code: row.period_code,
    name: row.period_name,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    standardDaysByGroup: toStandardDaysByGroup(row.standard_days_by_group),
    defaultStandardDays: toOptionalNumber(row.default_standard_days) ?? 26,
    holidays: toHolidayList(row.holidays),
    rules: resolveRulesConfig(row.rules_config),
    status: normalizePeriodStatus(row.status),
  };
}

export function mapEmployeeRow(row: PayrollBnEmployeeRow, periodDateFrom: string): PayrollEmployee {
  const endDate = row.end_date ?? null;
  return {
    code: row.employee_code,
    name: row.employee_name,
    group: normalizeGroup(row.group_name),
    employmentType: normalizeEmploymentType(row.employment_type),
    monthlySalary: toOptionalNumber(row.monthly_salary),
    hourlyRate: toOptionalNumber(row.hourly_rate),
    allowance: toOptionalNumber(row.allowance),
    overtimeRate: toOptionalNumber(row.overtime_rate),
    standardDaysOverride: toOptionalNumber(row.standard_days_override),
    startDate: row.start_date ?? null,
    endDate,
    // A terminated employee keeps an empty row for the period that starts after
    // their last working day (end_date < period.date_from).
    terminated: Boolean(endDate && periodDateFrom && endDate < periodDateFrom),
  };
}

export function mapAttendanceRow(row: PayrollBnAttendanceRow): AttendanceRow {
  return {
    employeeCode: row.employee_code,
    employeeName: row.employee_name ?? "",
    date: row.work_date,
    checkIn: toTimeValue(row.check_in),
    checkOut: toTimeValue(row.check_out),
    department: row.department ?? null,
    shift: normalizeAttendanceShift(row.shift),
    lateMinutes: toOptionalNumber(row.late_minutes),
    earlyMinutes: toOptionalNumber(row.early_minutes),
  };
}

// ---------------------------------------------------------------------------
// GPS attendance preview / import / schedule summary
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
    )
    : [];
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toNullableText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function toCount(value: unknown): number {
  return toOptionalNumber(value) ?? 0;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const SCHEDULE_DETAIL_KINDS: readonly PeriodScheduleDetailKind[] = [
  "no_show",
  "late",
  "unscheduled",
  "missing_out",
];

function normalizeScheduleDetailKind(value: unknown): PeriodScheduleDetailKind {
  return typeof value === "string"
    && (SCHEDULE_DETAIL_KINDS as readonly string[]).includes(value)
    ? (value as PeriodScheduleDetailKind)
    : "no_show";
}

/** A missing/unknown import source reads as a machine file (old rows). */
export function normalizeImportSource(value: unknown): AttendanceImportSource {
  return value === "gps" ? "gps" : "machine";
}

export function mapGpsAttendanceRow(value: unknown): GpsAttendancePreviewRow {
  const row = asRecord(value);
  return {
    employeeCode: toText(row.employee_code),
    employeeName: toText(row.employee_name),
    department: toNullableText(row.department),
    date: toText(row.work_date),
    checkIn: toTimeValue(row.check_in),
    checkOut: toTimeValue(row.check_out),
    shift: toNullableText(row.shift),
    lateMinutes: toOptionalNumber(row.late_minutes),
    earlyMinutes: toOptionalNumber(row.early_minutes),
    scheduledShiftCode: toNullableText(row.scheduled_shift_code),
    scheduledStart: toTimeValue(row.scheduled_start),
    hasOverride: row.has_override === true,
    alreadyInPeriod: row.already_in_period === true,
  };
}

export function mapGpsAttendancePreview(data: unknown): GpsAttendancePreview {
  const row = asRecord(data);
  const totals = asRecord(row.totals);
  return {
    periodId: toText(row.period_id),
    from: toText(row.from),
    to: toText(row.to),
    rows: asRecordArray(row.rows).map(mapGpsAttendanceRow),
    skippedCodes: toStringArray(row.skipped_codes),
    totals: {
      rows: toCount(totals.rows),
      employees: toCount(totals.employees),
      daysMissingOut: toCount(totals.days_missing_out),
      alreadyInPeriod: toCount(totals.already_in_period),
      toInsert: toCount(totals.to_insert),
    },
  };
}

export function mapGpsAttendanceImportResult(data: unknown): GpsAttendanceImportResult {
  const row = asRecord(data);
  return {
    importId: toNullableText(row.import_id),
    insertedRows: toCount(row.inserted_rows),
    skippedExisting: toCount(row.skipped_existing),
    alreadyImported: row.already_imported === true,
    skippedCodes: toStringArray(row.skipped_codes),
  };
}

function mapScheduleDetail(value: unknown): PeriodScheduleDetail {
  const row = asRecord(value);
  return {
    workDate: toText(row.work_date),
    kind: normalizeScheduleDetailKind(row.kind),
    shiftStart: toTimeValue(row.shift_start),
    checkIn: toTimeValue(row.check_in),
    checkOut: toTimeValue(row.check_out),
    minutesLate: toOptionalNumber(row.minutes_late),
  };
}

function mapScheduleEmployee(value: unknown): PeriodScheduleEmployee {
  const row = asRecord(value);
  return {
    employeeCode: toText(row.employee_code),
    employeeName: toText(row.employee_name),
    groupName: toNullableText(row.group_name),
    scheduledDays: toCount(row.scheduled_days),
    offDays: toCount(row.off_days),
    workedDays: toCount(row.worked_days),
    workedScheduled: toCount(row.worked_scheduled),
    noShowDays: toCount(row.no_show_days),
    unscheduledDays: toCount(row.unscheduled_days),
    lateDays: toCount(row.late_days),
    lateMinutesTotal: toCount(row.late_minutes_total),
    missingOutDays: toCount(row.missing_out_days),
    approvedLeaves: toCount(row.approved_leaves),
    approvedChanges: toCount(row.approved_changes),
    details: asRecordArray(row.details).map(mapScheduleDetail),
  };
}

export function mapPeriodScheduleSummary(data: unknown): PeriodScheduleSummary {
  const row = asRecord(data);
  const totals = asRecord(row.totals);
  return {
    periodId: toText(row.period_id),
    dateFrom: toText(row.date_from),
    dateTo: toText(row.date_to),
    coveredFrom: toNullableText(row.covered_from),
    coveredTo: toNullableText(row.covered_to),
    employees: asRecordArray(row.employees).map(mapScheduleEmployee),
    totals: {
      employees: toCount(totals.employees),
      scheduledDays: toCount(totals.scheduled_days),
      offDays: toCount(totals.off_days),
      workedDays: toCount(totals.worked_days),
      workedScheduled: toCount(totals.worked_scheduled),
      noShowDays: toCount(totals.no_show_days),
      unscheduledDays: toCount(totals.unscheduled_days),
      lateDays: toCount(totals.late_days),
      lateMinutesTotal: toCount(totals.late_minutes_total),
      missingOutDays: toCount(totals.missing_out_days),
      approvedLeaves: toCount(totals.approved_leaves),
      approvedChanges: toCount(totals.approved_changes),
    },
  };
}

export function mapAdjustmentRow(row: PayrollBnAdjustmentRow): PayrollAdjustment {
  return {
    employeeCode: row.employee_code,
    field: normalizeAdjustmentField(row.field),
    value: toAdjustmentValue(row.new_value),
    reason: row.reason,
    actor: shortenActor(row.actor),
    at: row.created_at,
    oldValue: toAdjustmentValue(row.old_value),
  };
}

export function mapIssueReviewRow(row: PayrollBnIssueReviewRow): IssueReview {
  return {
    employeeCode: row.employee_code,
    workDate: row.work_date,
    issueCode: normalizeIssueCode(row.issue_code),
    decision: normalizeIssueDecision(row.decision),
    note: row.note ?? null,
  };
}

// ---------------------------------------------------------------------------
// Domain -> DB write rows
// ---------------------------------------------------------------------------

export function toPeriodInsertRow(input: PayrollBnPeriodInput): PayrollBnPeriodInsertRow {
  return {
    period_code: input.code,
    period_name: input.name,
    date_from: input.dateFrom,
    date_to: input.dateTo,
    standard_days_by_group: { ...input.standardDaysByGroup },
    holidays: [...input.holidays],
  };
}

export function toEmployeeUpsertRow(
  periodId: string,
  employee: PayrollEmployee,
): PayrollBnEmployeeUpsertRow {
  return {
    period_id: periodId,
    employee_code: employee.code,
    employee_name: employee.name,
    group_name: employee.group,
    employment_type: employee.employmentType,
    monthly_salary: employee.monthlySalary ?? null,
    // daily_rate is intentionally omitted: the domain type has no field for it,
    // so upserts must not overwrite an existing value with null.
    hourly_rate: employee.hourlyRate ?? null,
    overtime_rate: employee.overtimeRate ?? null,
    allowance: employee.allowance ?? null,
    standard_days_override: employee.standardDaysOverride ?? null,
    start_date: employee.startDate ?? null,
    end_date: employee.endDate ?? null,
  };
}

export function toAttendancePayloadRow(row: AttendanceRow): PayrollBnAttendanceInsertRow {
  return {
    employee_code: row.employeeCode,
    employee_name: row.employeeName === "" ? null : row.employeeName,
    work_date: row.date,
    check_in: row.checkIn,
    check_out: row.checkOut,
    department: row.department,
    shift: row.shift ?? null,
    late_minutes: row.lateMinutes ?? null,
    early_minutes: row.earlyMinutes ?? null,
  };
}

export function toAdjustmentInsertRow(
  periodId: string,
  input: {
    employeeCode: string;
    field: AdjustmentField;
    value: number | string | null;
    oldValue?: number | string | null;
    reason: string;
  },
): PayrollBnAdjustmentInsertRow {
  return {
    period_id: periodId,
    employee_code: input.employeeCode,
    field: input.field,
    ...(input.oldValue !== undefined && input.oldValue !== null ? { old_value: input.oldValue } : {}),
    new_value: input.value,
    reason: input.reason,
  };
}

export function toIssueReviewUpsertRow(
  periodId: string,
  input: {
    employeeCode: string;
    workDate: string;
    issueCode: AnomalyCode;
    decision: IssueDecision;
    note?: string | null;
  },
): PayrollBnIssueReviewUpsertRow {
  return {
    period_id: periodId,
    employee_code: input.employeeCode,
    work_date: input.workDate,
    issue_code: input.issueCode,
    decision: input.decision,
    note: input.note ?? null,
  };
}
