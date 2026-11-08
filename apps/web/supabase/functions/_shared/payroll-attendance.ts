// Pure logic for Bếp Q7 employee GPS attendance (payroll_bn).
//
// No Deno-only imports and no DOM globals: `node --test` runs this file
// directly. The reason codes and decision order mirror
// public.record_payroll_bn_attendance_event(...) in the
// 20261109100000_payroll_bn_gps_attendance.sql migration.

export type AttendanceEventKind = "in" | "out";
export type AttendanceDecision = "accepted" | "rejected";

export type AttendanceRejectReason =
  | "gate_disabled"
  | "site_not_configured"
  | "no_location"
  | "low_accuracy"
  | "outside_geofence"
  | "device_not_approved"
  | "device_used_by_other"
  | "already_recorded"
  | "checkout_before_checkin"
  | "session_invalid";

/** A device fix beyond this accuracy is not trustworthy for attendance. */
export const PAYROLL_ATTENDANCE_MAX_ACCURACY_M = 100;

/** Private selfie bucket limit (600 KB), also declared in the migration. */
export const PAYROLL_ATTENDANCE_SELFIE_MAX_BYTES = 600 * 1024;

export const PAYROLL_ATTENDANCE_SELFIE_MIME_TYPES = ["image/jpeg", "image/webp"] as const;

/** Exact Vietnamese text required for an incomplete attendance day. */
export const INCOMPLETE_DAY_MESSAGE = "Ngày công không được tính, vui lòng liên hệ quản lý duyệt";

const EARTH_RADIUS_M = 6371008.8;

export type AttendanceDayStatus = "complete" | "missing_in" | "missing_out" | "approved_override";

export interface AttendanceDayEvent {
  eventKind: AttendanceEventKind;
  decision: AttendanceDecision;
}

export interface EvaluateCheckinInput {
  eventKind: AttendanceEventKind;
  gateEnabled: boolean;
  siteConfigured: boolean;
  siteLatitude?: number | null;
  siteLongitude?: number | null;
  radiusM?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  deviceApproved: boolean;
  /** The employee has never had any device row; this device becomes active (owner decision 09/11). */
  isFirstDeviceForEmployee?: boolean;
  /** This device is already the active device of another employee. */
  deviceActiveForOtherEmployee?: boolean;
  deviceUsedByOtherEmployeeToday?: boolean;
  hasAcceptedIn?: boolean;
  hasAcceptedOut?: boolean;
}

export interface EvaluateCheckinResult {
  decision: AttendanceDecision;
  reasonCode: AttendanceRejectReason | null;
  distanceM: number | null;
  suspectedProxy: boolean;
}

export type SelfieUploadRejectReason = "selfie_required" | "selfie_type_invalid" | "selfie_too_large";

export type SelfieUploadValidation =
  | { ok: true }
  | { ok: false; reasonCode: SelfieUploadRejectReason; message: string };

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Great-circle distance in metres. Null/invalid inputs return NaN. */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  if (![lat1, lng1, lat2, lng2].every(isFiniteNumber)) return Number.NaN;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Vietnam-local work date (Asia/Ho_Chi_Minh) as YYYY-MM-DD. */
export function vietnamWorkDate(input: Date | string | number = new Date()): string {
  const date = input instanceof Date ? input : new Date(input);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  if (!year || !month || !day) return "";
  return `${year}-${month}-${day}`;
}

function coordinatesAreValid(latitude: number | null | undefined, longitude: number | null | undefined): boolean {
  return (
    isFiniteNumber(latitude) &&
    isFiniteNumber(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/**
 * Server-authoritative decision. The order is deliberate and matches the SQL
 * RPC: rollout gate, site configuration, device fix quality, device sharing,
 * device approval, in/out ordering, then the radius.
 */
export function evaluateCheckin(input: EvaluateCheckinInput): EvaluateCheckinResult {
  const reject = (
    reasonCode: AttendanceRejectReason,
    suspectedProxy = false,
    distanceM: number | null = null,
  ): EvaluateCheckinResult => ({
    decision: "rejected",
    reasonCode,
    distanceM,
    suspectedProxy,
  });

  if (!input.gateEnabled) return reject("gate_disabled");

  if (
    !input.siteConfigured ||
    !coordinatesAreValid(input.siteLatitude, input.siteLongitude) ||
    !isFiniteNumber(input.radiusM) ||
    input.radiusM <= 0
  ) {
    return reject("site_not_configured");
  }

  if (!coordinatesAreValid(input.latitude, input.longitude)) return reject("no_location");

  if (
    !isFiniteNumber(input.accuracyM) ||
    input.accuracyM < 0 ||
    input.accuracyM > PAYROLL_ATTENDANCE_MAX_ACCURACY_M
  ) {
    return reject("low_accuracy");
  }

  if (input.deviceUsedByOtherEmployeeToday) {
    return reject("device_used_by_other", true);
  }

  const autoRegisteredFirstDevice =
    !input.deviceApproved &&
    input.isFirstDeviceForEmployee === true &&
    input.deviceActiveForOtherEmployee !== true;
  if (!input.deviceApproved && !autoRegisteredFirstDevice) return reject("device_not_approved");

  if (input.eventKind === "out" && !input.hasAcceptedIn) {
    return reject("checkout_before_checkin");
  }

  if (
    (input.eventKind === "in" && input.hasAcceptedIn) ||
    (input.eventKind === "out" && input.hasAcceptedOut)
  ) {
    return reject("already_recorded");
  }

  const distanceM = haversineMeters(
    input.latitude as number,
    input.longitude as number,
    input.siteLatitude as number,
    input.siteLongitude as number,
  );

  if (!Number.isFinite(distanceM) || distanceM > (input.radiusM as number)) {
    return reject("outside_geofence", false, Number.isFinite(distanceM) ? distanceM : null);
  }

  return {
    decision: "accepted",
    reasonCode: null,
    distanceM,
    suspectedProxy: false,
  };
}

/**
 * Per-day status. A manager override only upgrades an otherwise incomplete day;
 * a day with both accepted punches is always complete.
 */
export function dayStatus(
  events: readonly AttendanceDayEvent[],
  override: boolean | null | undefined,
): AttendanceDayStatus {
  const hasAcceptedIn = events.some((event) => event.decision === "accepted" && event.eventKind === "in");
  const hasAcceptedOut = events.some((event) => event.decision === "accepted" && event.eventKind === "out");

  if (hasAcceptedIn && hasAcceptedOut) return "complete";
  if (override) return "approved_override";
  if (hasAcceptedIn) return "missing_out";
  return "missing_in";
}

/** Employee-facing message for a decision/reason code. */
export function attendanceMessage(reasonCode: string | null | undefined): string {
  switch (reasonCode) {
    case null:
    case undefined:
    case "":
    case "accepted":
      return "Đã chấm công.";
    case "gate_disabled":
      return "Chấm công GPS chưa được bật cho nhân viên này. Vui lòng liên hệ quản lý.";
    case "site_not_configured":
      return "Bếp Q7 chưa được cấu hình vị trí chấm công. Vui lòng liên hệ quản lý.";
    case "no_location":
      return "Không xác định được vị trí GPS. Vui lòng bật định vị và thử lại.";
    case "low_accuracy":
      return "Tín hiệu GPS chưa đủ chính xác. Vui lòng ra nơi thoáng và thử lại.";
    case "outside_geofence":
      return "Bạn đang ở ngoài phạm vi bếp. Vui lòng đến đúng vị trí và thử lại.";
    case "device_not_approved":
      return "Thiết bị này chưa được duyệt. Vui lòng chờ quản lý duyệt thiết bị.";
    case "device_used_by_other":
      return "Thiết bị này đã được dùng cho nhân viên khác trong ngày. Vui lòng liên hệ quản lý.";
    case "already_recorded":
      return "Hôm nay bạn đã chấm công mục này rồi.";
    case "checkout_before_checkin":
      return "Bạn cần chấm công vào trước khi chấm công ra.";
    case "session_invalid":
      return "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.";
    default:
      return "Không thực hiện được chấm công. Vui lòng thử lại.";
  }
}

/** Message for a day status: the exact incomplete text or empty when complete. */
export function dayStatusMessage(status: AttendanceDayStatus): string {
  return status === "complete" || status === "approved_override" ? "" : INCOMPLETE_DAY_MESSAGE;
}

/** Validate a selfie before upload: JPEG/WebP, non-empty, at most 600 KB. */
export function validateSelfieUpload(
  mime: string | null | undefined,
  bytes: number | Uint8Array | null | undefined,
): SelfieUploadValidation {
  const byteLength =
    typeof bytes === "number" ? bytes : bytes instanceof Uint8Array ? bytes.byteLength : 0;

  if (!byteLength || byteLength <= 0) {
    return { ok: false, reasonCode: "selfie_required", message: "Vui lòng chụp ảnh selfie." };
  }

  const normalizedMime = String(mime ?? "").trim().toLowerCase();
  if (!(PAYROLL_ATTENDANCE_SELFIE_MIME_TYPES as readonly string[]).includes(normalizedMime)) {
    return {
      ok: false,
      reasonCode: "selfie_type_invalid",
      message: "Ảnh selfie phải là JPEG hoặc WebP.",
    };
  }

  if (byteLength > PAYROLL_ATTENDANCE_SELFIE_MAX_BYTES) {
    return {
      ok: false,
      reasonCode: "selfie_too_large",
      message: "Ảnh selfie vượt quá 600 KB. Vui lòng chụp lại.",
    };
  }

  return { ok: true };
}
