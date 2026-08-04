import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  extractReportSessionToken,
  jsonResponse,
  publicReportStaffProfile,
  readJsonBody,
  resolveReportSession,
} from "../_shared/report.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = req.method === "POST" ? await readJsonBody<Record<string, unknown>>(req) : {};
    const token = extractReportSessionToken(body, req);
    if (!token) {
      return errorResponse(req, "Phiên báo cáo không hợp lệ. Vui lòng đăng nhập lại.", 401, "report_session_required");
    }

    const supabase = createServiceClient();
    const sessionContext = await resolveReportSession(supabase, token);
    if (!sessionContext) {
      return errorResponse(req, "Phiên báo cáo đã hết hạn. Vui lòng đăng nhập lại.", 401, "report_session_invalid");
    }

    return jsonResponse(req, {
      success: true,
      expires_at: sessionContext.session.expires_at,
      ...publicReportStaffProfile(sessionContext.staff, sessionContext.location),
    });
  } catch (error) {
    console.error("[report-session] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không thể tải phiên báo cáo";
    return errorResponse(req, message, 500, "report_session_failed");
  }
});
