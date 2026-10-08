import assert from "node:assert/strict";
import test from "node:test";

import {
  addAdjustment,
  createPeriod,
  describeDbError,
  ensurePeriodForRows,
  importAttendance,
  listIssueReviews,
  listPeriods,
  loadPeriodData,
  loadPreviousCatalog,
  lockPeriod,
  setAttendanceApproved,
  upsertEmployee,
  upsertIssueReview,
} from "./db-client.ts";
import type { BepBnClient } from "./db-client.ts";
import type { AttendanceRow, PayrollEmployee } from "./types.ts";

// ---------------------------------------------------------------------------
// Minimal fake Supabase client
// ---------------------------------------------------------------------------

interface FakeResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

type TableHandler = (op: string, payload: unknown, options: unknown) => FakeResult;
type RpcHandler = (args: Record<string, unknown> | undefined) => FakeResult;

interface FakeClientOptions {
  tables?: Record<string, TableHandler>;
  rpc?: Record<string, RpcHandler>;
  calls?: { table: string; op: string }[];
}

function createFakeClient(options: FakeClientOptions = {}): BepBnClient {
  const calls = options.calls;

  const from = (table: string) => {
    let op: string | null = null;
    let payload: unknown;
    let upsertOptions: unknown;

    const run = (): FakeResult => {
      const effectiveOp = op ?? "select";
      if (calls) calls.push({ table, op: effectiveOp });
      const handler = options.tables?.[table];
      return handler
        ? handler(effectiveOp, payload, upsertOptions)
        : { data: [], error: null };
    };

    const query: any = {
      select: () => {
        op = op ?? "select";
        return query;
      },
      insert: (values: unknown) => {
        op = "insert";
        payload = values;
        return query;
      },
      upsert: (values: unknown, settings?: unknown) => {
        op = "upsert";
        payload = values;
        upsertOptions = settings;
        return query;
      },
      update: (values: unknown) => {
        op = "update";
        payload = values;
        return query;
      },
      delete: () => {
        op = "delete";
        return query;
      },
      eq: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: () => Promise.resolve(run()),
      single: () => Promise.resolve(run()),
      then: (resolve: (value: FakeResult) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };

    return query;
  };

  const rpc = (name: string, args?: Record<string, unknown>) => {
    if (calls) calls.push({ table: `rpc:${name}`, op: "rpc" });
    const handler = options.rpc?.[name];
    return Promise.resolve(handler ? handler(args) : { data: null, error: null });
  };

  return { from, rpc } as unknown as BepBnClient;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOMAIN_ROW: AttendanceRow = {
  employeeCode: "E01",
  employeeName: "Nguyễn Văn A",
  date: "2026-08-03",
  checkIn: "08:00:00",
  checkOut: "17:30:00",
  department: "Bếp bánh",
};

const DOMAIN_EMPLOYEE: PayrollEmployee = {
  code: "E01",
  name: "Nguyễn Văn A",
  group: "Bếp bánh",
  employmentType: "official",
  monthlySalary: 10000000,
  hourlyRate: null,
  overtimeRate: 30000,
  allowance: 500000,
  standardDaysOverride: null,
  startDate: "2025-01-01",
  endDate: null,
};

const PERIOD_ROW = {
  id: "period-1",
  period_code: "T08.2026",
  period_name: "Tháng 8/2026",
  date_from: "2026-08-01",
  date_to: "2026-08-31",
  default_standard_days: 26,
  standard_days_by_group: { "Văn phòng": 22 },
  holidays: [],
  rules_config: {},
  status: "draft",
  attendance_approved_at: null,
  attendance_approved_by: null,
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test("listPeriods maps rows into summary objects", async () => {
  const client = createFakeClient({
    tables: {
      payroll_bn_periods: (op) => {
        assert.equal(op, "select");
        return {
          data: [
            PERIOD_ROW,
            { ...PERIOD_ROW, id: "period-2", period_code: "T09.2026", status: "locked" },
          ],
          error: null,
        };
      },
    },
  });

  const periods = await listPeriods(client);
  assert.deepEqual(periods, [
    {
      id: "period-1",
      code: "T08.2026",
      name: "Tháng 8/2026",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      status: "draft",
    },
    {
      id: "period-2",
      code: "T09.2026",
      name: "Tháng 8/2026",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      status: "locked",
    },
  ]);
});

test("loadPeriodData maps the period, catalogue, attendance, imports and adjustments", async () => {
  const client = createFakeClient({
    tables: {
      payroll_bn_periods: () => ({ data: PERIOD_ROW, error: null }),
      payroll_bn_period_employees: () => ({
        data: [
          {
            id: "employee-1",
            period_id: "period-1",
            employee_code: "E01",
            employee_name: "Nguyễn Văn A",
            group_name: "Bếp bánh",
            employment_type: "official",
            monthly_salary: "10000000",
            hourly_rate: null,
            overtime_rate: 30000,
            allowance: 500000,
            standard_days_override: null,
            start_date: "2025-01-01",
            end_date: null,
          },
        ],
        error: null,
      }),
      payroll_bn_attendance_rows: () => ({
        data: [
          {
            id: "row-1",
            period_id: "period-1",
            employee_code: "E01",
            employee_name: "Nguyễn Văn A",
            work_date: "2026-08-03",
            check_in: "08:00:00",
            check_out: "17:30:00",
            department: "Bếp bánh",
          },
        ],
        error: null,
      }),
      payroll_bn_attendance_imports: () => ({
        data: [
          {
            id: "import-1",
            period_id: "period-1",
            file_name: "T08.xlsx",
            sha256: "a".repeat(64),
            row_count: 12,
            imported_at: "2026-09-01T00:00:00.000Z",
          },
        ],
        error: null,
      }),
      payroll_bn_adjustments: () => ({
        data: [
          {
            id: "adjustment-1",
            period_id: "period-1",
            employee_code: "E01",
            field: "work_days",
            old_value: 25,
            new_value: 26.5,
            reason: "Chốt lương",
            actor: "12345678-90ab-cdef-1234-567890abcdef",
            created_at: "2026-09-01T03:04:05.000Z",
          },
        ],
        error: null,
      }),
    },
  });

  const data = await loadPeriodData(client, "period-1");
  assert.ok(data);
  assert.equal(data.id, "period-1");
  assert.equal(data.period.code, "T08.2026");
  assert.deepEqual(data.measures, {});
  assert.equal(data.attendanceApprovedAt, null);
  assert.equal(data.employees.length, 1);
  assert.equal(data.employees[0].code, "E01");
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].checkIn, "08:00:00");
  assert.deepEqual(data.imports, [
    {
      id: "import-1",
      fileName: "T08.xlsx",
      sha256: "a".repeat(64),
      rowCount: 12,
      importedAt: "2026-09-01T00:00:00.000Z",
    },
  ]);
  assert.equal(data.adjustments[0].actor, "12345678");
});

test("loadPeriodData returns null when the period does not exist", async () => {
  const client = createFakeClient({
    tables: { payroll_bn_periods: () => ({ data: null, error: null }) },
  });

  assert.equal(await loadPeriodData(client, "missing"), null);
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

test("importAttendance reports a duplicate file as alreadyImported", async () => {
  const sha256 = "a".repeat(64);
  const client = createFakeClient({
    rpc: {
      payroll_bn_import_attendance: (args) => {
        assert.equal(args?._period_id, "period-1");
        assert.equal(args?._sha256, sha256);
        assert.equal(args?._file_name, "T08.xlsx");
        assert.deepEqual(args?._rows, [
          {
            employee_code: "E01",
            employee_name: "Nguyễn Văn A",
            work_date: "2026-08-03",
            check_in: "08:00:00",
            check_out: "17:30:00",
            department: "Bếp bánh",
          },
        ]);
        return { data: [{ import_id: "import-1", inserted_rows: 0, already_imported: true }], error: null };
      },
    },
  });

  const result = await importAttendance(client, {
    periodId: "period-1",
    fileName: "T08.xlsx",
    sha256,
    rows: [DOMAIN_ROW],
  });

  assert.deepEqual(result, { alreadyImported: true, insertedRows: 0 });
});

test("importAttendance returns the inserted row count for a new file", async () => {
  const client = createFakeClient({
    rpc: {
      payroll_bn_import_attendance: () => ({
        data: [{ import_id: "import-2", inserted_rows: 12, already_imported: false }],
        error: null,
      }),
    },
  });

  const result = await importAttendance(client, {
    periodId: "period-1",
    fileName: "T08.xlsx",
    sha256: "a".repeat(64),
    rows: [DOMAIN_ROW],
  });

  assert.deepEqual(result, { alreadyImported: false, insertedRows: 12 });
});

test("importAttendance turns a locked-period error into a Vietnamese message", async () => {
  const client = createFakeClient({
    rpc: {
      payroll_bn_import_attendance: () => ({
        data: null,
        error: { code: "55006", message: "payroll_bn_period_locked" },
      }),
    },
  });

  await assert.rejects(
    () =>
      importAttendance(client, {
        periodId: "period-1",
        fileName: "T08.xlsx",
        sha256: "a".repeat(64),
        rows: [DOMAIN_ROW],
      }),
    /Kỳ lương đã chốt, không thể thay đổi\./,
  );
});

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

test("addAdjustment rejects an empty reason before calling the DB", async () => {
  const calls: { table: string; op: string }[] = [];
  const client = createFakeClient({
    calls,
    tables: {
      payroll_bn_adjustments: () => {
        throw new Error("the DB must not be called");
      },
    },
  });

  await assert.rejects(
    () =>
      addAdjustment(client, "period-1", {
        employeeCode: "E01",
        field: "work_days",
        value: 24,
        reason: "   ",
      }),
    /Bắt buộc ghi lý do điều chỉnh\./,
  );

  assert.equal(calls.length, 0);
});

test("addAdjustment trims the reason and inserts the adjustment", async () => {
  let inserted: Record<string, unknown> | null = null;
  const calls: { table: string; op: string }[] = [];
  const client = createFakeClient({
    calls,
    tables: {
      payroll_bn_adjustments: (op, payload) => {
        assert.equal(op, "insert");
        inserted = payload as Record<string, unknown>;
        return { data: null, error: null };
      },
    },
  });

  await addAdjustment(client, "period-1", {
    employeeCode: "E01",
    field: "exclude_overtime",
    value: null,
    reason: "  Chốt lương  ",
  });

  assert.deepEqual(inserted, {
    period_id: "period-1",
    employee_code: "E01",
    field: "exclude_overtime",
    new_value: null,
    reason: "Chốt lương",
  });
  assert.deepEqual(calls, [{ table: "payroll_bn_adjustments", op: "insert" }]);
});

// ---------------------------------------------------------------------------
// Lock / create / upsert
// ---------------------------------------------------------------------------

test("lockPeriod reports a permission error", async () => {
  const client = createFakeClient({
    rpc: {
      payroll_bn_set_period_locked: () => ({
        data: null,
        error: { code: "42501", message: "insufficient_privilege: owner required" },
      }),
    },
  });

  await assert.rejects(() => lockPeriod(client, "period-1"), /Bạn không có quyền thực hiện thao tác này\./);
});

test("createPeriod returns the new id and sends the insert row", async () => {
  let inserted: Record<string, unknown> | null = null;
  const client = createFakeClient({
    tables: {
      payroll_bn_periods: (op, payload) => {
        assert.equal(op, "insert");
        inserted = payload as Record<string, unknown>;
        return { data: { id: "new-period" }, error: null };
      },
    },
  });

  const id = await createPeriod(client, {
    code: "T10.2026",
    name: "Tháng 10/2026",
    dateFrom: "2026-10-01",
    dateTo: "2026-10-31",
    standardDaysByGroup: { "Văn phòng": 22, "Bếp bánh": 27, "Kho BN": 27 },
    holidays: ["2026-10-01"],
  });

  assert.equal(id, "new-period");
  assert.deepEqual(inserted, {
    period_code: "T10.2026",
    period_name: "Tháng 10/2026",
    date_from: "2026-10-01",
    date_to: "2026-10-31",
    standard_days_by_group: { "Văn phòng": 22, "Bếp bánh": 27, "Kho BN": 27 },
    holidays: ["2026-10-01"],
  });
});

test("upsertEmployee upserts on period_id + employee_code", async () => {
  let upserted: Record<string, unknown> | null = null;
  let settings: unknown = null;
  const client = createFakeClient({
    tables: {
      payroll_bn_period_employees: (op, payload, options) => {
        assert.equal(op, "upsert");
        upserted = payload as Record<string, unknown>;
        settings = options;
        return { data: null, error: null };
      },
    },
  });

  await upsertEmployee(client, "period-1", DOMAIN_EMPLOYEE);

  assert.equal(upserted?.period_id, "period-1");
  assert.equal(upserted?.employee_code, "E01");
  assert.equal(upserted?.monthly_salary, 10000000);
  assert.equal(upserted && "daily_rate" in upserted, false);
  assert.deepEqual(settings, { onConflict: "period_id,employee_code" });
});

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

test("describeDbError maps lock, permission, missing period and duplicate day", () => {
  assert.equal(
    describeDbError({ code: "55006", message: "payroll_bn_period_locked" }),
    "Kỳ lương đã chốt, không thể thay đổi.",
  );
  assert.equal(
    describeDbError({ code: "42501", message: "insufficient_privilege: payroll edit required" }),
    "Bạn không có quyền thực hiện thao tác này.",
  );
  assert.equal(
    describeDbError({ code: "P0002", message: "payroll_bn_period_not_found" }),
    "Không tìm thấy kỳ lương.",
  );
  assert.equal(
    describeDbError({ code: "23505", message: "payroll_bn_duplicate_employee_day" }),
    "Trùng ngày chấm công của cùng một nhân viên trong file.",
  );
  assert.equal(
    describeDbError({ code: "22023", message: "payroll_bn_date_out_of_period_or_missing_key" }),
    "Có dòng chấm công nằm ngoài khoảng ngày của kỳ hoặc thiếu mã nhân viên/ngày.",
  );
});

// ---------------------------------------------------------------------------
// Issue reviews / attendance approval
// ---------------------------------------------------------------------------

test("loadPeriodData exposes the attendance approval timestamp", async () => {
  const client = createFakeClient({
    tables: {
      payroll_bn_periods: () => ({
        data: { ...PERIOD_ROW, attendance_approved_at: "2026-09-02T10:00:00.000Z" },
        error: null,
      }),
      payroll_bn_period_employees: () => ({ data: [], error: null }),
      payroll_bn_attendance_rows: () => ({ data: [], error: null }),
      payroll_bn_attendance_imports: () => ({ data: [], error: null }),
      payroll_bn_adjustments: () => ({ data: [], error: null }),
    },
  });

  const data = await loadPeriodData(client, "period-1");
  assert.equal(data?.attendanceApprovedAt, "2026-09-02T10:00:00.000Z");
});

test("listIssueReviews maps rows and orders by work date", async () => {
  const client = createFakeClient({
    tables: {
      payroll_bn_issue_reviews: (op) => {
        assert.equal(op, "select");
        return {
          data: [
            {
              id: "review-1",
              period_id: "period-1",
              employee_code: "E01",
              work_date: "2026-09-03",
              issue_code: "missing_check_out",
              decision: "excluded",
              note: "chốt lương",
            },
          ],
          error: null,
        };
      },
    },
  });

  assert.deepEqual(await listIssueReviews(client, "period-1"), [
    {
      employeeCode: "E01",
      workDate: "2026-09-03",
      issueCode: "missing_check_out",
      decision: "excluded",
      note: "chốt lương",
    },
  ]);
});

test("upsertIssueReview trims the note and upserts on the unique key", async () => {
  let payload: Record<string, unknown> | null = null;
  let settings: unknown = null;
  const client = createFakeClient({
    tables: {
      payroll_bn_issue_reviews: (op, values, options) => {
        assert.equal(op, "upsert");
        payload = values as Record<string, unknown>;
        settings = options;
        return { data: null, error: null };
      },
    },
  });

  await upsertIssueReview(client, "period-1", {
    employeeCode: "E01",
    workDate: "2026-09-03",
    issueCode: "missing_check_out",
    decision: "excluded",
    note: "  chốt lương  ",
  });

  assert.deepEqual(payload, {
    period_id: "period-1",
    employee_code: "E01",
    work_date: "2026-09-03",
    issue_code: "missing_check_out",
    decision: "excluded",
    note: "chốt lương",
  });
  assert.deepEqual(settings, {
    onConflict: "period_id,employee_code,work_date,issue_code",
  });
});

test("upsertIssueReview rejects an exclusion without a note before calling the DB", async () => {
  const calls: { table: string; op: string }[] = [];
  const client = createFakeClient({
    calls,
    tables: {
      payroll_bn_issue_reviews: () => {
        throw new Error("the DB must not be called");
      },
    },
  });

  await assert.rejects(
    () =>
      upsertIssueReview(client, "period-1", {
        employeeCode: "E01",
        workDate: "2026-09-03",
        issueCode: "missing_check_out",
        decision: "excluded",
        note: "   ",
      }),
    /Bắt buộc ghi ghi chú khi loại bỏ dòng chấm công\./,
  );

  assert.equal(calls.length, 0);
});

test("setAttendanceApproved forwards the period and the flag to the RPC", async () => {
  let args: Record<string, unknown> | undefined;
  const client = createFakeClient({
    rpc: {
      payroll_bn_set_attendance_approved: (input) => {
        args = input;
        return { data: null, error: null };
      },
    },
  });

  await setAttendanceApproved(client, "period-1", true);
  assert.deepEqual(args, { _period_id: "period-1", _approved: true });

  await setAttendanceApproved(client, "period-1", false);
  assert.deepEqual(args, { _period_id: "period-1", _approved: false });
});

// ---------------------------------------------------------------------------
// Previous catalogue / period discovery
// ---------------------------------------------------------------------------

test("loadPreviousCatalog returns the catalogue of the latest earlier period", async () => {
  const client = createFakeClient({
    tables: {
      payroll_bn_periods: () => ({
        data: [
          { id: "period-2", date_from: "2026-09-01" },
          { id: "period-1", date_from: "2026-08-01" },
        ],
        error: null,
      }),
      payroll_bn_period_employees: () => ({
        data: [
          {
            period_id: "period-1",
            employee_code: "E01",
            employee_name: "Nguyễn Văn A",
            group_name: "Bếp bánh",
            employment_type: "official",
            monthly_salary: 10000000,
            hourly_rate: null,
            overtime_rate: 30000,
            allowance: 500000,
            standard_days_override: null,
            start_date: "2025-01-01",
            end_date: null,
          },
        ],
        error: null,
      }),
    },
  });

  const catalog = await loadPreviousCatalog(client, "period-2");
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].code, "E01");
  assert.equal(catalog[0].monthlySalary, 10000000);
  // Mapped against the previous period's start date, so the row is still active.
  assert.equal(catalog[0].terminated, false);
});

test("loadPreviousCatalog returns [] when there is no earlier period", async () => {
  const client = createFakeClient({
    tables: {
      payroll_bn_periods: () => ({
        data: [{ id: "period-1", date_from: "2026-08-01" }],
        error: null,
      }),
    },
  });

  assert.deepEqual(await loadPreviousCatalog(client, "period-1"), []);
});

test("ensurePeriodForRows returns the existing period for the month", async () => {
  let inserted = false;
  const client = createFakeClient({
    tables: {
      payroll_bn_periods: (op) => {
        if (op === "insert") {
          inserted = true;
          return { data: { id: "created" }, error: null };
        }
        return { data: { id: "existing-period" }, error: null };
      },
    },
  });

  const id = await ensurePeriodForRows(client, [DOMAIN_ROW]);
  assert.equal(id, "existing-period");
  assert.equal(inserted, false);
});

test("ensurePeriodForRows creates the period with the derived code and standard days", async () => {
  let payload: Record<string, unknown> | null = null;
  const client = createFakeClient({
    tables: {
      payroll_bn_periods: (op, values) => {
        if (op === "insert") {
          payload = values as Record<string, unknown>;
          return { data: { id: "new-period" }, error: null };
        }
        return { data: null, error: null };
      },
    },
  });

  const id = await ensurePeriodForRows(client, [
    { ...DOMAIN_ROW, date: "2026-09-03" },
    { ...DOMAIN_ROW, date: "2026-09-27" },
  ]);

  assert.equal(id, "new-period");
  assert.deepEqual(payload, {
    period_code: "T09.2026",
    period_name: "Kỳ lương tháng 09/2026 — Bếp BN",
    date_from: "2026-09-01",
    date_to: "2026-09-30",
    standard_days_by_group: { "Văn phòng": 22, "Bếp bánh": 26, "Kho BN": 26 },
    holidays: [],
  });
});

test("ensurePeriodForRows rejects rows spanning two months", async () => {
  const client = createFakeClient({});
  await assert.rejects(
    () =>
      ensurePeriodForRows(client, [
        { ...DOMAIN_ROW, date: "2026-09-30" },
        { ...DOMAIN_ROW, date: "2026-10-01" },
      ]),
    /trải qua nhiều tháng/,
  );
});

test("ensurePeriodForRows rejects an empty file", async () => {
  const client = createFakeClient({});
  await assert.rejects(() => ensurePeriodForRows(client, []), /Không có ngày chấm công/);
});
