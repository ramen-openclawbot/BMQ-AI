// Browser-side GPS attendance client for the Bếp Q7 employee portal.
//
// Talks only to the two attendance Edge Functions and never computes the
// attendance decision itself: the server re-checks the gate, device, geofence
// and in/out order. This module maps transport/HTTP failures to Vietnamese and
// keeps the psp_ session + device id headers consistent.

import type {
  AttendanceDayStatus,
  AttendanceEventKind,
  PayrollAttendanceCheckinInput,
  PayrollAttendanceCheckinResult,
  PayrollAttendanceConsentState,
  PayrollAttendanceDaySummary,
  PayrollAttendanceEvent,
  PayrollAttendanceSource,
  PayrollAttendanceTodayPayload,
} from "./types.ts";
import { PayslipSessionExpiredError } from "./types.ts";
import type { PayslipStorage } from "./api.ts";
import { PAYSLIP_SESSION_STORAGE_KEY } from "./api.ts";
import { getOrCreateDeviceId } from "./device-id.ts";
import {
  attendanceMessage,
  PAYROLL_ATTENDANCE_CONSENT_VERSION,
} from "../../../supabase/functions/_shared/payroll-attendance.ts";

export interface PayrollAttendanceApiOptions {
  /** Edge Functions base, e.g. https://<ref>.supabase.co/functions/v1 */
  baseUrl?: string;
  /** Supabase publishable/anon key sent as apikey + Bearer. */
  anonKey?: string;
  fetch?: typeof fetch;
  storage?: PayslipStorage;
  sessionKey?: string;
}

interface FunctionResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
}

function readEnv(): Record<string, string | undefined> {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
}

function defaultBaseUrl(): string {
  const url = readEnv().VITE_SUPABASE_URL ?? "";
  return url ? `${url.replace(/\/+$/, "")}/functions/v1` : "";
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

function defaultStorage(): PayslipStorage {
  const candidate = (globalThis as { localStorage?: PayslipStorage }).localStorage;
  if (candidate && typeof candidate.getItem === "function") return candidate;
  return memoryStorage();
}

function serverMessage(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  if (typeof data.message === "string" && data.message.trim() !== "") return data.message;
  if (typeof data.error === "string" && data.error.trim() !== "") return data.error;
  return null;
}

function serverReasonCode(data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const value = data.reason_code ?? data.code;
  return typeof value === "string" && value !== "" ? value : null;
}

/** Vietnamese message for an API/decision error, preferring the server text. */
export function attendanceErrorMessage(
  reasonCode: string | null | undefined,
  fallback?: string | null,
): string {
  if (fallback && fallback.trim() !== "") return fallback;
  return attendanceMessage(reasonCode);
}

function asDayStatus(value: unknown): AttendanceDayStatus {
  return value === "complete" || value === "missing_in" || value === "missing_out" || value === "approved_override"
    ? value
    : "missing_in";
}

function asEventKind(value: unknown): AttendanceEventKind {
  return value === "out" ? "out" : "in";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asEvent(value: unknown): PayrollAttendanceEvent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const reasonCode = typeof row.reason_code === "string" ? row.reason_code : null;
  const decision = row.decision === "accepted" ? "accepted" : "rejected";
  return {
    eventKind: asEventKind(row.event_kind),
    decision,
    reasonCode,
    message: attendanceErrorMessage(decision === "accepted" ? null : reasonCode, serverMessage(row)),
    workDate: String(row.work_date ?? ""),
    serverReceivedAt: String(row.server_received_at ?? ""),
    distanceM: asNumber(row.distance_m),
    suspectedProxy: row.suspected_proxy === true,
  };
}

function asDay(value: unknown): PayrollAttendanceDaySummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const status = asDayStatus(row.status);
  const message = typeof row.message === "string"
    ? row.message
    : status === "missing_in" || status === "missing_out"
      ? "Ngày công không được tính, vui lòng liên hệ quản lý duyệt"
      : "";
  return { workDate: String(row.work_date ?? ""), status, message };
}

function asConsent(
  value: unknown,
  fallbackVersion: string = PAYROLL_ATTENDANCE_CONSENT_VERSION,
): PayrollAttendanceConsentState {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    requiredVersion: typeof row.required_version === "string" && row.required_version.trim() !== ""
      ? row.required_version
      : fallbackVersion,
    accepted: row.accepted === true,
    acceptedAt: typeof row.accepted_at === "string" ? row.accepted_at : null,
    withdrawnAt: typeof row.withdrawn_at === "string" ? row.withdrawn_at : null,
  };
}

export function normalizeTodayPayload(data: Record<string, unknown> | null): PayrollAttendanceTodayPayload {
  const employee = (data?.employee ?? {}) as Record<string, unknown>;
  const today = (data?.today ?? {}) as Record<string, unknown>;
  const events = Array.isArray(today.events)
    ? today.events.map(asEvent).filter((event): event is PayrollAttendanceEvent => event !== null)
    : [];
  const incompleteDays = Array.isArray(data?.incomplete_days)
    ? data!.incomplete_days
        .map(asDay)
        .filter((day): day is PayrollAttendanceDaySummary => day !== null)
    : [];
  const status = asDayStatus(today.status);

  return {
    employee: {
      code: typeof employee.code === "string" ? employee.code : "",
      name: typeof employee.name === "string" ? employee.name : null,
    },
    gateEnabled: data?.gate_enabled === true,
    siteConfigured: data?.site_configured === true,
    siteName: typeof data?.site_name === "string" ? data.site_name : null,
    siteRadiusM: asNumber(data?.site_radius_m),
    today: {
      workDate: String(today.work_date ?? ""),
      status,
      message: typeof today.message === "string"
        ? today.message
        : status === "complete" || status === "approved_override"
          ? ""
          : "Ngày công không được tính, vui lòng liên hệ quản lý duyệt",
      events,
      consent: asConsent(data?.consent ?? today.consent),
    },
    incompleteDays,
  };
}

export function createPayrollAttendanceApi(options: PayrollAttendanceApiOptions = {}): PayrollAttendanceSource {
  const env = readEnv();
  const baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, "");
  const anonKey = options.anonKey ?? env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  const fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const storage = options.storage ?? defaultStorage();
  const sessionKey = options.sessionKey ?? PAYSLIP_SESSION_STORAGE_KEY;

  const baseHeaders = (): Record<string, string> => {
    const result: Record<string, string> = {};
    if (anonKey) {
      result.apikey = anonKey;
      result.Authorization = `Bearer ${anonKey}`;
    }
    return result;
  };

  const requireSession = (): { token: string; deviceId: string } => {
    const token = storage.getItem(sessionKey);
    if (!token) throw new PayslipSessionExpiredError();
    return { token, deviceId: getOrCreateDeviceId(storage) };
  };

  const handleUnauthorized = (result: FunctionResult): never => {
    if (result.status === 401) {
      storage.removeItem(sessionKey);
      throw new PayslipSessionExpiredError();
    }
    throw new Error(attendanceErrorMessage(serverReasonCode(result.data), serverMessage(result.data)));
  };

  const parse = async (response: Response): Promise<FunctionResult> => {
    let data: Record<string, unknown> | null = null;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  };

  const post = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(url, init);
    } catch {
      throw new Error("Không thể kết nối máy chủ chấm công. Vui lòng kiểm tra mạng và thử lại.");
    }
  };

  return {
    async getToday() {
      const { token, deviceId } = requireSession();
      const response = await post(`${baseUrl}/payslip-attendance-today`, {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/json",
          "x-payslip-session": token,
          "x-payslip-device": deviceId,
        },
        body: JSON.stringify({ session_token: token }),
      });
      const result = await parse(response);
      if (result.status === 401) handleUnauthorized(result);
      if (!result.ok) {
        throw new Error(attendanceErrorMessage(serverReasonCode(result.data), serverMessage(result.data)));
      }
      return normalizeTodayPayload(result.data);
    },

    async checkIn(input: PayrollAttendanceCheckinInput) {
      const { token, deviceId } = requireSession();
      const form = new FormData();
      form.append("kind", input.kind);
      if (input.latitude !== null && Number.isFinite(input.latitude)) {
        form.append("lat", String(input.latitude));
      }
      if (input.longitude !== null && Number.isFinite(input.longitude)) {
        form.append("lng", String(input.longitude));
      }
      if (input.accuracyM !== null && Number.isFinite(input.accuracyM)) {
        form.append("accuracy", String(input.accuracyM));
      }
      form.append("captured_at", input.capturedAt);
      form.append(
        "selfie",
        input.selfie,
        input.selfieFileName ?? (input.selfie.type === "image/webp" ? "selfie.webp" : "selfie.jpg"),
      );

      const response = await post(`${baseUrl}/payslip-attendance-checkin`, {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "x-payslip-session": token,
          "x-payslip-device": deviceId,
        },
        body: form,
      });
      const result = await parse(response);
      if (result.status === 401) handleUnauthorized(result);
      if (!result.ok) {
        throw new Error(attendanceErrorMessage(serverReasonCode(result.data), serverMessage(result.data)));
      }

      const decision = result.data?.decision === "accepted" ? "accepted" : "rejected";
      const reasonCode = typeof result.data?.reason_code === "string" ? result.data.reason_code : null;
      return {
        decision,
        reasonCode,
        message: attendanceErrorMessage(
          decision === "accepted" ? null : reasonCode,
          typeof result.data?.message === "string" ? result.data.message : null,
        ),
        suspectedProxy: result.data?.suspected_proxy === true,
        workDate: typeof result.data?.work_date === "string" ? result.data.work_date : null,
        distanceM: asNumber(result.data?.distance_m),
        eventId: typeof result.data?.event_id === "string" ? result.data.event_id : null,
      } satisfies PayrollAttendanceCheckinResult;
    },

    async acceptConsent(version: string) {
      const { token, deviceId } = requireSession();
      const response = await post(`${baseUrl}/payslip-attendance-consent`, {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/json",
          "x-payslip-session": token,
          "x-payslip-device": deviceId,
        },
        body: JSON.stringify({ action: "accept", version, session_token: token }),
      });
      const result = await parse(response);
      if (result.status === 401) handleUnauthorized(result);
      if (!result.ok) {
        throw new Error(attendanceErrorMessage(serverReasonCode(result.data), serverMessage(result.data)));
      }
      return asConsent(result.data?.consent, version);
    },

    async withdrawConsent() {
      const { token, deviceId } = requireSession();
      const response = await post(`${baseUrl}/payslip-attendance-consent`, {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/json",
          "x-payslip-session": token,
          "x-payslip-device": deviceId,
        },
        body: JSON.stringify({ action: "withdraw", session_token: token }),
      });
      const result = await parse(response);
      if (result.status === 401) handleUnauthorized(result);
      if (!result.ok) {
        throw new Error(attendanceErrorMessage(serverReasonCode(result.data), serverMessage(result.data)));
      }
      return asConsent(result.data?.consent);
    },
  };
}

export default createPayrollAttendanceApi;
