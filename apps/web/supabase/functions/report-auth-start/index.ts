import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  consumeReportAuthRateLimit,
  createServiceClient,
  errorResponse,
  generateDealerOtp,
  getOtpExpiresAt,
  getRequestMetadata,
  hashReportOtp,
  jsonResponse,
  normalizeDealerPhone,
  readJsonBody,
  sendDealerOtpZns,
} from "../_shared/report.ts";

const GENERIC_AUTH_START_MESSAGE =
  "Nếu số điện thoại thuộc nhân viên báo cáo đang hoạt động, mã OTP được gửi qua Zalo ZNS.";
const OTP_RESEND_COOLDOWN_SECONDS = 60;

const genericAuthStartResponse = (req: Request) =>
  jsonResponse(req, {
    success: true,
    otp_required: true,
    message: GENERIC_AUTH_START_MESSAGE,
  });

const edgeRuntime = (globalThis as typeof globalThis & {
  EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
}).EdgeRuntime;

function scheduleReportOtpDelivery(createTask: () => Promise<unknown>) {
  const waitUntil = edgeRuntime?.waitUntil;
  if (!waitUntil) {
    console.error("[report-auth-start] EdgeRuntime.waitUntil is unavailable; OTP delivery not scheduled");
    return false;
  }

  const task = createTask();
  task.catch((error) => console.error("[report-auth-start] Background OTP delivery failed", error));
  const EdgeRuntime = { waitUntil };
  EdgeRuntime.waitUntil(task);
  return true;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = await readJsonBody<{ phone?: unknown }>(req);
    const phoneNormalized = normalizeDealerPhone(body.phone);

    if (!phoneNormalized) {
      return errorResponse(req, "Số điện thoại không hợp lệ. Vui lòng nhập số di động Việt Nam.", 400, "invalid_phone");
    }

    const supabase = createServiceClient();
    const requestMeta = getRequestMetadata(req);
    const rateLimits = await Promise.all([
      consumeReportAuthRateLimit(supabase, {
        scope: "report-auth-start-phone",
        key: phoneNormalized,
        maxAttempts: 5,
        windowSeconds: 600,
      }),
      consumeReportAuthRateLimit(supabase, {
        scope: "report-auth-start-ip",
        key: requestMeta.request_ip || "unknown",
        maxAttempts: 20,
        windowSeconds: 600,
      }),
      consumeReportAuthRateLimit(supabase, {
        scope: "report-auth-start-device",
        key: `${requestMeta.request_ip || "unknown"}|${requestMeta.user_agent || "unknown"}`,
        maxAttempts: 15,
        windowSeconds: 600,
      }),
      consumeReportAuthRateLimit(supabase, {
        scope: "report-auth-start-global",
        key: "all",
        maxAttempts: 1000,
        windowSeconds: 60,
      }),
    ]);
    const blocked = rateLimits.find((limit) => !limit.allowed);
    if (blocked) {
      return jsonResponse(req, {
        success: false,
        error: "Vui lòng thử lại sau.",
        code: "rate_limited",
        retry_after_seconds: blocked.retryAfterSeconds,
      }, 429);
    }

    const [staffRes, deliveryRes] = await Promise.all([
      supabase
        .from("kiosk_report_staff")
        .select(
          "id, full_name, phone_normalized, location_id, active, kiosk_report_locations!inner(id, location_code, location_name, address, active)",
        )
        .eq("phone_normalized", phoneNormalized)
        .eq("active", true)
        .eq("kiosk_report_locations.active", true)
        .limit(2),
      supabase
        .from("delivery_staff")
        .select("id, full_name, phone_normalized, active")
        .eq("phone_normalized", phoneNormalized)
        .eq("active", true)
        .limit(2),
    ]);

    if (staffRes.error) throw staffRes.error;
    if (deliveryRes.error) throw deliveryRes.error;

    const staffRows = staffRes.data || [];
    const deliveryRows = deliveryRes.data || [];
    if (staffRows.length + deliveryRows.length !== 1) {
      return genericAuthStartResponse(req);
    }

    const staff = staffRows[0] || null;
    const deliveryStaff = deliveryRows[0] || null;
    const reportChallengeActor = { actor_type: "report_staff" as const };
    const deliveryChallengeActor = { actor_type: "delivery_staff" as const };
    const actorPayload = staff ? reportChallengeActor : deliveryChallengeActor;

    // Dealer auth may allow log-only OTP delivery during local development.
    // The public report portal always fails closed so an accidental production
    // flag cannot put a report-staff OTP into logs or a client response.
    if (Deno.env.get("DEALER_AUTH_DEV_ALLOW_SKIP_ZNS")?.toLowerCase() === "true") {
      console.error("[report-auth-start] Refusing dev-skip OTP delivery");
      return genericAuthStartResponse(req);
    }

    scheduleReportOtpDelivery(() => sendEligibleReportOtpChallenge({
      supabase,
      phoneNormalized,
      requestMeta,
      staff,
      deliveryStaff,
      actorPayload,
    }));

    return genericAuthStartResponse(req);
  } catch (error) {
    console.error("[report-auth-start] Unexpected error", error);
    return errorResponse(
      req,
      "Không thể bắt đầu xác thực báo cáo. Vui lòng thử lại sau.",
      500,
      "report_auth_start_failed",
    );
  }
});

async function sendEligibleReportOtpChallenge({
  supabase,
  phoneNormalized,
  requestMeta,
  staff,
  deliveryStaff,
  actorPayload,
}: {
  supabase: ReturnType<typeof createServiceClient>;
  phoneNormalized: string;
  requestMeta: ReturnType<typeof getRequestMetadata>;
  staff: { id: string; location_id: string | null } | null;
  deliveryStaff: { id: string } | null;
  actorPayload: { actor_type: "report_staff" } | { actor_type: "delivery_staff" };
}) {
  const challengeId = crypto.randomUUID();
  const otp = generateDealerOtp();
  const expiresAt = getOtpExpiresAt();
  const otpHash = await hashReportOtp(challengeId, phoneNormalized, otp);
  const { data: challengeResult, error: challengeError } = await supabase
    .rpc("create_kiosk_report_otp_challenge_atomic", {
      p_challenge_id: challengeId,
      p_phone_normalized: phoneNormalized,
      p_otp_hash: otpHash,
      p_expires_at: expiresAt,
      p_request_ip: requestMeta.request_ip,
      p_user_agent: requestMeta.user_agent,
      p_actor_type: actorPayload.actor_type,
      p_staff_id: staff?.id ?? null,
      p_location_id: staff?.location_id ?? null,
      p_delivery_staff_id: deliveryStaff?.id ?? null,
    });

  if (challengeError) throw challengeError;

  const status = typeof challengeResult === "object" && challengeResult !== null && "status" in challengeResult
    ? String((challengeResult as { status?: unknown }).status || "")
    : "";

  if (status === "cooldown") {
    console.info(`[report-auth-start] OTP cooldown active (${OTP_RESEND_COOLDOWN_SECONDS}s)`);
    return;
  }

  if (status === "created") {
    // Only the transaction that acquired a send lease reaches the provider call below.
  } else {
    throw new Error("unexpected_report_otp_challenge_status");
  }

  try {
    const sendResult = await sendDealerOtpZns({
      phoneNormalized,
      otp,
      challengeId,
    });

    await supabase
      .from("kiosk_report_otp_challenges")
      .update({
        sent_at: new Date().toISOString(),
        send_provider: sendResult.provider,
        send_status: sendResult.skipped ? "dev_skipped" : "sent",
      })
      .eq("id", challengeId)
      .eq("send_status", "pending");

    if (sendResult.skipped) {
      await supabase
        .from("kiosk_report_otp_challenges")
        .update({ consumed_at: new Date().toISOString() })
        .eq("id", challengeId)
        .eq("send_status", "dev_skipped");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Không gửi được Zalo ZNS OTP";
    console.error("[report-auth-start] ZNS send failed", message);

    await supabase
      .from("kiosk_report_otp_challenges")
      .update({
        consumed_at: new Date().toISOString(),
        send_status: "failed",
        send_error: message,
      })
      .eq("id", challengeId)
      .eq("send_status", "pending");
  }
}
