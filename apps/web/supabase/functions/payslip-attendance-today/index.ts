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
  attendanceMessage,
  dayStatus,
  vietnamWorkDate,
  type AttendanceDayEvent,
  type AttendanceDayStatus,
} from "../_shared/payroll-attendance.ts";

const LOOKBACK_DAYS = 35;

interface DbAttendanceEvent {
  id: string;
  event_kind: string;
  work_date: string;
  decision: string;
  reject_reason: string | null;
  distance_m: number | string | null;
  suspected_proxy: boolean | null;
  server_received_at: string;
}

function extractSessionToken(body: Record<string, unknown>, req: Request): string | null {
  const raw = body.session_token || body.payslip_token || req.headers.get("x-payslip-session");
  const token = typeof raw === "string" ? raw.trim() : "";
  return token.startsWith(PAYSLIP_SESSION_TOKEN_PREFIX) ? token : null;
}

function extractDeviceId(body: Record<string, unknown>, req: Request): string | null {
  const raw = body.device_id ?? req.headers.get("x-payslip-device");
  return normalizePayslipDeviceId(raw);
}

function previousDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function publicEvent(row: DbAttendanceEvent) {
  const decision = row.decision === "accepted" ? "accepted" : "rejected";
  return {
    event_kind: row.event_kind === "out" ? "out" : "in",
    decision,
    reason_code: decision === "accepted" ? null : row.reject_reason,
    message: attendanceMessage(decision === "accepted" ? null : row.reject_reason),
    work_date: row.work_date,
    server_received_at: row.server_received_at,
    distance_m: row.distance_m === null ? null : Number(row.distance_m),
    suspected_proxy: row.suspected_proxy === true,
  };
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
    const deviceId = extractDeviceId(body, req);
    if (!token) {
      return errorResponse(req, "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.", 401, "session_required");
    }
    if (!deviceId) {
      return errorResponse(req, "Thiết bị chưa được xác thực. Vui lòng đăng nhập lại.", 401, "device_required");
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

    await supabase
      .from("payroll_bn_payslip_sessions")
      .update({ last_seen_at: now })
      .eq("id", session.id);

    const today = vietnamWorkDate(new Date());
    const fromDate = previousDate(today, LOOKBACK_DAYS - 1);

    const gateResult = await supabase
      .from("payroll_bn_attendance_gates")
      .select("enabled, geofence_location_id")
      .eq("employee_code", session.employee_code)
      .maybeSingle();
    if (gateResult.error) throw gateResult.error;
    const gate = gateResult.data as { enabled: boolean | null; geofence_location_id: string | null } | null;
    const gateEnabled = gate?.enabled === true;

    let siteName: string | null = null;
    let siteRadiusM: number | null = null;
    let siteConfigured = false;
    if (gate?.geofence_location_id) {
      const siteResult = await supabase
        .from("attendance_geofence_locations")
        .select("name, latitude, longitude, accepted_radius_m, active")
        .eq("id", gate.geofence_location_id)
        .maybeSingle();
      if (siteResult.error) throw siteResult.error;
      const site = siteResult.data as {
        name: string | null;
        latitude: number | string | null;
        longitude: number | string | null;
        accepted_radius_m: number | null;
        active: boolean | null;
      } | null;
      siteName = site?.name ?? null;
      siteRadiusM = site?.accepted_radius_m ?? null;
      siteConfigured = Boolean(
        site && site.active === true && site.latitude !== null && site.longitude !== null,
      );
    }

    const eventsResult = await supabase
      .from("payroll_bn_attendance_events")
      .select("id, event_kind, work_date, decision, reject_reason, distance_m, suspected_proxy, server_received_at")
      .eq("employee_code", session.employee_code)
      .gte("work_date", fromDate)
      .lte("work_date", today)
      .order("server_received_at", { ascending: false });
    if (eventsResult.error) throw eventsResult.error;
    const rawEvents = (eventsResult.data || []) as DbAttendanceEvent[];

    const overridesResult = await supabase
      .from("payroll_bn_attendance_day_overrides")
      .select("work_date")
      .eq("employee_code", session.employee_code)
      .gte("work_date", fromDate)
      .lte("work_date", today);
    if (overridesResult.error) throw overridesResult.error;
    const overrideDates = new Set(
      ((overridesResult.data || []) as Array<{ work_date: string }>).map((row) => row.work_date),
    );

    const eventsByDay = new Map<string, AttendanceDayEvent[]>();
    for (const row of rawEvents) {
      const list = eventsByDay.get(row.work_date) ?? [];
      list.push({
        eventKind: row.event_kind === "out" ? "out" : "in",
        decision: row.decision === "accepted" ? "accepted" : "rejected",
      });
      eventsByDay.set(row.work_date, list);
    }

    const todayStatus: AttendanceDayStatus = dayStatus(
      eventsByDay.get(today) ?? [],
      overrideDates.has(today),
    );
    const todayEvents = rawEvents.filter((row) => row.work_date === today).map(publicEvent);

    const incompleteDays: Array<{ work_date: string; status: AttendanceDayStatus; message: string }> = [];
    for (let offset = 0; offset < LOOKBACK_DAYS; offset += 1) {
      const date = previousDate(today, offset);
      const events = eventsByDay.get(date) ?? [];
      if (events.length === 0 && !overrideDates.has(date)) continue;
      const status = dayStatus(events, overrideDates.has(date));
      if (status === "missing_in" || status === "missing_out") {
        incompleteDays.push({
          work_date: date,
          status,
          message: "Ngày công không được tính, vui lòng liên hệ quản lý duyệt",
        });
      }
    }

    return jsonResponse(req, {
      success: true,
      employee: { code: session.employee_code },
      gate_enabled: gateEnabled,
      site_configured: siteConfigured,
      site_name: siteName,
      site_radius_m: siteRadiusM,
      today: {
        work_date: today,
        status: todayStatus,
        message: todayStatus === "missing_in" || todayStatus === "missing_out"
          ? "Ngày công không được tính, vui lòng liên hệ quản lý duyệt"
          : "",
        events: todayEvents,
      },
      incomplete_days: incompleteDays,
    });
  } catch (error) {
    console.error("[payslip-attendance-today] Unexpected error", error);
    return errorResponse(
      req,
      "Không thể tải tình trạng chấm công. Vui lòng thử lại sau.",
      500,
      "payslip_attendance_today_failed",
    );
  }
});
