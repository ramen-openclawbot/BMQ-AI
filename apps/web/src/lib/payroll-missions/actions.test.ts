// Action orchestration tests (node:test, fake Supabase client).
//
// Covers: the previous-period lookup, skipping manager templates, and the
// mandatory re-read of the server snapshot when a write fails.

import assert from "node:assert/strict";
import test from "node:test";

import type { BepBnClient } from "../payroll-bn/db-client.ts";
import { suggestFromPrevious, toDomainMissionTemplates } from "./actions.ts";
import type { MissionTemplateRecord } from "./types.ts";

// ---------------------------------------------------------------------------
// Minimal fake Supabase client (same shape as db-client.test.ts)
// ---------------------------------------------------------------------------

interface FakeResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

type TableHandler = (
  op: string,
  payload: unknown,
  options: unknown,
  filters: [string, unknown][],
) => FakeResult;
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
    const filters: [string, unknown][] = [];

    const run = (): FakeResult => {
      const effectiveOp = op ?? "select";
      if (calls) calls.push({ table, op: effectiveOp });
      const handler = options.tables?.[table];
      return handler
        ? handler(effectiveOp, payload, upsertOptions, filters)
        : { data: [], error: null };
    };

    const query: any = {
      select: () => query,
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
      delete: () => query,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return query;
      },
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

const CURRENT_PERIOD = {
  id: "cur",
  period_code: "T10.2026",
  period_name: "Kỳ lương tháng 10/2026 — Bếp BN",
  date_from: "2026-10-01",
  date_to: "2026-10-31",
  default_standard_days: 26,
  standard_days_by_group: { "Kho BN": 26 },
  holidays: [],
  rules_config: {},
  status: "draft",
  attendance_approved_at: null,
};

const PREVIOUS_PERIOD = {
  ...CURRENT_PERIOD,
  id: "prev",
  period_code: "T09.2026",
  period_name: "Kỳ lương tháng 09/2026 — Bếp BN",
  date_from: "2026-09-01",
  date_to: "2026-09-30",
};

const EMPLOYEE = {
  id: "employee-1",
  period_id: "cur",
  employee_code: "00002",
  employee_name: "Hùng Kim Ngọc",
  group_name: "Kho BN",
  employment_type: "part_time",
  monthly_salary: null,
  hourly_rate: 23000,
  overtime_rate: null,
  allowance: null,
  standard_days_override: null,
  start_date: null,
  end_date: null,
};

const ATTENDANCE = {
  id: "att-1",
  period_id: "prev",
  employee_code: "00002",
  employee_name: "Ngoc",
  work_date: "2026-09-03",
  check_in: "08:05:00",
  check_out: "17:30:00",
  department: "Kho BN",
  shift: "HC",
  late_minutes: 5,
  early_minutes: 0,
};

const DUNGGIO_TEMPLATE = {
  id: "tpl-dung",
  period_id: "cur",
  code: "T-DUNGGIO",
  name: "Đúng giờ",
  description: "Đi làm đúng giờ",
  mode: "pay",
  verification: "auto",
  applies_to: {},
  params: { dung_sai_phut: 0, nguong_de_xuat: 1 },
  reward_vnd: 100000,
  accept_deadline: null,
  prorate_allowed: false,
  enabled: true,
};

const QL_TEMPLATE = {
  ...DUNGGIO_TEMPLATE,
  id: "tpl-ql",
  code: "T-QL",
  name: "Quản lý xác nhận",
  mode: "pay",
  verification: "manager",
};

function baseTables(): Record<string, TableHandler> {
  return {
    payroll_bn_periods: (_op, _payload, _options, filters) =>
      filters.some(([column]) => column === "id")
        ? { data: { ...CURRENT_PERIOD }, error: null }
        : { data: [CURRENT_PERIOD, PREVIOUS_PERIOD], error: null },
    payroll_bn_period_employees: () => ({ data: [EMPLOYEE], error: null }),
    payroll_bn_attendance_rows: () => ({ data: [ATTENDANCE], error: null }),
    payroll_bn_attendance_imports: () => ({ data: [], error: null }),
    payroll_bn_adjustments: () => ({ data: [], error: null }),
    payroll_bn_mission_templates: () => ({
      data: [DUNGGIO_TEMPLATE, QL_TEMPLATE],
      error: null,
    }),
    payroll_bn_mission_settings: () => ({ data: null, error: null }),
    payroll_bn_missions: () => ({ data: [], error: null }),
    payroll_bn_mission_bonuses: () => ({ data: [], error: null }),
    payroll_bn_mission_draws: () => ({ data: null, error: null }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("bỏ qua mẫu quản lý và mẫu tắt khi dựng template gợi ý", () => {
  const records = [DUNGGIO_TEMPLATE, QL_TEMPLATE, { ...DUNGGIO_TEMPLATE, id: "off", enabled: false }]
    .map(
      (row): MissionTemplateRecord => ({
        id: row.id,
        periodId: row.period_id,
        code: row.code,
        name: row.name,
        description: row.description,
        mode: row.mode,
        verification: row.verification,
        appliesTo: row.applies_to,
        params: row.params,
        rewardVnd: row.reward_vnd,
        acceptDeadline: row.accept_deadline,
        prorateAllowed: row.prorate_allowed,
        enabled: row.enabled,
      }),
    );

  const templates = toDomainMissionTemplates(records);
  assert.deepEqual(templates.map((template) => template.code), ["T-DUNGGIO"]);
});

test("suggestFromPrevious dùng chấm công kỳ liền trước và chỉ gửi mẫu auto", async () => {
  let suggestArgs: Record<string, unknown> | undefined;
  const client = createFakeClient({
    tables: baseTables(),
    rpc: {
      payroll_bn_mission_suggest: (args) => {
        suggestArgs = args;
        return { data: 1, error: null };
      },
    },
  });

  const result = await suggestFromPrevious(client, "cur");

  assert.equal(result.value, 1);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].employeeCode, "00002");
  assert.equal(result.suggestions[0].templateCode, "T-DUNGGIO");
  assert.equal(result.suggestions[0].reasonText, "1 ngày trễ");

  const payload = suggestArgs?._suggestions as { template_code: string }[];
  assert.equal(payload.length, 1);
  assert.equal(payload[0].template_code, "T-DUNGGIO");
  assert.equal(
    payload.some((item) => item.template_code === "T-QL"),
    false,
  );
});

test("suggestFromPrevious đọc lại state khi RPC lỗi rồi mới báo lỗi", async () => {
  const calls: { table: string; op: string }[] = [];
  const client = createFakeClient({
    calls,
    tables: baseTables(),
    rpc: {
      payroll_bn_mission_suggest: () => ({
        data: null,
        error: { code: "55006", message: "payroll_bn_period_locked" },
      }),
    },
  });

  await assert.rejects(() => suggestFromPrevious(client, "cur"), /đã chốt/);

  // One read for the initial snapshot, one for the mandatory re-read after the error.
  const templateReads = calls.filter(
    (call) => call.table === "payroll_bn_mission_templates" && call.op === "select",
  );
  assert.ok(templateReads.length >= 2, `expected a re-read, got ${templateReads.length}`);
  const suggestIndex = calls.findIndex((call) => call.table === "rpc:payroll_bn_mission_suggest");
  const readsAfterRpc = calls
    .slice(suggestIndex + 1)
    .filter((call) => call.table === "payroll_bn_mission_templates").length;
  assert.ok(readsAfterRpc >= 1, "the snapshot must be re-read after the failed write");
});
