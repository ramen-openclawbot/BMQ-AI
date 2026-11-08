import assert from "node:assert/strict";
import test from "node:test";

import {
  attendanceErrorMessage,
  createPayrollAttendanceApi,
  normalizeTodayPayload,
} from "./attendance-api.ts";
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

test("getToday sends the session and device headers and normalises the payload", async () => {
  const storage = signedInStorage();
  const { fetchImpl, calls } = createFakeFetch([
    {
      body: {
        success: true,
        employee: { code: "BN001" },
        gate_enabled: true,
        site_configured: false,
        site_name: "Bếp Q7",
        site_radius_m: 50,
        consent: {
          required_version: "2026-11-09",
          accepted: false,
          accepted_at: null,
          withdrawn_at: null,
        },
        today: {
          work_date: "2026-11-09",
          status: "missing_in",
          events: [],
        },
        incomplete_days: [
          { work_date: "2026-11-08", status: "missing_out", message: "Ngày công không được tính, vui lòng liên hệ quản lý duyệt" },
        ],
      },
    },
  ]);
  const api = createPayrollAttendanceApi({ baseUrl: BASE, anonKey: "anon", fetch: fetchImpl, storage });

  const result = await api.getToday();
  assert.equal(calls[0].url, `${BASE}/payslip-attendance-today`);
  assert.equal(calls[0].headers["x-payslip-session"], "psp_abc");
  assert.match(calls[0].headers["x-payslip-device"], /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].headers["x-payslip-device"], storage.getItem(PAYSLIP_DEVICE_ID_STORAGE_KEY));
  assert.equal(result.employee.code, "BN001");
  assert.equal(result.gateEnabled, true);
  assert.equal(result.siteConfigured, false);
  assert.equal(result.siteName, "Bếp Q7");
  assert.equal(result.siteRadiusM, 50);
  assert.equal(result.today.status, "missing_in");
  assert.deepEqual(result.today.consent, {
    requiredVersion: "2026-11-09",
    accepted: false,
    acceptedAt: null,
    withdrawnAt: null,
  });
  assert.equal(result.incompleteDays.length, 1);
  assert.equal(result.incompleteDays[0].status, "missing_out");
});

test("checkIn sends multipart fields and maps the server decision", async () => {
  const storage = signedInStorage();
  const { fetchImpl, calls } = createFakeFetch([
    {
      body: {
        success: true,
        decision: "rejected",
        reason_code: "outside_geofence",
        suspected_proxy: false,
        distance_m: 120.5,
        work_date: "2026-11-09",
        event_id: "event-1",
      },
    },
  ]);
  const api = createPayrollAttendanceApi({ baseUrl: BASE, anonKey: "anon", fetch: fetchImpl, storage });

  const result = await api.checkIn({
    kind: "in",
    latitude: 10.75,
    longitude: 106.65,
    accuracyM: 8,
    capturedAt: "2026-11-09T01:00:00.000Z",
    selfie: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
  });

  assert.equal(calls[0].url, `${BASE}/payslip-attendance-checkin`);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["x-payslip-session"], "psp_abc");
  assert.equal(calls[0].headers["content-type"], undefined, "browser must set the multipart boundary");
  assert.ok(calls[0].body instanceof FormData);
  const form = calls[0].body as FormData;
  assert.equal(form.get("kind"), "in");
  assert.equal(form.get("lat"), "10.75");
  assert.equal(form.get("lng"), "106.65");
  assert.equal(form.get("accuracy"), "8");
  assert.equal(form.get("captured_at"), "2026-11-09T01:00:00.000Z");
  assert.ok(form.get("selfie") instanceof Blob);

  assert.equal(result.decision, "rejected");
  assert.equal(result.reasonCode, "outside_geofence");
  assert.match(result.message, /ngoài phạm vi bếp/);
  assert.equal(result.distanceM, 120.5);
  assert.equal(result.eventId, "event-1");
});

test("acceptConsent and withdrawConsent use the consent endpoint, headers and 401 rule", async () => {
  const storage = signedInStorage();
  const { fetchImpl, calls } = createFakeFetch([
    {
      body: {
        success: true,
        consent: {
          required_version: "2026-11-09",
          accepted: true,
          accepted_at: "2026-11-09T01:00:00.000Z",
          withdrawn_at: null,
        },
      },
    },
    {
      body: {
        success: true,
        consent: {
          required_version: "2026-11-09",
          accepted: false,
          accepted_at: "2026-11-09T01:00:00.000Z",
          withdrawn_at: "2026-11-09T02:00:00.000Z",
        },
      },
    },
  ]);
  const api = createPayrollAttendanceApi({ baseUrl: BASE, anonKey: "anon", fetch: fetchImpl, storage });

  const accepted = await api.acceptConsent("2026-11-09");
  assert.equal(calls[0].url, `${BASE}/payslip-attendance-consent`);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["x-payslip-session"], "psp_abc");
  assert.match(calls[0].headers["x-payslip-device"], /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    action: "accept",
    version: "2026-11-09",
    session_token: "psp_abc",
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.acceptedAt, "2026-11-09T01:00:00.000Z");
  assert.equal(accepted.withdrawnAt, null);

  const withdrawn = await api.withdrawConsent();
  assert.deepEqual(JSON.parse(String(calls[1].body)), {
    action: "withdraw",
    session_token: "psp_abc",
  });
  assert.equal(withdrawn.accepted, false);
  assert.equal(withdrawn.withdrawnAt, "2026-11-09T02:00:00.000Z");

  const expiredStorage = signedInStorage();
  const expired = createFakeFetch([{ status: 401, body: { code: "session_invalid" } }]);
  const expiredApi = createPayrollAttendanceApi({
    baseUrl: BASE,
    fetch: expired.fetchImpl,
    storage: expiredStorage,
  });
  await assert.rejects(() => expiredApi.acceptConsent("2026-11-09"), PayslipSessionExpiredError);
  assert.equal(expiredStorage.getItem(PAYSLIP_SESSION_STORAGE_KEY), null);
});

test("getToday clears the session and throws on 401", async () => {
  const storage = signedInStorage();
  const { fetchImpl } = createFakeFetch([{ status: 401, body: { code: "session_invalid" } }]);
  const api = createPayrollAttendanceApi({ baseUrl: BASE, fetch: fetchImpl, storage });

  await assert.rejects(() => api.getToday(), PayslipSessionExpiredError);
  assert.equal(storage.getItem(PAYSLIP_SESSION_STORAGE_KEY), null);
});

test("checkIn without a stored session never calls the network", async () => {
  const { fetchImpl, calls } = createFakeFetch([]);
  const api = createPayrollAttendanceApi({ baseUrl: BASE, fetch: fetchImpl, storage: memoryStorage() });
  await assert.rejects(
    () =>
      api.checkIn({
        kind: "out",
        latitude: null,
        longitude: null,
        accuracyM: null,
        capturedAt: "2026-11-09T01:00:00.000Z",
        selfie: new Blob([new Uint8Array([1])], { type: "image/jpeg" }),
      }),
    PayslipSessionExpiredError,
  );
  assert.equal(calls.length, 0);
});

test("normalizeTodayPayload supplies the exact incomplete-day message", () => {
  const payload = normalizeTodayPayload({
    employee: { code: "BN001" },
    today: { work_date: "2026-11-09", status: "missing_out", events: [] },
    incomplete_days: [{ work_date: "2026-11-09", status: "missing_out" }],
  });
  assert.equal(payload.today.message, "Ngày công không được tính, vui lòng liên hệ quản lý duyệt");
  assert.deepEqual(payload.today.consent, {
    requiredVersion: "2026-11-09",
    accepted: false,
    acceptedAt: null,
    withdrawnAt: null,
  });
  assert.equal(payload.incompleteDays[0].message, "Ngày công không được tính, vui lòng liên hệ quản lý duyệt");
});

test("attendanceErrorMessage prefers server text and falls back to the reason map", () => {
  assert.equal(attendanceErrorMessage("device_used_by_other"), "Thiết bị này đã được dùng cho nhân viên khác trong ngày. Vui lòng liên hệ quản lý.");
  assert.equal(attendanceErrorMessage("low_accuracy", "Lỗi từ máy chủ"), "Lỗi từ máy chủ");
});
