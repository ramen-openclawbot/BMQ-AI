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
  mapPeriodRow,
  normalizePeriodStatus,
  toAdjustmentInsertRow,
  toAttendancePayloadRow,
  toEmployeeUpsertRow,
  toPeriodInsertRow,
} from "./db-mapping.ts";
import type {
  PayrollBnAdjustmentRow,
  PayrollBnAttendanceImportRow,
  PayrollBnAttendanceRow,
  PayrollBnEmployeeRow,
  PayrollBnPeriodInput,
  PayrollBnPeriodRow,
} from "./db-mapping.ts";
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
