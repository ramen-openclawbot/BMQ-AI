// Browser-side payslip portal API client.
//
// Implements PayslipPortalSource (the UI contract in types.ts) against the four
// payslip-* Edge Functions. The session token lives in localStorage under
// 'bmq_payslip_session'; an expired/revoked session clears it and throws
// PayslipSessionExpiredError so the UI can send the employee back to OTP.
//
// No React and no UI: this module only talks HTTP.

import type {
  Payslip,
  PayslipEmployee,
  PayslipMission,
  PayslipMissionAcceptResult,
  PayslipPortalSource,
} from "./types.ts";
import { PayslipSessionExpiredError } from "./types.ts";

export const PAYSLIP_SESSION_STORAGE_KEY = "bmq_payslip_session";

const GENERIC_START_MESSAGE =
  "Nếu số điện thoại thuộc nhân viên đang hoạt động, mã OTP được gửi qua Zalo ZNS.";

export interface PayslipStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PayslipApiOptions {
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

function asEmployee(value: unknown): PayslipEmployee | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.code !== "string" || row.code === "") return null;
  return {
    code: row.code,
    name: typeof row.name === "string" ? row.name : "",
    groupName: typeof row.groupName === "string" ? row.groupName : null,
  };
}

function errorMessage(data: Record<string, unknown> | null): string {
  if (data && typeof data.error === "string" && data.error !== "") return data.error;
  return "Không thực hiện được thao tác. Vui lòng thử lại.";
}

function asMission(value: unknown): PayslipMission | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === "") return null;
  const status = typeof row.status === "string" ? row.status : "published";
  return {
    id: row.id,
    periodId: typeof row.periodId === "string" ? row.periodId : "",
    code: typeof row.code === "string" ? row.code : "",
    name: typeof row.name === "string" ? row.name : "",
    description: typeof row.description === "string" ? row.description : null,
    mode: typeof row.mode === "string" ? row.mode : "",
    status: status as PayslipMission["status"],
    reason: typeof row.reason === "string" ? row.reason : null,
    rewardVnd: typeof row.rewardVnd === "number" ? row.rewardVnd : null,
    acceptDeadline: typeof row.acceptDeadline === "string" ? row.acceptDeadline : null,
    acceptedAt: typeof row.acceptedAt === "string" ? row.acceptedAt : null,
  };
}

export function createPayslipApiSource(options: PayslipApiOptions = {}): PayslipPortalSource {
  const env = readEnv();
  const baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, "");
  const anonKey = options.anonKey ?? env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  const fetchImpl = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const storage = options.storage ?? defaultStorage();
  const sessionKey = options.sessionKey ?? PAYSLIP_SESSION_STORAGE_KEY;

  const headers = (): Record<string, string> => {
    const result: Record<string, string> = { "Content-Type": "application/json" };
    if (anonKey) {
      result.apikey = anonKey;
      result.Authorization = `Bearer ${anonKey}`;
    }
    return result;
  };

  const post = async (name: string, payload: Record<string, unknown>): Promise<FunctionResult> => {
    const response = await fetchImpl(`${baseUrl}/${name}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
    });
    let data: Record<string, unknown> | null = null;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  };

  const requireList = async (): Promise<{ employee: PayslipEmployee; payslips: Payslip[] }> => {
    const token = storage.getItem(sessionKey);
    if (!token) throw new PayslipSessionExpiredError();

    const result = await post("payslip-list", { session_token: token });
    if (result.status === 401) {
      storage.removeItem(sessionKey);
      throw new PayslipSessionExpiredError();
    }
    if (!result.ok) throw new Error(errorMessage(result.data));

    const employee = asEmployee(result.data?.employee);
    const payslips = Array.isArray(result.data?.payslips) ? (result.data?.payslips as Payslip[]) : [];
    if (!employee) {
      storage.removeItem(sessionKey);
      throw new PayslipSessionExpiredError();
    }
    return { employee, payslips };
  };

  const requireMissions = async (): Promise<PayslipMission[]> => {
    const token = storage.getItem(sessionKey);
    if (!token) throw new PayslipSessionExpiredError();

    const result = await post("payslip-missions", { session_token: token });
    if (result.status === 401) {
      storage.removeItem(sessionKey);
      throw new PayslipSessionExpiredError();
    }
    if (!result.ok) throw new Error(errorMessage(result.data));

    const raw = Array.isArray(result.data?.missions) ? (result.data?.missions as unknown[]) : [];
    return raw.map(asMission).filter((item): item is PayslipMission => item !== null);
  };

  return {
    async startOtp(phone: string) {
      const result = await post("payslip-auth-start", { phone });
      if (!result.ok) throw new Error(errorMessage(result.data));
      const message = result.data && typeof result.data.message === "string"
        ? result.data.message
        : GENERIC_START_MESSAGE;
      return { message };
    },

    async verifyOtp(phone: string, otp: string) {
      const result = await post("payslip-auth-verify", { phone, otp });
      if (!result.ok) throw new Error(errorMessage(result.data));

      const token = result.data && typeof result.data.session_token === "string"
        ? result.data.session_token
        : "";
      if (!token) throw new Error("Không nhận được phiên đăng nhập. Vui lòng thử lại.");
      storage.setItem(sessionKey, token);
    },

    async restoreSession() {
      const token = storage.getItem(sessionKey);
      if (!token) return null;

      const result = await post("payslip-list", { session_token: token });
      if (result.status === 401) {
        storage.removeItem(sessionKey);
        throw new PayslipSessionExpiredError();
      }
      if (!result.ok) throw new Error(errorMessage(result.data));

      const employee = asEmployee(result.data?.employee);
      if (!employee) {
        storage.removeItem(sessionKey);
        return null;
      }
      return employee;
    },

    listPayslips: requireList,

    listMissions: requireMissions,

    async acceptMission(missionId: string) {
      const token = storage.getItem(sessionKey);
      if (!token) throw new PayslipSessionExpiredError();

      const result = await post("payslip-mission-accept", {
        session_token: token,
        mission_id: missionId,
      });
      if (result.status === 401) {
        storage.removeItem(sessionKey);
        throw new PayslipSessionExpiredError();
      }
      if (!result.ok) {
        // Re-read the list before the employee may retry, so the UI never keeps
        // a stale mission on screen.
        try {
          await requireMissions();
        } catch {
          // The original error is the one worth surfacing.
        }
        throw new Error(errorMessage(result.data));
      }

      const mission = result.data?.mission as Record<string, unknown> | undefined;
      if (!mission || typeof mission.id !== "string") {
        throw new Error("Không nhận được nhiệm vụ. Vui lòng thử lại.");
      }
      const status = typeof mission.status === "string" ? mission.status : "accepted";
      const acceptedAt = typeof mission.acceptedAt === "string" ? mission.acceptedAt : null;
      const accepted: PayslipMissionAcceptResult = {
        id: mission.id,
        periodId: typeof mission.periodId === "string" ? mission.periodId : "",
        status: status as PayslipMissionAcceptResult["status"],
        acceptedAt,
      };
      return accepted;
    },

    async logout() {
      const token = storage.getItem(sessionKey);
      try {
        if (token) await post("payslip-auth-logout", { session_token: token });
      } catch {
        // Clearing the local session is what matters for the employee.
      } finally {
        storage.removeItem(sessionKey);
      }
    },
  };
}

export default createPayslipApiSource;
