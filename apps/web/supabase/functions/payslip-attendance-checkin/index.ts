import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  hashReportSessionToken,
  jsonResponse,
} from "../_shared/report.ts";
import {
  hashPayslipDeviceId,
  normalizePayslipDeviceId,
  PAYSLIP_SESSION_TOKEN_PREFIX,
} from "../_shared/payslip-portal.ts";
import {
  attendanceMessage,
  validateSelfieUpload,
  vietnamWorkDate,
} from "../_shared/payroll-attendance.ts";

const SELFIE_BUCKET = "payroll-attendance-selfies";

function textField(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numericField(form: FormData, name: string): number | null {
  const value = textField(form, name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractSessionToken(form: FormData, req: Request): string | null {
  const raw = textField(form, "session_token") ?? req.headers.get("x-payslip-session");
  const token = typeof raw === "string" ? raw.trim() : "";
  return token.startsWith(PAYSLIP_SESSION_TOKEN_PREFIX) ? token : null;
}

function extractDeviceId(form: FormData, req: Request): string | null {
  const raw = textField(form, "device_id") ?? req.headers.get("x-payslip-device");
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

function safeEmployeeSegment(employeeCode: string): string {
  return employeeCode.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "employee";
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return errorResponse(req, "Dữ liệu chấm công không hợp lệ.", 400, "invalid_form");
    }

    const token = extractSessionToken(form, req);
    const deviceId = extractDeviceId(form, req);
    if (!token) {
      return errorResponse(req, "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.", 401, "session_required");
    }
    if (!deviceId) {
      return errorResponse(req, "Thiết bị chưa được xác thực. Vui lòng đăng nhập lại.", 401, "device_required");
    }

    const kind = textField(form, "kind");
    if (kind !== "in" && kind !== "out") {
      return errorResponse(req, "Loại chấm công không hợp lệ.", 400, "invalid_event_kind");
    }

    const selfieEntry = form.get("selfie");
    const selfie = selfieEntry && typeof selfieEntry === "object" && "size" in selfieEntry
      ? (selfieEntry as File)
      : null;
    const selfieCheck = validateSelfieUpload(selfie?.type ?? null, selfie?.size ?? 0);
    if (!selfie || !selfieCheck.ok) {
      return errorResponse(
        req,
        selfieCheck.ok ? "Vui lòng chụp ảnh selfie." : selfieCheck.message,
        400,
        selfieCheck.ok ? "selfie_required" : selfieCheck.reasonCode,
      );
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

    const workDate = vietnamWorkDate(new Date());
    const extension = selfie.type === "image/webp" ? "webp" : "jpg";
    const selfiePath = `${safeEmployeeSegment(session.employee_code)}/${workDate}/${crypto.randomUUID()}.${extension}`;

    const uploadResult = await supabase.storage
      .from(SELFIE_BUCKET)
      .upload(selfiePath, selfie, {
        contentType: selfie.type,
        cacheControl: "3600",
        upsert: false,
      });
    if (uploadResult.error) throw uploadResult.error;

    const capturedAtRaw = textField(form, "captured_at");
    const capturedAtDate = capturedAtRaw ? new Date(capturedAtRaw) : null;
    const capturedAt = capturedAtDate && Number.isFinite(capturedAtDate.getTime())
      ? capturedAtDate.toISOString()
      : null;

    const rpcResult = await supabase.rpc("record_payroll_bn_attendance_event", {
      p_employee_code: session.employee_code,
      p_event_kind: kind,
      p_device_hash: deviceHash,
      p_session_id: session.id,
      p_latitude: numericField(form, "lat"),
      p_longitude: numericField(form, "lng"),
      p_accuracy_m: numericField(form, "accuracy"),
      p_device_captured_at: capturedAt,
      p_selfie_path: selfiePath,
      p_user_agent_family: userAgentFamily(req.headers.get("user-agent")),
    });
    if (rpcResult.error) throw rpcResult.error;

    const result = (rpcResult.data || {}) as Record<string, unknown>;
    const decision = result.decision === "accepted" ? "accepted" : "rejected";
    const reasonCode = typeof result.reason_code === "string" ? result.reason_code : null;

    return jsonResponse(req, {
      success: true,
      decision,
      reason_code: reasonCode,
      message: attendanceMessage(decision === "accepted" ? null : reasonCode),
      suspected_proxy: result.suspected_proxy === true,
      work_date: typeof result.work_date === "string" ? result.work_date : workDate,
      distance_m: result.distance_m === null || result.distance_m === undefined ? null : Number(result.distance_m),
      event_id: typeof result.event_id === "string" ? result.event_id : null,
    });
  } catch (error) {
    console.error("[payslip-attendance-checkin] Unexpected error", error);
    return errorResponse(
      req,
      "Không thể chấm công. Vui lòng thử lại sau.",
      500,
      "payslip_attendance_checkin_failed",
    );
  }
});
