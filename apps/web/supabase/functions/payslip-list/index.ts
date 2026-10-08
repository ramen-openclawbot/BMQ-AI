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
  PAYSLIP_SESSION_TOKEN_PREFIX,
  toPublicPayslips,
  type DbPayslipRow,
} from "../_shared/payslip-portal.ts";

function extractSessionToken(body: Record<string, unknown>, req: Request): string | null {
  const raw =
    body.session_token ||
    body.payslip_token ||
    req.headers.get("x-payslip-session");
  const token = typeof raw === "string" ? raw.trim() : "";
  return token.startsWith(PAYSLIP_SESSION_TOKEN_PREFIX) ? token : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = req.method === "POST" ? await readJsonBody<Record<string, unknown>>(req) : {};
    const token = extractSessionToken(body, req);
    if (!token) {
      return errorResponse(req, "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.", 401, "session_required");
    }

    const supabase = createServiceClient();
    const tokenHash = await hashReportSessionToken(token);
    const now = new Date().toISOString();

    const sessionResult = await supabase
      .from("payroll_bn_payslip_sessions")
      .select("id, employee_code, expires_at")
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", now)
      .maybeSingle();
    if (sessionResult.error) throw sessionResult.error;

    const session = sessionResult.data as { id: string; employee_code: string } | null;
    if (!session) {
      return errorResponse(req, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401, "session_invalid");
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

    await supabase
      .from("payroll_bn_payslip_sessions")
      .update({ last_seen_at: now })
      .eq("id", session.id);

    // employee_code comes from the session, never from the request body.
    const payslipsResult = await supabase
      .from("payroll_bn_payslips")
      .select(
        "period_id, employee_code, employee_name, group_name, period_name, date_from, date_to, net_pay, lines, note, published_at",
      )
      .eq("employee_code", session.employee_code)
      .order("published_at", { ascending: false });
    if (payslipsResult.error) throw payslipsResult.error;

    const payload = toPublicPayslips(
      (payslipsResult.data || []) as DbPayslipRow[],
      { employeeCode: session.employee_code },
    );

    return jsonResponse(req, { success: true, ...payload });
  } catch (error) {
    console.error("[payslip-list] Unexpected error", error);
    return errorResponse(req, "Không thể tải phiếu lương. Vui lòng thử lại sau.", 500, "payslip_list_failed");
  }
});
