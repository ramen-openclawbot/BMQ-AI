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

const isValidDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = req.method === "POST" ? await readJsonBody<{ report_date?: unknown }>(req) : {};
    const token = extractReportSessionToken(body, req);
    const reportDate = String(body.report_date || vietnamToday()).slice(0, 10);

    if (!token) {
      return errorResponse(req, "Phiên báo cáo không hợp lệ. Vui lòng đăng nhập lại.", 401, "report_session_required");
    }

    if (!isValidDate(reportDate)) {
      return errorResponse(req, "Ngày báo cáo không hợp lệ.", 400, "invalid_report_date");
    }

    const supabase = createServiceClient();
    const sessionContext = await resolveReportSession(supabase, token);
    if (!sessionContext) {
      return errorResponse(req, "Phiên báo cáo đã hết hạn. Vui lòng đăng nhập lại.", 401, "report_session_invalid");
    }

    const [productsRes, channelsRes, reportRes] = await Promise.all([
      supabase
        .from("kiosk_report_products")
        .select("code, product_name, unit, sale_allowed, breadstick_consumption_ratio, display_order")
        .eq("active", true)
        .order("display_order", { ascending: true }),
      supabase
        .from("kiosk_report_channels")
        .select("code, channel_name, display_order")
        .eq("active", true)
        .order("display_order", { ascending: true }),
      supabase
        .from("kiosk_daily_reports")
        .select("id, report_date, status, notes, submitted_at, updated_at, opening_source_report_date")
        .eq("location_id", sessionContext.session.location_id)
        .eq("report_date", reportDate)
        .maybeSingle(),
    ]);

    if (productsRes.error) throw productsRes.error;
    if (channelsRes.error) throw channelsRes.error;
    if (reportRes.error) throw reportRes.error;

    const report = reportRes.data;
    const [inventoryRes, channelRowsRes] = report?.id
      ? await Promise.all([
          supabase
            .from("kiosk_daily_report_inventory_rows")
            .select("product_code, product_name_snapshot, opening_quantity, received_quantity, shortage_quantity, transfer_quantity, waste_quantity, returns_quantity, sold_quantity, consumed_quantity, closing_quantity, notes")
            .eq("report_id", report.id),
          supabase
            .from("kiosk_daily_report_channel_rows")
            .select("channel_code, channel_name_snapshot, quantity, amount_vnd, notes")
            .eq("report_id", report.id),
        ])
      : [{ data: [], error: null }, { data: [], error: null }];

    if (inventoryRes.error) throw inventoryRes.error;
    if (channelRowsRes.error) throw channelRowsRes.error;

    let openingSourceReport: { id: string; report_date: string } | null = null;
    let openingInventoryRows: Array<{ product_code: string; opening_quantity: number }> = [];

    if (!report) {
      const previousReportRes = await supabase
        .from("kiosk_daily_reports")
        .select("id, report_date")
        .eq("location_id", sessionContext.session.location_id)
        .eq("status", "submitted")
        .lt("report_date", reportDate)
        .order("report_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (previousReportRes.error) throw previousReportRes.error;
      openingSourceReport = previousReportRes.data;

      if (openingSourceReport?.id) {
        const previousInventoryRes = await supabase
          .from("kiosk_daily_report_inventory_rows")
          .select("product_code, closing_quantity")
          .eq("report_id", openingSourceReport.id);

        if (previousInventoryRes.error) throw previousInventoryRes.error;
        openingInventoryRows = (previousInventoryRes.data || []).map((row) => ({
          product_code: row.product_code,
          opening_quantity: Number(row.closing_quantity || 0),
        }));
      }
    }

    return jsonResponse(req, {
      success: true,
      report_date: reportDate,
      ...publicReportStaffProfile(sessionContext.staff, sessionContext.location),
      products: productsRes.data || [],
      channels: channelsRes.data || [],
      opening_inventory_rows: openingInventoryRows,
      opening_source_report_date: openingSourceReport?.report_date || null,
      report: report
        ? {
            report_date: report.report_date,
            status: report.status,
            notes: report.notes,
            submitted_at: report.submitted_at,
            updated_at: report.updated_at,
            opening_source_report_date: report.opening_source_report_date,
            inventory_rows: inventoryRes.data || [],
            channel_rows: channelRowsRes.data || [],
          }
        : null,
    });
  } catch (error) {
    console.error("[report-bootstrap] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không thể tải báo cáo";
    return errorResponse(req, message, 500, "report_bootstrap_failed");
  }
});
