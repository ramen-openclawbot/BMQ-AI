import assert from "node:assert/strict";
import test from "node:test";

import { createPayrollDeliveryApi, normalizeDeliveryTask } from "./delivery-api.ts";
import { PAYSLIP_SESSION_STORAGE_KEY } from "./api.ts";
import { PAYSLIP_DEVICE_ID_STORAGE_KEY } from "./device-id.ts";
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

function signedInStorage(): PayslipStorage {
  const storage = memoryStorage();
  storage.setItem(PAYSLIP_SESSION_STORAGE_KEY, "psp_abc");
  storage.setItem(PAYSLIP_DEVICE_ID_STORAGE_KEY, "00000000-0000-4000-8000-000000000000");
  return storage;
}

const BASE = "https://ref.supabase.co/functions/v1";

const PHOTO = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });

test("normalizeDeliveryTask maps driver_note and keeps null when absent", () => {
  const completed = normalizeDeliveryTask({
    id: "task-1",
    status: "completed",
    dealer_note: null,
    driver_note: "Giao trước 7h",
  });
  assert.equal(completed.driverNote, "Giao trước 7h");

  const pending = normalizeDeliveryTask({ id: "task-2", status: "pending" });
  assert.equal(pending.driverNote, null);
});

test("complete appends the trimmed note only when it has content", async () => {
  const { fetchImpl, calls } = createFakeFetch([
    { body: { success: true, completed_at: "2026-11-27T01:00:00.000Z", location_attached: true } },
  ]);
  const api = createPayrollDeliveryApi({
    baseUrl: BASE,
    anonKey: "anon",
    fetch: fetchImpl,
    storage: signedInStorage(),
  });

  const result = await api.complete({
    taskId: "task-1",
    photo: PHOTO(),
    latitude: 10.75,
    longitude: 106.65,
    accuracyM: 8,
    capturedAt: "2026-11-27T01:00:00.000Z",
    note: "  Giao trước 7h  ",
  });

  assert.equal(calls[0].url, `${BASE}/payslip-delivery-complete`);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["x-payslip-session"], "psp_abc");
  assert.ok(calls[0].body instanceof FormData);
  const form = calls[0].body as FormData;
  assert.equal(form.get("task_id"), "task-1");
  assert.equal(form.get("note"), "Giao trước 7h");
  assert.equal(result.completedAt, "2026-11-27T01:00:00.000Z");
  assert.equal(result.locationAttached, true);
});

test("complete omits the note field when the note is empty", async () => {
  const { fetchImpl, calls } = createFakeFetch([
    { body: { success: true, completed_at: "2026-11-27T01:00:00.000Z", location_attached: false } },
  ]);
  const api = createPayrollDeliveryApi({
    baseUrl: BASE,
    anonKey: "anon",
    fetch: fetchImpl,
    storage: signedInStorage(),
  });

  await api.complete({
    taskId: "task-1",
    photo: PHOTO(),
    latitude: 10.75,
    longitude: 106.65,
    accuracyM: 8,
    capturedAt: "2026-11-27T01:00:00.000Z",
    note: "   ",
  });

  const form = calls[0].body as FormData;
  assert.equal(form.get("note"), null);
});

test("complete maps delivery_note_too_long to the Vietnamese message", async () => {
  const { fetchImpl } = createFakeFetch([
    {
      status: 400,
      body: {
        success: false,
        code: "delivery_note_too_long",
        error: "delivery_note_too_long",
      },
    },
  ]);
  const api = createPayrollDeliveryApi({
    baseUrl: BASE,
    anonKey: "anon",
    fetch: fetchImpl,
    storage: signedInStorage(),
  });

  await assert.rejects(
    () =>
      api.complete({
        taskId: "task-1",
        photo: PHOTO(),
        latitude: 10.75,
        longitude: 106.65,
        accuracyM: 8,
        capturedAt: "2026-11-27T01:00:00.000Z",
        note: "a".repeat(501),
      }),
    (failure: Error) => failure.message === "Ghi chú tối đa 500 ký tự.",
  );
});
