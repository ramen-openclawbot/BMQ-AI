import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createServiceClient,
  hashReportSessionToken,
} from "../_shared/report.ts";
import {
  hashPayslipDeviceId,
  normalizePayslipDeviceId,
  PAYSLIP_SESSION_TOKEN_PREFIX,
} from "../_shared/payslip-portal.ts";
import {
  attendanceConsentState,
  PAYROLL_ATTENDANCE_CONSENT_VERSION,
  vietnamWorkDate,
} from "../_shared/payroll-attendance.ts";
import {
  deliveryCompletionWindow,
  deliveryMapsLink,
  deliveryUnitsForDay,
} from "../_shared/delivery-tasks.ts";

// Only the employee payroll portal may call this function from a browser.
const PORTAL_ORIGIN = "https://luong.banhmique.vn";

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": origin === PORTAL_ORIGIN ? origin : PORTAL_ORIGIN,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-payslip-session, x-payslip-device",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

function error(req: Request, message: string, status: number, code: string): Response {
  return json(req, { success: false, error: message, code }, status);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

interface DeliveryTaskRow {
  id: string;
  delivery_date: string;
  destination_customer_id: string;
  destination_name: string | null;
  address: string | null;
  units: number | string | null;
  sort_order: number | string | null;
  quantity: number | string | null;
  items: unknown;
  dealer_note: string | null;
  driver_note: string | null;
  status: string;
  completed_at: string | null;
  latitude: number | string | null;
  longitude: number | string | null;
  distance_m: number | string | null;
  location_attached: boolean | null;
}

interface DeliveryItem {
  sku_code: string;
  product_name: string;
  unit: string | null;
  quantity: number;
}

function mapItems(value: unknown): DeliveryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const quantity = Number(item.quantity);
    return [{
      sku_code: typeof item.sku_code === "string" ? item.sku_code : "",
      product_name: typeof item.product_name === "string" ? item.product_name : "",
      unit: typeof item.unit === "string" ? item.unit : null,
      quantity: Number.isFinite(quantity) ? quantity : 0,
    }];
  });
}

function publicTask(
  row: DeliveryTaskRow,
  destinationLatitude: number | null,
  destinationLongitude: number | null,
) {
  const latitude = row.latitude === null ? null : Number(row.latitude);
  const longitude = row.longitude === null ? null : Number(row.longitude);
  // The destination pin (if any) is the stable point; a task that just attached
  // it also has the same coordinates. Fall back to the completion coordinates.
  const linkLatitude = destinationLatitude ?? latitude;
  const linkLongitude = destinationLongitude ?? longitude;
  return {
    id: row.id,
    delivery_date: row.delivery_date,
    destination_name: row.destination_name ?? "",
    address: row.address ?? "",
    maps_link: deliveryMapsLink(
      row.destination_name,
      row.address,
      linkLatitude,
      linkLongitude,
    ),
    has_location: destinationLatitude !== null && destinationLongitude !== null,
    units: Number(row.units ?? 0),
    sort_order: Number(row.sort_order ?? 0),
    quantity: Number(row.quantity ?? 0),
    items: mapItems(row.items),
    dealer_note: row.dealer_note,
    driver_note: row.driver_note ?? null,
    status: row.status === "completed" || row.status === "cancelled" ? row.status : "pending",
    completed_at: row.completed_at,
    latitude,
    longitude,
    distance_m: row.distance_m === null ? null : Number(row.distance_m),
    location_attached: row.location_attached === true,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(req) });
  }
  if (req.method !== "GET") {
    return error(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    // Session/device credentials stay in headers: query strings end up in
    // gateway and function logs, which would make a psp_ session replayable.
    const rawToken = text(req.headers.get("x-payslip-session"));
    const token = rawToken && rawToken.startsWith(PAYSLIP_SESSION_TOKEN_PREFIX) ? rawToken : null;
    const deviceId = normalizePayslipDeviceId(text(req.headers.get("x-payslip-device")));
    if (!token) {
      return error(req, "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.", 401, "session_required");
    }
    if (!deviceId) {
      return error(req, "Thiết bị chưa được xác thực. Vui lòng đăng nhập lại.", 401, "device_required");
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
      return error(req, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401, "session_invalid");
    }
    if (!session.device_hash || !deviceHash || session.device_hash !== deviceHash) {
      return error(req, "Phiên đăng nhập không khớp thiết bị. Vui lòng đăng nhập lại.", 401, "device_mismatch");
    }

    const today = vietnamWorkDate(new Date());
    const completionWindow = deliveryCompletionWindow(new Date());
    const employeeCode = session.employee_code;

    const [
      contactResult,
      tasksResult,
      reopenedResult,
      settingResult,
      baseHistoryResult,
      consentConfigResult,
      consentResult,
    ] = await Promise.all([
        supabase
          .from("payroll_bn_employee_contacts")
          .select("employee_code")
          .eq("employee_code", employeeCode)
          .eq("active", true)
          .maybeSingle(),
        supabase
          .from("delivery_tasks")
          .select(
            "id, delivery_date, destination_customer_id, destination_name, address, units, sort_order, quantity, items, dealer_note, driver_note, status, completed_at, latitude, longitude, distance_m, location_attached",
          )
          .in("delivery_date", completionWindow.allowedDates)
          .eq("employee_code", employeeCode)
          .order("sort_order", { ascending: true }),
        // An owner can reopen an old task; it stays pending regardless of the
        // normal today/yesterday window and must be returned so the driver can
        // complete it again.
        supabase
          .from("delivery_tasks")
          .select(
            "id, delivery_date, destination_customer_id, destination_name, address, units, sort_order, quantity, items, dealer_note, driver_note, status, completed_at, latitude, longitude, distance_m, location_attached",
          )
          .eq("employee_code", employeeCode)
          .eq("status", "pending")
          .not("reopened_at", "is", null),
        supabase
          .from("delivery_driver_settings")
          .select("base_units_per_day")
          .eq("employee_code", employeeCode)
          .eq("active", true)
          .maybeSingle(),
        // A base change is effective-dated; today's units use the value that
        // was effective today, not a change already scheduled for tomorrow.
        supabase
          .from("delivery_driver_setting_history")
          .select("base_units_per_day")
          .eq("employee_code", employeeCode)
          .lte("effective_from", today)
          .order("effective_from", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("payroll_bn_attendance_consent_config")
          .select("current_version")
          .eq("id", true)
          .maybeSingle(),
        supabase
          .from("payroll_bn_attendance_consents")
          .select("consent_version, accepted_at, withdrawn_at")
          .eq("employee_code", employeeCode)
          .order("accepted_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    if (contactResult.error) throw contactResult.error;
    if (!contactResult.data) {
      await supabase
        .from("payroll_bn_payslip_sessions")
        .update({ revoked_at: now })
        .eq("id", session.id);
      return error(req, "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.", 401, "session_invalid");
    }
    for (const result of [
      tasksResult,
      reopenedResult,
      settingResult,
      baseHistoryResult,
      consentConfigResult,
      consentResult,
    ]) {
      if (result.error) throw result.error;
    }

    const lastSeenResult = await supabase
      .from("payroll_bn_payslip_sessions")
      .update({ last_seen_at: now })
      .eq("id", session.id);
    if (lastSeenResult.error) throw lastSeenResult.error;

    const rawTasks = [
      ...((tasksResult.data || []) as DeliveryTaskRow[]),
      ...((reopenedResult.data || []) as DeliveryTaskRow[]),
    ];
    // Before 06:00 the driver can still finish yesterday's last stops; an owner
    // reopen can bring back any older pending task. Both keep their own
    // delivery_date and stay out of today's completed totals.
    const uniqueTasks = new Map<string, DeliveryTaskRow>();
    for (const task of rawTasks) uniqueTasks.set(task.id, task);
    const tasks = [...uniqueTasks.values()]
      .filter((task) => task.delivery_date === today || task.status === "pending")
      .sort((left, right) =>
        left.delivery_date.localeCompare(right.delivery_date) ||
        Number(left.sort_order ?? 0) - Number(right.sort_order ?? 0)
      );
    const destinationIds = [...new Set(tasks.map((task) => task.destination_customer_id))];
    const destinationResult = destinationIds.length === 0
      ? { data: [] as unknown, error: null }
      : await supabase
        .from("mini_crm_customers")
        .select("id, location_lat, location_lng")
        .in("id", destinationIds);
    if (destinationResult.error) throw destinationResult.error;
    const destinationById = new Map<string, { latitude: number | null; longitude: number | null }>();
    for (const raw of (destinationResult.data || []) as Array<Record<string, unknown>>) {
      if (typeof raw.id !== "string") continue;
      const latitude = raw.location_lat === null ? null : Number(raw.location_lat);
      const longitude = raw.location_lng === null ? null : Number(raw.location_lng);
      destinationById.set(raw.id, {
        latitude: Number.isFinite(latitude as number) ? latitude as number : null,
        longitude: Number.isFinite(longitude as number) ? longitude as number : null,
      });
    }

    // Today's totals count only today's stops; older pending ones are
    // reported separately in previous_pending_points.
    const activeTasks = tasks.filter((task) => task.delivery_date === today && task.status !== "cancelled");
    const completed = tasks.filter((task) => task.status === "completed");
    const todayCompleted = completed.filter((task) => task.delivery_date === today);
    const previousPending = tasks.filter(
      (task) => task.delivery_date !== today && task.status === "pending",
    );
    const baseUnits = Number(
      baseHistoryResult.data?.base_units_per_day ??
        settingResult.data?.base_units_per_day ??
        0.5,
    );
    const todayUnits = deliveryUnitsForDay(
      baseUnits,
      todayCompleted.map((task) => Number(task.units ?? 0)),
    );

    const requiredConsentVersion =
      typeof consentConfigResult.data?.current_version === "string" &&
        consentConfigResult.data.current_version.trim() !== ""
        ? consentConfigResult.data.current_version
        : PAYROLL_ATTENDANCE_CONSENT_VERSION;
    const consent = attendanceConsentState(
      requiredConsentVersion,
      consentResult.data
        ? {
          consentVersion: String(consentResult.data.consent_version ?? ""),
          acceptedAt: typeof consentResult.data.accepted_at === "string"
            ? consentResult.data.accepted_at
            : null,
          withdrawnAt: typeof consentResult.data.withdrawn_at === "string"
            ? consentResult.data.withdrawn_at
            : null,
        }
        : null,
    );

    return json(req, {
      success: true,
      employee: { code: employeeCode },
      delivery_date: today,
      consent: {
        required_version: consent.requiredVersion,
        accepted: consent.accepted,
        accepted_at: consent.acceptedAt,
        withdrawn_at: consent.withdrawnAt,
      },
      // A driver has an active delivery setting or at least one task; the
      // portal hides the delivery panel for everyone else.
      is_driver: Boolean(settingResult.data) || tasks.length > 0,
      base_units_per_day: baseUnits,
      today: {
        delivery_date: today,
        allow_previous: completionWindow.allowPrevious,
        previous_pending_points: previousPending.length,
        total_points: activeTasks.length,
        completed_points: completed.length,
        delivered_quantity: completed.reduce((total, task) => total + Number(task.quantity ?? 0), 0),
        delivery_units: todayUnits,
        tasks: tasks.map((task) => {
          const destination = destinationById.get(task.destination_customer_id);
          return publicTask(task, destination?.latitude ?? null, destination?.longitude ?? null);
        }),
      },
    });
  } catch (failure) {
    console.error("[payslip-delivery-today] Unexpected error", failure);
    return error(req, "Không thể tải việc giao hàng. Vui lòng thử lại sau.", 500, "payslip_delivery_today_failed");
  }
});
