// Supabase reads/writes for the Bếp BN payroll panel.
//
// Every function takes the client as its first argument and returns plain
// domain data, so the caller (react-query hook) can swap in the real Supabase
// client or a fake one in tests.
//
// The generated Database type does not include the new payroll_bn_* tables, so
// the client is typed through the small local `BepBnClient` shape below and the
// hook casts the real client into it once.
//
// No money is logged anywhere in this module.

import {
  mapAdjustmentRow,
  mapAttendanceRow,
  mapEmployeeRow,
  mapIssueReviewRow,
  mapPeriodRow,
  normalizePeriodStatus,
  toAdjustmentInsertRow,
  toAttendancePayloadRow,
  toEmployeeUpsertRow,
  toIssueReviewUpsertRow,
  toPeriodInsertRow,
} from "./db-mapping.ts";
import type {
  PayrollBnAdjustmentRow,
  PayrollBnAttendanceImportRow,
  PayrollBnAttendanceRow,
  PayrollBnEmployeeRow,
  PayrollBnIssueReviewRow,
  PayrollBnPeriodInput,
  PayrollBnPeriodRow,
} from "./db-mapping.ts";
import { toPublishPayload } from "./payslip.ts";
import type { PayslipRecord } from "./payslip.ts";
import type { AnomalyCode } from "./anomalies.ts";
import type { IssueDecision, IssueReview } from "./issue-review.ts";
import type {
  AdjustmentField,
  AttendanceRow,
  PayrollAdjustment,
  PayrollEmployee,
  PayrollEmployeeMeasures,
  PayrollPeriod,
  PayrollPeriodStatus,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Local client shape (covers the new tables missing from generated types)
// ---------------------------------------------------------------------------

interface DbErrorLike {
  message?: string;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
}

interface DbResult<T> {
  data: T | null;
  error: DbErrorLike | null;
}

export interface BepBnQuery {
  select(columns?: string): BepBnQuery;
  insert(values: unknown): BepBnQuery;
  upsert(values: unknown, options?: { onConflict?: string }): BepBnQuery;
  update(values: unknown): BepBnQuery;
  delete(): BepBnQuery;
  eq(column: string, value: unknown): BepBnQuery;
  order(column: string, options?: { ascending?: boolean }): BepBnQuery;
  limit(count: number): BepBnQuery;
  maybeSingle(): PromiseLike<DbResult<unknown>>;
  single(): PromiseLike<DbResult<unknown>>;
  then<TResult1 = DbResult<unknown>, TResult2 = never>(
    onfulfilled?: ((value: DbResult<unknown>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

export interface BepBnClient {
  from(table: string): BepBnQuery;
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<DbResult<unknown>>;
}

// ---------------------------------------------------------------------------
// Data returned to the UI
// ---------------------------------------------------------------------------

export interface BepBnPeriodSummary {
  id: string;
  code: string;
  name: string;
  dateFrom: string;
  dateTo: string;
  status: PayrollPeriodStatus;
}

export interface BepBnImportSummary {
  id: string;
  fileName: string;
  sha256: string;
  rowCount: number;
  importedAt: string;
}

export interface BepBnPeriodData {
  id: string;
  period: PayrollPeriod;
  employees: PayrollEmployee[];
  /** Always empty: manual figures go through the adjustment log. */
  measures: Record<string, PayrollEmployeeMeasures>;
  rows: AttendanceRow[];
  adjustments: PayrollAdjustment[];
  imports: BepBnImportSummary[];
  /** When the attendance of this period was approved, or null. */
  attendanceApprovedAt: string | null;
}

export interface BepBnImportResult {
  alreadyImported: boolean;
  insertedRows: number;
}

export interface BepBnAdjustmentInput {
  employeeCode: string;
  field: AdjustmentField;
  value: number | null;
  oldValue?: number | null;
  reason: string;
}

export interface BepBnImportInput {
  periodId: string;
  fileName: string;
  sha256: string;
  rows: AttendanceRow[];
}

export interface BepBnIssueReviewInput {
  employeeCode: string;
  workDate: string;
  issueCode: AnomalyCode;
  decision: IssueDecision;
  /** Required (non-blank) when the decision is `excluded`. */
  note?: string | null;
}

/** An employee phone registered for the payslip portal. */
export interface BepBnEmployeeContact {
  employeeCode: string;
  /** Normalised to 84xxxxxxxxx. */
  phone: string;
  active: boolean;
}

export interface BepBnEmployeeContactInput {
  employeeCode: string;
  phone: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Error messages (Vietnamese, operator friendly)
// ---------------------------------------------------------------------------

const GENERIC_ERROR = "Không thực hiện được thao tác. Vui lòng thử lại.";

/** Convert a PostgREST/Postgres error into a message an operator can act on. */
export function describeDbError(error: unknown): string {
  const raw = (error ?? {}) as DbErrorLike;
  const code = typeof raw.code === "string" ? raw.code : "";
  const message = typeof raw.message === "string" ? raw.message : "";

  switch (code) {
    case "42501":
      return "Bạn không có quyền thực hiện thao tác này.";
    case "55006":
      return "Kỳ lương đã chốt, không thể thay đổi.";
    case "P0002":
      return "Không tìm thấy kỳ lương.";
    case "22023":
      if (message.includes("invalid_sha256")) return "Mã sha256 của file chấm công không hợp lệ.";
      if (message.includes("invalid_rows")) return "Dữ liệu chấm công gửi lên không hợp lệ.";
      if (message.includes("date_out_of_period")) {
        return "Có dòng chấm công nằm ngoài khoảng ngày của kỳ hoặc thiếu mã nhân viên/ngày.";
      }
      return "Dữ liệu gửi lên không hợp lệ.";
    case "23505":
      if (message.includes("duplicate_employee_day")) {
        return "Trùng ngày chấm công của cùng một nhân viên trong file.";
      }
      return "Dữ liệu đã tồn tại (trùng khoá duy nhất).";
    case "23503":
      return "Kỳ lương hoặc dữ liệu liên quan không tồn tại.";
    case "23514":
      return "Dữ liệu không thoả ràng buộc của hệ thống.";
    default:
      break;
  }

  if (message.includes("payroll_bn_period_locked")) return "Kỳ lương đã chốt, không thể thay đổi.";
  if (message.includes("payroll_bn_lock_owner_only")) return "Chỉ chủ sở hữu mới được chốt kỳ lương.";
  if (message.includes("insufficient_privilege")) return "Bạn không có quyền thực hiện thao tác này.";
  if (message.includes("payroll_bn_period_not_found")) return "Không tìm thấy kỳ lương.";
  if (message.includes("payroll_bn_duplicate_employee_day")) {
    return "Trùng ngày chấm công của cùng một nhân viên trong file.";
  }
  if (message) return message;
  return GENERIC_ERROR;
}

function fail(error: DbErrorLike | null | undefined): never {
  throw new Error(describeDbError(error));
}

function asRows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    return data.length > 0 ? (data[0] as Record<string, unknown>) : null;
  }
  if (data && typeof data === "object") return data as Record<string, unknown>;
  return null;
}

function toRowCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listPeriods(client: BepBnClient): Promise<BepBnPeriodSummary[]> {
  const { data, error } = await client
    .from("payroll_bn_periods")
    .select("id, period_code, period_name, date_from, date_to, status")
    .order("date_from", { ascending: false });
  if (error) fail(error);

  return asRows<PayrollBnPeriodRow>(data).map((row) => ({
    id: row.id,
    code: row.period_code,
    name: row.period_name,
    dateFrom: row.date_from,
    dateTo: row.date_to,
    status: normalizePeriodStatus(row.status),
  }));
}

export async function loadPeriodData(
  client: BepBnClient,
  periodId: string,
): Promise<BepBnPeriodData | null> {
  const periodResult = await client
    .from("payroll_bn_periods")
    .select("*")
    .eq("id", periodId)
    .maybeSingle();
  if (periodResult.error) fail(periodResult.error);
  if (!periodResult.data) return null;

  const periodRow = periodResult.data as PayrollBnPeriodRow;
  const period = mapPeriodRow(periodRow);

  const [employeesResult, rowsResult, importsResult, adjustmentsResult] = await Promise.all([
    client
      .from("payroll_bn_period_employees")
      .select("*")
      .eq("period_id", periodId)
      .order("employee_code", { ascending: true }),
    client
      .from("payroll_bn_attendance_rows")
      .select("*")
      .eq("period_id", periodId)
      .order("work_date", { ascending: true }),
    client
      .from("payroll_bn_attendance_imports")
      .select("*")
      .eq("period_id", periodId)
      .order("imported_at", { ascending: false }),
    client
      .from("payroll_bn_adjustments")
      .select("*")
      .eq("period_id", periodId)
      // Oldest first: the engine lets the latest adjustment of a field win.
      .order("created_at", { ascending: true }),
  ]);

  if (employeesResult.error) fail(employeesResult.error);
  if (rowsResult.error) fail(rowsResult.error);
  if (importsResult.error) fail(importsResult.error);
  if (adjustmentsResult.error) fail(adjustmentsResult.error);

  return {
    id: periodRow.id,
    period,
    employees: asRows<PayrollBnEmployeeRow>(employeesResult.data).map((row) =>
      mapEmployeeRow(row, period.dateFrom),
    ),
    measures: {},
    rows: asRows<PayrollBnAttendanceRow>(rowsResult.data).map(mapAttendanceRow),
    adjustments: asRows<PayrollBnAdjustmentRow>(adjustmentsResult.data).map(mapAdjustmentRow),
    imports: asRows<PayrollBnAttendanceImportRow>(importsResult.data).map((row) => ({
      id: row.id,
      fileName: row.file_name,
      sha256: row.sha256,
      rowCount: toRowCount(row.row_count),
      importedAt: row.imported_at,
    })),
    attendanceApprovedAt: periodRow.attendance_approved_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function importAttendance(
  client: BepBnClient,
  input: BepBnImportInput,
): Promise<BepBnImportResult> {
  const { data, error } = await client.rpc("payroll_bn_import_attendance", {
    _period_id: input.periodId,
    _file_name: input.fileName,
    _sha256: input.sha256,
    _rows: input.rows.map(toAttendancePayloadRow),
  });
  if (error) fail(error);

  const row = firstRow(data);
  return {
    alreadyImported: Boolean(row?.already_imported),
    insertedRows: toRowCount(row?.inserted_rows),
  };
}

export async function addAdjustment(
  client: BepBnClient,
  periodId: string,
  input: BepBnAdjustmentInput,
): Promise<void> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason === "") {
    // Reject before touching the DB: the adjustment log always requires a reason.
    throw new Error("Bắt buộc ghi lý do điều chỉnh.");
  }

  const { error } = await client
    .from("payroll_bn_adjustments")
    .insert(toAdjustmentInsertRow(periodId, { ...input, reason }));
  if (error) fail(error);
}

export async function lockPeriod(client: BepBnClient, periodId: string): Promise<void> {
  const { error } = await client.rpc("payroll_bn_set_period_locked", { _period_id: periodId });
  if (error) fail(error);
}

export async function createPeriod(
  client: BepBnClient,
  input: PayrollBnPeriodInput,
): Promise<string> {
  const { data, error } = await client
    .from("payroll_bn_periods")
    .insert(toPeriodInsertRow(input))
    .select("id")
    .single();
  if (error) fail(error);

  const id = (data as { id?: string } | null)?.id;
  if (!id) throw new Error("Không tạo được kỳ lương (không nhận được mã kỳ).");
  return id;
}

export async function upsertEmployee(
  client: BepBnClient,
  periodId: string,
  employee: PayrollEmployee,
): Promise<void> {
  const { error } = await client
    .from("payroll_bn_period_employees")
    .upsert(toEmployeeUpsertRow(periodId, employee), { onConflict: "period_id,employee_code" });
  if (error) fail(error);
}

// ---------------------------------------------------------------------------
// Issue reviews and attendance approval
// ---------------------------------------------------------------------------

export async function listIssueReviews(
  client: BepBnClient,
  periodId: string,
): Promise<IssueReview[]> {
  const { data, error } = await client
    .from("payroll_bn_issue_reviews")
    .select("*")
    .eq("period_id", periodId)
    .order("work_date", { ascending: true });
  if (error) fail(error);

  return asRows<PayrollBnIssueReviewRow>(data).map(mapIssueReviewRow);
}

export async function upsertIssueReview(
  client: BepBnClient,
  periodId: string,
  input: BepBnIssueReviewInput,
): Promise<void> {
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (input.decision === "excluded" && note === "") {
    // Reject before touching the DB: dropping a row always needs a reason.
    throw new Error("Bắt buộc ghi ghi chú khi loại bỏ dòng chấm công.");
  }

  const { error } = await client
    .from("payroll_bn_issue_reviews")
    .upsert(
      toIssueReviewUpsertRow(periodId, { ...input, note: note === "" ? null : note }),
      { onConflict: "period_id,employee_code,work_date,issue_code" },
    );
  if (error) fail(error);
}

export async function setAttendanceApproved(
  client: BepBnClient,
  periodId: string,
  approved: boolean,
): Promise<void> {
  const { error } = await client.rpc("payroll_bn_set_attendance_approved", {
    _period_id: periodId,
    _approved: approved,
  });
  if (error) fail(error);
}

// ---------------------------------------------------------------------------
// Period discovery
// ---------------------------------------------------------------------------

/**
 * Catalogue of the latest period whose date_from is before this period.
 * Returns [] when there is no earlier period.
 */
export async function loadPreviousCatalog(
  client: BepBnClient,
  periodId: string,
): Promise<PayrollEmployee[]> {
  const periodsResult = await client
    .from("payroll_bn_periods")
    .select("id, date_from")
    .order("date_from", { ascending: false });
  if (periodsResult.error) fail(periodsResult.error);

  const periods = asRows<{ id: string; date_from: string }>(periodsResult.data);
  const current = periods.find((period) => period.id === periodId);
  if (!current) return [];
  const previous = periods.find((period) => period.date_from < current.date_from);
  if (!previous) return [];

  const employeesResult = await client
    .from("payroll_bn_period_employees")
    .select("*")
    .eq("period_id", previous.id)
    .order("employee_code", { ascending: true });
  if (employeesResult.error) fail(employeesResult.error);

  return asRows<PayrollBnEmployeeRow>(employeesResult.data).map((row) =>
    mapEmployeeRow(row, previous.date_from),
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Find (or create) the payroll period that covers the month of the rows.
 * The month comes from the earliest date; rows spanning two months are refused.
 */
export async function ensurePeriodForRows(
  client: BepBnClient,
  rows: readonly AttendanceRow[],
): Promise<string> {
  const dates = rows
    .map((row) => row.date)
    .filter((date) => typeof date === "string" && date.length >= 10)
    .sort();
  if (dates.length === 0) {
    throw new Error("Không có ngày chấm công để xác định kỳ lương.");
  }

  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first.slice(0, 7) !== last.slice(0, 7)) {
    throw new Error("File chấm công trải qua nhiều tháng, không xác định được một kỳ lương.");
  }

  const yearText = first.slice(0, 4);
  const monthText = first.slice(5, 7);
  const year = Number(yearText);
  const month = Number(monthText);
  const dateFrom = `${yearText}-${monthText}-01`;
  const dateTo = lastDayOfMonth(year, month);

  const existing = await client
    .from("payroll_bn_periods")
    .select("id")
    .eq("date_from", dateFrom)
    .eq("date_to", dateTo)
    .maybeSingle();
  if (existing.error) fail(existing.error);
  const existingId = (existing.data as { id?: string } | null)?.id;
  if (existingId) return existingId;

  return createPeriod(client, {
    code: `T${monthText}.${yearText}`,
    name: `Kỳ lương tháng ${monthText}/${yearText} — Bếp BN`,
    dateFrom,
    dateTo,
    standardDaysByGroup: { "Văn phòng": 22, "Bếp bánh": 26, "Kho BN": 26 },
    holidays: [],
  });
}

// ---------------------------------------------------------------------------
// Payslip portal: employee contacts + publishing
// ---------------------------------------------------------------------------

/**
 * Normalise a Vietnamese mobile number to 84xxxxxxxxx, or null when it is not a
 * valid mobile. Same semantics as normalizeDealerPhone.
 */
export function normalizePayslipPhone(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+84")) digits = `84${digits.slice(3)}`;
  digits = digits.replace(/\D/g, "");

  if (digits.startsWith("0084")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `84${digits.slice(1)}`;

  return /^84(3|5|7|8|9)\d{8}$/.test(digits) ? digits : null;
}

export async function fetchEmployeeContacts(client: BepBnClient): Promise<BepBnEmployeeContact[]> {
  const { data, error } = await client
    .from("payroll_bn_employee_contacts")
    .select("employee_code, phone_normalized, active")
    .order("employee_code", { ascending: true });
  if (error) fail(error);

  return asRows<{ employee_code: string; phone_normalized: string; active?: boolean | null }>(data).map((row) => ({
    employeeCode: row.employee_code,
    phone: row.phone_normalized,
    active: row.active !== false,
  }));
}

export async function upsertEmployeeContact(
  client: BepBnClient,
  input: BepBnEmployeeContactInput,
): Promise<void> {
  const employeeCode = String(input.employeeCode ?? "").trim();
  if (employeeCode === "") {
    throw new Error("Thiếu mã nhân viên.");
  }

  const phone = normalizePayslipPhone(input.phone);
  if (!phone) {
    throw new Error("Số điện thoại không hợp lệ. Vui lòng nhập số di động Việt Nam.");
  }

  const { error } = await client
    .from("payroll_bn_employee_contacts")
    .upsert(
      { employee_code: employeeCode, phone_normalized: phone, active: Boolean(input.active) },
      { onConflict: "employee_code" },
    );
  if (error) fail(error);
}

export async function deleteEmployeeContact(client: BepBnClient, employeeCode: string): Promise<void> {
  const code = String(employeeCode ?? "").trim();
  if (code === "") {
    throw new Error("Thiếu mã nhân viên.");
  }

  const { error } = await client
    .from("payroll_bn_employee_contacts")
    .delete()
    .eq("employee_code", code);
  if (error) fail(error);
}

/** Convert a publish RPC error into a message an operator can act on. */
export function describePublishPayslipsError(error: unknown): string {
  const raw = (error ?? {}) as DbErrorLike;
  const code = typeof raw.code === "string" ? raw.code : "";
  const message = typeof raw.message === "string" ? raw.message : "";

  if (message.includes("payroll_bn_publish_owner_only") || code === "42501") {
    return "Chỉ chủ sở hữu mới được phát hành phiếu lương.";
  }
  if (message.includes("payroll_bn_period_not_locked") || code === "55006") {
    return "Chỉ phát hành được phiếu lương của kỳ đã chốt.";
  }
  if (message.includes("payroll_bn_payslip_employee_not_in_period") || code === "22023") {
    return "Có nhân viên không thuộc kỳ lương, không thể phát hành phiếu lương.";
  }
  return describeDbError(error);
}

/** Publish (replace) the payslips of a locked period; returns the row count. */
export async function publishPayslips(
  client: BepBnClient,
  periodId: string,
  payslips: readonly PayslipRecord[],
): Promise<number> {
  const { data, error } = await client.rpc("payroll_bn_publish_payslips", {
    _period_id: periodId,
    _payslips: toPublishPayload(payslips),
  });
  if (error) throw new Error(describePublishPayslipsError(error));
  return toRowCount(data);
}

export async function fetchPublishedPayslipCount(
  client: BepBnClient,
  periodId: string,
): Promise<number> {
  const { data, error } = await client
    .from("payroll_bn_payslips")
    .select("id")
    .eq("period_id", periodId);
  if (error) fail(error);
  return asRows<{ id: string }>(data).length;
}
