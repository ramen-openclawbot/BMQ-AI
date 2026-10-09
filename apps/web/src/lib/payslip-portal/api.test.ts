import assert from "node:assert/strict";
import test from "node:test";

import { createPayslipApiSource, PAYSLIP_SESSION_STORAGE_KEY } from "./api.ts";
import { PayslipSessionExpiredError } from "./types.ts";
import type { PayslipStorage } from "./api.ts";

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

interface FakeResponse {
  status?: number;
  body?: unknown;
}

function createFakeFetch(responses: FakeResponse[]) {
  const calls: RecordedCall[] = [];
  let index = 0;

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
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

function createMemoryStorage(): PayslipStorage {
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

test("startOtp posts the phone and returns the server's generic message", async () => {
  const { fetchImpl, calls } = createFakeFetch([
    { body: { success: true, otp_required: true, message: "Gửi OTP nếu số tồn tại." } },
  ]);
  const source = createPayslipApiSource({ baseUrl: BASE, anonKey: "anon", fetch: fetchImpl, storage: createMemoryStorage() });

  const result = await source.startOtp("0901234567");
  assert.deepEqual(result, { message: "Gửi OTP nếu số tồn tại." });
  assert.equal(calls[0].url, `${BASE}/payslip-auth-start`);
  assert.deepEqual(calls[0].body, { phone: "0901234567" });
  assert.equal(calls[0].headers.apikey, "anon");
});

test("startOtp falls back to the generic message when the server omits it", async () => {
  const { fetchImpl } = createFakeFetch([{ body: { success: true } }]);
  const source = createPayslipApiSource({ baseUrl: BASE, fetch: fetchImpl, storage: createMemoryStorage() });
  const result = await source.startOtp("0901234567");
  assert.match(result.message, /Nếu số điện thoại/);
});

test("verifyOtp stores the session token under bmq_payslip_session", async () => {
  const storage = createMemoryStorage();
  const { fetchImpl, calls } = createFakeFetch([{ body: { success: true, session_token: "psp_abc" } }]);
  const source = createPayslipApiSource({ baseUrl: BASE, fetch: fetchImpl, storage });

  await source.verifyOtp("0901234567", "123456");
  assert.equal(storage.getItem(PAYSLIP_SESSION_STORAGE_KEY), "psp_abc");
  assert.deepEqual(calls[0].body, { phone: "0901234567", otp: "123456" });
});

test("verifyOtp surfaces the server error", async () => {
  const { fetchImpl } = createFakeFetch([{ status: 401, body: { error: "Mã OTP không đúng." } }]);
  const source = createPayslipApiSource({ baseUrl: BASE, fetch: fetchImpl, storage: createMemoryStorage() });
  await assert.rejects(() => source.verifyOtp("0901234567", "000000"), /Mã OTP không đúng\./);
});

test("restoreSession returns null when there is no stored token", async () => {
  const { fetchImpl, calls } = createFakeFetch([]);
  const source = createPayslipApiSource({ baseUrl: BASE, fetch: fetchImpl, storage: createMemoryStorage() });

  assert.equal(await source.restoreSession(), null);
  assert.equal(calls.length, 0);
});

test("restoreSession calls payslip-list and returns the employee", async () => {
  const storage = createMemoryStorage();
  storage.setItem(PAYSLIP_SESSION_STORAGE_KEY, "psp_abc");
  const { fetchImpl, calls } = createFakeFetch([
    { body: { success: true, employee: { code: "E01", name: "Nguyễn Văn A", groupName: "Bếp bánh" }, payslips: [] } },
  ]);
  const source = createPayslipApiSource({ baseUrl: BASE, fetch: fetchImpl, storage });

  assert.deepEqual(await source.restoreSession(), { code: "E01", name: "Nguyễn Văn A", groupName: "Bếp bánh" });
  assert.equal(calls[0].url, `${BASE}/payslip-list`);
  assert.deepEqual(calls[0].body, { session_token: "psp_abc" });
});

test("restoreSession clears the token and throws on 401", async () => {
  const storage = createMemoryStorage();
  storage.setItem(PAYSLIP_SESSION_STORAGE_KEY, "psp_expired");
  const { fetchImpl } = createFakeFetch([{ status: 401, body: { error: "expired", code: "session_invalid" } }]);
  const source = createPayslipApiSource({ baseUrl: BASE, fetch: fetchImpl, storage });

  await assert.rejects(() => source.restoreSession(), PayslipSessionExpiredError);
  assert.equal(storage.getItem(PAYSLIP_SESSION_STORAGE_KEY), null);
});

test("listPayslips maps the payload and never asks the body for the employee code", async () => {
  const storage = createMemoryStorage();
  storage.setItem(PAYSLIP_SESSION_STORAGE_KEY, "psp_abc");
  const payslip = {
    periodId: "period-sep",
    periodName: "Kỳ lương tháng 09/2026 — Bếp BN",
    dateFrom: "2026-09-01",
    dateTo: "2026-09-30",
    publishedAt: "2026-10-01T00:00:00.000Z",
    employeeCode: "E01",
    employeeName: "Nguyễn Văn A",
    netPay: 7192000,
    lines: [{ key: "gross_pay", label: "Tổng thu nhập", value: 7192307.69, unit: "vnd" }],
    note: "Chốt lương",
  };
  const { fetchImpl, calls } = createFakeFetch([
    {
      body: {
        success: true,
        employee: { code: "E01", name: "Nguyễn Văn A", groupName: "Bếp bánh" },
        payslips: [payslip],
      },
    },
  ]);
  const source = createPayslipApiSource({ baseUrl: BASE, fetch: fetchImpl, storage });

  const result = await source.listPayslips();
  assert.deepEqual(result.employee, { code: "E01", name: "Nguyễn Văn A", groupName: "Bếp bánh" });
  assert.deepEqual(result.payslips, [payslip]);
  assert.deepEqual(calls[0].body, { session_token: "psp_abc" });
});

test("listPayslips without a token throws PayslipSessionExpiredError", async () => {
  const { fetchImpl, calls } = createFakeFetch([]);
  const source = createPayslipApiSource({ baseUrl: BASE, fetch: fetchImpl, storage: createMemoryStorage() });
  await assert.rejects(() => source.listPayslips(), PayslipSessionExpiredError);
  assert.equal(calls.length, 0);
});

test("logout revokes the session and always clears the local token", async () => {
  const storage = createMemoryStorage();
  storage.setItem(PAYSLIP_SESSION_STORAGE_KEY, "psp_abc");
  const { fetchImpl, calls } = createFakeFetch([{ body: { success: true } }]);
  const source = createPayslipApiSource({ baseUrl: BASE, fetch: fetchImpl, storage });

  await source.logout();
  assert.equal(calls[0].url, `${BASE}/payslip-auth-logout`);
  assert.deepEqual(calls[0].body, { session_token: "psp_abc" });
  assert.equal(storage.getItem(PAYSLIP_SESSION_STORAGE_KEY), null);
});

test("listMissions maps the payload and posts only the session token", async () => {
  const storage = createMemoryStorage();
  storage.setItem(PAYSLIP_SESSION_STORAGE_KEY, "psp_abc");
  const mission = {
    id: "m1",
    periodId: "period-oct",
    code: "T-DUNGGIO",
    name: "Đúng giờ",
    description: "Đi làm đúng giờ theo chấm công ca hành chính.",
    mode: "pay",
    status: "published",
    reason: "7 ngày trễ",
    rewardVnd: 100000,
    acceptDeadline: "2026-10-05T17:00:00+07:00",
    acceptedAt: null,
  };
  const { fetchImpl, calls } = createFakeFetch([
    { body: { success: true, employeeCode: "E01", missions: [mission] } },
  ]);
  const source = createPayslipApiSource({ baseUrl: BASE, fetch: fetchImpl, storage });

  assert.deepEqual(await source.listMissions(), [mission]);
  assert.equal(calls[0].url, `${BASE}/payslip-missions`);
  assert.deepEqual(calls[0].body, { session_token: "psp_abc" });
});

test("acceptMission posts mission_id and returns the server status", async () => {
  const storage = createMemoryStorage();
  storage.setItem(PAYSLIP_SESSION_STORAGE_KEY, "psp_abc");
  const { fetchImpl, calls } = createFakeFetch([
    {
      body: {
        success: true,
        mission: { id: "m1", periodId: "period-oct", status: "accepted", acceptedAt: "2026-10-04T10:00:00.000Z" },
      },
    },
  ]);
  const source = createPayslipApiSource({ baseUrl: BASE, fetch: fetchImpl, storage });

  assert.deepEqual(await source.acceptMission("m1"), {
    id: "m1",
    periodId: "period-oct",
    status: "accepted",
    acceptedAt: "2026-10-04T10:00:00.000Z",
  });
  assert.deepEqual(calls[0].body, { session_token: "psp_abc", mission_id: "m1" });
});

test("acceptMission reads the list again before surfacing an error", async () => {
  const storage = createMemoryStorage();
  storage.setItem(PAYSLIP_SESSION_STORAGE_KEY, "psp_abc");
  const { fetchImpl, calls } = createFakeFetch([
    { status: 400, body: { error: "Không nhận được nhiệm vụ." } },
    { body: { success: true, missions: [] } },
  ]);
  const source = createPayslipApiSource({ baseUrl: BASE, fetch: fetchImpl, storage });

  await assert.rejects(() => source.acceptMission("m1"), /Không nhận được nhiệm vụ/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${BASE}/payslip-missions`);
  assert.deepEqual(calls[1].body, { session_token: "psp_abc" });
});
