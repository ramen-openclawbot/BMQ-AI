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
  vietnamToday,
} from "../_shared/report.ts";

type InventoryInput = {
  product_code?: unknown;
  opening_quantity?: unknown;
  received_quantity?: unknown;
  shortage_quantity?: unknown;
  transfer_quantity?: unknown;
  waste_quantity?: unknown;
  returns_quantity?: unknown;
  sold_quantity?: unknown;
  notes?: unknown;
};

type ChannelInput = {
  channel_code?: unknown;
  quantity?: unknown;
  amount_vnd?: unknown;
  notes?: unknown;
};

const isValidDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const toNumber = (value: unknown) => {
  const numberValue = Number(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const nonnegative = (value: unknown) => Math.max(0, toNumber(value));

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = await readJsonBody<{
      report_date?: unknown;
      status?: unknown;
      notes?: unknown;
      inventory_rows?: InventoryInput[];
      channel_rows?: ChannelInput[];
    }>(req);
    const token = extractReportSessionToken(body, req);
    const reportDate = String(body.report_date || vietnamToday()).slice(0, 10);
    const status = String(body.status || "draft").trim();

    if (!token) {
      return errorResponse(req, "Phiên báo cáo không hợp lệ. Vui lòng đăng nhập lại.", 401, "report_session_required");
    }

    if (!isValidDate(reportDate)) {
      return errorResponse(req, "Ngày báo cáo không hợp lệ.", 400, "invalid_report_date");
    }

    if (status !== "draft" && status !== "submitted") {
      return errorResponse(req, "Trạng thái báo cáo không hợp lệ.", 400, "invalid_report_status");
    }

    const supabase = createServiceClient();
    const sessionContext = await resolveReportSession(supabase, token);
    if (!sessionContext) {
      return errorResponse(req, "Phiên báo cáo đã hết hạn. Vui lòng đăng nhập lại.", 401, "report_session_invalid");
    }

    const currentLocationId = sessionContext.session.location_id;
    if (!currentLocationId) {
      return errorResponse(req, "Không xác định được current location/date của nhân viên.", 403, "report_location_required");
    }

    const notes = String(body.notes || "").trim() || null;
    const profile = publicReportStaffProfile(sessionContext.staff, sessionContext.location);
    const inventoryRows = (Array.isArray(body.inventory_rows) ? body.inventory_rows : [])
      .slice(0, 100)
      .map((row) => ({
        product_code: String(row.product_code || "").trim(),
        opening_quantity: nonnegative(row.opening_quantity),
        received_quantity: nonnegative(row.received_quantity),
        shortage_quantity: nonnegative(row.shortage_quantity),
        transfer_quantity: toNumber(row.transfer_quantity),
        waste_quantity: nonnegative(row.waste_quantity),
        returns_quantity: nonnegative(row.returns_quantity),
        sold_quantity: nonnegative(row.sold_quantity),
        notes: String(row.notes || "").trim().slice(0, 1000) || null,
      }));
    const channelRows = (Array.isArray(body.channel_rows) ? body.channel_rows : [])
      .slice(0, 100)
      .map((row) => ({
        channel_code: String(row.channel_code || "").trim(),
        quantity: nonnegative(row.quantity),
        amount_vnd: nonnegative(row.amount_vnd),
        notes: String(row.notes || "").trim().slice(0, 1000) || null,
      }));

    const { data: finalReport, error: saveError } = await supabase.rpc(
      "save_kiosk_daily_report_atomic",
      {
        p_location_id: currentLocationId,
        p_staff_id: sessionContext.session.staff_id,
        p_report_date: reportDate,
        p_status: status,
        p_notes: notes?.slice(0, 2000) || null,
        p_staff_name_snapshot: profile.staff.full_name || "Nhân viên",
        p_staff_phone_normalized_snapshot: sessionContext.staff.phone_normalized || "",
        p_location_code_snapshot: profile.location.code || null,
        p_location_name_snapshot: profile.location.name || "Điểm bán",
        p_location_address_snapshot: profile.location.address || null,
        p_inventory_rows: inventoryRows,
        p_channel_rows: channelRows,
      },
    );

    if (saveError?.message?.includes("submitted_report_immutable")) {
      return errorResponse(req, "Báo cáo đã gửi không thể chỉnh sửa.", 409, "submitted_report_immutable");
    }
    if (saveError?.message?.includes("report_assignment_invalid")) {
      return errorResponse(req, "Phân công điểm bán đã thay đổi. Vui lòng đăng nhập lại.", 403, "report_assignment_invalid");
    }
    if (saveError?.message?.includes("ingredient_retail_sale_forbidden")) {
      return errorResponse(req, "Pate, ớt và nguyên liệu chỉ dùng nội bộ, không được ghi nhận bán lẻ.", 400, "ingredient_retail_sale_forbidden");
    }
    if (saveError?.message?.includes("prior_draft_report_pending")) {
      return errorResponse(req, "Vui lòng gửi báo cáo ngày trước trước khi gửi ngày này.", 409, "prior_draft_report_pending");
    }
    if (saveError?.message?.includes("later_submitted_report_exists")) {
      return errorResponse(req, "Không thể gửi báo cáo cũ hơn một báo cáo đã gửi.", 409, "later_submitted_report_exists");
    }
    if (saveError) throw saveError;

    return jsonResponse(req, {
      success: true,
      ...profile,
      report: {
        report_date: finalReport?.report_date,
        status: finalReport?.status,
        notes: finalReport?.notes,
        submitted_at: finalReport?.submitted_at,
        updated_at: finalReport?.updated_at,
      },
    });
  } catch (error) {
    console.error("[report-daily-save] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không thể lưu báo cáo";
    return errorResponse(req, message, 500, "report_daily_save_failed");
  }
});
