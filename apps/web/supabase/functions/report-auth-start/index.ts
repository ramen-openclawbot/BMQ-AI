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

    const { data: staffRows, error: staffError } = await supabase
      .from("kiosk_report_staff")
      .select(
        "id, full_name, phone_normalized, location_id, active, kiosk_report_locations!inner(id, location_code, location_name, address, active)",
      )
      .eq("phone_normalized", phoneNormalized)
      .eq("active", true)
      .eq("kiosk_report_locations.active", true)
      .limit(2);

    if (staffError) throw staffError;

    if (!staffRows?.length) {
      return genericAuthStartResponse(req);
    }

    if (staffRows.length > 1) {
      return genericAuthStartResponse(req);
    }

    const cooldownSince = new Date(Date.now() - OTP_RESEND_COOLDOWN_SECONDS * 1000).toISOString();
    const { data: recentChallenge, error: cooldownError } = await supabase
      .from("kiosk_report_otp_challenges")
      .select("id")
      .eq("phone_normalized", phoneNormalized)
      .gte("created_at", cooldownSince)
      .limit(1)
      .maybeSingle();

    if (cooldownError) throw cooldownError;

    if (recentChallenge) {
      return genericAuthStartResponse(req);
    }

    const staff = staffRows[0];

    // Dealer auth may allow log-only OTP delivery during local development.
    // The public report portal always fails closed so an accidental production
    // flag cannot put a report-staff OTP into logs or a client response.
    if (Deno.env.get("DEALER_AUTH_DEV_ALLOW_SKIP_ZNS")?.toLowerCase() === "true") {
      console.error("[report-auth-start] Refusing dev-skip OTP delivery");
      return genericAuthStartResponse(req);
    }

    const challengeId = crypto.randomUUID();
    const otp = generateDealerOtp();
    const expiresAt = getOtpExpiresAt();
    const otpHash = await hashReportOtp(challengeId, phoneNormalized, otp);
    await supabase
      .from("kiosk_report_otp_challenges")
      .update({
        consumed_at: new Date().toISOString(),
        send_status: "superseded",
      })
      .eq("phone_normalized", phoneNormalized)
      .is("consumed_at", null);

    const { error: insertError } = await supabase
      .from("kiosk_report_otp_challenges")
      .insert({
        id: challengeId,
        staff_id: staff.id,
        location_id: staff.location_id,
        phone_normalized: phoneNormalized,
        otp_hash: otpHash,
        expires_at: expiresAt,
        request_ip: requestMeta.request_ip,
        user_agent: requestMeta.user_agent,
      });

    if (insertError) throw insertError;

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
        .eq("id", challengeId);

      if (sendResult.skipped) {
        await supabase
          .from("kiosk_report_otp_challenges")
          .update({ consumed_at: new Date().toISOString() })
          .eq("id", challengeId);
      }

      return genericAuthStartResponse(req);
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
        .eq("id", challengeId);

      return genericAuthStartResponse(req);
    }
  } catch (error) {
    console.error("[report-auth-start] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không thể bắt đầu xác thực báo cáo";
    return errorResponse(req, message, 500, "report_auth_start_failed");
  }
});
