/**
 * Shared HTTP, validation and persistence helpers for dealer signup.
 *
 * This module is server-only. It never prints a provider key, Gmail token or
 * raw provider response.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import type { DealerRecord } from "./dealer-signup-distance.ts";

export const DEALER_SIGNUP_CHECK_LIMIT_PER_HOUR = 20;
export const DEALER_SIGNUP_SUBMIT_LIMIT_PER_HOUR = 5;
export const DEALER_SIGNUP_PRIMARY_ORIGIN = "https://dathang.banhmique.vn";

const STATIC_ALLOWED_ORIGINS = new Set([
  "https://dathang.banhmique.vn",
  "https://ai.banhmique.vn",
]);

function isAllowedLocalOrigin(origin: string): boolean {
  return /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin);
}

export function getDealerSignupCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = STATIC_ALLOWED_ORIGINS.has(origin) || isAllowedLocalOrigin(origin)
    ? origin
    : DEALER_SIGNUP_PRIMARY_ORIGIN;

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function dealerSignupPreflight(req: Request): Response {
  return new Response(null, { status: 204, headers: getDealerSignupCorsHeaders(req) });
}

export function dealerSignupJson(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getDealerSignupCorsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function dealerSignupError(
  req: Request,
  error: string,
  status = 400,
  code?: string,
): Response {
  return dealerSignupJson(req, { success: false, error, code }, status);
}

export async function readDealerSignupBody<T extends Record<string, unknown>>(
  req: Request,
): Promise<T> {
  try {
    const parsed = await req.json();
    return (parsed && typeof parsed === "object" ? parsed : {}) as T;
  } catch {
    return {} as T;
  }
}

export function getClientIp(req: Request): string {
  const forwarded = (req.headers.get("x-forwarded-for") || "").split(",")[0]?.trim();
  return forwarded ||
    req.headers.get("cf-connecting-ip")?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    "unknown";
}

/** Hash an IP with a server-only salt; the raw IP is never persisted. */
export async function hashClientIp(ip: string, salt: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function isWithinVietnam(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= 8 && lat <= 24 && lng >= 102 && lng <= 110;
}

export function parseFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeEmail(value: unknown): string | null {
  const email = String(value || "").trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(email)
    ? email
    : null;
}

/** Return a local 0xxxxxxxxx Vietnamese mobile number, or null. */
export function normalizeVietnamPhone(value: unknown): string | null {
  let digits = String(value || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+84")) digits = `84${digits.slice(3)}`;
  digits = digits.replace(/\D/g, "");
  if (digits.startsWith("0084")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `84${digits.slice(1)}`;
  if (!/^84(3|5|7|8|9)\d{8}$/.test(digits)) return null;
  return `0${digits.slice(2)}`;
}

export function normalizeCccd(value: unknown): string | null {
  const cccd = String(value || "").trim();
  return /^\d{9}$/.test(cccd) || /^\d{12}$/.test(cccd) ? cccd : null;
}

export function isIsoDate(value: unknown): boolean {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const timestamp = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === text;
}

export function isIdempotencyKey(value: unknown): boolean {
  const key = String(value || "").trim();
  return /^[A-Za-z0-9_-]{8,200}$/.test(key);
}

/** Contract/application date in Vietnam time. */
export function vietnamDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function generateApplicationCode(now: Date): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const suffix = String(random[0] % 10000).padStart(4, "0");
  return `DLM-${vietnamDate(now).replace(/-/g, "")}-${suffix}`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only expose a stable, non-secret error code. */
export function safeErrorCode(error: unknown, fallback = "unexpected_error"): string {
  const candidate = (error as { code?: unknown } | null)?.code;
  if (typeof candidate === "string" && /^[a-z0-9_]{1,80}$/.test(candidate)) return candidate;
  return fallback;
}

export type DealerSignupStatus =
  | "rejected_too_close"
  | "manual_review"
  | "contract_sent"
  | "email_failed";

export type DealerSignupApplication = {
  id: string;
  application_code: string;
  status: DealerSignupStatus;
  applicant_name: string;
  cccd: string;
  cccd_valid_until: string;
  phone: string;
  email: string;
  business_name: string;
  address_text: string;
  lat: number | string;
  lng: number | string;
  nearest_dealer_customer_id: string | null;
  nearest_distance_m: number | null;
  distance_provider: string | null;
  unlocated_dealer_count: number;
  idempotency_key: string;
  client_ip_hash: string | null;
  contract_sent_at: string | null;
  email_message_id: string | null;
  last_error_code: string | null;
  created_at?: string;
  updated_at?: string;
};

export type NewDealerSignupApplication = Omit<
  DealerSignupApplication,
  "id" | "created_at" | "updated_at"
>;

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
};

export type DealerSignupStore = {
  findByIdempotencyKey(key: string): Promise<DealerSignupApplication | null>;
  insert(row: NewDealerSignupApplication): Promise<DealerSignupApplication>;
  update(id: string, patch: Partial<DealerSignupApplication>): Promise<void>;
  loadActiveDealers(): Promise<DealerRecord[]>;
  checkRateLimit(ipHash: string, action: "check" | "submit", limit: number): Promise<RateLimitDecision>;
};


export function createDealerSignupServiceClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing Supabase service role configuration");
  }
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createSupabaseDealerSignupStore(supabase: any): DealerSignupStore {
  return {
    async findByIdempotencyKey(key: string) {
      const { data, error } = await supabase
        .from("dealer_signup_applications")
        .select("*")
        .eq("idempotency_key", key)
        .maybeSingle();
      if (error) throw error;
      return (data as DealerSignupApplication | null) ?? null;
    },

    async insert(row: NewDealerSignupApplication) {
      const { data, error } = await supabase
        .from("dealer_signup_applications")
        .insert(row)
        .select("*")
        .single();
      if (error) throw error;
      return data as DealerSignupApplication;
    },

    async update(id: string, patch: Partial<DealerSignupApplication>) {
      const { error } = await supabase
        .from("dealer_signup_applications")
        .update(patch)
        .eq("id", id);
      if (error) throw error;
    },

    async loadActiveDealers() {
      const { data, error } = await supabase
        .from("mini_crm_customers")
        .select("id, customer_name, address, customer_group, is_active, location_lat, location_lng")
        .eq("is_active", true)
        .in("customer_group", ["banhmi_agency", "banhmi_point"]);
      if (error) throw error;
      return (data || []) as DealerRecord[];
    },

    async checkRateLimit(ipHash: string, action: "check" | "submit", limit: number) {
      const { data, error } = await supabase.rpc("dealer_signup_record_rate_limit", {
        p_ip_hash: ipHash,
        p_action: action,
        p_limit: limit,
      });
      if (error) throw error;

      const value = (data || {}) as {
        allowed?: unknown;
        remaining?: unknown;
        retry_after_seconds?: unknown;
      };

      return {
        allowed: value.allowed === true,
        remaining: Math.max(0, Number(value.remaining) || 0),
        retry_after_seconds: Math.max(0, Number(value.retry_after_seconds) || 0),
      };
    },
  };
}
