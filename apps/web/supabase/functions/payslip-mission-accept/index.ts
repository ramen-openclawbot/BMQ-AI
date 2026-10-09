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
  acceptMission,
  buildMissionAuditEntry,
} from "../_shared/payroll-missions.ts";
import type { DbMissionTemplateEmbed } from "../_shared/payroll-missions.ts";
import { PAYSLIP_SESSION_TOKEN_PREFIX } from "../_shared/payslip-portal.ts";

interface AcceptMissionRow {
  id: string;
  period_id: string;
  employee_code: string;
  status: string;
  accepted_at?: string | null;
  payroll_bn_mission_templates?: DbMissionTemplateEmbed | DbMissionTemplateEmbed[] | null;
}

function extractSessionToken(body: Record<string, unknown>, req: Request): string | null {
  const raw = body.session_token || body.payslip_token || req.headers.get("x-payslip-session");
  const token = typeof raw === "string" ? raw.trim() : "";
  return token.startsWith(PAYSLIP_SESSION_TOKEN_PREFIX) ? token : null;
}

function acceptDeadlineOf(row: AcceptMissionRow): string | null {
  const embed = Array.isArray(row.payroll_bn_mission_templates)
    ? row.payroll_bn_mission_templates[0]
    : row.payroll_bn_mission_templates;
  return embed?.accept_deadline ?? null;
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
    if (!token) {
      return errorResponse(req, "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.", 401, "session_required");
    }

    const missionId = String(body.mission_id ?? "").trim();
    if (missionId === "") {
      return errorResponse(req, "Thiếu mã nhiệm vụ.", 400, "mission_id_required");
    }

    const supabase = createServiceClient();
    const tokenHash = await hashReportSessionToken(token);
    const now = new Date();
    const nowIso = now.toISOString();

    const sessionResult = await supabase
      .from("payroll_bn_payslip_sessions")
      .select("id, employee_code, expires_at")
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .gt("expires_at", nowIso)
      .maybeSingle();
    if (sessionResult.error) throw sessionResult.error;

    const session = sessionResult.data as { id: string; employee_code: string } | null;
    if (!session) {
      return errorResponse(req, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401, "session_invalid");
    }

    const contactResult = await supabase
      .from("payroll_bn_employee_contacts")
      .select("employee_code")
      .eq("employee_code", session.employee_code)
      .eq("active", true)
      .maybeSingle();
    if (contactResult.error) throw contactResult.error;
    if (!contactResult.data) return errorResponse(req, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401, "session_invalid");

    // The mission must belong to the session's employee; nothing else is visible.
    const missionResult = await supabase
      .from("payroll_bn_missions")
      .select(
        "id, period_id, employee_code, status, accepted_at, payroll_bn_mission_templates(accept_deadline)",
      )
      .eq("id", missionId)
      .eq("employee_code", session.employee_code)
      .maybeSingle();
    if (missionResult.error) throw missionResult.error;

    const mission = missionResult.data as AcceptMissionRow | null;
    if (!mission) {
      return errorResponse(req, "Không tìm thấy nhiệm vụ.", 404, "mission_not_found");
    }

    const result = acceptMission(
      {
        status: mission.status,
        acceptedAt: mission.accepted_at ?? null,
        acceptDeadline: acceptDeadlineOf(mission),
      },
      now,
    );

    // Idempotent: only a published mission is written; a repeat click is a no-op.
    if (mission.status === "published" && result.status === "accepted") {
      await supabase
        .from("payroll_bn_missions")
        .update({ status: "accepted", accepted_at: result.acceptedAt })
        .eq("id", mission.id)
        .eq("employee_code", session.employee_code)
        .eq("status", "published");
    } else if (mission.status === "published" && result.status === "expired") {
      await supabase
        .from("payroll_bn_missions")
        .update({ status: "expired" })
        .eq("id", mission.id)
        .eq("employee_code", session.employee_code)
        .eq("status", "published");
    }

    // Audit entry built from a whitelist: no amount can reach the audit row.
    const audit = buildMissionAuditEntry(
      { action: "accept", missionId: mission.id, employeeCode: session.employee_code },
      now,
    );
    await supabase.from("payroll_bn_mission_audit").insert({
      period_id: mission.period_id,
      mission_id: audit.missionId,
      action: audit.action,
      new: { status: result.status },
    });

    return jsonResponse(req, {
      success: true,
      mission: {
        id: mission.id,
        periodId: mission.period_id,
        status: result.status,
        acceptedAt: result.acceptedAt,
      },
    });
  } catch (error) {
    console.error("[payslip-mission-accept] Unexpected error", error);
    return errorResponse(req, "Không thể nhận nhiệm vụ. Vui lòng thử lại sau.", 500, "mission_accept_failed");
  }
});
