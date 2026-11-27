// Pure logic for Bếp BN delivery tasks (Giao hàng).
//
// No Deno-only imports and no DOM globals: the Deno test runs this file
// directly. The Edge Functions add the session/device/consent gate and storage
// upload; this module only decides validity, distance and the location rule.
//
// Owner decision 2026-11-25:
//   * a driver may complete today's task, or yesterday's task before 06:00
//     Vietnam time;
//   * the photo is mandatory (JPEG/PNG/WebP, at most 3 MB);
//   * the destination's first-ever coordinates are attached from the first
//     completion, whatever the accuracy; later completions only store the
//     distance as data — there is no geofence flag and no time flag.

import { vietnamWorkDate } from "./payroll-attendance.ts";

export const DELIVERY_PROOF_BUCKET = "delivery-proofs";
export const DELIVERY_PROOF_MAX_BYTES = 3 * 1024 * 1024;
export const DELIVERY_PROOF_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const DELIVERY_PROOF_RETENTION_DAYS = 90;
export const DELIVERY_UNIT_STEP = 0.25;
export const DELIVERY_DRIVER_NOTE_MAX_LENGTH = 500;

/** Files are kept for 90 days; older objects are removed by the daily cron. */
export const DELIVERY_PROOF_RETENTION_MAX_PER_RUN = 1000;

const EARTH_RADIUS_M = 6371008.8;

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  if (![lat1, lng1, lat2, lng2].every((value) => Number.isFinite(value))) return Number.NaN;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 2-decimal metres, or null when a coordinate is missing. */
export function distanceMeters(
  fromLat: number | null | undefined,
  fromLng: number | null | undefined,
  toLat: number | null | undefined,
  toLng: number | null | undefined,
): number | null {
  if (fromLat === null || fromLat === undefined || fromLng === null || fromLng === undefined) {
    return null;
  }
  if (toLat === null || toLat === undefined || toLng === null || toLng === undefined) {
    return null;
  }
  const metres = haversineMeters(fromLat, fromLng, toLat, toLng);
  return Number.isFinite(metres) ? Math.round(metres * 100) / 100 : null;
}

/**
 * Location rule: a destination without coordinates gets them from this
 * completion (distance stays null). A destination that already has coordinates
 * only gets a distance value. No accuracy threshold and no control flag.
 */
export function decideDeliveryLocation(
  destinationLat: number | null | undefined,
  destinationLng: number | null | undefined,
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): { locationAttached: boolean; distanceM: number | null } {
  const missing = destinationLat === null || destinationLat === undefined ||
    destinationLng === null || destinationLng === undefined;
  if (missing) return { locationAttached: true, distanceM: null };
  return {
    locationAttached: false,
    distanceM: distanceMeters(destinationLat, destinationLng, latitude, longitude),
  };
}

function vietnamClock(input: Date | string | number): { date: string; hour: number } {
  const date = input instanceof Date ? input : new Date(input);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = Number(get("hour"));
  return {
    date: `${year}-${month}-${day}`,
    hour: Number.isFinite(hour) ? hour : 0,
  };
}

function previousIsoDate(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Today, or yesterday while it is still before 06:00 in Vietnam. */
export function deliveryCompletionWindow(
  now: Date | string | number = new Date(),
): { today: string; allowPrevious: boolean; allowedDates: string[] } {
  const { date: today, hour } = vietnamClock(now);
  const allowPrevious = hour < 6;
  const yesterday = previousIsoDate(today);
  return {
    today,
    allowPrevious,
    allowedDates: allowPrevious ? [today, yesterday] : [today],
  };
}

export interface DeliveryTaskForCompletion {
  employeeCode: string | null;
  /** YYYY-MM-DD. */
  deliveryDate: string;
  status: "pending" | "completed" | "cancelled" | string;
  /** Set by an owner reopen: the normal today/yesterday window no longer applies. */
  reopenedAt?: string | null;
}

export interface DeliveryCompletionValidationInput {
  task: DeliveryTaskForCompletion;
  employeeCode: string;
  photoMime?: string | null;
  photoBytes?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  destinationLatitude?: number | null;
  destinationLongitude?: number | null;
  now?: Date | string | number;
}

export type DeliveryCompletionCheck =
  | { ok: true; locationAttached: boolean; distanceM: number | null }
  | { ok: false; code: string; message: string; httpStatus: number };

export function validateDeliveryCompletion(
  input: DeliveryCompletionValidationInput,
): DeliveryCompletionCheck {
  const employeeCode = String(input.employeeCode ?? "").trim();
  const taskEmployee = String(input.task.employeeCode ?? "").trim();
  if (employeeCode === "" || taskEmployee !== employeeCode) {
    return {
      ok: false,
      code: "delivery_not_assigned",
      message: "Việc giao hàng này không thuộc tài xế đang đăng nhập.",
      httpStatus: 403,
    };
  }

  const window = deliveryCompletionWindow(input.now);
  const reopened = typeof input.task.reopenedAt === "string" &&
    input.task.reopenedAt.trim() !== "";
  if (!reopened && !window.allowedDates.includes(input.task.deliveryDate)) {
    return {
      ok: false,
      code: "delivery_date_closed",
      message: "Chỉ hoàn thành được việc giao hàng của hôm nay (hoặc hôm qua trước 06:00).",
      httpStatus: 409,
    };
  }

  if (input.task.status !== "pending") {
    return {
      ok: false,
      code: "delivery_not_pending",
      message: input.task.status === "completed"
        ? "Việc giao hàng này đã hoàn thành."
        : "Việc giao hàng này đã bị huỷ.",
      httpStatus: 409,
    };
  }

  const mime = String(input.photoMime ?? "").trim().toLowerCase();
  const bytes = typeof input.photoBytes === "number" ? input.photoBytes : 0;
  if (!(DELIVERY_PROOF_MIME_TYPES as readonly string[]).includes(mime)) {
    return {
      ok: false,
      code: "delivery_photo_type_invalid",
      message: "Ảnh giao hàng phải là JPEG, PNG hoặc WebP.",
      httpStatus: 400,
    };
  }
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return {
      ok: false,
      code: "delivery_photo_required",
      message: "Vui lòng chụp ảnh giao hàng.",
      httpStatus: 400,
    };
  }
  if (bytes > DELIVERY_PROOF_MAX_BYTES) {
    return {
      ok: false,
      code: "delivery_photo_too_large",
      message: "Ảnh giao hàng vượt quá 3 MB. Vui lòng chụp lại.",
      httpStatus: 400,
    };
  }

  const lat = input.latitude;
  const lng = input.longitude;
  if (
    lat === null || lat === undefined || lng === null || lng === undefined ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    lat < -90 || lat > 90 || lng < -180 || lng > 180
  ) {
    return {
      ok: false,
      code: "delivery_no_location",
      message: "Không xác định được vị trí GPS. Vui lòng bật định vị và thử lại.",
      httpStatus: 400,
    };
  }

  const accuracy = input.accuracyM;
  if (accuracy === null || accuracy === undefined || !Number.isFinite(accuracy) || accuracy < 0) {
    return {
      ok: false,
      code: "delivery_accuracy_invalid",
      message: "Độ chính xác GPS không hợp lệ.",
      httpStatus: 400,
    };
  }

  const decision = decideDeliveryLocation(
    input.destinationLatitude,
    input.destinationLongitude,
    lat,
    lng,
  );
  return { ok: true, ...decision };
}

export type DeliveryDriverNoteCheck =
  | { ok: true; note: string | null }
  | { ok: false; code: "delivery_note_too_long"; message: string; httpStatus: 400 };

/**
 * Optional driver note on completion:
 *   - normalise CRLF (multipart FormData turns textarea line breaks into CRLF);
 *   - drop NUL and non-printing controls, keeping newline and tab (PostgreSQL
 *     text cannot store NUL);
 *   - trim, empty becomes null;
 *   - more than 500 characters is rejected.
 * The database enforces the 1..500 length with btrim; this helper additionally
 * normalises line breaks/whitespace and control characters before the Edge
 * Function uploads the photo, so unstoreable input is rejected early.
 */
export function normalizeDriverNote(value: unknown): DeliveryDriverNoteCheck {
  const note = typeof value === "string"
    ? value
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
      .trim()
    : "";
  if (note === "") return { ok: true, note: null };
  // Count code points, matching PostgreSQL length() rather than UTF-16 units.
  if ([...note].length > DELIVERY_DRIVER_NOTE_MAX_LENGTH) {
    return {
      ok: false,
      code: "delivery_note_too_long",
      message: "Ghi chú tối đa 500 ký tự.",
      httpStatus: 400,
    };
  }
  return { ok: true, note };
}

/** Storage path: <employee>/<date>/<task>.<ext> inside delivery-proofs. */
export function deliveryProofPath(
  employeeCode: string,
  deliveryDate: string,
  taskId: string,
  mime: string,
  attemptId?: string,
): string {
  const employee = String(employeeCode ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) ||
    "employee";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) ? deliveryDate : "unknown-date";
  const task = String(taskId ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "task";
  const attempt = attemptId
    ? `-${String(attemptId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}`
    : "";
  const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return `${employee}/${date}/${task}${attempt}.${extension}`;
}

/** Google Maps link: coordinates when known, otherwise a name + address search. */
export function deliveryMapsLink(
  name: string | null | undefined,
  address: string | null | undefined,
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): string {
  if (
    latitude !== null && latitude !== undefined && longitude !== null && longitude !== undefined &&
    Number.isFinite(latitude) && Number.isFinite(longitude)
  ) {
    return `https://www.google.com/maps?q=${latitude},${longitude}`;
  }
  const query = `${name ?? ""} ${address ?? ""}`.trim();
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/**
 * Công của một ngày giao hàng: base_units_per_day when at least one destination
 * was completed that day, plus the units of every completed destination.
 */
export function deliveryUnitsForDay(
  baseUnitsPerDay: number,
  completedUnits: readonly number[],
): number {
  if (completedUnits.length === 0) return 0;
  const base = Number.isFinite(baseUnitsPerDay) ? Math.max(0, baseUnitsPerDay) : 0;
  return completedUnits.reduce(
    (total, units) => total + (Number.isFinite(units) ? Math.max(0, units) : 0),
    base,
  );
}

/** true when a delivery unit value is non-negative and a multiple of 0.25. */
export function isValidDeliveryUnits(value: unknown): value is number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return false;
  const quarters = parsed * 4;
  return Math.abs(quarters - Math.round(quarters)) <= 1e-9;
}
