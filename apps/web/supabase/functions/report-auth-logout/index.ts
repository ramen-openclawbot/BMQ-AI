import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  extractReportSessionToken,
  hashReportSessionToken,
  jsonResponse,
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
    const body = await readJsonBody<Record<string, unknown>>(req);
    const token = extractReportSessionToken(body, req);
    if (token) {
      const supabase = createServiceClient();
      const tokenHash = await hashReportSessionToken(token);
      await supabase
        .from("kiosk_report_sessions")
        .update({ revoked_at: new Date().toISOString() })
        .eq("token_hash", tokenHash)
        .is("revoked_at", null);
    }

    return jsonResponse(req, { success: true });
  } catch (error) {
    console.error("[report-auth-logout] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không thể đăng xuất báo cáo";
    return errorResponse(req, message, 500, "report_logout_failed");
  }
});
