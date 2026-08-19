import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  extractReportSessionToken,
  jsonResponse,
  publicReportActorProfile,
  readJsonBody,
  resolveAttendanceEnabled,
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

    const attendanceEnabled = await resolveAttendanceEnabled(
      supabase,
      sessionContext.actor_type,
      sessionContext.actor_type === "delivery_staff"
        ? sessionContext.session.delivery_staff_id
        : sessionContext.session.staff_id,
    );
    const profile = publicReportActorProfile(sessionContext, attendanceEnabled) as Record<string, unknown>;
    return jsonResponse(req, {
      success: true,
      ...profile,
      actor_type: sessionContext.actor_type,
      expires_at: sessionContext.session.expires_at,
      attendance_enabled: attendanceEnabled === true,
    });
  } catch (error) {
    console.error("[report-session] Unexpected error", error);
    return errorResponse(req, "Không thể tải phiên báo cáo. Vui lòng thử lại sau.", 500, "report_session_failed");
  }
});
