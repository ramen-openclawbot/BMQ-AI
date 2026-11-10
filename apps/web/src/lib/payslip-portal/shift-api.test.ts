import assert from "node:assert/strict";
import test from "node:test";

import { createPayrollShiftApi, normalizeShiftWeek } from "./shift-api.ts";
import { PAYSLIP_DEVICE_ID_STORAGE_KEY } from "./device-id.ts";
import { PAYSLIP_SESSION_STORAGE_KEY } from "./api.ts";
import { PayslipSessionExpiredError } from "./types.ts";
import type { PayslipStorage } from "./api.ts";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | null;
}

interface FakeResponse {
  status?: number;
  body?: unknown;
}

function createFakeFetch(responses: FakeResponse[]) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers,
      body: (init?.body as BodyInit | null | undefined) ?? null,
    });
    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function memoryStorage(): PayslipStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

const BASE = "https://ref.supabase.co/functions/v1";

function signedInStorage(): PayslipStorage {
  const storage = memoryStorage();
  storage.setItem(PAYSLIP_SESSION_STORAGE_KEY, "psp_abc");
  return storage;
}

function weekPayload() {
  return {
    success: true,
    week: {
      eligible: true,
      week: {
        week_start: "2026-11-09",
        status: "open",
        opens_at: "2026-11-02T17:00:00+00:00",
        deadline: "2026-11-07T05:00:00+00:00",
        can_edit: true,
        closed_dates: ["2026-11-12"],
      },
      shift_types: [
        {
          code: "sang",
          label: "Sáng",
          start_time: "07:00",
          end_time: "11:00",
          sort: 1,
          active: true,
        },
      ],
      days: [
        {
          work_date: "2026-11-09",
          closed: false,
          my: {
            shift_code: "sang",
            state: "registered",
            source: "employee",
            previous_shift_code: null,
          },
          shifts: [
            {
              code: "sang",
              registered: 3,
              needed: 4,
              full: false,
              need_more: true,
            },
          ],
          quota_groups: [
            { quota_group: "morning", registered: 3, needed: 4, full: false },
          ],
          off_count: 1,
          off_full: false,
          total_staff: 3,
        },
      ],
      suggestion: [
        {
          work_date: "2026-11-09",
          shift_code: "sang",
          state: "registered",
          carried: true,
        },
      ],
      current_week: [
        {
          work_date: "2026-11-02",
          shift_code: null,
          state: "registered",
          source: "manager",
        },
      ],
      requests: [
        {
          id: "req-1",
          work_date: "2026-11-10",
          kind: "change",
          from_shift_code: "sang",
          to_shift_code: "chieu",
          reason: "Đổi lịch gia đình",
          state: "pending",
          decision_note: null,
          created_at: "2026-11-06T08:00:00+00:00",
          decided_at: null,
        },
      ],
      can_request: true,
    },
  };
}

test("getShiftWeek sends session/device headers and normalises the payload", async () => {
  const storage = signedInStorage();
  const { fetchImpl, calls } = createFakeFetch([{ body: weekPayload() }]);
  const api = createPayrollShiftApi({ baseUrl: BASE, anonKey: "anon", fetch: fetchImpl, storage });

  const week = await api.getShiftWeek();
  assert.equal(calls[0].url, `${BASE}/payslip-shifts`);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["x-payslip-session"], "psp_abc");
  assert.match(calls[0].headers["x-payslip-device"], /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].headers["x-payslip-device"], storage.getItem(PAYSLIP_DEVICE_ID_STORAGE_KEY));
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    action: "get",
    session_token: "psp_abc",
  });

  assert.equal(week.eligible, true);
  assert.equal(week.week.weekStart, "2026-11-09");
  assert.equal(week.week.status, "open");
  assert.equal(week.week.canEdit, true);
  assert.deepEqual(week.week.closedDates, ["2026-11-12"]);
  assert.equal(week.shiftTypes[0].startTime, "07:00");
  assert.equal(week.days[0].my?.shiftCode, "sang");
  assert.equal(week.days[0].shifts[0].needMore, true);
  assert.equal(week.days[0].quotaGroups[0].quotaGroup, "morning");
  assert.equal(week.days[0].offCount, 1);
  assert.equal(week.days[0].totalStaff, 3);
  assert.equal(week.suggestion[0].carried, true);
  assert.equal(week.currentWeek[0].shiftCode, null);
  assert.equal(week.currentWeek[0].source, "manager");
  assert.equal(week.canRequest, true);
  assert.equal(week.requests[0].id, "req-1");
  assert.equal(week.requests[0].kind, "change");
  assert.equal(week.requests[0].fromShiftCode, "sang");
  assert.equal(week.requests[0].toShiftCode, "chieu");
  assert.equal(week.requests[0].state, "pending");
});

test("getShiftWeek forwards an explicit week_start", async () => {
  const { fetchImpl, calls } = createFakeFetch([{ body: weekPayload() }]);
  const api = createPayrollShiftApi({ baseUrl: BASE, fetch: fetchImpl, storage: signedInStorage() });
  await api.getShiftWeek("2026-11-16");
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    action: "get",
    week_start: "2026-11-16",
    session_token: "psp_abc",
  });
});

test("submitShiftRegistration posts snake_case entries and maps the response", async () => {
  const storage = signedInStorage();
  const payload = weekPayload();
  payload.week.days[0].my = {
    shift_code: null,
    state: "waitlist",
    source: "employee",
    previous_shift_code: "sang",
  };
  const { fetchImpl, calls } = createFakeFetch([{ body: payload }]);
  const api = createPayrollShiftApi({ baseUrl: BASE, anonKey: "anon", fetch: fetchImpl, storage });

  const week = await api.submitShiftRegistration("2026-11-09", [
    { workDate: "2026-11-09", shiftCode: null },
    { workDate: "2026-11-10", shiftCode: "sang" },
  ]);
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    action: "submit",
    week_start: "2026-11-09",
    entries: [
      { work_date: "2026-11-09", shift_code: null },
      { work_date: "2026-11-10", shift_code: "sang" },
    ],
    session_token: "psp_abc",
  });
  assert.equal(week.days[0].my?.state, "waitlist");
  assert.equal(week.days[0].my?.previousShiftCode, "sang");
});

test("a 401 clears the session and throws PayslipSessionExpiredError", async () => {
  const storage = signedInStorage();
  const { fetchImpl } = createFakeFetch([{ status: 401, body: { code: "session_invalid" } }]);
  const api = createPayrollShiftApi({ baseUrl: BASE, fetch: fetchImpl, storage });

  await assert.rejects(() => api.getShiftWeek(), PayslipSessionExpiredError);
  assert.equal(storage.getItem(PAYSLIP_SESSION_STORAGE_KEY), null);
});

test("no stored session never calls the network", async () => {
  const { fetchImpl, calls } = createFakeFetch([]);
  const api = createPayrollShiftApi({ baseUrl: BASE, fetch: fetchImpl, storage: memoryStorage() });
  await assert.rejects(() => api.getShiftWeek(), PayslipSessionExpiredError);
  assert.equal(calls.length, 0);
});

test("a server error message is surfaced to the employee", async () => {
  const { fetchImpl } = createFakeFetch([
    { status: 409, body: { message: "Đã hết hạn đăng ký ca tuần này.", code: "shift_registration_closed" } },
  ]);
  const api = createPayrollShiftApi({ baseUrl: BASE, fetch: fetchImpl, storage: signedInStorage() });
  await assert.rejects(
    () => api.submitShiftRegistration("2026-11-09", []),
    /Đã hết hạn đăng ký ca tuần này\./,
  );
});

test("normalizeShiftWeek tolerates a missing payload", () => {
  assert.deepEqual(normalizeShiftWeek(null), {
    eligible: false,
    week: {
      weekStart: "",
      status: "open",
      opensAt: null,
      deadline: null,
      canEdit: false,
      closedDates: [],
    },
    shiftTypes: [],
    days: [],
    suggestion: [],
    currentWeek: [],
    requests: [],
    canRequest: false,
  });
  assert.equal(normalizeShiftWeek({ week: null }).eligible, false);
  const partial = normalizeShiftWeek({ week: { eligible: true } });
  assert.deepEqual(partial.requests, []);
  assert.equal(partial.canRequest, false);
});

test("requestChange posts the request and normalises request + coverage", async () => {
  const storage = signedInStorage();
  const { fetchImpl, calls } = createFakeFetch([{
    body: {
      success: true,
      request: {
        id: "req-1",
        work_date: "2026-11-10",
        kind: "change",
        from_shift_code: "sang",
        to_shift_code: "chieu",
        reason: "Đổi lịch gia đình",
        state: "pending",
        decision_note: null,
        created_at: "2026-11-06T08:00:00+00:00",
        decided_at: null,
      },
      coverage: {
        work_date: "2026-11-10",
        shifts: [{ code: "chieu", registered: 2, needed: 3, full: false, need_more: true }],
        quota_groups: [],
        off_count: 0,
        total_staff: 2,
      },
    },
  }]);
  const api = createPayrollShiftApi({ baseUrl: BASE, anonKey: "anon", fetch: fetchImpl, storage });

  const result = await api.requestChange({
    workDate: "2026-11-10",
    kind: "change",
    toShiftCode: "chieu",
    reason: "Đổi lịch gia đình",
  });
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    action: "request",
    work_date: "2026-11-10",
    kind: "change",
    to_shift_code: "chieu",
    reason: "Đổi lịch gia đình",
    session_token: "psp_abc",
  });
  assert.equal(result.request?.state, "pending");
  assert.equal(result.request?.fromShiftCode, "sang");
  assert.equal(result.coverage?.workDate, "2026-11-10");
  assert.equal(result.coverage?.totalStaff, 2);
});

test("cancelRequest posts the request id and normalises the cancelled request", async () => {
  const storage = signedInStorage();
  const { fetchImpl, calls } = createFakeFetch([{
    body: {
      success: true,
      request: {
        id: "req-1",
        work_date: "2026-11-10",
        kind: "leave",
        from_shift_code: "sang",
        to_shift_code: null,
        reason: "Việc nhà",
        state: "cancelled",
        decision_note: null,
        created_at: "2026-11-06T08:00:00+00:00",
        decided_at: "2026-11-06T09:00:00+00:00",
      },
    },
  }]);
  const api = createPayrollShiftApi({ baseUrl: BASE, anonKey: "anon", fetch: fetchImpl, storage });

  const request = await api.cancelRequest("req-1");
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    action: "cancel_request",
    request_id: "req-1",
    session_token: "psp_abc",
  });
  assert.equal(request?.id, "req-1");
  assert.equal(request?.state, "cancelled");
  assert.equal(request?.kind, "leave");
});
