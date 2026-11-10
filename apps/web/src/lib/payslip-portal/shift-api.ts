// Browser-side weekly shift client for the Bếp Q7 employee portal.
//
// Talks only to the payslip-shifts Edge Function. The server owns eligibility,
// quotas, waitlist state and the deadline; this module only maps the transport
// payload into camelCase and keeps the psp_ session + device headers consistent
// with mission-api.ts / attendance-api.ts.

import type {
  PayrollShiftCoverageCell,
  PayrollShiftCurrentEntry,
  PayrollShiftDay,
  PayrollShiftMyEntry,
  PayrollShiftQuotaGroupCell,
  PayrollShiftRegistrationEntry,
  PayrollShiftRequest,
  PayrollShiftRequestInput,
  PayrollShiftRequestKind,
  PayrollShiftRequestResult,
  PayrollShiftRequestState,
  PayrollShiftSource,
  PayrollShiftSourceType,
  PayrollShiftState,
  PayrollShiftSuggestion,
  PayrollShiftType,
  PayrollShiftWeek,
  PayrollShiftWeekInfo,
  PayrollShiftWeekStatus,
} from "./types.ts";
import { PayslipSessionExpiredError } from "./types.ts";
import type { PayslipStorage } from "./api.ts";
import { PAYSLIP_SESSION_STORAGE_KEY } from "./api.ts";
import { getOrCreateDeviceId } from "./device-id.ts";

export interface PayrollShiftApiOptions {
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

const SHIFT_ERROR = "Không tải được lịch ca. Vui lòng thử lại.";
const SUBMIT_ERROR = "Không thể đăng ký ca. Vui lòng thử lại.";
const REQUEST_ERROR = "Không thể gửi yêu cầu đổi ca. Vui lòng thử lại.";
const CANCEL_ERROR = "Không thể huỷ yêu cầu. Vui lòng thử lại.";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function asState(value: unknown): PayrollShiftState {
  return value === "waitlist" ? "waitlist" : "registered";
}

function asSource(value: unknown): PayrollShiftSourceType {
  if (value === "manager" || value === "carried") return value;
  return "employee";
}

function asStatus(value: unknown): PayrollShiftWeekStatus {
  return value === "published" ? "published" : "open";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asWeekInfo(value: unknown): PayrollShiftWeekInfo {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    weekStart: asString(row.week_start),
    status: asStatus(row.status),
    opensAt: asNullableString(row.opens_at),
    deadline: asNullableString(row.deadline),
    canEdit: row.can_edit === true,
    closedDates: asStringArray(row.closed_dates),
  };
}

function asShiftType(value: unknown): PayrollShiftType | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const code = asString(row.code);
  if (code === "") return null;
  return {
    code,
    label: asNullableString(row.label),
    startTime: asString(row.start_time),
    endTime: asNullableString(row.end_time),
    sort: asNumber(row.sort),
    active: row.active !== false,
  };
}

function asMyEntry(value: unknown): PayrollShiftMyEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return {
    shiftCode: typeof row.shift_code === "string" ? row.shift_code : null,
    state: asState(row.state),
    source: asSource(row.source),
    previousShiftCode: typeof row.previous_shift_code === "string"
      ? row.previous_shift_code
      : null,
  };
}

function asCoverageCell(value: unknown): PayrollShiftCoverageCell | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const code = asString(row.code) || asString(row.shift_code);
  if (code === "") return null;
  return {
    code,
    registered: asNumber(row.registered),
    needed: asNumber(row.needed),
    full: row.full === true,
    needMore: row.need_more === true,
  };
}

function asQuotaGroupCell(value: unknown): PayrollShiftQuotaGroupCell | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const quotaGroup = asString(row.quota_group);
  if (quotaGroup === "") return null;
  return {
    quotaGroup,
    registered: asNumber(row.registered),
    needed: asNumber(row.needed),
    full: row.full === true,
  };
}

function asDay(value: unknown): PayrollShiftDay | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const workDate = asString(row.work_date);
  if (workDate === "") return null;
  return {
    workDate,
    closed: row.closed === true,
    my: asMyEntry(row.my),
    shifts: Array.isArray(row.shifts)
      ? row.shifts
        .map(asCoverageCell)
        .filter((cell): cell is PayrollShiftCoverageCell => cell !== null)
      : [],
    quotaGroups: Array.isArray(row.quota_groups)
      ? row.quota_groups
        .map(asQuotaGroupCell)
        .filter((cell): cell is PayrollShiftQuotaGroupCell => cell !== null)
      : [],
    offCount: asNumber(row.off_count),
    offFull: row.off_full === true,
    totalStaff: asNumber(row.total_staff),
  };
}

function asSuggestion(value: unknown): PayrollShiftSuggestion | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const workDate = asString(row.work_date);
  if (workDate === "") return null;
  return {
    workDate,
    shiftCode: typeof row.shift_code === "string" ? row.shift_code : null,
    state: asState(row.state),
    carried: true,
  };
}

function asCurrentEntry(value: unknown): PayrollShiftCurrentEntry | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const workDate = asString(row.work_date);
  if (workDate === "") return null;
  return {
    workDate,
    shiftCode: typeof row.shift_code === "string" ? row.shift_code : null,
    state: asState(row.state),
    source: asSource(row.source),
  };
}

function asRequestKind(value: unknown): PayrollShiftRequestKind {
  return value === "leave" ? "leave" : "change";
}

function asRequestState(value: unknown): PayrollShiftRequestState {
  if (value === "approved" || value === "rejected" || value === "cancelled") return value;
  return "pending";
}

function asRequest(value: unknown): PayrollShiftRequest | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = asString(row.id);
  if (id === "") return null;
  return {
    id,
    workDate: asString(row.work_date),
    kind: asRequestKind(row.kind),
    fromShiftCode: typeof row.from_shift_code === "string" ? row.from_shift_code : null,
    toShiftCode: typeof row.to_shift_code === "string" ? row.to_shift_code : null,
    reason: asString(row.reason),
    state: asRequestState(row.state),
    decisionNote: typeof row.decision_note === "string" ? row.decision_note : null,
    createdAt: asNullableString(row.created_at),
    decidedAt: asNullableString(row.decided_at),
  };
}

/** Normalise the Edge Function result of a change/leave request. */
export function normalizeShiftRequestResult(
  data: Record<string, unknown> | null,
): PayrollShiftRequestResult {
  const request = asRequest(data?.request);
  const coverage = data?.coverage && typeof data.coverage === "object"
    ? asDay(data.coverage)
    : null;
  return { request, coverage };
}

function emptyWeek(): PayrollShiftWeek {
  return {
    eligible: false,
    week: {
      weekStart: "",
      status: "open",
      opensAt: null,
      deadline: null,
      canEdit: false,
      closedDates: [],
    },
    shiftTypes: [],
    days: [],
    suggestion: [],
    currentWeek: [],
    requests: [],
    canRequest: false,
  };
}

/** Map the Edge Function payload into the portal domain shape. */
export function normalizeShiftWeek(data: Record<string, unknown> | null): PayrollShiftWeek {
  const raw = data?.week;
  if (!raw || typeof raw !== "object") return emptyWeek();
  const row = raw as Record<string, unknown>;
  return {
    eligible: row.eligible === true,
    week: asWeekInfo(row.week),
    shiftTypes: Array.isArray(row.shift_types)
      ? row.shift_types
        .map(asShiftType)
        .filter((type): type is PayrollShiftType => type !== null)
      : [],
    days: Array.isArray(row.days)
      ? row.days.map(asDay).filter((day): day is PayrollShiftDay => day !== null)
      : [],
    suggestion: Array.isArray(row.suggestion)
      ? row.suggestion
        .map(asSuggestion)
        .filter((entry): entry is PayrollShiftSuggestion => entry !== null)
      : [],
    currentWeek: Array.isArray(row.current_week)
      ? row.current_week
        .map(asCurrentEntry)
        .filter((entry): entry is PayrollShiftCurrentEntry => entry !== null)
      : [],
    requests: Array.isArray(row.requests)
      ? row.requests
        .map(asRequest)
        .filter((request): request is PayrollShiftRequest => request !== null)
      : [],
    canRequest: row.can_request === true,
  };
}

export function createPayrollShiftApi(
  options: PayrollShiftApiOptions = {},
): PayrollShiftSource {
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

  const parse = async (response: Response): Promise<FunctionResult> => {
    let data: Record<string, unknown> | null = null;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  };

  const post = async (body: Record<string, unknown>, token: string, deviceId: string) => {
    try {
      return await fetchImpl(`${baseUrl}/payslip-shifts`, {
        method: "POST",
        headers: {
          ...baseHeaders(),
          "Content-Type": "application/json",
          "x-payslip-session": token,
          "x-payslip-device": deviceId,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error("Không thể kết nối máy chủ lịch ca. Vui lòng kiểm tra mạng và thử lại.");
    }
  };

  const handleUnauthorized = (result: FunctionResult): never => {
    if (result.status === 401) {
      storage.removeItem(sessionKey);
      throw new PayslipSessionExpiredError();
    }
    throw new Error(serverMessage(result.data) || SHIFT_ERROR);
  };

  return {
    async getShiftWeek(weekStart?: string) {
      const { token, deviceId } = requireSession();
      const body: Record<string, unknown> = { action: "get", session_token: token };
      if (typeof weekStart === "string" && weekStart.trim() !== "") {
        body.week_start = weekStart.trim();
      }
      const response = await post(body, token, deviceId);
      const result = await parse(response);
      if (result.status === 401) handleUnauthorized(result);
      if (!result.ok) {
        throw new Error(serverMessage(result.data) || SHIFT_ERROR);
      }
      return normalizeShiftWeek(result.data);
    },

    async submitShiftRegistration(
      weekStart: string | null | undefined,
      entries: PayrollShiftRegistrationEntry[],
    ) {
      const { token, deviceId } = requireSession();
      const response = await post(
        {
          action: "submit",
          week_start: weekStart ?? null,
          entries: entries.map((entry) => ({
            work_date: entry.workDate,
            shift_code: entry.shiftCode,
          })),
          session_token: token,
        },
        token,
        deviceId,
      );
      const result = await parse(response);
      if (result.status === 401) handleUnauthorized(result);
      if (!result.ok) {
        throw new Error(serverMessage(result.data) || SUBMIT_ERROR);
      }
      return normalizeShiftWeek(result.data);
    },

    async requestChange(input: PayrollShiftRequestInput) {
      const { token, deviceId } = requireSession();
      const response = await post(
        {
          action: "request",
          work_date: input.workDate,
          kind: input.kind,
          to_shift_code: input.toShiftCode ?? null,
          reason: input.reason,
          session_token: token,
        },
        token,
        deviceId,
      );
      const result = await parse(response);
      if (result.status === 401) handleUnauthorized(result);
      if (!result.ok) {
        throw new Error(serverMessage(result.data) || REQUEST_ERROR);
      }
      return normalizeShiftRequestResult(result.data);
    },

    async cancelRequest(requestId: string) {
      const { token, deviceId } = requireSession();
      const response = await post(
        {
          action: "cancel_request",
          request_id: requestId,
          session_token: token,
        },
        token,
        deviceId,
      );
      const result = await parse(response);
      if (result.status === 401) handleUnauthorized(result);
      if (!result.ok) {
        throw new Error(serverMessage(result.data) || CANCEL_ERROR);
      }
      return asRequest(result.data?.request);
    },
  };
}

export default createPayrollShiftApi;
