// Browser-side monthly mission client for the Bếp Q7 employee portal.
//
// Talks only to the payslip-mission Edge Function. The server owns progress,
// final review, the draw ticket and every amount; this module only maps the
// transport payload into camelCase and keeps the psp_ session + device headers
// consistent with attendance-api.ts.

import type {
  PayrollMissionCampaign,
  PayrollMissionDecision,
  PayrollMissionEarnedItem,
  PayrollMissionItem,
  PayrollMissionItemKind,
  PayrollMissionOffer,
  PayrollMissionProgressDetail,
  PayrollMissionProgressItem,
  PayrollMissionReview,
  PayrollMissionSource,
  PayrollMissionStatus,
  PayrollMissionTicket,
} from "./types.ts";
import { PayslipSessionExpiredError } from "./types.ts";
import type { PayslipStorage } from "./api.ts";
import { PAYSLIP_SESSION_STORAGE_KEY } from "./api.ts";
import { getOrCreateDeviceId } from "./device-id.ts";

export interface PayrollMissionApiOptions {
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

const MISSION_ERROR = "Không tải được nhiệm vụ. Vui lòng thử lại.";
const RESPOND_ERROR = "Không thể phản hồi nhiệm vụ. Vui lòng thử lại.";

const ITEM_KINDS: readonly PayrollMissionItemKind[] = [
  "attendance_regular",
  "punctual",
  "draw_ticket",
  "manual",
];

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function asItemKind(value: unknown): PayrollMissionItemKind {
  return typeof value === "string" && (ITEM_KINDS as readonly string[]).includes(value)
    ? (value as PayrollMissionItemKind)
    : "manual";
}

function asStatus(value: unknown): PayrollMissionStatus {
  return value === "accepted" || value === "declined" ? value : "pending";
}

function asItem(value: unknown): PayrollMissionItem | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const key = asString(row.key);
  if (key === "") return null;
  return {
    key,
    label: asString(row.label),
    detail: typeof row.detail === "string" ? row.detail : null,
    kind: asItemKind(row.kind),
    amountVnd: asNumber(row.amount_vnd),
  };
}

function asCampaign(value: unknown): PayrollMissionCampaign {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const items = Array.isArray(row.items)
    ? row.items.map(asItem).filter((item): item is PayrollMissionItem => item !== null)
    : [];
  const rules = Array.isArray(row.rules)
    ? row.rules.filter((rule): rule is string => typeof rule === "string")
    : [];
  return {
    title: asString(row.title),
    summary: typeof row.summary === "string" ? row.summary : null,
    startsOn: asString(row.starts_on),
    endsOn: asString(row.ends_on),
    items,
    rules,
    draw: row.draw && typeof row.draw === "object" && !Array.isArray(row.draw)
      ? (row.draw as Record<string, unknown>)
      : null,
  };
}

function asProgressDetail(value: unknown): PayrollMissionProgressDetail {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    daysWithIn: asNumber(row.days_with_in),
    daysComplete: asNumber(row.days_complete),
    daysMissingOut: asNumber(row.days_missing_out),
    onTimeDays: asNumber(row.on_time_days),
    minDays: asNumber(row.min_days),
    graceMinutes: asNumber(row.grace_minutes),
    cutoff: asString(row.cutoff),
    windowFrom: asString(row.window_from),
    windowTo: asString(row.window_to),
  };
}

function asProgressItem(value: unknown): PayrollMissionProgressItem | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const key = asString(row.key);
  if (key === "") return null;
  return {
    key,
    kind: asItemKind(row.kind),
    met: row.met === true,
    detail: asProgressDetail(row.detail),
  };
}

function asEarned(value: unknown): PayrollMissionEarnedItem | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const key = asString(row.key);
  if (key === "") return null;
  return { key, amountVnd: asNumber(row.amount_vnd) };
}

function asReview(value: unknown): PayrollMissionReview | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const earned = Array.isArray(row.earned)
    ? row.earned.map(asEarned).filter((item): item is PayrollMissionEarnedItem => item !== null)
    : [];
  return { earned, disqualified: row.disqualified === true };
}

function asTicket(value: unknown): PayrollMissionTicket | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return {
    quarter: asString(row.quarter),
    issuedAt: asString(row.issued_at),
    voidReason: typeof row.void_reason === "string" ? row.void_reason : null,
  };
}

/** Map the Edge Function payload into the portal domain shape. */
export function normalizeMissionOffer(
  data: Record<string, unknown> | null,
): PayrollMissionOffer | null {
  const offer = data?.offer;
  if (!offer || typeof offer !== "object") return null;
  const row = offer as Record<string, unknown>;
  const id = asString(row.id);
  if (id === "") return null;

  return {
    id,
    status: asStatus(row.status),
    campaign: asCampaign(row.campaign),
    progress: Array.isArray(row.progress)
      ? row.progress
        .map(asProgressItem)
        .filter((item): item is PayrollMissionProgressItem => item !== null)
      : [],
    review: asReview(row.review),
    ticket: asTicket(row.ticket),
  };
}

export function createPayrollMissionApi(
  options: PayrollMissionApiOptions = {},
): PayrollMissionSource {
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
      return await fetchImpl(`${baseUrl}/payslip-mission`, {
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
      throw new Error("Không thể kết nối máy chủ nhiệm vụ. Vui lòng kiểm tra mạng và thử lại.");
    }
  };

  const handleUnauthorized = (result: FunctionResult): never => {
    if (result.status === 401) {
      storage.removeItem(sessionKey);
      throw new PayslipSessionExpiredError();
    }
    throw new Error(serverMessage(result.data) || MISSION_ERROR);
  };

  return {
    async getMission() {
      const { token, deviceId } = requireSession();
      const response = await post({ action: "get", session_token: token }, token, deviceId);
      const result = await parse(response);
      if (result.status === 401) handleUnauthorized(result);
      if (!result.ok) {
        throw new Error(serverMessage(result.data) || MISSION_ERROR);
      }
      return normalizeMissionOffer(result.data);
    },

    async respondMission(offerId: string, decision: PayrollMissionDecision) {
      const { token, deviceId } = requireSession();
      const response = await post(
        {
          action: "respond",
          offer_id: offerId,
          decision,
          session_token: token,
        },
        token,
        deviceId,
      );
      const result = await parse(response);
      if (result.status === 401) handleUnauthorized(result);
      if (!result.ok) {
        throw new Error(serverMessage(result.data) || RESPOND_ERROR);
      }
      return normalizeMissionOffer(result.data);
    },
  };
}

export default createPayrollMissionApi;
