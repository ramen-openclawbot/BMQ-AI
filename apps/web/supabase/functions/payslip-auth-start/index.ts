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
  readJsonBody,
  sendDealerOtpZns,
} from "../_shared/report.ts";
import { normalizePayslipPhone } from "../_shared/payslip-portal.ts";

const GENERIC_AUTH_START_MESSAGE =
  "Nếu số điện thoại thuộc nhân viên đang hoạt động, mã OTP được gửi qua Zalo ZNS.";
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

function scheduleOtpDelivery(createTask: () => Promise<unknown>) {
  const waitUntil = edgeRuntime?.waitUntil;
  if (!waitUntil) {
    console.error("[payslip-auth-start] EdgeRuntime.waitUntil is unavailable; OTP delivery not scheduled");
    return false;
  }

  const task = createTask();
  task.catch((error) => console.error("[payslip-auth-start] Background OTP delivery failed", error));
  const runtime = { waitUntil };
  runtime.waitUntil(task);
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
    const phoneNormalized = normalizePayslipPhone(body.phone);

    if (!phoneNormalized) {
      return errorResponse(
        req,
        "Số điện thoại không hợp lệ. Vui lòng nhập số di động Việt Nam.",
        400,
        "invalid_phone",
      );
    }

    const supabase = createServiceClient();
    const requestMeta = getRequestMetadata(req);
    const rateLimits = await Promise.all([
      consumeReportAuthRateLimit(supabase, {
        scope: "payslip-auth-start-phone",
        key: phoneNormalized,
        maxAttempts: 5,
        windowSeconds: 600,
      }),
      consumeReportAuthRateLimit(supabase, {
        scope: "payslip-auth-start-ip",
        key: requestMeta.request_ip || "unknown",
        maxAttempts: 20,
        windowSeconds: 600,
      }),
      consumeReportAuthRateLimit(supabase, {
        scope: "payslip-auth-start-device",
        key: `${requestMeta.request_ip || "unknown"}|${requestMeta.user_agent || "unknown"}`,
        maxAttempts: 15,
        windowSeconds: 600,
      }),
      consumeReportAuthRateLimit(supabase, {
        scope: "payslip-auth-start-global",
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

    const contactsResult = await supabase
      .from("payroll_bn_employee_contacts")
      .select("employee_code, phone_normalized, active")
      .eq("phone_normalized", phoneNormalized)
      .eq("active", true)
      .limit(2);
    if (contactsResult.error) throw contactsResult.error;

    const contacts = contactsResult.data || [];
    // A phone must map to exactly one active employee; anything else stays
    // indistinguishable from an unknown phone.
    if (contacts.length !== 1) {
      return genericAuthStartResponse(req);
    }

    const employeeCode = String(contacts[0]?.employee_code || "");
    if (!employeeCode) {
      return genericAuthStartResponse(req);
    }

    scheduleOtpDelivery(() =>
      createAndSendPayslipOtp({ supabase, phoneNormalized, employeeCode })
    );

    return genericAuthStartResponse(req);
  } catch (error) {
    console.error("[payslip-auth-start] Unexpected error", error);
    return errorResponse(
      req,
      "Không thể bắt đầu xác thực. Vui lòng thử lại sau.",
      500,
      "payslip_auth_start_failed",
    );
  }
});

async function createAndSendPayslipOtp({
  supabase,
  phoneNormalized,
  employeeCode,
}: {
  supabase: ReturnType<typeof createServiceClient>;
  phoneNormalized: string;
  employeeCode: string;
}) {
  // 60s resend cooldown: keep the most recent unconsumed challenge silent.
  const existing = await supabase
    .from("payroll_bn_payslip_otp_challenges")
    .select("id, created_at")
    .eq("phone_normalized", phoneNormalized)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) throw existing.error;

  const createdAt = existing.data?.created_at ? new Date(existing.data.created_at).getTime() : 0;
  if (createdAt && Date.now() - createdAt < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
    console.info(`[payslip-auth-start] OTP cooldown active (${OTP_RESEND_COOLDOWN_SECONDS}s)`);
    return;
  }

  const challengeId = crypto.randomUUID();
  const otp = generateDealerOtp();
  const expiresAt = getOtpExpiresAt();
  const otpHash = await hashReportOtp(challengeId, phoneNormalized, otp);

  const insertResult = await supabase
    .from("payroll_bn_payslip_otp_challenges")
    .insert({
      id: challengeId,
      phone_normalized: phoneNormalized,
      employee_code: employeeCode,
      otp_hash: otpHash,
      expires_at: expiresAt,
    });
  if (insertResult.error) throw insertResult.error;

  await sendDealerOtpZns({
    phoneNormalized,
    otp,
    challengeId,
  });
}
