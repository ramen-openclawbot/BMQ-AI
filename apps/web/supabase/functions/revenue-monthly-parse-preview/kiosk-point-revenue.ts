export type KioskPointChannelRow = {
  id: string;
  channel_code: string;
  channel_name_snapshot?: string | null;
  quantity: number | string | null;
  amount_vnd?: number | string | null;
  notes?: string | null;
};

export type KioskPointReportRow = {
  id: string;
  report_date: string;
  location_id: string;
  location_name_snapshot: string;
  submitted_at?: string | null;
  kiosk_daily_report_channel_rows?: KioskPointChannelRow[] | null;
};

type JsonRecord = Record<string, unknown>;

export type KioskPointRevenuePreviewLine = {
  run_id: string;
  source_row_number: number;
  revenue_date: string;
  po_received_date: string | null;
  period: string;
  channel: "Retail Kiosk";
  source_tab: string;
  branch: string;
  invoice_no: null;
  customer_id: null;
  parent_customer_id: null;
  customer_code: null;
  customer_name: string;
  product_code: "BMQ-001";
  product_name: "Bánh Mì Que Pate";
  item_note: string | null;
  quantity: number;
  unit_price: number;
  gross_revenue: number;
  source_type: "po_email_parse";
  source_ref: string;
  confidence_status: "matched";
  reconciliation_status: "not_reconciled";
  review_status: "not_required";
  raw_payload: JsonRecord;
};

export const KIOSK_POINT_PRICE_CHANGE_DATE = "2026-08-15";
export const KIOSK_POINT_PRICE_BEFORE_VND = 12_000;
export const KIOSK_POINT_PRICE_FROM_CHANGE_VND = 14_000;
export const KIOSK_POINT_PRICE_RULE = "kiosk_bread_unit_price_effective_20260815_v1";

const REVENUE_CHANNELS = new Set(["khach_le", "shopeefood", "grabfood", "befood"]);

const normalizedChannelCode = (value: unknown) => String(value || "").trim().toLowerCase();

const numericQuantity = (value: unknown) => {
  const quantity = Number(value);
  return Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
};

export const kioskPointUnitPriceVnd = (reportDate: string) =>
  String(reportDate || "").slice(0, 10) >= KIOSK_POINT_PRICE_CHANGE_DATE
    ? KIOSK_POINT_PRICE_FROM_CHANGE_VND
    : KIOSK_POINT_PRICE_BEFORE_VND;

export const buildKioskPointRevenuePreviewLines = (
  runId: string,
  period: string,
  revenueFrom: string,
  revenueTo: string,
  reports: KioskPointReportRow[],
  metadata: JsonRecord = {},
) => {
  const lines: KioskPointRevenuePreviewLine[] = [];

  for (const report of reports) {
    const reportDate = String(report.report_date || "").slice(0, 10);
    if (!reportDate || reportDate < revenueFrom || reportDate > revenueTo) continue;
    const unitPrice = kioskPointUnitPriceVnd(reportDate);

    for (const channelRow of report.kiosk_daily_report_channel_rows || []) {
      const channelCode = normalizedChannelCode(channelRow.channel_code);
      if (!REVENUE_CHANNELS.has(channelCode)) continue;
      const quantity = numericQuantity(channelRow.quantity);
      const sourceAmountVnd = Number(channelRow.amount_vnd || 0);

      lines.push({
        run_id: runId,
        source_row_number: lines.length + 1,
        revenue_date: reportDate,
        po_received_date: null,
        period,
        channel: "Retail Kiosk",
        source_tab: "Báo cáo điểm bán",
        branch: report.location_name_snapshot,
        invoice_no: null,
        customer_id: null,
        parent_customer_id: null,
        customer_code: null,
        customer_name: report.location_name_snapshot,
        product_code: "BMQ-001",
        product_name: "Bánh Mì Que Pate",
        item_note: channelRow.notes?.trim() || null,
        quantity,
        unit_price: unitPrice,
        gross_revenue: Math.round(quantity * unitPrice),
        source_type: "po_email_parse",
        source_ref: channelRow.id || report.id,
        confidence_status: "matched",
        reconciliation_status: "not_reconciled",
        review_status: "not_required",
        raw_payload: {
          source: "kiosk_point_report",
          source_url: "https://baocao.banhmique.vn",
          kiosk_report_id: report.id,
          kiosk_channel_row_id: channelRow.id,
          location_id: report.location_id,
          location_name: report.location_name_snapshot,
          channel_code: channelCode,
          channel_name: channelRow.channel_name_snapshot || channelCode,
          report_date: reportDate,
          submitted_at: report.submitted_at || null,
          source_amount_vnd: Number.isFinite(sourceAmountVnd) ? sourceAmountVnd : 0,
          applied_unit_price_vnd: unitPrice,
          pricing_rule: KIOSK_POINT_PRICE_RULE,
          dashboard_channel: "Retail Kiosk",
          trust_semantics: "submitted_kiosk_report_replaces_retail_kiosk_po_email_for_reported_date",
          ...metadata,
        },
      });
    }
  }

  return lines;
};

export const kioskReportedDates = (reports: KioskPointReportRow[]) =>
  new Set(
    reports
      .map((report) => String(report.report_date || "").slice(0, 10))
      .filter(Boolean),
  );
