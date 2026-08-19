import {
  buildAttendanceDecision,
  DEFAULT_ATTENDANCE_ACCURACY_THRESHOLD_M,
  hashRequestIp,
  parseAttendanceRequest,
  publicAttendanceResponse,
  resolveAttendanceGeofence,
  truncateUserAgent,
  type AttendanceActorType,
  type AttendanceGeofence,
  type AttendanceSessionLike,
} from "../_shared/attendance.ts";
import {
  consumeReportAuthRateLimit,
  createServiceClient,
  errorResponse,
  getRequestMetadata,
  jsonResponse,
  readJsonBody,
  resolveReportSession,
} from "../_shared/report.ts";

const ATTENDANCE_FUNCTION = "attendance-check-in";
const DEFAULT_ATTENDANCE_RATE_LIMIT_MAX = 30;
const DEFAULT_ATTENDANCE_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_ALLOWED_ATTENDANCE_ORIGINS = [
  "https://baocao.banhmique.vn",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://localhost:3000",
];

type SupabaseLike = any;

type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export type AttendanceHandlerDeps = {
  createServiceClient?: () => SupabaseLike;
  resolveReportSession?: (supabase: SupabaseLike, token: string) => Promise<AttendanceSessionLike | null>;
  resolveAttendanceActorGate?: (supabase: SupabaseLike, sessionContext: AttendanceSessionLike) => Promise<{ enabled: boolean }>;
  consumeRateLimit?: (supabase: SupabaseLike, options: { scope: string; key: string; maxAttempts: number; windowSeconds: number }) => Promise<RateLimitResult>;
  now?: () => Date;
  ipHashSecret?: string | null;
  accuracyThresholdM?: number;
  allowedOrigins?: string[];
};

function getAllowedOrigins(deps: AttendanceHandlerDeps): string[] {
  const envOrigins = Deno.env.get("ATTENDANCE_CHECK_IN_ALLOWED_ORIGINS")
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return deps.allowedOrigins ?? (envOrigins?.length ? envOrigins : DEFAULT_ALLOWED_ATTENDANCE_ORIGINS);
}

function exactCorsHeaders(req: Request, deps: AttendanceHandlerDeps, methods = "POST, OPTIONS"): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "content-type, x-report-session, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (getAllowedOrigins(deps).includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function corsJson(req: Request, deps: AttendanceHandlerDeps, body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...exactCorsHeaders(req, deps), ...extraHeaders, "Content-Type": "application/json" },
  });
}

function corsError(req: Request, deps: AttendanceHandlerDeps, error: string, status: number, code: string, extraHeaders: Record<string, string> = {}): Response {
  return corsJson(req, deps, { success: false, error, code }, status, extraHeaders);
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "23505";
}

function safeErrorCode(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,12}$/i.test(code)) return code;
  const name = (error as { name?: string } | null)?.name;
  if (typeof name === "string" && /^[A-Z0-9_]{2,40}$/i.test(name)) return name;
  return "unknown";
}

function actorIds(sessionContext: AttendanceSessionLike): {
  actorType: AttendanceActorType;
  kioskReportStaffId: string | null;
  deliveryStaffId: string | null;
} {
  if (sessionContext.actor_type === "delivery_staff") {
    return {
      actorType: "delivery_staff",
      kioskReportStaffId: null,
      deliveryStaffId: sessionContext.session.delivery_staff_id ?? null,
    };
  }
  return {
    actorType: "report_staff",
    kioskReportStaffId: sessionContext.session.staff_id ?? null,
    deliveryStaffId: null,
  };
}


async function resolveAttendanceActorGate(supabase: SupabaseLike, sessionContext: AttendanceSessionLike): Promise<{ enabled: boolean }> {
  const ids = actorIds(sessionContext);
  const actorId = ids.actorType === "delivery_staff" ? ids.deliveryStaffId : ids.kioskReportStaffId;
  if (!actorId) return { enabled: false };
  const { data, error } = await supabase.rpc("get_mobile_gps_attendance_actor_gate", {
    p_actor_type: ids.actorType,
    p_actor_id: actorId,
  });
  if (error) {
    console.error("[attendance-check-in] gate lookup failed", safeErrorCode(error));
    return { enabled: false };
  }
  return { enabled: data === true };
}

async function loadCandidateGeofences(supabase: SupabaseLike, sessionContext: AttendanceSessionLike): Promise<AttendanceGeofence[]> {
  let query = supabase
    .from("attendance_geofence_locations")
    .select("id, code, name, location_type, kiosk_location_id, latitude, longitude, accepted_radius_m, active")
    .eq("active", true);

  if (sessionContext.actor_type === "delivery_staff") {
    query = query.eq("code", "warehouse_tan_tao");
  } else {
    query = query.eq("location_type", "kiosk").eq("kiosk_location_id", sessionContext.session.location_id ?? "");
  }

  const { data, error } = await query;
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as AttendanceGeofence[];
}

async function recordAttendanceEvent(params: {
  supabase: SupabaseLike;
  sessionContext: AttendanceSessionLike;
  geofence: AttendanceGeofence;
  device: { latitude: number; longitude: number; accuracy_m: number; captured_at: Date };
  decision: { accepted: boolean; reason_code: string; distance_m: number; radius_m: number };
  ipHash: string | null;
  userAgent: string | null;
}): Promise<{ ok: true; eventId: string | null } | { ok: false; error: unknown }> {
  const ids = actorIds(params.sessionContext);
  const { data, error } = await params.supabase.rpc("record_mobile_gps_attendance_event", {
    p_actor_type: ids.actorType,
    p_kiosk_report_staff_id: ids.kioskReportStaffId,
    p_delivery_staff_id: ids.deliveryStaffId,
    p_device_latitude: params.device.latitude,
    p_device_longitude: params.device.longitude,
    p_device_accuracy_m: params.device.accuracy_m,
    p_device_captured_at: params.device.captured_at.toISOString(),
    p_geofence_location_id: params.geofence.id,
    p_geofence_code: params.geofence.code,
    p_geofence_name: params.geofence.name,
    p_geofence_location_type: params.geofence.location_type,
    p_geofence_latitude: params.geofence.latitude,
    p_geofence_longitude: params.geofence.longitude,
    p_geofence_radius_m: params.decision.radius_m,
    p_distance_m: params.decision.distance_m,
    p_decision: params.decision.accepted ? "accepted" : "rejected",
    p_reason_code: params.decision.reason_code,
    p_session_id: params.sessionContext.session.id ?? null,
    p_request_ip_hash: params.ipHash,
    p_request_user_agent: params.userAgent,
  });
  if (error) return { ok: false, error };
  const eventId = typeof data === "string"
    ? data
    : typeof data?.event_id === "string"
      ? data.event_id
      : null;
  return { ok: true, eventId };
}

export async function handleAttendanceCheckIn(req: Request, deps: AttendanceHandlerDeps = {}): Promise<Response> {
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("origin") || "";
    const headers = exactCorsHeaders(req, deps);
    return new Response(null, { status: getAllowedOrigins(deps).includes(origin) ? 204 : 403, headers });
  }

  if (req.method !== "POST") {
    return corsError(req, deps, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = await readJsonBody<Record<string, unknown>>(req);
    const now = deps.now?.() ?? new Date();
    const parsed = parseAttendanceRequest(body, now);
    if (!parsed.ok) {
      return corsError(req, deps, "Thông tin chấm công không hợp lệ.", 400, parsed.reason_code);
    }

    const supabase = (deps.createServiceClient ?? createServiceClient)();
    const metadata = getRequestMetadata(req);
    const maxAttempts = Number(Deno.env.get("ATTENDANCE_CHECK_IN_RATE_LIMIT_MAX") || DEFAULT_ATTENDANCE_RATE_LIMIT_MAX);
    const windowSeconds = Number(Deno.env.get("ATTENDANCE_CHECK_IN_RATE_LIMIT_WINDOW_SECONDS") || DEFAULT_ATTENDANCE_RATE_LIMIT_WINDOW_SECONDS);
    const consumeLimit = deps.consumeRateLimit ?? consumeReportAuthRateLimit;
    const preSessionRateLimit = await consumeLimit(supabase, {
      scope: ATTENDANCE_FUNCTION,
      key: `pre-session-ip:${metadata.request_ip ?? "unknown"}`,
      maxAttempts,
      windowSeconds,
    });
    if (!preSessionRateLimit.allowed) {
      return corsError(req, deps, "Bạn thao tác quá nhanh. Vui lòng thử lại sau.", 429, "rate_limited", { "Retry-After": String(preSessionRateLimit.retryAfterSeconds) });
    }

    const sessionContext = await (deps.resolveReportSession ?? resolveReportSession)(supabase, parsed.token);
    if (!sessionContext) {
      return corsError(req, deps, "Phiên báo cáo đã hết hạn. Vui lòng đăng nhập lại.", 401, "report_session_invalid");
    }

    const ids = actorIds(sessionContext);
    const actorRateLimit = await consumeLimit(supabase, {
      scope: ATTENDANCE_FUNCTION,
      key: `actor:${ids.actorType}:${ids.deliveryStaffId ?? ids.kioskReportStaffId ?? sessionContext.session.id ?? "unknown"}`,
      maxAttempts,
      windowSeconds,
    });
    if (!actorRateLimit.allowed) {
      return corsError(req, deps, "Bạn thao tác quá nhanh. Vui lòng thử lại sau.", 429, "rate_limited", { "Retry-After": String(actorRateLimit.retryAfterSeconds) });
    }

    const gate = await (deps.resolveAttendanceActorGate ?? resolveAttendanceActorGate)(supabase, sessionContext);
    if (!gate.enabled) {
      return corsError(req, deps, "Tính năng chấm công chưa được bật cho tài khoản này.", 403, "attendance_pilot_not_enabled");
    }

    const geofences = await loadCandidateGeofences(supabase, sessionContext);
    const geofence = resolveAttendanceGeofence(sessionContext, geofences);
    if (!geofence || geofence.active !== true || geofence.latitude === null || geofence.longitude === null) {
      return corsError(req, deps, "Cấu hình vị trí chấm công chưa sẵn sàng.", 503, "attendance_geofence_not_configured");
    }

    const decision = buildAttendanceDecision({
      device: parsed.device,
      geofence,
      now,
      accuracyThresholdM: deps.accuracyThresholdM ?? Number(Deno.env.get("ATTENDANCE_CHECK_IN_MAX_ACCURACY_M") || DEFAULT_ATTENDANCE_ACCURACY_THRESHOLD_M),
    });

    const ipHash = await hashRequestIp(metadata.request_ip, deps.ipHashSecret ?? Deno.env.get("ATTENDANCE_IP_HASH_SECRET"));
    const userAgent = truncateUserAgent(metadata.user_agent);
    const eventResult = await recordAttendanceEvent({ supabase, sessionContext, geofence, device: parsed.device, decision, ipHash, userAgent });

    if (!eventResult.ok && decision.accepted && isUniqueViolation(eventResult.error)) {
      const replayAuditResult = await recordAttendanceEvent({
        supabase,
        sessionContext,
        geofence,
        device: parsed.device,
        decision: { ...decision, accepted: false, reason_code: "already_checked_in" },
        ipHash,
        userAgent,
      });
      if (!replayAuditResult.ok) {
        console.error("[attendance-check-in] duplicate replay audit failed", safeErrorCode(replayAuditResult.error));
        return corsError(req, deps, "Không thể ghi nhận chấm công. Vui lòng thử lại.", 500, "attendance_record_failed");
      }
      return corsJson(req, deps, publicAttendanceResponse({
        accepted: true,
        already_checked_in: true,
        reason_code: "already_checked_in",
        distance_m: decision.distance_m,
        accuracy_m: parsed.device.accuracy_m,
      }));
    }

    if (!eventResult.ok) {
      console.error("[attendance-check-in] record failed", safeErrorCode(eventResult.error));
      return corsError(req, deps, "Không thể ghi nhận chấm công. Vui lòng thử lại.", 500, "attendance_record_failed");
    }

    return corsJson(req, deps, publicAttendanceResponse({
      accepted: decision.accepted,
      already_checked_in: false,
      reason_code: decision.reason_code,
      distance_m: decision.distance_m,
      accuracy_m: parsed.device.accuracy_m,
    }));
  } catch (error) {
    console.error("[attendance-check-in] Unexpected error", safeErrorCode(error));
    return corsError(req, deps, "Không thể chấm công. Vui lòng thử lại sau.", 500, "attendance_check_in_failed");
  }
}

// Keep imported response helpers referenced for static contract parity with report functions.
void jsonResponse;
void errorResponse;
