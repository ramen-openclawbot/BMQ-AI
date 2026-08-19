import assert from "node:assert/strict";

import {
  buildAttendanceDecision,
  hashRequestIp,
  haversineDistanceMeters,
  parseAttendanceRequest,
  publicAttendanceResponse,
  resolveAttendanceGeofence,
  truncateUserAgent,
} from "./attendance.ts";

const now = new Date("2026-08-19T05:00:00.000Z");
const geofence = {
  id: "geo-1",
  code: "warehouse_tan_tao",
  name: "Kho Tân Tạo",
  location_type: "warehouse",
  kiosk_location_id: null,
  latitude: 10.0,
  longitude: 106.0,
  accepted_radius_m: 20,
  active: true,
};

function pointNorthMeters(meters: number): { latitude: number; longitude: number } {
  return { latitude: 10.0 + meters / 111_320, longitude: 106.0 };
}

Deno.test("haversine distance supports exact geofence boundary decisions", () => {
  for (const [meters, accepted] of [[0, true], [19.9, true], [20, true], [20.1, false]] as const) {
    const point = pointNorthMeters(meters);
    const distance = haversineDistanceMeters(point.latitude, point.longitude, geofence.latitude, geofence.longitude);
    const decision = buildAttendanceDecision({
      device: { ...point, accuracy_m: 5, captured_at: now },
      geofence,
      now,
      accuracyThresholdM: 50,
    });
    assert.equal(decision.accepted, accepted, `${meters}m accepted=${accepted} distance=${distance}`);
  }
});

Deno.test("accuracy threshold rejects without expanding configured radius", () => {
  const point = pointNorthMeters(0);
  const decision = buildAttendanceDecision({
    device: { ...point, accuracy_m: 50.1, captured_at: now },
    geofence,
    now,
    accuracyThresholdM: 50,
  });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason_code, "accuracy_too_low");
});

Deno.test("request parser accepts only token and device GPS fields", () => {
  const parsed = parseAttendanceRequest({
    report_token: "krp_secret",
    latitude: 10,
    longitude: 106,
    accuracy: 12.345,
    captured_at: now.toISOString(),
    actor_type: "delivery_staff",
    geofence_latitude: 0,
    radius_m: 500,
  }, now);
  assert.equal(parsed.ok, true);
  if (parsed.ok !== true) throw new Error("expected parsed request");
  assert.deepEqual(Object.keys(parsed.device).sort(), ["accuracy_m", "captured_at", "latitude", "longitude"]);
  assert.equal(parsed.token, "krp_secret");
});

Deno.test("request parser validates coordinate ranges, finite accuracy, and stale/future capture", () => {
  for (const [patch, code] of [
    [{ latitude: 91 }, "invalid_latitude"],
    [{ longitude: 181 }, "invalid_longitude"],
    [{ accuracy: Number.POSITIVE_INFINITY }, "invalid_accuracy"],
    [{ captured_at: "2026-08-19T04:44:59.000Z" }, "captured_at_stale"],
    [{ captured_at: "2026-08-19T05:02:01.000Z" }, "captured_at_future"],
  ] as const) {
    const parsed = parseAttendanceRequest({ report_token: "krp_t", latitude: 10, longitude: 106, accuracy: 5, captured_at: now.toISOString(), ...patch }, now);
    assert.equal(parsed.ok, false, code);
    if (parsed.ok) throw new Error("expected rejection");
    assert.equal(parsed.reason_code, code);
  }
});

Deno.test("geofence resolution is server-side and fail-closed for missing config", () => {
  const reportContext = { actor_type: "report_staff" as const, session: { location_id: "loc-1" } };
  assert.equal(resolveAttendanceGeofence(reportContext, [{ ...geofence, location_type: "kiosk", kiosk_location_id: "loc-1" }])?.id, "geo-1");
  assert.equal(resolveAttendanceGeofence({ actor_type: "delivery_staff", session: {} }, [{ ...geofence, code: "warehouse_tan_tao" }])?.id, "geo-1");
  assert.equal(resolveAttendanceGeofence(reportContext, [{ ...geofence, location_type: "kiosk", kiosk_location_id: "loc-2" }]), null);
  assert.throws(() => buildAttendanceDecision({ device: { latitude: 10, longitude: 106, accuracy_m: 5, captured_at: now }, geofence: { ...geofence, latitude: null }, now, accuracyThresholdM: 50 }), /geofence_coordinates_missing/);
});

Deno.test("privacy helpers hash IP only with secret and truncate user-agent", async () => {
  assert.equal(await hashRequestIp("1.2.3.4", null), null);
  assert.match(await hashRequestIp("1.2.3.4", "salt") ?? "", /^[0-9a-f]{64}$/);
  assert.equal(truncateUserAgent("x".repeat(500))?.length, 240);
});

Deno.test("public response is stable and redacts canonical geofence coordinates", () => {
  const response = publicAttendanceResponse({ accepted: true, already_checked_in: false, reason_code: "within_geofence", distance_m: 19.94, accuracy_m: 5.55 });
  assert.equal(response.success, true);
  assert.equal(response.status, "accepted");
  assert.equal(response.distance_m, 19.9);
  assert.equal(response.accuracy_m, 5.6);
  assert.equal("geofence_latitude" in response, false);
  assert.equal("latitude" in response, false);
});
