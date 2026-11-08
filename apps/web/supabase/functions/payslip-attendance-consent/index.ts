import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  hashReportSessionToken,
  jsonResponse,
  readJsonBody,
} from "../_shared/report.ts";
import {
  hashPayslipDeviceId,
  normalizePayslipDeviceId,
  PAYSLIP_SESSION_TOKEN_PREFIX,
} from "../_shared/payslip-portal.ts";
import {
  attendanceConsentState,
  PAYROLL_ATTENDANCE_CONSENT_VERSION,
  type AttendanceConsentState,
} from "../_shared/payroll-attendance.ts";

function extractSessionToken(body: Record<string, unknown>, req: Request): string | null {
  const raw = body.session_token || body.payslip_token || req.headers.get("x-payslip-session");
  const token = typeof raw === "string" ? raw.trim() : "";
  return token.startsWith(PAYSLIP_SESSION_TOKEN_PREFIX) ? token : null;
}

function extractDeviceId(body: Record<string, unknown>, req: Request): string | null {
  const raw = body.device_id ?? req.headers.get("x-payslip-device");
  return normalizePayslipDeviceId(raw);
}

function userAgentFamily(userAgent: string | null): string | null {
  const ua = String(userAgent || "");
  if (!ua) return null;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  return "other";
}

function publicConsent(consent: AttendanceConsentState) {
  return {
    required_version: consent.requiredVersion,
    accepted: consent.accepted,
    accepted_at: consent.acceptedAt,
    withdrawn_at: consent.withdrawnAt,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody<Record<string, unknown>>(req);
    } catch {
      return errorResponse(req, "Dữ liệu thoả thuận không hợp lệ.", 400, "invalid_json");
    }

    const token = extractSessionToken(body, req);
    const deviceId = extractDeviceId(body, req);
    if (!token) {
      return errorResponse(req, "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.", 401, "session_required");
    }
    if (!deviceId) {
      return errorResponse(req, "Thiết bị chưa được xác thực. Vui lòng đăng nhập lại.", 401, "device_required");
    }

    const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
    if (action !== "accept" && action !== "withdraw") {
      return errorResponse(req, "Thao tác thoả thuận không hợp lệ.", 400, "invalid_action");
    }

    const version = typeof body.version === "string" ? body.version.trim() : "";
    if (action === "accept" && version === "") {
      return errorResponse(req, "Phiên bản thoả thuận không hợp lệ.", 400, "consent_version_required");
    }

    const supabase = createServiceClient();
    const tokenHash = await hashReportSessionToken(token);
    const deviceHash = await hashPayslipDeviceId(deviceId);
    const now = new Date().toISOString();

    const sessionResult = await supabase
      .from("payroll_bn_payslip_sessions")
      .select("id, employee_code, device_hash, expires_at")
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", now)
      .maybeSingle();
    if (sessionResult.error) throw sessionResult.error;

    const session = sessionResult.data as {
      id: string;
      employee_code: string;
      device_hash: string | null;
    } | null;
    if (!session) {
      return errorResponse(req, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401, "session_invalid");
    }
    if (!session.device_hash) {
      return errorResponse(req, "Phiên này chưa gắn thiết bị. Vui lòng đăng nhập lại.", 401, "device_not_bound");
    }
    if (!deviceHash || session.device_hash !== deviceHash) {
      return errorResponse(req, "Phiên đăng nhập không khớp thiết bị. Vui lòng đăng nhập lại.", 401, "device_mismatch");
    }

    // Turning a phone off in the Nhân viên tab cuts access immediately.
    const contactResult = await supabase
      .from("payroll_bn_employee_contacts")
      .select("employee_code")
      .eq("employee_code", session.employee_code)
      .eq("active", true)
      .maybeSingle();
    if (contactResult.error) throw contactResult.error;
    if (!contactResult.data) {
      await supabase
        .from("payroll_bn_payslip_sessions")
        .update({ revoked_at: now })
        .eq("id", session.id);
      return errorResponse(req, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401, "session_invalid");
    }

    if (action === "accept") {
      const acceptResult = await supabase.rpc("accept_payroll_bn_attendance_consent", {
        p_employee_code: session.employee_code,
        p_version: version,
        p_device_hash: deviceHash,
        p_session_id: session.id,
        p_user_agent_family: userAgentFamily(req.headers.get("user-agent")),
      });
      if (acceptResult.error) {
        const message = String(acceptResult.error.message ?? "");
        if (message.includes("consent_version_not_current")) {
          return errorResponse(
            req,
            "Phiên bản thoả thuận không còn hiệu lực. Vui lòng tải lại trang.",
            409,
            "consent_version_not_current",
          );
        }
        throw acceptResult.error;
      }
    } else {
      const withdrawResult = await supabase.rpc("withdraw_payroll_bn_attendance_consent", {
        p_employee_code: session.employee_code,
      });
      if (withdrawResult.error) throw withdrawResult.error;
    }

    const consentConfigResult = await supabase
      .from("payroll_bn_attendance_consent_config")
      .select("current_version")
      .eq("id", true)
      .maybeSingle();
    if (consentConfigResult.error) throw consentConfigResult.error;
    const requiredVersion = typeof consentConfigResult.data?.current_version === "string" &&
        consentConfigResult.data.current_version.trim() !== ""
      ? consentConfigResult.data.current_version
      : PAYROLL_ATTENDANCE_CONSENT_VERSION;

    const consentResult = await supabase
      .from("payroll_bn_attendance_consents")
      .select("consent_version, accepted_at, withdrawn_at")
      .eq("employee_code", session.employee_code)
      .order("accepted_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (consentResult.error) throw consentResult.error;

    const consentRow = consentResult.data
      ? {
        consentVersion: String(consentResult.data.consent_version ?? ""),
        acceptedAt: typeof consentResult.data.accepted_at === "string"
          ? consentResult.data.accepted_at
          : null,
        withdrawnAt: typeof consentResult.data.withdrawn_at === "string"
          ? consentResult.data.withdrawn_at
          : null,
      }
      : null;
    const consent = attendanceConsentState(requiredVersion, consentRow);

    return jsonResponse(req, {
      success: true,
      consent: publicConsent(consent),
    });
  } catch (error) {
    console.error("[payslip-attendance-consent] Unexpected error", error);
    return errorResponse(
      req,
      "Không thể lưu thoả thuận. Vui lòng thử lại sau.",
      500,
      "payslip_attendance_consent_failed",
    );
  }
});
