export const DEFAULT_ATTENDANCE_RADIUS_M = 20;
export const DEFAULT_ATTENDANCE_ACCURACY_THRESHOLD_M = 50;
export const DEFAULT_ATTENDANCE_STALE_SECONDS = 15 * 60;
export const DEFAULT_ATTENDANCE_FUTURE_SECONDS = 2 * 60;

export type AttendanceActorType = "report_staff" | "delivery_staff";

export type AttendanceDeviceInput = {
  latitude: number;
  longitude: number;
  accuracy_m: number;
  captured_at: Date;
};

export type AttendanceGeofence = {
  id: string;
  code: string;
  name: string;
  location_type: "kiosk" | "warehouse" | string;
  kiosk_location_id: string | null;
  latitude: number | null;
  longitude: number | null;
  accepted_radius_m: number | null;
  active: boolean | null;
};

export type AttendanceSessionLike = {
  actor_type: AttendanceActorType;
  session: {
    id?: string | null;
    staff_id?: string | null;
    delivery_staff_id?: string | null;
    location_id?: string | null;
  };
};

export type ParsedAttendanceRequest =
  | { ok: true; token: string; device: AttendanceDeviceInput }
  | { ok: false; reason_code: string };

export type AttendanceDecision = {
  accepted: boolean;
  reason_code: string;
  distance_m: number;
  radius_m: number;
  accuracy_m: number;
};

const encoder = new TextEncoder();

function asFiniteNumber(value: unknown): number | null {
  const numberValue = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(numberValue) ? numberValue : null;
}

function getAccuracy(body: Record<string, unknown>): number | null {
  return asFiniteNumber(body.accuracy ?? body.accuracy_m ?? body.device_accuracy_m);
}

function getCapturedAt(body: Record<string, unknown>): Date | null {
  const raw = body.captured_at ?? body.device_captured_at;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function parseAttendanceRequest(
  body: Record<string, unknown>,
  now = new Date(),
  options: { staleSeconds?: number; futureSeconds?: number } = {},
): ParsedAttendanceRequest {
  const token = typeof body.report_token === "string" ? body.report_token.trim() : "";
  if (!token) return { ok: false, reason_code: "report_session_required" };

  const latitude = asFiniteNumber(body.latitude ?? body.device_latitude);
  if (latitude === null || latitude < -90 || latitude > 90) return { ok: false, reason_code: "invalid_latitude" };

  const longitude = asFiniteNumber(body.longitude ?? body.device_longitude);
  if (longitude === null || longitude < -180 || longitude > 180) return { ok: false, reason_code: "invalid_longitude" };

  const accuracy = getAccuracy(body);
  if (accuracy === null || accuracy < 0 || accuracy >= 100000) return { ok: false, reason_code: "invalid_accuracy" };

  const capturedAt = getCapturedAt(body);
  if (!capturedAt) return { ok: false, reason_code: "invalid_captured_at" };

  const staleSeconds = options.staleSeconds ?? DEFAULT_ATTENDANCE_STALE_SECONDS;
  const futureSeconds = options.futureSeconds ?? DEFAULT_ATTENDANCE_FUTURE_SECONDS;
  const ageMs = now.getTime() - capturedAt.getTime();
  if (ageMs > staleSeconds * 1000) return { ok: false, reason_code: "captured_at_stale" };
  if (ageMs < -futureSeconds * 1000) return { ok: false, reason_code: "captured_at_future" };

  return { ok: true, token, device: { latitude, longitude, accuracy_m: accuracy, captured_at: capturedAt } };
}

export function haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusM = 6_371_000;
  const toRad = (degrees: number) => degrees * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function resolveAttendanceGeofence(
  sessionContext: AttendanceSessionLike,
  geofences: AttendanceGeofence[],
): AttendanceGeofence | null {
  if (sessionContext.actor_type === "delivery_staff") {
    return geofences.find((geofence) => geofence.active === true && geofence.code === "warehouse_tan_tao") ?? null;
  }

  const kioskLocationId = sessionContext.session.location_id;
  if (!kioskLocationId) return null;
  return geofences.find((geofence) => (
    geofence.active === true &&
    geofence.location_type === "kiosk" &&
    geofence.kiosk_location_id === kioskLocationId
  )) ?? null;
}

function requireConfiguredGeofence(geofence: AttendanceGeofence): { latitude: number; longitude: number; radius_m: number } {
  if (geofence.active !== true) throw new Error("geofence_inactive");
  if (!Number.isFinite(geofence.latitude) || !Number.isFinite(geofence.longitude)) {
    throw new Error("geofence_coordinates_missing");
  }
  const radius = Number.isFinite(geofence.accepted_radius_m) && Number(geofence.accepted_radius_m) > 0
    ? Number(geofence.accepted_radius_m)
    : DEFAULT_ATTENDANCE_RADIUS_M;
  return { latitude: geofence.latitude as number, longitude: geofence.longitude as number, radius_m: radius };
}

export function buildAttendanceDecision(params: {
  device: AttendanceDeviceInput;
  geofence: AttendanceGeofence;
  now?: Date;
  accuracyThresholdM?: number;
}): AttendanceDecision {
  const configured = requireConfiguredGeofence(params.geofence);
  const accuracyThresholdM = params.accuracyThresholdM ?? DEFAULT_ATTENDANCE_ACCURACY_THRESHOLD_M;
  const distance = haversineDistanceMeters(
    params.device.latitude,
    params.device.longitude,
    configured.latitude,
    configured.longitude,
  );

  if (params.device.accuracy_m > accuracyThresholdM) {
    return { accepted: false, reason_code: "accuracy_too_low", distance_m: distance, radius_m: configured.radius_m, accuracy_m: params.device.accuracy_m };
  }
  if (distance <= configured.radius_m) {
    return { accepted: true, reason_code: "within_geofence", distance_m: distance, radius_m: configured.radius_m, accuracy_m: params.device.accuracy_m };
  }
  return { accepted: false, reason_code: "outside_geofence", distance_m: distance, radius_m: configured.radius_m, accuracy_m: params.device.accuracy_m };
}

export function truncateUserAgent(userAgent: string | null | undefined): string | null {
  const trimmed = String(userAgent ?? "").trim();
  return trimmed ? trimmed.slice(0, 240) : null;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashRequestIp(ip: string | null | undefined, secret: string | null | undefined): Promise<string | null> {
  const trimmedIp = String(ip ?? "").trim();
  const trimmedSecret = String(secret ?? "").trim();
  if (!trimmedIp || !trimmedSecret) return null;
  return sha256Hex(["attendance-ip-v1", trimmedIp, trimmedSecret].join(":"));
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

export function publicAttendanceResponse(result: {
  accepted: boolean;
  already_checked_in: boolean;
  reason_code: string;
  distance_m: number | null;
  accuracy_m: number | null;
}): Record<string, unknown> {
  return {
    success: true,
    status: result.accepted ? "accepted" : "rejected",
    reason_code: result.reason_code,
    accepted: result.accepted,
    already_checked_in: result.already_checked_in,
    distance_m: result.distance_m === null ? null : rounded(result.distance_m),
    accuracy_m: result.accuracy_m === null ? null : rounded(result.accuracy_m),
  };
}
