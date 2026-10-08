import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  hashReportSessionToken,
  jsonResponse,
  readJsonBody,
} from "../_shared/report.ts";
import { PAYSLIP_SESSION_TOKEN_PREFIX } from "../_shared/payslip-portal.ts";

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

  if (req.method !== "POST") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = await readJsonBody<Record<string, unknown>>(req);
    const token = extractSessionToken(body, req);
    if (token) {
      const supabase = createServiceClient();
      const tokenHash = await hashReportSessionToken(token);
      await supabase
        .from("payroll_bn_payslip_sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("token_hash", tokenHash)
        .is("revoked_at", null);
    }

    return jsonResponse(req, { success: true });
  } catch (error) {
    console.error("[payslip-auth-logout] Unexpected error", error);
    return errorResponse(req, "Không thể đăng xuất. Vui lòng thử lại sau.", 500, "payslip_logout_failed");
  }
});
