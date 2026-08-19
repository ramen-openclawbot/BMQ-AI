import assert from "node:assert/strict";

import { handleAttendanceCheckIn } from "./handler.ts";

const fixedNow = new Date("2026-08-19T05:00:00.000Z");

class QueryMock {
  private rows: unknown[];
  constructor(rows: unknown[]) {
    this.rows = rows;
  }
  select() { return this; }
  eq(field: string, value: unknown) {
    this.rows = this.rows.filter((row) => (row as Record<string, unknown>)[field] === value);
    return this;
  }
  is(field: string, value: unknown) {
    this.rows = this.rows.filter((row) => (row as Record<string, unknown>)[field] === value);
    return this;
  }
  limit() { return this; }
  maybeSingle() { return Promise.resolve({ data: this.rows[0] ?? null, error: null }); }
  then(resolve: (value: { data: unknown[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
    return Promise.resolve({ data: this.rows, error: null }).then(resolve, reject);
  }
}

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("https://example.supabase.co/functions/v1/attendance-check-in", {
    method: "POST",
    headers: { origin: "https://baocao.banhmique.vn", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function makeDeps(overrides: Record<string, unknown> = {}): any {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rateLimitCalls: Array<{ scope: string; key: string; maxAttempts: number; windowSeconds: number }> = [];
  let geofenceTableReads = 0;
  const geofences = overrides.geofences ?? [{
    id: "geo-1",
    code: "warehouse_tan_tao",
    name: "Kho Tân Tạo",
    location_type: "warehouse",
    kiosk_location_id: null,
    latitude: 10,
    longitude: 106,
    accepted_radius_m: 20,
    active: true,
  }];
  const supabase = {
    from(table: string) {
      assert.equal(table === "attendance_geofence_locations" || table === "mobile_gps_attendance_events", true);
      if (table === "attendance_geofence_locations") geofenceTableReads += 1;
      return new QueryMock(table === "attendance_geofence_locations" ? geofences as unknown[] : []);
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (overrides.conflictOnAccepted && name === "record_mobile_gps_attendance_event" && args.p_decision === "accepted") {
        return { data: null, error: { code: "23505", message: "duplicate accepted" } };
      }
      if (overrides.failRejectedReplayAudit && name === "record_mobile_gps_attendance_event" && args.p_decision === "rejected" && args.p_reason_code === "already_checked_in") {
        return { data: null, error: { code: "XX000", message: "audit insert failed" } };
      }
      return { data: "event-id", error: null };
    },
  };
  return {
    rpcCalls,
    rateLimitCalls,
    get geofenceTableReads() { return geofenceTableReads; },
    createServiceClient: () => supabase,
    resolveReportSession: () => Promise.resolve(overrides.session ?? {
      actor_type: "delivery_staff",
      session: { id: "11111111-1111-1111-1111-111111111111", delivery_staff_id: "22222222-2222-2222-2222-222222222222" },
      staff: null,
      deliveryStaff: { id: "22222222-2222-2222-2222-222222222222" },
      location: null,
    }),
    resolveAttendanceActorGate: () => Promise.resolve({ enabled: overrides.gateEnabled !== false }),
    consumeRateLimit: (_supabase: unknown, options: { scope: string; key: string; maxAttempts: number; windowSeconds: number }) => {
      rateLimitCalls.push(options);
      return Promise.resolve({ allowed: true, retryAfterSeconds: 60 });
    },
    now: () => fixedNow,
    ipHashSecret: "pepper",
    accuracyThresholdM: 50,
    ...overrides,
  };
}

Deno.test("attendance-check-in records accepted attempt with server-resolved warehouse geofence and no raw IP", async () => {
  const deps = makeDeps();
  const response = await handleAttendanceCheckIn(request({ report_token: "krp_token", latitude: 10, longitude: 106, accuracy: 5, captured_at: fixedNow.toISOString() }, { "x-forwarded-for": "1.2.3.4", "user-agent": "ua" }), deps);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(body.already_checked_in, false);
  assert.equal("geofence_latitude" in body, false);
  assert.equal(deps.rpcCalls.some((call: { name: string; args: Record<string, unknown> }) => call.name === "record_mobile_gps_attendance_event" && call.args.p_decision === "accepted"), true);
  const eventCall = deps.rpcCalls.find((call: { name: string; args: Record<string, unknown> }) => call.name === "record_mobile_gps_attendance_event")!;
  assert.equal(eventCall.args.p_delivery_staff_id, "22222222-2222-2222-2222-222222222222");
  assert.equal(eventCall.args.p_geofence_code, "warehouse_tan_tao");
  assert.match(String(eventCall.args.p_request_ip_hash), /^[0-9a-f]{64}$/);
  assert.equal(eventCall.args.p_request_user_agent, "ua");
});


Deno.test("attendance-check-in fails closed before geofence lookup when pilot gate disabled", async () => {
  const deps = makeDeps({ gateEnabled: false });
  const response = await handleAttendanceCheckIn(request({ report_token: "krp_token", latitude: 10, longitude: 106, accuracy: 5, captured_at: fixedNow.toISOString() }), deps);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "attendance_pilot_not_enabled");
  assert.equal(deps.geofenceTableReads, 0);
  assert.equal(deps.rpcCalls.length, 0);
});

Deno.test("attendance-check-in allows enabled pilot actor to continue to geofence and ledger", async () => {
  const deps = makeDeps({ gateEnabled: true });
  const response = await handleAttendanceCheckIn(request({ report_token: "krp_token", latitude: 10, longitude: 106, accuracy: 5, captured_at: fixedNow.toISOString() }), deps);
  assert.equal(response.status, 200);
  assert.equal(deps.geofenceTableReads, 1);
  assert.equal(deps.rpcCalls.some((call: { name: string }) => call.name === "record_mobile_gps_attendance_event"), true);
});

Deno.test("attendance-check-in maps accepted unique conflict to already_checked_in and records rejected replay", async () => {
  const deps = makeDeps({ conflictOnAccepted: true });
  const response = await handleAttendanceCheckIn(request({ report_token: "krp_token", latitude: 10, longitude: 106, accuracy: 5, captured_at: fixedNow.toISOString() }), deps);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.equal(body.already_checked_in, true);
  assert.equal(deps.rpcCalls.filter((call: { name: string; args: Record<string, unknown> }) => call.args.p_decision === "accepted").length, 1);
  assert.equal(deps.rpcCalls.filter((call: { name: string; args: Record<string, unknown> }) => call.args.p_decision === "rejected" && call.args.p_reason_code === "already_checked_in").length, 1);
});

Deno.test("attendance-check-in returns retry error when duplicate replay audit insert fails", async () => {
  const deps = makeDeps({ conflictOnAccepted: true, failRejectedReplayAudit: true });
  const response = await handleAttendanceCheckIn(request({ report_token: "krp_token", latitude: 10, longitude: 106, accuracy: 5, captured_at: fixedNow.toISOString() }), deps);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.code, "attendance_record_failed");
  assert.equal(deps.rpcCalls.filter((call: { name: string; args: Record<string, unknown> }) => call.args.p_decision === "accepted").length, 1);
  assert.equal(deps.rpcCalls.filter((call: { name: string; args: Record<string, unknown> }) => call.args.p_decision === "rejected" && call.args.p_reason_code === "already_checked_in").length, 1);
});

Deno.test("attendance-check-in pre-session rate limit bucket ignores attacker-controlled token changes", async () => {
  const deps = makeDeps({ resolveReportSession: () => Promise.resolve(null) });
  for (const token of ["krp_random_one", "krp_random_two"]) {
    const response = await handleAttendanceCheckIn(request({ report_token: token, latitude: 10, longitude: 106, accuracy: 5, captured_at: fixedNow.toISOString() }, { "x-forwarded-for": "9.8.7.6" }), deps);
    assert.equal(response.status, 401);
  }
  assert.equal(deps.rateLimitCalls.length, 2);
  assert.equal(deps.rateLimitCalls[0].key, deps.rateLimitCalls[1].key);
  assert.equal(deps.rateLimitCalls[0].key.includes("krp_random"), false);
});

Deno.test("attendance-check-in returns stable config error without ledger write when geofence coordinates missing", async () => {
  const deps = makeDeps({ geofences: [{ id: "geo-1", code: "warehouse_tan_tao", name: "Kho Tân Tạo", location_type: "warehouse", kiosk_location_id: null, latitude: null, longitude: null, accepted_radius_m: 20, active: true }] });
  const response = await handleAttendanceCheckIn(request({ report_token: "krp_token", latitude: 10, longitude: 106, accuracy: 5, captured_at: fixedNow.toISOString() }), deps);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "attendance_geofence_not_configured");
  assert.equal(deps.rpcCalls.length, 0);
});

Deno.test("attendance-check-in rate limits before ledger and rejects disallowed methods", async () => {
  const limited = makeDeps({ consumeRateLimit: () => Promise.resolve({ allowed: false, retryAfterSeconds: 30 }) });
  const limitedResponse = await handleAttendanceCheckIn(request({ report_token: "krp_token", latitude: 10, longitude: 106, accuracy: 5, captured_at: fixedNow.toISOString() }), limited);
  assert.equal(limitedResponse.status, 429);
  assert.equal(limited.rpcCalls.length, 0);

  const getResponse = await handleAttendanceCheckIn(new Request("https://example.supabase.co/functions/v1/attendance-check-in", { method: "GET" }), makeDeps());
  assert.equal(getResponse.status, 405);
});
