import assert from "node:assert/strict";
import test from "node:test";

import { createPayrollMissionApi, normalizeMissionOffer } from "./mission-api.ts";
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

function offerPayload() {
  return {
    success: true,
    offer: {
      id: "offer-1",
      status: "pending",
      campaign: {
        title: "Nhiệm vụ tháng 11",
        summary: "Chấm công đều và đúng giờ",
        starts_on: "2026-11-01",
        ends_on: "2026-11-30",
        items: [
          {
            key: "regular",
            label: "Chấm công đều",
            detail: "Đủ ngày, không thiếu giờ ra",
            kind: "attendance_regular",
            amount_vnd: 100000,
          },
          {
            key: "punctual",
            label: "Đúng giờ",
            detail: null,
            kind: "punctual",
            amount_vnd: "50000",
          },
        ],
        rules: ["Không vi phạm nội quy"],
        draw: { quarter: "2026-Q4", prize_vnd: 5000000 },
      },
      progress: [
        {
          key: "regular",
          kind: "attendance_regular",
          met: true,
          detail: {
            days_with_in: 12,
            days_complete: 12,
            days_missing_out: 0,
            on_time_days: 11,
            min_days: 10,
            grace_minutes: 5,
            cutoff: "07:00",
            window_from: "2026-11-03",
            window_to: "2026-11-30",
          },
        },
      ],
      review: {
        earned: [{ key: "regular", amount_vnd: 100000 }],
        disqualified: false,
      },
      ticket: {
        quarter: "2026-Q4",
        issued_at: "2026-11-30T10:00:00.000Z",
        void_reason: null,
      },
    },
  };
}

test("getMission sends session/device headers and normalises the payload", async () => {
  const storage = signedInStorage();
  const { fetchImpl, calls } = createFakeFetch([{ body: offerPayload() }]);
  const api = createPayrollMissionApi({ baseUrl: BASE, anonKey: "anon", fetch: fetchImpl, storage });

  const offer = await api.getMission();
  assert.ok(offer);
  assert.equal(calls[0].url, `${BASE}/payslip-mission`);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["x-payslip-session"], "psp_abc");
  assert.match(calls[0].headers["x-payslip-device"], /^[0-9a-f-]{36}$/);
  assert.equal(calls[0].headers["x-payslip-device"], storage.getItem(PAYSLIP_DEVICE_ID_STORAGE_KEY));
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    action: "get",
    session_token: "psp_abc",
  });

  assert.equal(offer.id, "offer-1");
  assert.equal(offer.status, "pending");
  assert.equal(offer.campaign.title, "Nhiệm vụ tháng 11");
  assert.equal(offer.campaign.items[0].amountVnd, 100000);
  assert.equal(offer.campaign.items[1].amountVnd, 50000);
  assert.deepEqual(offer.campaign.rules, ["Không vi phạm nội quy"]);
  assert.equal(offer.progress[0].met, true);
  assert.equal(offer.progress[0].detail.daysWithIn, 12);
  assert.equal(offer.progress[0].detail.cutoff, "07:00");
  assert.deepEqual(offer.review, {
    earned: [{ key: "regular", amountVnd: 100000 }],
    disqualified: false,
  });
  assert.deepEqual(offer.ticket, {
    quarter: "2026-Q4",
    issuedAt: "2026-11-30T10:00:00.000Z",
    voidReason: null,
  });
});

test("getMission returns null when no active campaign is open", async () => {
  const { fetchImpl } = createFakeFetch([{ body: { success: true, offer: null } }]);
  const api = createPayrollMissionApi({ baseUrl: BASE, fetch: fetchImpl, storage: signedInStorage() });
  assert.equal(await api.getMission(), null);
});

test("respondMission posts the decision and maps the idempotent response", async () => {
  const storage = signedInStorage();
  const accepted = offerPayload();
  accepted.offer.status = "accepted";
  const { fetchImpl, calls } = createFakeFetch([{ body: accepted }]);
  const api = createPayrollMissionApi({ baseUrl: BASE, anonKey: "anon", fetch: fetchImpl, storage });

  const offer = await api.respondMission("offer-1", "accept");
  assert.ok(offer);
  assert.equal(offer.status, "accepted");
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    action: "respond",
    offer_id: "offer-1",
    decision: "accept",
    session_token: "psp_abc",
  });
  assert.equal(calls[0].headers["x-payslip-session"], "psp_abc");
  assert.equal(calls[0].headers["x-payslip-device"], storage.getItem(PAYSLIP_DEVICE_ID_STORAGE_KEY));
});

test("a 401 clears the session and throws PayslipSessionExpiredError", async () => {
  const storage = signedInStorage();
  const { fetchImpl } = createFakeFetch([{ status: 401, body: { code: "session_invalid" } }]);
  const api = createPayrollMissionApi({ baseUrl: BASE, fetch: fetchImpl, storage });

  await assert.rejects(() => api.getMission(), PayslipSessionExpiredError);
  assert.equal(storage.getItem(PAYSLIP_SESSION_STORAGE_KEY), null);
});

test("no stored session never calls the network", async () => {
  const { fetchImpl, calls } = createFakeFetch([]);
  const api = createPayrollMissionApi({ baseUrl: BASE, fetch: fetchImpl, storage: memoryStorage() });
  await assert.rejects(() => api.getMission(), PayslipSessionExpiredError);
  assert.equal(calls.length, 0);
});

test("a server error message is surfaced to the employee", async () => {
  const { fetchImpl } = createFakeFetch([
    { status: 409, body: { message: "Nhiệm vụ đã được phản hồi.", code: "offer_already_responded" } },
  ]);
  const api = createPayrollMissionApi({ baseUrl: BASE, fetch: fetchImpl, storage: signedInStorage() });
  await assert.rejects(
    () => api.respondMission("offer-1", "decline"),
    /Nhiệm vụ đã được phản hồi\./,
  );
});

test("normalizeMissionOffer tolerates a missing campaign/progress payload", () => {
  assert.equal(normalizeMissionOffer(null), null);
  assert.equal(normalizeMissionOffer({ offer: null }), null);
  const offer = normalizeMissionOffer({ offer: { id: "offer-2" } });
  assert.ok(offer);
  assert.equal(offer.id, "offer-2");
  assert.equal(offer.status, "pending");
  assert.deepEqual(offer.progress, []);
  assert.equal(offer.review, null);
  assert.equal(offer.ticket, null);
  assert.deepEqual(offer.campaign.items, []);
});
