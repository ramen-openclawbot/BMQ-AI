import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createServiceClient,
  hashReportSessionToken,
  timingSafeEqual,
} from "../_shared/report.ts";
import {
  hashPayslipDeviceId,
  normalizePayslipDeviceId,
  PAYSLIP_SESSION_TOKEN_PREFIX,
} from "../_shared/payslip-portal.ts";
import {
  attendanceConsentState,
  PAYROLL_ATTENDANCE_CONSENT_VERSION,
  PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN,
  selectExpiredSelfiePaths,
  selfieRetentionCutoff,
  type SelfieStorageObject,
} from "../_shared/payroll-attendance.ts";
import {
  DELIVERY_PROOF_BUCKET,
  DELIVERY_PROOF_RETENTION_DAYS,
  deliveryProofPath,
  validateDeliveryCompletion,
} from "../_shared/delivery-tasks.ts";

const PORTAL_ORIGIN = "https://luong.banhmique.vn";

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": origin === PORTAL_ORIGIN ? origin : PORTAL_ORIGIN,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-payslip-session, x-payslip-device",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

function isoInstant(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

interface StorageListRow {
  name: string;
  id: string | null;
  created_at?: string | null;
}

/**
 * Daily cleanup of delivery proofs older than 90 days. pg_cron calls this
 * function with x-worker-secret (the same singleton secret as the selfie
 * retention worker); deleted objects always go through the Storage API.
 */
async function handleProofRetention(req: Request, suppliedSecret: string): Promise<Response> {
  const supabase = createServiceClient();
  const configResult = await supabase
    .from("payroll_bn_attendance_consent_config")
    .select("worker_secret")
    .eq("id", true)
    .maybeSingle();
  if (configResult.error) {
    console.error("[payslip-delivery-complete] Retention config read failed", configResult.error.message);
    return error(req, "Không đọc được cấu hình lưu ảnh.", 500, "config_read_failed");
  }

  const storedSecret = String(configResult.data?.worker_secret || "");
  if (!storedSecret || !timingSafeEqual(suppliedSecret, storedSecret)) {
    return error(req, "Unauthorized", 401, "unauthorized");
  }

  try {
    const cutoff = selfieRetentionCutoff(new Date(), DELIVERY_PROOF_RETENTION_DAYS);
    const storage = supabase.storage.from(DELIVERY_PROOF_BUCKET);
    const folders: string[] = [""];
    const scannedObjects: SelfieStorageObject[] = [];
    let scanned = 0;

    while (
      folders.length > 0 &&
      scanned < PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN
    ) {
      const folder = folders.shift() as string;
      let offset = 0;

      while (scanned < PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN) {
        const { data, error: listError } = await storage.list(folder, {
          limit: 100,
          offset,
          sortBy: { column: "created_at", order: "asc" },
        });
        if (listError) throw listError;

        const rows = (data || []) as unknown as StorageListRow[];
        for (const row of rows) {
          if (!row?.name) continue;
          const path = folder ? `${folder}/${row.name}` : row.name;
          if (row.id === null) {
            // <employee>/<YYYY-MM-DD>/ folders: skip date folders that are not
            // expired yet so recent proofs do not consume the scan budget.
            if (/^\d{4}-\d{2}-\d{2}$/.test(row.name) && row.name >= cutoff.slice(0, 10)) {
              continue;
            }
            folders.push(path);
            continue;
          }
          if (scanned >= PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN) break;
          scanned += 1;
          scannedObjects.push({ path, createdAt: row.created_at ?? null });
        }

        if (rows.length < 100) break;
        offset += rows.length;
      }
    }

    const expired = selectExpiredSelfiePaths(
      scannedObjects,
      cutoff,
      PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN,
    );

    let deleted = 0;
    for (let index = 0; index < expired.length; index += 100) {
      const chunk = expired.slice(index, index + 100);
      const { data, error: removeError } = await storage.remove(chunk);
      if (removeError) throw removeError;
      deleted += Array.isArray(data) ? data.length : chunk.length;
    }

    return json(req, {
      success: true,
      deleted,
      scanned,
      retention_days: DELIVERY_PROOF_RETENTION_DAYS,
      cutoff,
    });
  } catch (failure) {
    console.error("[payslip-delivery-complete] Retention failed", failure);
    return error(req, "Không dọn được ảnh giao hàng cũ.", 500, "retention_failed");
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return error(req, "Method not allowed", 405, "method_not_allowed");
  }

  const workerSecret = req.headers.get("x-worker-secret") || "";
  if (workerSecret) {
    return await handleProofRetention(req, workerSecret);
  }

  try {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return error(req, "Dữ liệu giao hàng không hợp lệ.", 400, "invalid_form");
    }

    const token = extractSessionToken(form, req);
    const deviceId = extractDeviceId(form, req);
    if (!token) {
      return error(req, "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.", 401, "session_required");
    }
    if (!deviceId) {
      return error(req, "Thiết bị chưa được xác thực. Vui lòng đăng nhập lại.", 401, "device_required");
    }

    const taskId = textField(form, "task_id");
    if (!taskId) {
      return error(req, "Thiếu việc giao hàng cần hoàn thành.", 400, "task_required");
    }

    const photoEntry = form.get("photo");
    const photo = photoEntry && typeof photoEntry === "object" && "size" in photoEntry
      ? (photoEntry as File)
      : null;

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

    const [contactResult, consentConfigResult, consentResult] = await Promise.all([
      supabase
        .from("payroll_bn_employee_contacts")
        .select("employee_code")
        .eq("employee_code", session.employee_code)
        .eq("active", true)
        .maybeSingle(),
      supabase
        .from("payroll_bn_attendance_consent_config")
        .select("current_version")
        .eq("id", true)
        .maybeSingle(),
      supabase
        .from("payroll_bn_attendance_consents")
        .select("consent_version, accepted_at, withdrawn_at")
        .eq("employee_code", session.employee_code)
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
    for (const result of [consentConfigResult, consentResult]) {
      if (result.error) throw result.error;
    }

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
    if (!consent.accepted) {
      return error(
        req,
        "Bạn cần đọc và đồng ý thoả thuận sử dụng hình ảnh và vị trí trước khi hoàn thành giao hàng.",
        403,
        "consent_required",
      );
    }

    const taskResult = await supabase
      .from("delivery_tasks")
      .select("id, employee_code, delivery_date, status, destination_customer_id, destination_name, address, units, quantity, reopened_at")
      .eq("id", taskId)
      .maybeSingle();
    if (taskResult.error) throw taskResult.error;
    const task = taskResult.data as {
      id: string;
      employee_code: string | null;
      delivery_date: string;
      status: string;
      destination_customer_id: string;
      destination_name: string | null;
      address: string | null;
      units: number | string | null;
      quantity: number | string | null;
      reopened_at: string | null;
    } | null;
    if (!task) {
      return error(req, "Không tìm thấy việc giao hàng.", 404, "delivery_task_not_found");
    }

    const destinationResult = await supabase
      .from("mini_crm_customers")
      .select("id, location_lat, location_lng")
      .eq("id", task.destination_customer_id)
      .maybeSingle();
    if (destinationResult.error) throw destinationResult.error;
    const destination = destinationResult.data as {
      id: string;
      location_lat: number | string | null;
      location_lng: number | string | null;
    } | null;
    if (!destination) {
      return error(req, "Không tìm thấy điểm đến.", 404, "delivery_destination_not_found");
    }

    const validation = validateDeliveryCompletion({
      task: {
        employeeCode: task.employee_code,
        deliveryDate: task.delivery_date,
        status: task.status,
        reopenedAt: task.reopened_at,
      },
      employeeCode: session.employee_code,
      photoMime: photo?.type ?? null,
      photoBytes: photo?.size ?? 0,
      latitude: numericField(form, "latitude"),
      longitude: numericField(form, "longitude"),
      accuracyM: numericField(form, "accuracy_m"),
      destinationLatitude: destination.location_lat === null
        ? null
        : Number(destination.location_lat),
      destinationLongitude: destination.location_lng === null
        ? null
        : Number(destination.location_lng),
    });
    if (!validation.ok) {
      return error(req, validation.message, validation.httpStatus, validation.code);
    }
    if (!photo) {
      return error(req, "Vui lòng chụp ảnh giao hàng.", 400, "delivery_photo_required");
    }

    const latitude = numericField(form, "latitude") as number;
    const longitude = numericField(form, "longitude") as number;
    const accuracyM = numericField(form, "accuracy_m") as number;
    // One object per attempt: a losing/retried request can never overwrite the
    // proof of the request that actually completed the task.
    const photoPath = deliveryProofPath(
      session.employee_code,
      task.delivery_date,
      task.id,
      photo.type,
      crypto.randomUUID(),
    );

    const uploadResult = await supabase.storage
      .from(DELIVERY_PROOF_BUCKET)
      .upload(photoPath, photo, {
        contentType: photo.type,
        cacheControl: "3600",
        upsert: false,
      });
    if (uploadResult.error) throw uploadResult.error;

    const rpcResult = await supabase.rpc("complete_delivery_task", {
      p_task_id: task.id,
      p_employee_code: session.employee_code,
      p_session_id: session.id,
      p_device_hash: deviceHash,
      p_photo_path: photoPath,
      p_latitude: latitude,
      p_longitude: longitude,
      p_accuracy_m: accuracyM,
      p_device_captured_at: isoInstant(textField(form, "device_captured_at")),
    });

    if (rpcResult.error) {
      const message = String(rpcResult.error.message || "");

      // Only delete this attempt's object when the DB does not reference it.
      // A timeout after a successful commit must leave the proof in place.
      let referenced = true;
      const storedResult = await supabase
        .from("delivery_tasks")
        .select("photo_path")
        .eq("id", task.id)
        .maybeSingle();
      if (!storedResult.error) {
        referenced = storedResult.data?.photo_path === photoPath;
      }
      if (!referenced) {
        await supabase.storage.from(DELIVERY_PROOF_BUCKET).remove([photoPath]);
      }

      if (message.includes("delivery_task_not_pending")) {
        return error(req, "Việc giao hàng này đã hoàn thành.", 409, "delivery_already_completed");
      }
      if (message.includes("delivery_task_date_closed")) {
        return error(
          req,
          "Chỉ hoàn thành được việc giao hàng của hôm nay (hoặc hôm qua trước 06:00).",
          409,
          "delivery_date_closed",
        );
      }
      if (message.includes("delivery_task_not_assigned")) {
        return error(req, "Việc giao hàng này không thuộc tài xế đang đăng nhập.", 403, "delivery_not_assigned");
      }
      if (message.includes("payroll_bn_period_locked")) {
        return error(
          req,
          "Kỳ lương đã chốt, không thể hoàn thành giao hàng.",
          409,
          "payroll_bn_period_locked",
        );
      }
      throw rpcResult.error;
    }

    const result = (rpcResult.data || {}) as Record<string, unknown>;
    return json(req, {
      success: true,
      task_id: task.id,
      status: "completed",
      completed_at: result.completed_at ?? null,
      device_captured_at: result.device_captured_at ?? null,
      latitude: result.latitude ?? latitude,
      longitude: result.longitude ?? longitude,
      accuracy_m: result.accuracy_m ?? accuracyM,
      distance_m: result.distance_m === null || result.distance_m === undefined
        ? null
        : Number(result.distance_m),
      location_attached: result.location_attached === true,
      photo_path: result.photo_path ?? photoPath,
      units: Number(task.units ?? 0),
      quantity: Number(task.quantity ?? 0),
    });
  } catch (failure) {
    console.error("[payslip-delivery-complete] Unexpected error", failure);
    return error(
      req,
      "Không thể hoàn thành giao hàng. Vui lòng thử lại sau.",
      500,
      "payslip_delivery_complete_failed",
    );
  }
});
