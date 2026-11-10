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

// Employee-facing weekly shift registration endpoint.
//
// Authentication is identical to payslip-mission: a live psp_ session bound to
// the x-payslip-device hash. Only the session employee_code is ever used, so a
// caller can never read or submit another employee's schedule. Shift types,
// needed headcount, opening day, deadline and limits all come from SQL data.

interface SessionRow {
  id: string;
  employee_code: string;
  device_hash: string | null;
}

interface ShiftError {
  status: number;
  code: string;
  message: string;
}

const GENERIC_SHIFT_ERROR = "Không thể tải hoặc đăng ký ca. Vui lòng thử lại.";

function extractSessionToken(body: Record<string, unknown>, req: Request): string | null {
  const raw = body.session_token || body.payslip_token || req.headers.get("x-payslip-session");
  const token = typeof raw === "string" ? raw.trim() : "";
  return token.startsWith(PAYSLIP_SESSION_TOKEN_PREFIX) ? token : null;
}

function extractDeviceId(body: Record<string, unknown>, req: Request): string | null {
  const raw = body.device_id ?? req.headers.get("x-payslip-device");
  return normalizePayslipDeviceId(raw);
}

function isYmd(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/** Map the SQL error codes/messages to employee-facing Vietnamese text. */
function mapShiftError(raw: unknown): ShiftError {
  const message = typeof raw === "string"
    ? raw
    : raw && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string"
      ? String((raw as { message: string }).message)
      : "";
  const lowered = message.toLowerCase();

  if (lowered.includes("shift_registration_closed")) {
    return {
      status: 409,
      code: "shift_registration_closed",
      message: "Đã hết hạn đăng ký ca tuần này. Vui lòng liên hệ quản lý.",
    };
  }
  if (lowered.includes("shift_not_eligible")) {
    return {
      status: 403,
      code: "shift_not_eligible",
      message: "Bạn không thuộc nhóm nhân viên được đăng ký ca.",
    };
  }
  if (lowered.includes("shift_day_off_required")) {
    return {
      status: 400,
      code: "shift_day_off_required",
      message: "Cần đăng ký tối thiểu số ngày nghỉ trong tuần.",
    };
  }
  if (lowered.includes("shift_invalid_shift")) {
    return {
      status: 400,
      code: "shift_invalid_shift",
      message: "Ca làm không hợp lệ hoặc đã ngừng sử dụng.",
    };
  }
  if (lowered.includes("shift_incomplete_week")) {
    return {
      status: 400,
      code: "shift_incomplete_week",
      message: "Vui lòng chọn đủ mỗi ngày một ca hoặc một ngày nghỉ cho cả tuần.",
    };
  }
  return { status: 500, code: "payslip_shift_failed", message: GENERIC_SHIFT_ERROR };
}

async function authenticate(
  req: Request,
  body: Record<string, unknown>,
): Promise<
  | { ok: true; supabase: ReturnType<typeof createServiceClient>; session: SessionRow }
  | { ok: false; response: Response }
> {
  const token = extractSessionToken(body, req);
  const deviceId = extractDeviceId(body, req);
  if (!token) {
    return {
      ok: false,
      response: errorResponse(req, "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.", 401, "session_required"),
    };
  }
  if (!deviceId) {
    return {
      ok: false,
      response: errorResponse(req, "Thiết bị chưa được xác thực. Vui lòng đăng nhập lại.", 401, "device_required"),
    };
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

  const session = sessionResult.data as SessionRow | null;
  if (!session) {
    return {
      ok: false,
      response: errorResponse(req, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401, "session_invalid"),
    };
  }
  if (!session.device_hash) {
    return {
      ok: false,
      response: errorResponse(req, "Phiên này chưa gắn thiết bị. Vui lòng đăng nhập lại.", 401, "device_not_bound"),
    };
  }
  if (!deviceHash || session.device_hash !== deviceHash) {
    return {
      ok: false,
      response: errorResponse(req, "Phiên đăng nhập không khớp thiết bị. Vui lòng đăng nhập lại.", 401, "device_mismatch"),
    };
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
    return {
      ok: false,
      response: errorResponse(req, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401, "session_invalid"),
    };
  }

  await supabase
    .from("payroll_bn_payslip_sessions")
    .update({ last_seen_at: now })
    .eq("id", session.id);

  return { ok: true, supabase, session };
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
      return errorResponse(req, "Dữ liệu đăng ký ca không hợp lệ.", 400, "invalid_json");
    }

    const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
    if (action !== "get" && action !== "submit") {
      return errorResponse(req, "Thao tác đăng ký ca không hợp lệ.", 400, "invalid_action");
    }

    const weekStart = typeof body.week_start === "string" ? body.week_start.trim() : "";
    if (weekStart !== "" && !isYmd(weekStart)) {
      return errorResponse(req, "Tuần đăng ký không hợp lệ.", 400, "invalid_week_start");
    }

    const authenticated = await authenticate(req, body);
    if (!authenticated.ok) return authenticated.response;
    const { supabase, session } = authenticated;

    if (action === "get") {
      const { data, error } = await supabase.rpc("get_payroll_bn_shift_week", {
        p_employee_code: session.employee_code,
        p_week_start: weekStart === "" ? null : weekStart,
      });
      if (error) {
        const mapped = mapShiftError(error);
        return errorResponse(req, mapped.message, mapped.status, mapped.code);
      }
      return jsonResponse(req, { success: true, week: data ?? null });
    }

    if (!Array.isArray(body.entries)) {
      return errorResponse(
        req,
        "Vui lòng chọn đủ mỗi ngày một ca hoặc một ngày nghỉ cho cả tuần.",
        400,
        "shift_incomplete_week",
      );
    }
    if (weekStart === "") {
      return errorResponse(req, "Tuần đăng ký không hợp lệ.", 400, "invalid_week_start");
    }

    const { data, error } = await supabase.rpc("submit_payroll_bn_shift_registration", {
      p_employee_code: session.employee_code,
      p_week_start: weekStart,
      p_entries: body.entries,
    });
    if (error) {
      const mapped = mapShiftError(error);
      return errorResponse(req, mapped.message, mapped.status, mapped.code);
    }

    return jsonResponse(req, { success: true, week: data ?? null });
  } catch (error) {
    console.error("[payslip-shifts] Unexpected error", error);
    return errorResponse(
      req,
      "Không thể tải hoặc đăng ký ca. Vui lòng thử lại sau.",
      500,
      "payslip_shift_failed",
    );
  }
});
