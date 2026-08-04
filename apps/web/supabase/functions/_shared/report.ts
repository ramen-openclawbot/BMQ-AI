import {
  createServiceClient,
  errorResponse,
  generateDealerOtp,
  getOtpExpiresAt,
  getRequestMetadata,
  getSessionExpiresAt,
  jsonResponse,
  normalizeDealerPhone,
  readJsonBody,
  sendDealerOtpZns,
  timingSafeEqual,
} from "./dealer.ts";

const encoder = new TextEncoder();

export {
  createServiceClient,
  errorResponse,
  generateDealerOtp,
  getOtpExpiresAt,
  getRequestMetadata,
  getSessionExpiresAt,
  jsonResponse,
  normalizeDealerPhone,
  readJsonBody,
  sendDealerOtpZns,
  timingSafeEqual,
};

export type ReportLocation = {
  id: string;
  location_code: string | null;
  location_name: string | null;
  address: string | null;
  active?: boolean | null;
};

export type ReportStaff = {
  id: string;
  full_name: string | null;
  phone_normalized: string | null;
  location_id: string | null;
  active?: boolean | null;
  kiosk_report_locations?: ReportLocation | ReportLocation[] | null;
};

export type ReportSessionContext = {
  session: {
    id: string;
    staff_id: string;
    location_id: string;
    expires_at: string;
  };
  staff: ReportStaff;
  location: ReportLocation;
};

type ReportServiceClient = ReturnType<typeof createServiceClient>;

type ReportAuthRateLimitOptions = {
  scope: string;
  key: string;
  maxAttempts: number;
  windowSeconds: number;
};

export async function hashReportOtp(challengeId: string, phoneNormalized: string, otp: string): Promise<string> {
  return sha256Hex(["report-otp-v1", challengeId, phoneNormalized, otp, getReportSecret()].join(":"));
}

export async function hashReportSessionToken(token: string): Promise<string> {
  return sha256Hex(["report-session-v1", token, getReportSecret()].join(":"));
}

export async function hashReportRateLimitKey(scope: string, key: string): Promise<string> {
  return sha256Hex(["report-rate-limit-v1", scope, key, getReportSecret()].join(":"));
}

export async function consumeReportAuthRateLimit(
  supabase: ReportServiceClient,
  options: ReportAuthRateLimitOptions,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const keyHash = await hashReportRateLimitKey(options.scope, options.key || "unknown");
  const { data, error } = await supabase.rpc("consume_kiosk_report_auth_rate_limit", {
    p_scope: options.scope,
    p_key_hash: keyHash,
    p_max_attempts: options.maxAttempts,
    p_window_seconds: options.windowSeconds,
  });

  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: row?.allowed === true,
    retryAfterSeconds: Math.max(1, Number(row?.retry_after_seconds || options.windowSeconds)),
  };
}

export function generateReportSessionToken(): string {
  return `krp_${randomBase64Url(32)}`;
}

export function extractReportSessionToken(body: Record<string, unknown>, req: Request): string | null {
  const raw =
    body.report_token ||
    body.session_token ||
    body.reportSessionToken ||
    req.headers.get("x-report-session");

  const token = typeof raw === "string" ? raw.trim() : "";
  return token.startsWith("krp_") ? token : null;
}

export async function resolveReportSession(supabase: ReportServiceClient, token: string): Promise<ReportSessionContext | null> {
  const tokenHash = await hashReportSessionToken(token);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("kiosk_report_sessions")
    .select(
      "id, staff_id, location_id, expires_at, kiosk_report_staff!inner(id, full_name, phone_normalized, location_id, active, kiosk_report_locations!inner(id, location_code, location_name, address, active))",
    )
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .gt("expires_at", now)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const staff = data.kiosk_report_staff as ReportStaff | null;
  const location = Array.isArray(staff?.kiosk_report_locations)
    ? staff?.kiosk_report_locations[0]
    : staff?.kiosk_report_locations;

  const sessionLocationId = String(data.location_id || "");
  const currentLocationId = String(staff?.location_id || "");
  if (!staff?.active || !location?.active || !currentLocationId || sessionLocationId !== currentLocationId) {
    await supabase
      .from("kiosk_report_sessions")
      .update({ revoked_at: now })
      .eq("id", data.id)
      .is("revoked_at", null);
    return null;
  }

  await supabase
    .from("kiosk_report_sessions")
    .update({ last_seen_at: now })
    .eq("id", data.id);

  return {
    session: {
      id: data.id,
      staff_id: data.staff_id,
      location_id: data.location_id,
      expires_at: data.expires_at,
    },
    staff,
    location,
  };
}

export function publicReportStaffProfile(staff: ReportStaff, location: ReportLocation) {
  return {
    staff: {
      full_name: staff.full_name,
    },
    location: {
      code: location.location_code,
      name: location.location_name,
      address: location.address,
    },
  };
}

export function vietnamToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getReportSecret(): string {
  return (
    Deno.env.get("REPORT_AUTH_SECRET") ||
    Deno.env.get("REPORT_AUTH_OTP_PEPPER") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    "report-local-secret"
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
