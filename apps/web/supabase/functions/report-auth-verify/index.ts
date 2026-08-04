import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  consumeReportAuthRateLimit,
  createServiceClient,
  errorResponse,
  generateReportSessionToken,
  getRequestMetadata,
  getSessionExpiresAt,
  hashReportOtp,
  hashReportSessionToken,
  jsonResponse,
  normalizeDealerPhone,
  readJsonBody,
} from "../_shared/report.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = await readJsonBody<{ phone?: unknown; otp?: unknown }>(req);
    const phoneNormalized = normalizeDealerPhone(body.phone);
    const otp = String(body.otp || "").trim();

    if (!phoneNormalized) {
      return errorResponse(req, "Số điện thoại không hợp lệ.", 400, "invalid_phone");
    }

    if (!/^\d{6}$/.test(otp)) {
      return errorResponse(req, "Mã OTP phải gồm 6 chữ số.", 400, "invalid_otp_format");
    }

    const supabase = createServiceClient();
    const requestMeta = getRequestMetadata(req);
    const rateLimits = await Promise.all([
      consumeReportAuthRateLimit(supabase, {
        scope: "report-auth-verify-phone",
        key: phoneNormalized,
        maxAttempts: 20,
        windowSeconds: 600,
      }),
      consumeReportAuthRateLimit(supabase, {
        scope: "report-auth-verify-ip",
        key: requestMeta.request_ip || "unknown",
        maxAttempts: 40,
        windowSeconds: 600,
      }),
      consumeReportAuthRateLimit(supabase, {
        scope: "report-auth-verify-device",
        key: `${requestMeta.request_ip || "unknown"}|${requestMeta.user_agent || "unknown"}`,
        maxAttempts: 30,
        windowSeconds: 600,
      }),
      consumeReportAuthRateLimit(supabase, {
        scope: "report-auth-verify-global",
        key: "all",
        maxAttempts: 2000,
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

    const now = new Date().toISOString();
    const { data: challenge, error: challengeError } = await supabase
      .from("kiosk_report_otp_challenges")
      .select("id")
      .eq("phone_normalized", phoneNormalized)
      .is("consumed_at", null)
      .gt("expires_at", now)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (challengeError) throw challengeError;

    if (!challenge) {
      return errorResponse(req, "Mã OTP không đúng hoặc đã hết hạn.", 401, "otp_invalid_or_expired");
    }

    const otpHash = await hashReportOtp(challenge.id, phoneNormalized, otp);
    const sessionToken = generateReportSessionToken();
    const sessionTokenHash = await hashReportSessionToken(sessionToken);
    const expiresAt = getSessionExpiresAt();
    const { data: verification, error: verificationError } = await supabase.rpc(
      "verify_kiosk_report_otp_atomic",
      {
        p_challenge_id: challenge.id,
        p_phone_normalized: phoneNormalized,
        p_otp_hash: otpHash,
        p_session_token_hash: sessionTokenHash,
        p_session_expires_at: expiresAt,
        p_request_ip: requestMeta.request_ip,
        p_user_agent: requestMeta.user_agent,
      },
    );

    if (verificationError) throw verificationError;

    const result = verification as {
      status?: string;
      expires_at?: string;
      staff?: Record<string, unknown>;
      location?: Record<string, unknown>;
    } | null;

    if (result?.status === "otp_max_attempts") {
      return errorResponse(req, "Mã OTP đã vượt quá số lần thử. Vui lòng yêu cầu mã mới.", 429, "otp_max_attempts");
    }

    if (result?.status === "report_staff_inactive") {
      return errorResponse(req, "Nhân viên hoặc điểm bán đang tạm ngưng. Vui lòng liên hệ quản lý.", 403, "report_staff_inactive");
    }

    if (result?.status !== "verified" || !result.expires_at || !result.staff || !result.location) {
      return errorResponse(req, "Mã OTP không đúng hoặc đã hết hạn.", 401, "otp_invalid_or_expired");
    }

    return jsonResponse(req, {
      success: true,
      report_token: sessionToken,
      expires_at: result.expires_at,
      staff: result.staff,
      location: result.location,
    });
  } catch (error) {
    console.error("[report-auth-verify] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không thể xác thực OTP";
    return errorResponse(req, message, 500, "report_auth_verify_failed");
  }
});
