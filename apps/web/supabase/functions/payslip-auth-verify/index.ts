import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  consumeReportAuthRateLimit,
  createServiceClient,
  errorResponse,
  getRequestMetadata,
  hashReportOtp,
  hashReportSessionToken,
  jsonResponse,
  readJsonBody,
  timingSafeEqual,
} from "../_shared/report.ts";
import {
  getPayslipSessionExpiresAt,
  normalizePayslipPhone,
  PAYSLIP_OTP_MAX_ATTEMPTS,
  validatePayslipOtpChallenge,
} from "../_shared/payslip-portal.ts";

const OTP_INVALID_MESSAGE = "Mã OTP không đúng hoặc đã hết hạn.";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = await readJsonBody<{ phone?: unknown; otp?: unknown }>(req);
    const phoneNormalized = normalizePayslipPhone(body.phone);
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
        scope: "payslip-auth-verify-phone",
        key: phoneNormalized,
        maxAttempts: 20,
        windowSeconds: 600,
      }),
      consumeReportAuthRateLimit(supabase, {
        scope: "payslip-auth-verify-ip",
        key: requestMeta.request_ip || "unknown",
        maxAttempts: 40,
        windowSeconds: 600,
      }),
      consumeReportAuthRateLimit(supabase, {
        scope: "payslip-auth-verify-device",
        key: `${requestMeta.request_ip || "unknown"}|${requestMeta.user_agent || "unknown"}`,
        maxAttempts: 30,
        windowSeconds: 600,
      }),
      consumeReportAuthRateLimit(supabase, {
        scope: "payslip-auth-verify-global",
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

    const challengeResult = await supabase
      .from("payroll_bn_payslip_otp_challenges")
      .select("id, phone_normalized, employee_code, otp_hash, expires_at, attempt_count, consumed_at")
      .eq("phone_normalized", phoneNormalized)
      .is("consumed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (challengeResult.error) throw challengeResult.error;

    const challenge = challengeResult.data as {
      id: string;
      employee_code: string;
      otp_hash: string;
      expires_at: string;
      attempt_count: number | null;
      consumed_at: string | null;
    } | null;

    if (!challenge) {
      return errorResponse(req, OTP_INVALID_MESSAGE, 401, "otp_invalid_or_expired");
    }

    const check = validatePayslipOtpChallenge(challenge);
    if (!check.ok) {
      if (check.code === "otp_max_attempts") {
        return errorResponse(
          req,
          "Mã OTP đã vượt quá số lần thử. Vui lòng yêu cầu mã mới.",
          429,
          "otp_max_attempts",
        );
      }
      return errorResponse(req, OTP_INVALID_MESSAGE, 401, "otp_invalid_or_expired");
    }

    const candidateHash = await hashReportOtp(challenge.id, phoneNormalized, otp);
    if (!timingSafeEqual(candidateHash, challenge.otp_hash)) {
      const attempts = Number(challenge.attempt_count ?? 0);
      await supabase
        .from("payroll_bn_payslip_otp_challenges")
        .update({ attempt_count: Math.min(attempts + 1, PAYSLIP_OTP_MAX_ATTEMPTS) })
        .eq("id", challenge.id);
      return errorResponse(req, OTP_INVALID_MESSAGE, 401, "otp_invalid_or_expired");
    }

    const sessionToken = generatePayslipSessionToken();
    const sessionTokenHash = await hashReportSessionToken(sessionToken);
    const expiresAt = getPayslipSessionExpiresAt();
    const now = new Date().toISOString();

    const sessionInsert = await supabase
      .from("payroll_bn_payslip_sessions")
      .insert({
        token_hash: sessionTokenHash,
        employee_code: challenge.employee_code,
        expires_at: expiresAt,
        last_seen_at: now,
      });
    if (sessionInsert.error) throw sessionInsert.error;

    await supabase
      .from("payroll_bn_payslip_otp_challenges")
      .update({ consumed_at: now })
      .eq("id", challenge.id)
      .is("consumed_at", null);

    return jsonResponse(req, {
      success: true,
      session_token: sessionToken,
      expires_at: expiresAt,
      employee: { code: challenge.employee_code },
    });
  } catch (error) {
    console.error("[payslip-auth-verify] Unexpected error", error);
    return errorResponse(req, "Không thể xác thực OTP. Vui lòng thử lại sau.", 500, "payslip_auth_verify_failed");
  }
});

function generatePayslipSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  const token = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `psp_${token}`;
}
