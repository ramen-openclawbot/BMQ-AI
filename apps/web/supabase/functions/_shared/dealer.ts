import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "./cors.ts";

const encoder = new TextEncoder();
const OTP_TTL_MINUTES = 5;
const SESSION_TTL_DAYS = 30;

export type DealerCustomerProfile = {
  id: string;
  customer_name: string | null;
  customer_code?: string | null;
  customer_group?: string | null;
  address?: string | null;
  is_active?: boolean | null;
  is_npp?: boolean | null;
  supplied_by_npp_customer_id?: string | null;
};

export type DealerSessionContext = {
  session: {
    id: string;
    customer_id: string;
    contact_id: string | null;
    expires_at: string;
  };
  customer: DealerCustomerProfile;
  contact: {
    id: string;
    contact_name?: string | null;
    phone_normalized?: string | null;
  } | null;
};

export function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

export function errorResponse(req: Request, error: string, status = 400, code?: string): Response {
  return jsonResponse(req, { success: false, error, code }, status);
}

export async function readJsonBody<T extends Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export function createServiceClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing Supabase service role configuration");
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function normalizeDealerPhone(input: unknown): string | null {
  const raw = String(input || "").trim();
  if (!raw) return null;

  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+84")) digits = `84${digits.slice(3)}`;
  digits = digits.replace(/\D/g, "");

  if (digits.startsWith("0084")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `84${digits.slice(1)}`;

  return /^84(3|5|7|8|9)\d{8}$/.test(digits) ? digits : null;
}

export function maskDealerPhone(phoneNormalized: string): string {
  const local = phoneNormalized.startsWith("84") ? `0${phoneNormalized.slice(2)}` : phoneNormalized;
  if (local.length < 10) return local;
  return `${local.slice(0, 4)} *** ${local.slice(-3)}`;
}

export function generateDealerOtp(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(100000 + (bytes[0] % 900000));
}

export function getOtpExpiresAt(): string {
  return new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();
}

export function getSessionExpiresAt(): string {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export async function hashDealerOtp(challengeId: string, phoneNormalized: string, otp: string): Promise<string> {
  return sha256Hex(["dealer-otp-v1", challengeId, phoneNormalized, otp, getDealerSecret()].join(":"));
}

export async function hashDealerSessionToken(token: string): Promise<string> {
  return sha256Hex(["dealer-session-v1", token, getDealerSecret()].join(":"));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function generateDealerSessionToken(): string {
  return `dop_${randomBase64Url(32)}`;
}

export function getRequestMetadata(req: Request): { request_ip: string | null; user_agent: string | null } {
  const forwardedFor = req.headers.get("x-forwarded-for") || "";
  return {
    request_ip: forwardedFor.split(",")[0]?.trim() || req.headers.get("cf-connecting-ip") || null,
    user_agent: req.headers.get("user-agent"),
  };
}

export function extractDealerSessionToken(body: Record<string, unknown>, req: Request): string | null {
  const raw =
    body.dealer_token ||
    body.session_token ||
    body.dealerSessionToken ||
    req.headers.get("x-dealer-session");

  const token = typeof raw === "string" ? raw.trim() : "";
  return token.startsWith("dop_") ? token : null;
}

type DealerServiceClient = ReturnType<typeof createServiceClient>;

export async function resolveDealerSession(supabase: DealerServiceClient, token: string): Promise<DealerSessionContext | null> {
  const tokenHash = await hashDealerSessionToken(token);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("dealer_sessions")
    .select(
      "id, customer_id, contact_id, expires_at, mini_crm_customers!inner(id, customer_name, customer_code, customer_group, address, is_active, is_npp, supplied_by_npp_customer_id), dealer_customer_contacts(id, contact_name, phone_normalized, is_active)",
    )
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .gt("expires_at", now)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const customer = data.mini_crm_customers as DealerCustomerProfile | null;
  const contact = data.dealer_customer_contacts as DealerSessionContext["contact"] & { is_active?: boolean | null };

  if (!customer?.is_active || contact?.is_active === false) return null;

  await supabase
    .from("dealer_sessions")
    .update({ last_seen_at: now })
    .eq("id", data.id);

  return {
    session: {
      id: data.id,
      customer_id: data.customer_id,
      contact_id: data.contact_id,
      expires_at: data.expires_at,
    },
    customer,
    contact: contact
      ? {
          id: contact.id,
          contact_name: contact.contact_name,
          phone_normalized: contact.phone_normalized,
        }
      : null,
  };
}

export function publicCustomerProfile(customer: DealerCustomerProfile) {
  return {
    id: customer.id,
    name: customer.customer_name,
    code: customer.customer_code,
    group: customer.customer_group,
    address: customer.address,
    is_npp: customer.is_npp,
    supplied_by_npp_customer_id: customer.supplied_by_npp_customer_id,
  };
}

export function assertDealerZnsConfiguredOrDevSkip(): void {
  const allowSkip = Deno.env.get("DEALER_AUTH_DEV_ALLOW_SKIP_ZNS")?.toLowerCase() === "true";
  if (allowSkip) return;

  const accessToken = Deno.env.get("DEALER_VIETGUYS_ACCESS_TOKEN");
  const username = Deno.env.get("DEALER_VIETGUYS_USERNAME");
  const oaId = Deno.env.get("DEALER_VIETGUYS_OA_ID");
  const templateId = Deno.env.get("DEALER_VIETGUYS_TEMPLATE_ID");

  if (!accessToken || !username || !oaId || !templateId) {
    throw new Error(
      "VietGuys ZBS Mobile OTP is not configured. Set DEALER_VIETGUYS_ACCESS_TOKEN, DEALER_VIETGUYS_USERNAME, DEALER_VIETGUYS_OA_ID, and DEALER_VIETGUYS_TEMPLATE_ID, or set DEALER_AUTH_DEV_ALLOW_SKIP_ZNS=true for local development.",
    );
  }
}

export async function sendDealerOtpZns(params: {
  phoneNormalized: string;
  otp: string;
  challengeId: string;
}): Promise<{ provider: string; skipped: boolean; response?: unknown }> {
  const allowSkip = Deno.env.get("DEALER_AUTH_DEV_ALLOW_SKIP_ZNS")?.toLowerCase() === "true";
  const accessToken = Deno.env.get("DEALER_VIETGUYS_ACCESS_TOKEN");
  const username = Deno.env.get("DEALER_VIETGUYS_USERNAME");
  const oaId = Deno.env.get("DEALER_VIETGUYS_OA_ID");
  const templateId = Deno.env.get("DEALER_VIETGUYS_TEMPLATE_ID");
  const smsBrand = Deno.env.get("DEALER_VIETGUYS_SMS_BRAND") || "BMQ";
  const endpoint = Deno.env.get("DEALER_VIETGUYS_ENDPOINT") || "https://api-v2.vietguys.biz:4438/zalo/v4/send";

  if (!accessToken || !username || !oaId || !templateId) {
    if (allowSkip) {
      console.info(`[dealer-auth] Dev VietGuys skip enabled. OTP for ${maskDealerPhone(params.phoneNormalized)} is ${params.otp}`);
      return { provider: "dev_skip", skipped: true };
    }
    throw new Error("VietGuys ZBS Mobile OTP is not configured");
  }

  const providerRequestBody = {
    username,
    mobile: params.phoneNormalized,
    tracking_id: params.challengeId,
    failover: "sms",
    zns: {
      oa_id: oaId,
      template_id: templateId,
      template_data: {
        otp: params.otp,
        code: params.otp,
      },
    },
    sms: {
      message: `Ma OTP BMQ cua ban la ${params.otp}`,
      brand: smsBrand,
      unicode: false,
    },
  };

  const relayUrl = Deno.env.get("DEALER_OTP_RELAY_URL");
  const relaySecret = Deno.env.get("DEALER_OTP_RELAY_SECRET");
  const response = relayUrl && relaySecret
    ? await sendVietGuysRequestViaRelay({ relayUrl, relaySecret, endpoint, accessToken, providerRequestBody })
    : await fetch(endpoint, {
      method: "POST",
      headers: {
        "Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(providerRequestBody),
    });

  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    const preview = text.slice(0, 80).replace(/\s+/g, " ").trim();
    throw new Error(`VietGuys ZBS Mobile OTP send failed: provider returned non-JSON response${preview ? ` (${preview})` : ""}`);
  }

  const providerError = typeof payload === "object" && payload !== null && "error" in payload
    ? Number((payload as { error?: unknown }).error)
    : 0;

  if (!response.ok || providerError !== 0) {
    const providerCode = typeof payload === "object" && payload !== null && "error_code" in payload
      ? ` code=${String((payload as { error_code?: unknown }).error_code)}`
      : "";
    throw new Error(`VietGuys ZBS Mobile OTP send failed${providerCode}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }

  return { provider: "vietguys_zbs_mobile", skipped: false, response: payload };
}

async function sendVietGuysRequestViaRelay(params: {
  relayUrl: string;
  relaySecret: string;
  endpoint: string;
  accessToken: string;
  providerRequestBody: Record<string, unknown>;
}): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    endpoint: params.endpoint,
    accessToken: params.accessToken,
    payload: params.providerRequestBody,
  });
  const signature = await hmacSha256Hex(params.relaySecret, `${timestamp}.${body}`);

  return fetch(params.relayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BMQ-Relay-Timestamp": timestamp,
      "X-BMQ-Relay-Signature": signature,
    },
    body,
  });
}

async function hmacSha256Hex(secret: string, input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(input));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getDealerSecret(): string {
  return (
    Deno.env.get("DEALER_AUTH_SECRET") ||
    Deno.env.get("DEALER_AUTH_OTP_PEPPER") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    "dealer-local-secret"
  );
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
