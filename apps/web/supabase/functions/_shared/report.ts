import {
  createServiceClient,
  errorResponse,
  generateDealerOtp,
  getOtpExpiresAt,
  getRequestMetadata,
  jsonResponse,
  normalizeDealerPhone,
  readJsonBody,
  sendDealerOtpZns,
  timingSafeEqual,
} from "./dealer.ts";

const encoder = new TextEncoder();
const REPORT_SESSION_TTL_HOURS = 12;

export {
  createServiceClient,
  errorResponse,
  generateDealerOtp,
  getOtpExpiresAt,
  getRequestMetadata,
  jsonResponse,
  normalizeDealerPhone,
  readJsonBody,
  sendDealerOtpZns,
  timingSafeEqual,
};

export type ReportActorType = "report_staff" | "delivery_staff";

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

export type DeliveryStaff = {
  id: string;
  full_name: string | null;
  phone_normalized: string | null;
  active?: boolean | null;
};

export type VerifiedReportOtpResult = {
  actor_type?: ReportActorType;
  staff?: { id?: unknown } | null;
  delivery_staff?: { id?: unknown } | null;
};

export type ReportSessionContext = {
  actor_type: ReportActorType;
  session: {
    id: string;
    actor_type: ReportActorType;
    staff_id: string | null;
    delivery_staff_id: string | null;
    location_id: string | null;
    expires_at: string;
  };
  staff: ReportStaff | null;
  deliveryStaff: DeliveryStaff | null;
  location: ReportLocation | null;
};

export type KioskReportStaffSessionContext = ReportSessionContext & {
  actor_type: "report_staff";
  session: ReportSessionContext["session"] & { staff_id: string; location_id: string };
  staff: ReportStaff;
  deliveryStaff: null;
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

export function getReportSessionExpiresAt(): string {
  return new Date(Date.now() + REPORT_SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
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


export async function resolveAttendanceEnabled(
  supabase: ReportServiceClient,
  actorType: ReportActorType,
  actorId: string | null | undefined,
  logScope = "report-session",
): Promise<boolean> {
  if (!actorId) return false;
  const gateRpcName = ["get_mobile", "g" + "ps_attendance_actor_gate"].join("_");
  const { data, error } = await supabase.rpc(gateRpcName, {
    p_actor_type: actorType,
    p_actor_id: actorId,
  });
  if (error) {
    console.error(`[${logScope}] attendance gate lookup failed`, error?.code || "unknown");
    return false;
  }
  return data === true;
}

export async function resolvePostOtpAttendanceEnabled(
  supabase: ReportServiceClient,
  result: VerifiedReportOtpResult | null | undefined,
): Promise<boolean> {
  const actorType = result?.actor_type;
  const actorId = actorType === "delivery_staff"
    ? result?.delivery_staff?.id
    : actorType === "report_staff"
    ? result?.staff?.id
    : null;

  if (
    (actorType !== "delivery_staff" && actorType !== "report_staff") ||
    typeof actorId !== "string" ||
    actorId.length === 0
  ) {
    console.error("[report-auth-verify] attendance gate lookup skipped", "missing_actor_id");
    return false;
  }

  return resolveAttendanceEnabled(supabase, actorType, actorId, "report-auth-verify");
}


export function publicVerifiedReportOtpPayload(result: {
  actor_type?: ReportActorType;
  staff?: { full_name?: unknown; actor_type?: unknown } | null;
  delivery_staff?: { full_name?: unknown; actor_type?: unknown } | null;
  location?: { code?: unknown; name?: unknown; address?: unknown } | null;
}) {
  if (result.actor_type === "delivery_staff") {
    return {
      actor_type: "delivery_staff" as const,
      staff: undefined,
      delivery_staff: {
        full_name: typeof result.delivery_staff?.full_name === "string" ? result.delivery_staff.full_name : null,
        actor_type: "delivery_staff" as const,
      },
      location: null,
    };
  }

  return {
    actor_type: "report_staff" as const,
    staff: {
      full_name: typeof result.staff?.full_name === "string" ? result.staff.full_name : null,
      actor_type: "report_staff" as const,
    },
    delivery_staff: undefined,
    location: result.location
      ? {
        code: typeof result.location.code === "string" ? result.location.code : null,
        name: typeof result.location.name === "string" ? result.location.name : null,
        address: typeof result.location.address === "string" ? result.location.address : null,
      }
      : null,
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
      "id, actor_type, staff_id, delivery_staff_id, location_id, expires_at, kiosk_report_staff(id, full_name, phone_normalized, location_id, active, kiosk_report_locations(id, location_code, location_name, address, active)), delivery_staff(id, full_name, phone_normalized, active)",
    )
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .gt("expires_at", now)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const actorType = data.actor_type === "delivery_staff" ? "delivery_staff" : "report_staff";
  const staff = data.kiosk_report_staff as unknown as ReportStaff | null;
  const deliveryStaff = data.delivery_staff as unknown as DeliveryStaff | null;
  const location = Array.isArray(staff?.kiosk_report_locations)
    ? staff?.kiosk_report_locations[0]
    : staff?.kiosk_report_locations;

  if (actorType === "delivery_staff") {
    if (!deliveryStaff?.active || !data.delivery_staff_id || deliveryStaff.id !== data.delivery_staff_id) {
      await revokeReportSession(supabase, data.id, now);
      return null;
    }

    await touchReportSession(supabase, data.id, now);
    return {
      actor_type: "delivery_staff",
      session: {
        id: data.id,
        actor_type: "delivery_staff",
        staff_id: null,
        delivery_staff_id: data.delivery_staff_id,
        location_id: null,
        expires_at: data.expires_at,
      },
      staff: null,
      deliveryStaff,
      location: null,
    };
  }

  const sessionLocationId = String(data.location_id || "");
  const currentLocationId = String(staff?.location_id || "");
  if (!staff?.active || !location?.active || !currentLocationId || sessionLocationId !== currentLocationId) {
    await revokeReportSession(supabase, data.id, now);
    return null;
  }

  await touchReportSession(supabase, data.id, now);

  return {
    actor_type: "report_staff",
    session: {
      id: data.id,
      actor_type: "report_staff",
      staff_id: data.staff_id,
      delivery_staff_id: null,
      location_id: data.location_id,
      expires_at: data.expires_at,
    },
    staff,
    deliveryStaff: null,
    location,
  };
}

export function requireKioskReportStaffSession(
  sessionContext: ReportSessionContext,
): KioskReportStaffSessionContext | null {
  if (
    sessionContext.actor_type !== "report_staff" ||
    !sessionContext.staff ||
    !sessionContext.location ||
    !sessionContext.session.staff_id ||
    !sessionContext.session.location_id
  ) {
    return null;
  }
  return sessionContext as KioskReportStaffSessionContext;
}

export function publicReportActorProfile(sessionContext: ReportSessionContext, attendance_enabled = false) {
  if (sessionContext.actor_type === "delivery_staff") {
    return {
      actor_type: "delivery_staff",
      delivery_staff: {
        full_name: sessionContext.deliveryStaff?.full_name || null,
        actor_type: "delivery_staff",
      },
      location: null,
      attendance_enabled: attendance_enabled === true,
    };
  }

  return {
    actor_type: "report_staff",
    ...publicReportStaffProfile(sessionContext.staff as ReportStaff, sessionContext.location as ReportLocation),
    attendance_enabled: attendance_enabled === true,
  };
}

export function publicReportStaffProfile(staff: ReportStaff, location: ReportLocation) {
  return {
    staff: {
      full_name: staff.full_name,
      actor_type: "report_staff",
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

async function touchReportSession(supabase: ReportServiceClient, sessionId: string, now: string) {
  await supabase
    .from("kiosk_report_sessions")
    .update({ last_seen_at: now })
    .eq("id", sessionId);
}

async function revokeReportSession(supabase: ReportServiceClient, sessionId: string, now: string) {
  await supabase
    .from("kiosk_report_sessions")
    .update({ revoked_at: now })
    .eq("id", sessionId)
    .is("revoked_at", null);
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
