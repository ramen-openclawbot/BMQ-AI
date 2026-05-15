import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireAuth, requireCronSecret } from "../_shared/auth.ts";

type JsonRecord = Record<string, unknown>;

type InboxRow = {
  id: string;
  from_email?: string | null;
  received_at?: string | null;
  matched_customer_id: string | null;
  po_number?: string | null;
  email_subject: string | null;
  delivery_date: string | null;
  subtotal_amount: number | null;
  vat_amount: number | null;
  total_amount: number | null;
  revenue_channel: string | null;
  production_items: unknown[] | null;
  raw_payload: JsonRecord | null;
  mini_crm_customers?: {
    id?: string | null;
    customer_name?: string | null;
    customer_code?: string | null;
    product_group?: string | null;
    is_tier1?: boolean | null;
    supplied_by_npp_customer_id?: string | null;
  } | null;
};

type PreviewLine = {
  run_id: string;
  source_row_number: number;
  revenue_date: string;
  po_received_date: string | null;
  period: string;
  channel: string;
  source_tab: string | null;
  branch: string | null;
  invoice_no: string | null;
  customer_id: string | null;
  parent_customer_id: string | null;
  customer_code: string | null;
  customer_name: string;
  product_code: string | null;
  product_name: string | null;
  item_note: string | null;
  quantity: number;
  unit_price: number;
  gross_revenue: number;
  source_type: "po_email_parse";
  source_ref: string | null;
  confidence_status: "matched" | "manual_review" | "low_confidence";
  reconciliation_status: "not_reconciled" | "matched_po";
  review_status: "not_required" | "needs_manual_review";
  raw_payload: JsonRecord;
};

type ProgressEmitter = (event: JsonRecord) => void;
type ParseWindow = {
  period: string;
  revenueDateFrom: string;
  revenueDateTo: string;
  poReceivedFrom: string;
  poReceivedTo: string;
  hasRevenueWindow: boolean;
};
type PreviewOptions = {
  window?: ParseWindow;
  syncGmail?: boolean;
  monthlyParseKind?: string;
  sourceTab?: string;
  runSummary?: JsonRecord;
  linePayloadMetadata?: JsonRecord;
};

type DispatchRevenueConfirmationLine = {
  id: string;
  confirmation_id: string;
  source_line_key?: string | null;
  sku?: string | null;
  product_name?: string | null;
  ordered_qty?: number | string | null;
  produced_qty?: number | string | null;
  defect_qty?: number | string | null;
  dispatched_qty?: number | string | null;
  billable_qty?: number | string | null;
  unit_price_vat_included?: number | string | null;
  source_line_amount_vat_included?: number | string | null;
  temporary_revenue_amount_vat_included?: number | string | null;
  confirmed_revenue_amount_vat_included?: number | string | null;
  shortage_reason_code?: string | null;
  shortage_note?: string | null;
};

type DispatchRevenueConfirmation = {
  id: string;
  customer_po_inbox_id: string;
  warehouse_dispatch_id?: string | null;
  production_order_id?: string | null;
  status: "draft" | "confirmed" | "revised" | "cancelled" | string;
  amount_status: "temporary_po_amount" | "confirmed_dispatch_amount" | "needs_sku_allocation" | "month_end_audit_adjusted" | string;
  amount_basis?: string | null;
  ordered_qty_total?: number | string | null;
  produced_qty_total?: number | string | null;
  defect_qty_total?: number | string | null;
  dispatched_qty_total?: number | string | null;
  billable_qty_total?: number | string | null;
  temporary_revenue_amount_vat_included?: number | string | null;
  confirmed_revenue_amount_vat_included?: number | string | null;
  updated_at?: string | null;
  po_dispatch_revenue_confirmation_lines?: DispatchRevenueConfirmationLine[] | null;
};

type DispatchConfirmationMap = Map<string, DispatchRevenueConfirmation>;

const TIME_ZONE = "Asia/Ho_Chi_Minh";
const REVENUE_CRON_SECRET_ENV_KEY = "REVENUE_CRON_SECRET";
const LEGACY_PO_CRON_SECRET_ENV_KEY = "PO_SYNC_CRON_SECRET";
const THUY_DIRECT_DEALER_SENDER = "thuy@bmq.vn";
const AUTOMATION_REVIEW_STATUSES = new Set([
  "cancel_signal",
  "pdf_only_needs_review",
  "parse_failed_needs_review",
  "parsed_needs_review",
  "needs_manual_review",
  "po_evidence_only",
  "manual_trusted_ledger_only",
  "line_level_manual_revenue_ready",
  "vietjet_cumulative_evidence_only",
  "coopmart_manual_trusted_ledger_only",
  "superseded_duplicate_needs_review",
]);

const jsonResponse = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  const record = asRecord(error);
  const message = record.message || record.error || record.details || record.hint;
  if (typeof message === "string" && message.trim()) return message;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // fall through
  }
  return "Unknown error";
};

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

const stringValue = (...values: unknown[]) => {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return null;
};

const numberValue = (...values: unknown[]) => {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric !== 0) return numeric;
  }
  return 0;
};

const normalizeText = (...values: unknown[]) =>
  values
    .map((value) => String(value ?? ""))
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đ]/g, "d")
    .trim();

const DAM_XESG_T4_SENT_QTY = 12_320;
const DAM_XESG_T4_SOLD_QTY = 11_658;
const DAM_XESG_T4_GROSS_REVENUE = 139_986_000;
const DAM_XESG_T4_ESTIMATED_GROSS_PER_SENT_QTY = DAM_XESG_T4_GROSS_REVENUE / DAM_XESG_T4_SENT_QTY;
const DAM_XESG_T4_SELL_THROUGH_RATE = DAM_XESG_T4_SOLD_QTY / DAM_XESG_T4_SENT_QTY;

const dashboardRevenueChannel = (...signals: unknown[]) => {
  const normalizedSignals = signals.map((signal) => normalizeText(signal)).filter(Boolean);
  const combined = normalizedSignals.join(" ");

  // Strong parser/customer evidence should override stale broad channel values such as `b2b`.
  if (combined.includes("dam_xesg") || combined.includes("xesg")) return "Retail Kiosk";
  if (
    combined.includes("king") ||
    combined.includes("kfm") ||
    combined.includes("banhngot") ||
    combined.includes("kho banh")
  ) return "BÁNH NGỌT";

  for (const signal of signals) {
    const normalized = normalizeText(signal);
    if (!normalized) continue;

    if (normalized === "dai ly" || normalized === "agency" || normalized === "franchise") return "ĐẠI LÝ";
    if (normalized === "banh ngot" || normalized === "banhngot" || normalized === "bakery business") return "BÁNH NGỌT";
    if (normalized === "b2b" || normalized === "b2b bmq" || normalized === "b2b_bmq") return "B2B BMQ";
    if (normalized === "retail kiosk" || normalized === "retail" || normalized === "kiosk") return "Retail Kiosk";

    if (
      normalized.includes("b2b") ||
      normalized.includes("vietjet") ||
      normalized.includes("vjc")
    ) return "B2B BMQ";

    if (
      normalized.includes("agency") ||
      normalized.includes("franchise") ||
      normalized.includes("tony") ||
      normalized.includes("anh thanh") ||
      normalized.includes("thuy") ||
      normalized.includes("direct_company_dealer") ||
      normalized.includes("direct dealer") ||
      normalized.includes("direct_dealer") ||
      normalized.includes("dai ly")
    ) return "ĐẠI LÝ";
  }

  return "ĐẠI LÝ";
};

const estimateDamXesgRetailGross = (item: JsonRecord, rule: unknown, rawChannel: unknown) => {
  const normalized = normalizeText(rule, rawChannel, item.source_column_name);
  if (!normalized.includes("dam_xesg")) return null;
  const sentQty = numberValue(item.sent_qty, item.quantity, item.qty, item.ordered_qty, item.count);
  if (sentQty <= 0) return null;
  return {
    gross: Math.round(sentQty * DAM_XESG_T4_ESTIMATED_GROSS_PER_SENT_QTY),
    unit: DAM_XESG_T4_ESTIMATED_GROSS_PER_SENT_QTY,
    sentQty,
    estimatedSoldQty: sentQty * DAM_XESG_T4_SELL_THROUGH_RATE,
  };
};

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

const getDatePartsInTimeZone = (date: Date, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
  };
};

const timeZoneOffsetMinutes = (timeZone: string) => timeZone === TIME_ZONE ? 7 * 60 : 0;

const dateFromLocalParts = (date: string, timeZone: string, endOfDay = false) => {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  const localUtc = Date.UTC(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  return new Date(localUtc - timeZoneOffsetMinutes(timeZone) * 60 * 1000);
};

const shiftLocalDate = (date: string, deltaDays: number) => {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return isoDate(shifted);
};

const pad2 = (value: number) => String(value).padStart(2, "0");

const makeValidIsoDate = (year: number, month: number, day: number) => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
};

const strictIsoDate = (value: unknown) => {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const normalized = makeValidIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  return normalized === value ? normalized : null;
};

const normalizeRevenueDate = (value: unknown) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return makeValidIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // Kingfood spreadsheet exports commonly arrive as MM/DD/YYYY from SheetJS raw:false.
  // Normalize them so monthly preview filters compare ISO dates, not raw text.
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    const year = Number(us[3].length === 2 ? `20${us[3]}` : us[3]);
    return makeValidIsoDate(year, month, day);
  }

  const vn = raw.match(/^(\d{1,2})[.](\d{1,2})[.](\d{2}|\d{4})$/);
  if (vn) {
    const day = Number(vn[1]);
    const month = Number(vn[2]);
    const year = Number(vn[3].length === 2 ? `20${vn[3]}` : vn[3]);
    return makeValidIsoDate(year, month, day);
  }

  return null;
};

const firstNormalizedRevenueDate = (...values: unknown[]) => {
  for (const value of values) {
    const normalized = normalizeRevenueDate(value);
    if (normalized) return normalized;
  }
  return null;
};

const localDateRangeInclusive = (from: string, to: string) => {
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    dates.push(cursor);
    cursor = shiftLocalDate(cursor, 1);
    if (dates.length > 35) throw new Error("PO/email sync window is unexpectedly large");
  }
  return dates;
};

const gmailEpochSecondsForLocalDay = (date: string, endExclusive = false) => {
  const shifted = endExclusive ? shiftLocalDate(date, 1) : date;
  return Math.floor(dateFromLocalParts(shifted, TIME_ZONE).getTime() / 1000);
};

const currentMonthWindow = (now = new Date()) => {
  const current = getDatePartsInTimeZone(now, TIME_ZONE);
  const period = `${current.year}-${String(current.month).padStart(2, "0")}`;
  const revenueDateFrom = `${period}-01`;
  const revenueDateTo = shiftLocalDate(current.date, -1);
  const poReceivedFrom = shiftLocalDate(revenueDateFrom, -1);
  // Fetch through the current local day, then filter by parser service_date below.
  // This is required for cumulative schedules such as Vietjet: the latest file
  // for an earlier service_date can be received after service_date - 1.
  const poReceivedTo = current.date;
  const hasRevenueWindow = Date.parse(`${revenueDateTo}T00:00:00Z`) >= Date.parse(`${revenueDateFrom}T00:00:00Z`);
  return { period, revenueDateFrom, revenueDateTo, poReceivedFrom, poReceivedTo, hasRevenueWindow };
};

const autoDailyWindow = (now = new Date()) => {
  const current = getDatePartsInTimeZone(now, TIME_ZONE);
  const period = `${current.year}-${String(current.month).padStart(2, "0")}`;
  const revenueDateFrom = current.date;
  const revenueDateTo = current.date;
  const poReceivedFrom = shiftLocalDate(current.date, -1);
  const poReceivedTo = shiftLocalDate(current.date, -1);
  return { period, revenueDateFrom, revenueDateTo, poReceivedFrom, poReceivedTo, hasRevenueWindow: true };
};

const explicitRevenueDateWindow = (revenueDate: string) => ({
  period: revenueDate.slice(0, 7),
  revenueDateFrom: revenueDate,
  revenueDateTo: revenueDate,
  poReceivedFrom: shiftLocalDate(revenueDate, -1),
  poReceivedTo: shiftLocalDate(revenueDate, -1),
  hasRevenueWindow: true,
});

const localDateFromTimestamp = (value?: string | null) => {
  if (!value) return null;
  return getDatePartsInTimeZone(new Date(value), TIME_ZONE).date;
};

const extractPoNumberFromSubject = (subject?: string | null) => {
  const raw = String(subject || "");
  const match = raw.match(/PO\s*([0-9]{6,})/i) || raw.match(/\b(PO[0-9]{6,})\b/i);
  if (!match) return null;
  return match[1].toUpperCase().startsWith("PO") ? match[1].toUpperCase() : `PO${match[1]}`;
};

const amountNumber = (value: unknown, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const matchKey = (...values: unknown[]) =>
  normalizeText(...values)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const previewLineSourceKey = (item: JsonRecord, line: ReturnType<typeof lineFromItem>, itemIndex: number) =>
  stringValue(item.source_line_key, item.dedupe_key, item.sku, item.product_code, line.productCode, line.productName)
  || `line_${itemIndex + 1}`;

const lineMatchCandidates = (item: JsonRecord, line: ReturnType<typeof lineFromItem>, sourceLineKey: string) => {
  const keys = [
    sourceLineKey,
    item.source_line_key,
    item.dedupe_key,
    item.sku,
    item.product_code,
    line.productCode,
    item.product_name,
    item.name,
    item.item_name,
    line.productName,
  ];
  return new Set(keys.map((key) => matchKey(key)).filter(Boolean));
};

const findDispatchLine = (
  confirmation: DispatchRevenueConfirmation | undefined,
  item: JsonRecord,
  line: ReturnType<typeof lineFromItem>,
  sourceLineKey: string,
) => {
  const candidates = lineMatchCandidates(item, line, sourceLineKey);
  const dispatchLines = confirmation?.po_dispatch_revenue_confirmation_lines || [];
  return dispatchLines.find((dispatchLine) => {
    const keys = [
      dispatchLine.source_line_key,
      dispatchLine.sku,
      dispatchLine.product_name,
    ];
    return keys.some((key) => candidates.has(matchKey(key)));
  }) || null;
};

const buildVatIncludedMetadata = (row: InboxRow, item: JsonRecord) => {
  const raw = asRecord(row.raw_payload);
  const revenuePost = asRecord(raw.revenue_post);
  const poAutomation = asRecord(raw.po_automation);
  const amountIncludesVat = [item.amount_includes_vat, raw.amount_includes_vat, revenuePost.amount_includes_vat, poAutomation.amount_includes_vat]
    .some((value) => value === true || String(value).toLowerCase() === "true");
  const isKingfood = normalizeText(row.from_email, row.email_subject, row.mini_crm_customers?.customer_name, poAutomation.rule).includes("kingfood")
    || normalizeText(poAutomation.rule).includes("kingfood");

  if (!amountIncludesVat && !isKingfood) return null;

  return {
    amount_includes_vat: true,
    amount_source: stringValue(item.amount_source, revenuePost.amount_source, poAutomation.amount_source)
      || (isKingfood ? "kingfood_po_total_vat_included" : "source_marks_vat_included"),
    vat_handling: "no_extra_multiplier",
  };
};

const dispatchRevenueTrace = (
  rowId: string,
  item: JsonRecord,
  line: ReturnType<typeof lineFromItem>,
  sourceLineKey: string,
  confirmations: DispatchConfirmationMap,
) => {
  const confirmation = confirmations.get(rowId);
  if (!confirmation) {
    return {
      quantity: Number(line.quantity || 0),
      gross: Number(line.gross || 0),
      unit: Number(line.unit || 0),
      needsManualReview: false,
      raw: {
        source_line_key: sourceLineKey,
        revenue_amount_status: "temporary_po_amount",
        revenue_amount_basis: "temporary_po_ordered_amount",
        dispatch_confirmation_status: "missing",
      },
    };
  }

  const dispatchLine = findDispatchLine(confirmation, item, line, sourceLineKey);
  const isFinalStatus = confirmation.status === "confirmed" || confirmation.status === "revised";
  const isFinalAmount = confirmation.amount_status === "confirmed_dispatch_amount" || confirmation.amount_status === "month_end_audit_adjusted";
  const confirmedAmount = amountNumber(dispatchLine?.confirmed_revenue_amount_vat_included, NaN);
  const headerConfirmedAmount = amountNumber(confirmation.confirmed_revenue_amount_vat_included, NaN);
  const billableQty = amountNumber(dispatchLine?.billable_qty, Number(line.quantity || 0));
  const canUseDispatchLine = Boolean(dispatchLine && isFinalStatus && isFinalAmount && Number.isFinite(confirmedAmount));
  const canUseHeaderAmount = Boolean(
    (!dispatchLine || !Number.isFinite(confirmedAmount))
    && isFinalStatus
    && isFinalAmount
    && Number.isFinite(headerConfirmedAmount)
    && (confirmation.po_dispatch_revenue_confirmation_lines || []).length <= 1,
  );

  const raw = {
    source_line_key: sourceLineKey,
    dispatch_confirmation_id: confirmation.id,
    warehouse_dispatch_id: confirmation.warehouse_dispatch_id || null,
    dispatch_confirmation_status: confirmation.amount_status === "needs_sku_allocation" ? "needs_sku_allocation" : confirmation.status,
    revenue_amount_status: (canUseDispatchLine || canUseHeaderAmount) ? confirmation.amount_status : "temporary_po_amount",
    revenue_amount_basis: (canUseDispatchLine || canUseHeaderAmount) ? confirmation.amount_basis || "confirmed_dispatch_line_amounts" : "temporary_po_ordered_amount",
    dispatch_trace: {
      ordered_qty: amountNumber(dispatchLine?.ordered_qty, amountNumber(confirmation.ordered_qty_total)),
      produced_qty: amountNumber(dispatchLine?.produced_qty, amountNumber(confirmation.produced_qty_total)),
      defect_qty: amountNumber(dispatchLine?.defect_qty, amountNumber(confirmation.defect_qty_total)),
      dispatched_qty: amountNumber(dispatchLine?.dispatched_qty, amountNumber(confirmation.dispatched_qty_total)),
      billable_qty: amountNumber(dispatchLine?.billable_qty, amountNumber(confirmation.billable_qty_total)),
      shortage_reason_code: dispatchLine?.shortage_reason_code || null,
      shortage_note: dispatchLine?.shortage_note || null,
      matched_dispatch_line_id: dispatchLine?.id || null,
    },
  };

  if (canUseDispatchLine || canUseHeaderAmount) {
    const finalAmount = canUseDispatchLine ? confirmedAmount : headerConfirmedAmount;
    const finalQty = canUseDispatchLine ? billableQty : amountNumber(confirmation.billable_qty_total, Number(line.quantity || 0));
    return {
      quantity: finalQty,
      gross: finalAmount,
      unit: finalQty > 0 ? finalAmount / finalQty : Number(line.unit || 0),
      needsManualReview: false,
      raw,
    };
  }

  return {
    quantity: Number(line.quantity || 0),
    gross: Number(line.gross || 0),
    unit: Number(line.unit || 0),
    needsManualReview: confirmation.amount_status === "needs_sku_allocation",
    raw,
  };
};

async function userHasRole(supabaseAdmin: ReturnType<typeof createClient>, userId: string, role: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) throw error;
  const roles = (data || []).map((row: { role: string }) => row.role);
  return roles.includes(role);
}

async function ensureOwner(supabaseAdmin: ReturnType<typeof createClient>, userId: string) {
  if (!(await userHasRole(supabaseAdmin, userId, "owner"))) {
    throw new Error("Forbidden: owner role required for monthly parse");
  }
}

async function ensureRevenueViewer(supabaseAdmin: ReturnType<typeof createClient>, userId: string) {
  if (await userHasRole(supabaseAdmin, userId, "owner")) return;
  const { data, error } = await supabaseAdmin
    .from("user_module_permissions")
    .select("module_key,can_view")
    .eq("user_id", userId)
    .eq("module_key", "finance_revenue")
    .maybeSingle();
  if (error) throw error;
  if (!(data as { can_view?: boolean } | null)?.can_view) {
    throw new Error("Forbidden: finance_revenue view permission required for daily revenue report");
  }
}

async function syncGmailInboxForPreview(req: Request, window: ParseWindow, emit?: ProgressEmitter) {
  const authHeader = req.headers.get("Authorization") || "";
  const cronSecret = req.headers.get("x-cron-secret") || "";
  if (!authHeader.startsWith("Bearer ") && !cronSecret) {
    throw new Error("Missing Authorization header or cron secret for PO/email Gmail sync");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  if (!supabaseUrl) throw new Error("Missing SUPABASE_URL for PO/email Gmail sync");

  const syncResults: JsonRecord[] = [];
  const syncUrl = `${supabaseUrl}/functions/v1/po-gmail-sync`;
  const poDates = localDateRangeInclusive(window.poReceivedFrom, window.poReceivedTo);
  let totalFetched = 0;
  let totalSynced = 0;

  emit?.({ type: "progress", stage: "gmail_sync_start", channel: "Mailbox", totalDays: poDates.length, message: "Bắt đầu lấy PO/email từ Gmail" });

  for (let index = 0; index < poDates.length; index += 1) {
    const poDate = poDates[index];
    const after = gmailEpochSecondsForLocalDay(poDate);
    const before = gmailEpochSecondsForLocalDay(poDate, true);
    const query = `in:anywhere deliveredto:po@bmq.vn after:${after} before:${before}`;

    emit?.({
      type: "progress",
      stage: "gmail_sync_day_start",
      channel: "Mailbox",
      date: poDate,
      dayIndex: index + 1,
      totalDays: poDates.length,
      message: `Đang lấy mail ngày ${poDate}`,
    });

    const response = await fetch(syncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader.startsWith("Bearer ") ? { Authorization: authHeader } : {}),
        ...(cronSecret ? { "x-cron-secret": cronSecret } : {}),
      },
      body: JSON.stringify({ mode: "import", maxResults: 100, query, includeOnlyCrm: true }),
    });

    const rawText = await response.text();
    let parsed: JsonRecord = {};
    try {
      parsed = rawText ? asRecord(JSON.parse(rawText)) : {};
    } catch {
      parsed = { raw: rawText };
    }

    if (!response.ok) {
      throw new Error(`PO/email Gmail sync failed for ${poDate}: HTTP ${response.status} - ${String(parsed.error || parsed.message || parsed.raw || rawText)}`);
    }

    const fetched = Number(parsed.fetched || 0);
    const synced = Number(parsed.synced || 0);
    totalFetched += fetched;
    totalSynced += synced;
    const result = {
      date: poDate,
      query,
      synced,
      fetched,
      resultSizeEstimate: Number(parsed.resultSizeEstimate || 0),
      mailbox: typeof parsed.mailbox === "string" ? parsed.mailbox : null,
    };
    syncResults.push(result);
    emit?.({
      type: "progress",
      stage: "gmail_sync_day_done",
      channel: "Mailbox",
      date: poDate,
      dayIndex: index + 1,
      totalDays: poDates.length,
      fetched,
      synced,
      totalFetched,
      totalSynced,
      resultSizeEstimate: result.resultSizeEstimate,
      mailbox: result.mailbox,
      message: `${poDate}: ${fetched} mail fetched, ${synced} mail sync/import`,
    });
  }

  return syncResults;
}

async function fetchInboxRows(supabaseAdmin: ReturnType<typeof createClient>, receivedFrom: string, receivedTo: string) {
  const pageSize = 1000;
  const rowsById = new Map<string, InboxRow>();

  const fetchPages = async (applyScope?: (query: ReturnType<ReturnType<typeof supabaseAdmin.from>["select"]>) => unknown) => {
    let offset = 0;
    while (true) {
      let query = supabaseAdmin
        .from("customer_po_inbox")
        .select("*, mini_crm_customers(id, customer_name, customer_code, product_group, is_tier1, supplied_by_npp_customer_id)")
        .gte("received_at", receivedFrom)
        .lte("received_at", receivedTo)
        .order("received_at", { ascending: false })
        .range(offset, offset + pageSize - 1);

      if (applyScope) query = applyScope(query) as typeof query;
      const { data, error } = await query;
      if (error) throw error;
      const batch = (data || []) as InboxRow[];
      for (const row of batch) rowsById.set(row.id, row);
      if (batch.length < pageSize) break;
      offset += pageSize;
    }
  };

  await fetchPages();
  await fetchPages((query) => query.eq("from_email", THUY_DIRECT_DEALER_SENDER));
  return Array.from(rowsById.values());
}

async function fetchDispatchRevenueConfirmations(
  supabaseAdmin: ReturnType<typeof createClient>,
  inboxIds: string[],
): Promise<DispatchConfirmationMap> {
  const byInboxId: DispatchConfirmationMap = new Map();
  const uniqueIds = Array.from(new Set(inboxIds.filter(Boolean)));
  for (let index = 0; index < uniqueIds.length; index += 200) {
    const batch = uniqueIds.slice(index, index + 200);
    const { data, error } = await supabaseAdmin
      .from("po_dispatch_revenue_confirmations")
      .select("*, po_dispatch_revenue_confirmation_lines(*)")
      .in("customer_po_inbox_id", batch)
      .neq("status", "cancelled")
      .order("updated_at", { ascending: false });
    if (error) throw error;

    for (const row of (data || []) as DispatchRevenueConfirmation[]) {
      if (!byInboxId.has(row.customer_po_inbox_id)) byInboxId.set(row.customer_po_inbox_id, row);
    }
  }
  return byInboxId;
}

const lineFromItem = (item: JsonRecord, fallbackAmount: number) => {
  const quantity = numberValue(item.revenue_qty, item.quantity, item.qty, item.ordered_qty, item.count);
  const gross = numberValue(item.line_total, item.amount, item.gross_revenue, item.total, fallbackAmount);
  const unit = numberValue(item.unit_price, item.price, quantity > 0 ? gross / quantity : 0);
  return {
    quantity,
    gross,
    unit,
    productCode: stringValue(item.product_code, item.sku, item.code),
    productName: stringValue(item.product_name, item.name, item.item_name) || "PO/email parsed item",
    note: stringValue(item.note, item.item_note, item.description),
  };
};

const lineRevenueDate = (row: InboxRow, item: JsonRecord, poReceivedDate: string | null) => {
  const raw = asRecord(row.raw_payload);
  const parseMeta = asRecord(raw.parse_meta);
  return firstNormalizedRevenueDate(
    item.service_date,
    item.date,
    parseMeta.service_date,
    parseMeta.delivery_date,
    row.delivery_date,
    poReceivedDate ? shiftLocalDate(poReceivedDate, 1) : null,
  );
};

const isThuyDealerDateHeaderItem = (row: InboxRow, item: JsonRecord) => {
  const raw = asRecord(row.raw_payload);
  const poAutomation = asRecord(raw.po_automation);
  const fromEmail = normalizeText(row.from_email);
  const automationRule = normalizeText(poAutomation.rule, poAutomation.channel_scope);
  const rawLine = normalizeText(item.raw_line, item.source_line, item.text);
  const route = normalizeText(item.route, item.customer_name, item.route_name);
  const subject = normalizeText(row.email_subject);

  return (
    fromEmail.includes("thuy@bmq.vn") &&
    automationRule.includes("thuy") &&
    rawLine.match(/^dat banh\s+\d{1,2}(?:[.,\/]\d{1,2})?$/) !== null &&
    route === "dat banh" &&
    subject.includes(rawLine)
  );
};

const calcAmountFromRow = (row: InboxRow): number => {
  const raw = asRecord(row.raw_payload);
  const revenuePost = asRecord(raw.revenue_post);
  const posted = numberValue(revenuePost.total, revenuePost.amount);
  if (posted > 0) return posted;
  const direct = numberValue(row.total_amount, row.subtotal_amount);
  if (direct > 0) return direct;
  const items = asArray(raw.parsed_items_preview).map(asRecord);
  return items.reduce((sum, item) => sum + numberValue(item.line_total, item.amount, item.total), 0);
};

const buildPreviewLines = (
  runId: string,
  period: string,
  revenueFrom: string,
  revenueTo: string,
  rows: InboxRow[],
  dispatchConfirmations: DispatchConfirmationMap = new Map(),
  emit?: ProgressEmitter,
  options: Pick<PreviewOptions, "monthlyParseKind" | "sourceTab" | "linePayloadMetadata"> = {},
) => {
  const channelMailCounts = new Map<string, { mails: number; lines: number }>();
  const lines: PreviewLine[] = [];
  let sourceRowNumber = 1;
  const monthlyParseKind = options.monthlyParseKind || "manual_current_month_to_yesterday";
  const sourceTab = options.sourceTab || "PO/email monthly parse";
  const linePayloadMetadata = options.linePayloadMetadata || {};

  for (const row of rows) {
    const poReceivedDate = localDateFromTimestamp(row.received_at);
    if (!poReceivedDate) continue;

    const raw = asRecord(row.raw_payload);
    const poAutomation = asRecord(raw.po_automation);
    const automationStatus = String(poAutomation.automation_status || "");
    const needsReview = AUTOMATION_REVIEW_STATUSES.has(automationStatus) || !row.matched_customer_id;
    const fallbackAmount = calcAmountFromRow(row);
    const productionItems = asArray(row.production_items).map(asRecord);
    const parsedItems = asArray(raw.parsed_items_preview).map(asRecord);
    const items = productionItems.length > 0 ? productionItems : parsedItems;
    const effectiveItems = items.length > 0 ? items : [
      {
        product_name: "PO/email total",
        quantity: numberValue(raw.quantity, raw.total_quantity),
        line_total: fallbackAmount,
        unit_price: numberValue(raw.unit_price),
      },
    ];

    let rowLineCount = 0;
    let rowChannel: string | null = null;

    for (let itemIndex = 0; itemIndex < effectiveItems.length; itemIndex += 1) {
      const item = effectiveItems[itemIndex];
      if (isThuyDealerDateHeaderItem(row, item)) continue;
      const revenueDate = lineRevenueDate(row, item, poReceivedDate);
      if (!revenueDate || revenueDate < revenueFrom || revenueDate > revenueTo) continue;
      const line = lineFromItem(item, effectiveItems.length === 1 ? fallbackAmount : 0);
      const sourceLineKey = previewLineSourceKey(item, line, itemIndex);
      const customerName = stringValue(
        item.customer_name,
        item.route_name,
        row.mini_crm_customers?.customer_name,
        raw.customer_name,
        row.email_subject,
      ) || "Chưa xác định customer";
      const rawChannel = stringValue(
        row.revenue_channel,
        raw.revenue_channel,
        item.revenue_channel,
        item.source_channel,
        row.mini_crm_customers?.product_group,
        poAutomation.rule,
        poAutomation.channel_scope,
        row.from_email,
        customerName,
      ) || "po_email";
      const dashboardChannel = dashboardRevenueChannel(
        rawChannel,
        row.revenue_channel,
        raw.revenue_channel,
        item.revenue_channel,
        item.source_channel,
        row.mini_crm_customers?.product_group,
        poAutomation.rule,
        poAutomation.channel_scope,
        row.from_email,
        customerName,
      );
      const damXesgEstimate = dashboardChannel === "Retail Kiosk" && Number(line.gross || 0) === 0
        ? estimateDamXesgRetailGross(item, poAutomation.rule, rawChannel)
        : null;
      if (damXesgEstimate) {
        const estimateNote = `Retail Kiosk estimate from T4 XESG pattern: ${damXesgEstimate.sentQty} sent_qty × ${DAM_XESG_T4_ESTIMATED_GROSS_PER_SENT_QTY.toLocaleString("vi-VN")} VND/sent_qty`;
        line.gross = damXesgEstimate.gross;
        line.unit = damXesgEstimate.unit;
        line.note = line.note ? `${line.note}; ${estimateNote}` : estimateNote;
      }
      const dispatchTrace = dispatchRevenueTrace(row.id, item, line, sourceLineKey, dispatchConfirmations);
      const vatIncludedMetadata = buildVatIncludedMetadata(row, item);
      const gross = Number(dispatchTrace.gross || 0);
      const lineNeedsReview = needsReview || dispatchTrace.needsManualReview;
      rowChannel = rowChannel || dashboardChannel;
      rowLineCount += 1;
      lines.push({
        run_id: runId,
        source_row_number: sourceRowNumber,
        revenue_date: revenueDate,
        po_received_date: poReceivedDate,
        period,
        channel: dashboardChannel,
        source_tab: sourceTab,
        branch: stringValue(raw.branch, item.branch),
        invoice_no: stringValue(row.po_number, raw.po_number, extractPoNumberFromSubject(row.email_subject)),
        customer_id: row.matched_customer_id || stringValue(item.customer_id, item.parent_customer_id),
        parent_customer_id: stringValue(item.parent_customer_id, row.mini_crm_customers?.supplied_by_npp_customer_id),
        customer_code: stringValue(row.mini_crm_customers?.customer_code, raw.customer_code),
        customer_name: customerName,
        product_code: line.productCode,
        product_name: line.productName,
        item_note: line.note,
        quantity: Number(dispatchTrace.quantity || 0),
        unit_price: Number(dispatchTrace.unit || 0),
        gross_revenue: gross,
        source_type: "po_email_parse",
        source_ref: row.id,
        confidence_status: lineNeedsReview ? "manual_review" : "matched",
        reconciliation_status: "not_reconciled",
        review_status: lineNeedsReview ? "needs_manual_review" : "not_required",
        raw_payload: {
          inbox_row_id: row.id,
          from_email: row.from_email || null,
          received_at: row.received_at || null,
          email_subject: row.email_subject || null,
          po_number: row.po_number || extractPoNumberFromSubject(row.email_subject),
          po_received_date: poReceivedDate,
          revenue_date: revenueDate,
          date_mapping: stringValue(asRecord(raw.parse_meta).date_mapping) || "parser_service_date_or_po_received_local_date_plus_1_day_fallback",
          automation_status: automationStatus || null,
          automation_rule: poAutomation.rule || null,
          service_date_source: stringValue(item.service_date, item.date, asRecord(raw.parse_meta).service_date, asRecord(raw.parse_meta).delivery_date, row.delivery_date) ? "parser_service_date" : "fallback_po_received_plus_1",
          monthly_parse_kind: monthlyParseKind,
          trust_semantics: "not_trusted_month_end_audit_source",
          dashboard_channel: dashboardChannel,
          raw_parse_channel: rawChannel,
          route: stringValue(item.route),
          route_customer_id: stringValue(item.route_customer_id),
          route_customer_name: stringValue(item.route_customer_name),
          agency_customer_id: stringValue(item.agency_customer_id, item.route_customer_id),
          agency_customer_name: stringValue(item.agency_customer_name, item.route_customer_name),
          parent_customer_name: stringValue(item.parent_customer_name, row.mini_crm_customers?.customer_name),
          raw_line: stringValue(item.raw_line),
          ordered_qty: numberValue(item.ordered_qty),
          revenue_qty: numberValue(item.revenue_qty, item.qty, item.quantity),
          exchange_qty: numberValue(item.exchange_qty),
          makeup_qty: numberValue(item.makeup_qty),
          physical_qty: numberValue(item.physical_qty),
          item_confidence: numberValue(item.confidence),
          item_needs_manual_review: Boolean(item.needs_manual_review),
          item_review_reasons: asArray(item.review_reasons),
          retail_estimate_basis: damXesgEstimate ? {
            method: "t4_xesg_sent_qty_revenue_estimate",
            sent_qty: damXesgEstimate.sentQty,
            estimated_sold_qty: damXesgEstimate.estimatedSoldQty,
            t4_sent_qty: DAM_XESG_T4_SENT_QTY,
            t4_sold_qty: DAM_XESG_T4_SOLD_QTY,
            t4_gross_revenue: DAM_XESG_T4_GROSS_REVENUE,
            estimated_gross_per_sent_qty: DAM_XESG_T4_ESTIMATED_GROSS_PER_SENT_QTY,
            note: "Retail Kiosk May preview estimate uses T4 XESG pattern because current PO email has sent_qty only, not actual sold_qty.",
          } : null,
          source_dedupe_key: stringValue(item.dedupe_key),
          dedupe_strategy: stringValue(item.dedupe_strategy, asRecord(raw.parse_meta).dedupe_strategy),
          ...(vatIncludedMetadata || {}),
          ...dispatchTrace.raw,
          ...linePayloadMetadata,
        },
      });
      sourceRowNumber += 1;
    }

    if (rowLineCount > 0 && rowChannel) {
      const counts = channelMailCounts.get(rowChannel) || { mails: 0, lines: 0 };
      counts.mails += 1;
      counts.lines += rowLineCount;
      channelMailCounts.set(rowChannel, counts);
      emit?.({
        type: "progress",
        stage: "parse_channel",
        channel: rowChannel,
        mailCount: counts.mails,
        lineCount: counts.lines,
        currentMailLines: rowLineCount,
        fromEmail: row.from_email || null,
        receivedDate: poReceivedDate,
        subject: row.email_subject || null,
        totalParsedMails: Array.from(channelMailCounts.values()).reduce((sum, item) => sum + item.mails, 0),
        totalParsedLines: lines.length,
        message: `${rowChannel}: đã parse ${counts.mails} mail / ${counts.lines} dòng`,
      });
    }
  }

  const latestVietjetByKey = new Map<string, PreviewLine>();
  const deduped: PreviewLine[] = [];
  for (const line of lines) {
    const raw = asRecord(line.raw_payload);
    const rule = String(raw.automation_rule || "");
    const key = String(raw.source_dedupe_key || "");
    if (rule === "vietjet_cumulative_xlsx" && key) {
      const existing = latestVietjetByKey.get(key);
      const existingReceived = String(asRecord(existing?.raw_payload).received_at || "");
      const currentReceived = String(raw.received_at || "");
      if (!existing || currentReceived >= existingReceived) latestVietjetByKey.set(key, line);
      continue;
    }
    deduped.push(line);
  }

  for (const line of latestVietjetByKey.values()) deduped.push(line);
  return deduped.map((line, index) => ({ ...line, source_row_number: index + 1 }));
};

const summarizeLines = (lines: PreviewLine[], window: ParseWindow) => {
  const customers = new Set(lines.map((line) => line.customer_id || line.customer_name));
  const channels = new Map<string, { channel: string; rows: number; grossRevenue: number; quantity: number; reviewFlaggedRows: number }>();
  let grossRevenue = 0;
  let quantity = 0;
  let needsReview = 0;

  for (const line of lines) {
    grossRevenue += Number(line.gross_revenue || 0);
    quantity += Number(line.quantity || 0);
    const isReviewFlagged = line.review_status === "needs_manual_review";
    if (isReviewFlagged) needsReview += 1;
    const cur = channels.get(line.channel) || { channel: line.channel, rows: 0, grossRevenue: 0, quantity: 0, reviewFlaggedRows: 0 };
    cur.rows += 1;
    cur.grossRevenue += Number(line.gross_revenue || 0);
    cur.quantity += Number(line.quantity || 0);
    if (isReviewFlagged) cur.reviewFlaggedRows += 1;
    channels.set(line.channel, cur);
  }

  return {
    period: window.period,
    revenueDateFrom: window.revenueDateFrom,
    revenueDateTo: window.revenueDateTo,
    poReceivedFrom: window.poReceivedFrom,
    poReceivedTo: window.poReceivedTo,
    rows: lines.length,
    postedRows: lines.length,
    ledgerRows: lines.length,
    grossRevenue,
    dashboardGrossRevenue: grossRevenue,
    quantity,
    customers: customers.size,
    needsReview,
    reviewFlaggedRows: needsReview,
    approvalSemantics: "owner_controlled_ledger_first",
    channels: Array.from(channels.values()).sort((a, b) => b.grossRevenue - a.grossRevenue),
  };
};

async function runCurrentMonthPreview(
  req: Request,
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string | null,
  emit?: ProgressEmitter,
  options: PreviewOptions = {},
) {
  const window = options.window || currentMonthWindow();
  if (!window.hasRevenueWindow) {
    const error = new Error("Chưa có ngày doanh thu trong tháng hiện tại để parse. Hãy chạy từ ngày 02 trở đi.");
    error.name = "no_parseable_revenue_window";
    throw error;
  }

  const receivedFrom = dateFromLocalParts(window.poReceivedFrom, TIME_ZONE).toISOString();
  const receivedTo = dateFromLocalParts(window.poReceivedTo, TIME_ZONE, true).toISOString();

  const { data: run, error: runErr } = await supabaseAdmin
    .from("revenue_monthly_parse_runs")
    .insert({
      period: window.period,
      revenue_date_from: window.revenueDateFrom,
      revenue_date_to: window.revenueDateTo,
      po_received_from: window.poReceivedFrom,
      po_received_to: window.poReceivedTo,
      status: "preview_running",
      created_by: userId,
      summary: {
        receivedFrom,
        receivedTo,
        timezone: TIME_ZONE,
        monthly_parse_kind: options.monthlyParseKind || "manual_current_month_to_yesterday",
        ...(options.runSummary || {}),
      },
    })
    .select("*")
    .single();
  if (runErr) throw runErr;

  emit?.({ type: "progress", stage: "preview_run_created", runId: run.id, period: window.period, message: "Đã tạo staging run, bắt đầu parse" });

  try {
    const syncResults = options.syncGmail === false ? [] : await syncGmailInboxForPreview(req, window, emit);
    emit?.({ type: "progress", stage: "inbox_fetch_start", channel: "Mailbox", message: "Đang đọc inbox đã sync để chia theo channel" });
    const rows = await fetchInboxRows(supabaseAdmin, receivedFrom, receivedTo);
    emit?.({ type: "progress", stage: "inbox_fetch_done", channel: "Mailbox", inboxRows: rows.length, message: `Đã lấy ${rows.length} mail trong inbox, bắt đầu parse theo kênh` });
    const dispatchConfirmations = await fetchDispatchRevenueConfirmations(supabaseAdmin, rows.map((row) => row.id));
    emit?.({ type: "progress", stage: "dispatch_confirmation_fetch_done", rows: dispatchConfirmations.size, message: `Đã lấy ${dispatchConfirmations.size} xác nhận xuất kho/doanh thu` });
    const lines = buildPreviewLines(String(run.id), window.period, window.revenueDateFrom, window.revenueDateTo, rows, dispatchConfirmations, emit, {
      monthlyParseKind: options.monthlyParseKind,
      sourceTab: options.sourceTab,
      linePayloadMetadata: options.linePayloadMetadata,
    });
    const summary = {
      ...summarizeLines(lines, window),
      monthly_parse_kind: options.monthlyParseKind || "manual_current_month_to_yesterday",
      ...(options.runSummary || {}),
      gmailSync: syncResults,
    };

    emit?.({ type: "progress", stage: "staging_insert_start", rows: lines.length, message: `Đang ghi staging ${lines.length} dòng preview` });
    for (let index = 0; index < lines.length; index += 500) {
      const batch = lines.slice(index, index + 500);
      if (batch.length === 0) continue;
      const { error: insertErr } = await supabaseAdmin.from("revenue_monthly_parse_lines").insert(batch);
      if (insertErr) throw insertErr;
      emit?.({ type: "progress", stage: "staging_insert_batch", insertedRows: Math.min(index + batch.length, lines.length), rows: lines.length, message: `Đã ghi staging ${Math.min(index + batch.length, lines.length)}/${lines.length} dòng` });
    }

    const { data: updatedRun, error: updateErr } = await supabaseAdmin
      .from("revenue_monthly_parse_runs")
      .update({ status: "preview_ready", summary })
      .eq("id", run.id)
      .select("*")
      .single();
    if (updateErr) throw updateErr;

    return {
      success: true,
      run: updatedRun,
      summary,
      lines: lines.slice(0, 200),
      truncated: lines.length > 200,
    };
  } catch (error) {
    await supabaseAdmin
      .from("revenue_monthly_parse_runs")
      .delete()
      .eq("id", run.id);
    throw error;
  }
}

async function previewCurrentMonth(req: Request, supabaseAdmin: ReturnType<typeof createClient>, userId: string) {
  try {
    return jsonResponse(req, await runCurrentMonthPreview(req, supabaseAdmin, userId));
  } catch (error) {
    if (error instanceof Error && error.name === "no_parseable_revenue_window") {
      return jsonResponse(req, {
        success: false,
        code: error.name,
        message: error.message,
        window: currentMonthWindow(),
      }, 422);
    }
    throw error;
  }
}

type LedgerSummaryLine = {
  channel?: string | null;
  quantity?: number | string | null;
  gross_revenue?: number | string | null;
  review_status?: string | null;
  audit_status?: string | null;
};

const summarizeLedgerRows = (lines: LedgerSummaryLine[], fallback: JsonRecord = {}) => {
  const channels = new Map<string, { channel: string; rows: number; grossRevenue: number; quantity: number; reviewFlaggedRows: number }>();
  let grossRevenue = 0;
  let quantity = 0;
  let needsReview = 0;

  for (const line of lines) {
    const channel = String(line.channel || "Chưa phân kênh");
    const gross = Number(line.gross_revenue || 0);
    const qty = Number(line.quantity || 0);
    const reviewFlagged = line.review_status === "needs_manual_review" || line.audit_status === "needs_review";
    grossRevenue += gross;
    quantity += qty;
    if (reviewFlagged) needsReview += 1;
    const cur = channels.get(channel) || { channel, rows: 0, grossRevenue: 0, quantity: 0, reviewFlaggedRows: 0 };
    cur.rows += 1;
    cur.grossRevenue += gross;
    cur.quantity += qty;
    if (reviewFlagged) cur.reviewFlaggedRows += 1;
    channels.set(channel, cur);
  }

  return {
    rowCount: lines.length,
    lineCount: lines.length,
    grossRevenue,
    grossTotal: grossRevenue,
    quantity,
    reviewCount: needsReview,
    reviewFlaggedRows: needsReview,
    channels: Array.from(channels.values()).sort((a, b) => b.grossRevenue - a.grossRevenue),
    ...fallback,
  };
};

async function summarizeSourceDocument(supabaseAdmin: ReturnType<typeof createClient>, document: JsonRecord) {
  const sourceDocumentId = String(document.id || "");
  const summary = asRecord(document.summary);
  const { data: lines, error } = await supabaseAdmin
    .from("revenue_ledger_lines")
    .select("channel,quantity,gross_revenue,review_status,audit_status")
    .eq("source_document_id", sourceDocumentId)
    .neq("approval_status", "superseded");
  if (error) throw error;

  const ledgerSummary = summarizeLedgerRows((lines || []) as LedgerSummaryLine[]);
  const channelsFromSummary = asArray(summary.channels);
  return {
    sourceDocumentId,
    sourceName: String(document.source_name || ""),
    sourceType: String(document.source_type || ""),
    status: String(document.status || ""),
    period: String(document.period || summary.period || ""),
    importedAt: String(document.imported_at || document.created_at || ""),
    revenueDate: String(summary.revenue_date || summary.revenue_date_from || ""),
    trustSemantics: String(summary.trust_semantics || "not_trusted_month_end_audit_source"),
    temporaryControlledRevenue: summary.temporary_controlled_revenue === true,
    monthlyParseKind: String(summary.monthly_parse_kind || ""),
    noDoubleCountKey: String(summary.auto_daily_no_double_count_key || ""),
    summary: {
      rowCount: ledgerSummary.rowCount || Number(summary.row_count || summary.posted_line_count || 0),
      lineCount: ledgerSummary.lineCount || Number(summary.row_count || summary.posted_line_count || 0),
      grossRevenue: ledgerSummary.grossRevenue || Number(summary.gross_total || 0),
      grossTotal: ledgerSummary.grossTotal || Number(summary.gross_total || 0),
      quantity: ledgerSummary.quantity || Number(summary.quantity_total || 0),
      reviewCount: ledgerSummary.reviewCount || Number(summary.review_flagged_line_count || 0),
      reviewFlaggedRows: ledgerSummary.reviewFlaggedRows || Number(summary.review_flagged_line_count || 0),
      channels: ledgerSummary.channels.length ? ledgerSummary.channels : channelsFromSummary,
    },
  };
}

async function fetchLatestAutoDailyReport(supabaseAdmin: ReturnType<typeof createClient>) {
  const { data, error } = await supabaseAdmin
    .from("revenue_source_documents")
    .select("id,source_type,source_name,period,status,summary,imported_at,created_at")
    .eq("status", "controlled")
    .eq("source_type", "po_email_parse")
    .eq("summary->>monthly_parse_kind", "auto_daily_post")
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? await summarizeSourceDocument(supabaseAdmin, data as JsonRecord) : null;
}

async function fetchExistingAutoDailyReport(supabaseAdmin: ReturnType<typeof createClient>, revenueDate: string) {
  const { data, error } = await supabaseAdmin
    .from("revenue_source_documents")
    .select("id,source_type,source_name,period,status,summary,imported_at,created_at")
    .eq("status", "controlled")
    .eq("source_type", "po_email_parse")
    .eq("summary->>monthly_parse_kind", "auto_daily_post")
    .eq("summary->>revenue_date", revenueDate)
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? await summarizeSourceDocument(supabaseAdmin, data as JsonRecord) : null;
}

const normalizeSummaryForCompare = (summary: JsonRecord = {}) => ({
  rowCount: Number(summary.rowCount || summary.row_count || summary.postedRows || summary.posted_rows || summary.ledgerRows || 0),
  lineCount: Number(summary.lineCount || summary.rowCount || summary.row_count || summary.ledgerRows || 0),
  grossRevenue: Number(summary.grossRevenue || summary.gross_total || summary.dashboardGrossRevenue || 0),
  quantity: Number(summary.quantity || summary.quantity_total || 0),
  reviewCount: Number(summary.reviewCount || summary.reviewFlaggedRows || summary.review_flagged_line_count || summary.needsReview || 0),
  channels: asArray(summary.channels).map((item) => {
    const row = asRecord(item);
    return {
      channel: String(row.channel || "Chưa phân kênh"),
      rows: Number(row.rows || row.rowCount || 0),
      grossRevenue: Number(row.grossRevenue || row.gross_revenue || 0),
      quantity: Number(row.quantity || 0),
      reviewFlaggedRows: Number(row.reviewFlaggedRows || row.review_flagged_rows || 0),
    };
  }),
});

const compareDailySummaries = (currentSummary: JsonRecord | null, previewSummary: JsonRecord) => {
  const current = normalizeSummaryForCompare(currentSummary || {});
  const preview = normalizeSummaryForCompare(previewSummary);
  const currentChannels = new Map(current.channels.map((channel) => [channel.channel, channel]));
  const previewChannels = new Map(preview.channels.map((channel) => [channel.channel, channel]));
  const channelNames = Array.from(new Set([...currentChannels.keys(), ...previewChannels.keys()])).sort((a, b) => a.localeCompare(b, "vi"));
  return {
    totals: {
      current,
      preview,
      delta: {
        lineCount: preview.lineCount - current.lineCount,
        grossRevenue: preview.grossRevenue - current.grossRevenue,
        quantity: preview.quantity - current.quantity,
        reviewCount: preview.reviewCount - current.reviewCount,
      },
    },
    channels: channelNames.map((channel) => {
      const before = currentChannels.get(channel) || { channel, rows: 0, grossRevenue: 0, quantity: 0, reviewFlaggedRows: 0 };
      const after = previewChannels.get(channel) || { channel, rows: 0, grossRevenue: 0, quantity: 0, reviewFlaggedRows: 0 };
      return {
        channel,
        current: before,
        preview: after,
        delta: {
          rows: after.rows - before.rows,
          grossRevenue: after.grossRevenue - before.grossRevenue,
          quantity: after.quantity - before.quantity,
          reviewFlaggedRows: after.reviewFlaggedRows - before.reviewFlaggedRows,
        },
      };
    }),
  };
};

async function previewDailyCompare(req: Request, supabaseAdmin: ReturnType<typeof createClient>, userId: string, body: JsonRecord) {
  const requestedRevenueDate = Object.prototype.hasOwnProperty.call(body, "revenueDate") ? strictIsoDate(body.revenueDate) : null;
  if (Object.prototype.hasOwnProperty.call(body, "revenueDate") && !requestedRevenueDate) {
    return jsonResponse(req, { success: false, error: "Invalid revenueDate. Expected a real date in YYYY-MM-DD format." }, 400);
  }
  const window = explicitRevenueDateWindow(requestedRevenueDate || autoDailyWindow().revenueDateFrom);
  const noDoubleCountKey = `auto_daily_po_email_parse:${window.revenueDateFrom}`;
  const preview = await runCurrentMonthPreview(req, supabaseAdmin, userId, undefined, {
    window,
    syncGmail: true,
    monthlyParseKind: "auto_daily_post",
    sourceTab: "PO/email auto daily parse",
    runSummary: {
      triggered_by: "owner_chat_daily_preview_compare",
      controlled_kind: "auto_daily_temporary_controlled_parse",
      temporary_controlled_revenue: true,
      trust_semantics: "not_trusted_month_end_audit_source",
      auto_daily_no_double_count_key: noDoubleCountKey,
      noDoubleCountKey,
      revenue_date_source: requestedRevenueDate ? "explicit" : "auto_daily_window",
      explicit_revenue_date: requestedRevenueDate,
      chat_safe_preview_compare: true,
    },
    linePayloadMetadata: {
      controlled_kind: "auto_daily_temporary_controlled_parse",
      temporary_controlled_revenue: true,
      trust_semantics: "not_trusted_month_end_audit_source",
      owner_approval_required: false,
      auto_daily_no_double_count_key: noDoubleCountKey,
      noDoubleCountKey,
      revenue_date_source: requestedRevenueDate ? "explicit" : "auto_daily_window",
      explicit_revenue_date: requestedRevenueDate,
      chat_safe_preview_compare: true,
    },
  });
  const existingReport = await fetchExistingAutoDailyReport(supabaseAdmin, window.revenueDateFrom);
  return jsonResponse(req, {
    success: true,
    action: "preview_daily_compare",
    revenueDate: window.revenueDateFrom,
    period: window.period,
    runId: String(asRecord(preview.run).id || ""),
    existingReport,
    previewSummary: preview.summary,
    comparison: compareDailySummaries(existingReport ? asRecord(asRecord(existingReport).summary) : null, asRecord(preview.summary)),
  });
}

function requireRevenueCronSecret(req: Request, corsHeaders: Record<string, string>) {
  const envKey = Deno.env.get(REVENUE_CRON_SECRET_ENV_KEY)
    ? REVENUE_CRON_SECRET_ENV_KEY
    : LEGACY_PO_CRON_SECRET_ENV_KEY;
  requireCronSecret(req, envKey, corsHeaders);
}

async function upsertAutoDailyParseLog(
  supabaseAdmin: ReturnType<typeof createClient>,
  payload: {
    revenueDate: string;
    period: string;
    status: "started" | "success" | "failed";
    scheduledForVn?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    runId?: string | null;
    sourceDocumentId?: string | null;
    poReceivedFrom?: string | null;
    poReceivedTo?: string | null;
    rowCount?: number;
    grossTotal?: number;
    reviewFlaggedLineCount?: number;
    errorMessage?: string | null;
    metadata?: JsonRecord;
  },
) {
  const { error } = await supabaseAdmin.rpc("upsert_revenue_auto_daily_parse_log", {
    _revenue_date: payload.revenueDate,
    _period: payload.period,
    _status: payload.status,
    _scheduled_for_vn: payload.scheduledForVn || "23:59",
    _started_at: payload.startedAt || null,
    _finished_at: payload.finishedAt || null,
    _run_id: payload.runId || null,
    _source_document_id: payload.sourceDocumentId || null,
    _po_received_from: payload.poReceivedFrom || null,
    _po_received_to: payload.poReceivedTo || null,
    _row_count: Math.max(0, Math.trunc(Number(payload.rowCount || 0))),
    _gross_total: Number(payload.grossTotal || 0),
    _review_flagged_line_count: Math.max(0, Math.trunc(Number(payload.reviewFlaggedLineCount || 0))),
    _error_message: payload.errorMessage || null,
    _metadata: payload.metadata || {},
  });
  if (error) throw error;
}

async function autoDailyPost(req: Request, supabaseAdmin: ReturnType<typeof createClient>, body: JsonRecord = {}) {
  const hasExplicitRevenueDate = Object.prototype.hasOwnProperty.call(body, "revenueDate");
  const explicitRevenueDate = hasExplicitRevenueDate ? strictIsoDate(body.revenueDate) : null;
  if (hasExplicitRevenueDate && !explicitRevenueDate) {
    return jsonResponse(req, {
      success: false,
      error: "Invalid revenueDate. Expected a real date in YYYY-MM-DD format.",
    }, 400);
  }

  const window = explicitRevenueDate ? explicitRevenueDateWindow(explicitRevenueDate) : autoDailyWindow();
  const noDoubleCountKey = `auto_daily_po_email_parse:${window.revenueDateFrom}`;
  const trigger = String(body?.trigger || "vercel_cron");
  const cronScheduledAttempt = body?.cronScheduledAttempt === true || trigger === "vercel_cron";
  const revenueDateSource = explicitRevenueDate
    ? (cronScheduledAttempt ? "scheduled_cron_proxy" : "explicit")
    : "auto_daily_window";
  const manualRecovery = Boolean(explicitRevenueDate) && !cronScheduledAttempt;
  const startedAt = new Date().toISOString();
  let runId: string | null = null;

  try {
    if (cronScheduledAttempt) {
      const existingReport = await fetchExistingAutoDailyReport(supabaseAdmin, window.revenueDateFrom);
      if (existingReport) {
        return jsonResponse(req, {
          success: true,
          action: "auto_daily_post",
          skipped: true,
          reason: "auto_daily_already_posted_for_revenue_date",
          revenueDate: window.revenueDateFrom,
          revenueDateSource,
          cronScheduledAttempt,
          manualRecovery,
          noDoubleCountKey,
          poReceivedFrom: window.poReceivedFrom,
          poReceivedTo: window.poReceivedTo,
          existingReport,
        });
      }
    }

    await upsertAutoDailyParseLog(supabaseAdmin, {
      revenueDate: window.revenueDateFrom,
      period: window.period,
      status: "started",
      startedAt,
      poReceivedFrom: window.poReceivedFrom,
      poReceivedTo: window.poReceivedTo,
      metadata: { revenueDateSource, manualRecovery, cronScheduledAttempt, noDoubleCountKey, trigger },
    });

    const preview = await runCurrentMonthPreview(req, supabaseAdmin, null, undefined, {
      window,
      syncGmail: true,
      monthlyParseKind: "auto_daily_post",
      sourceTab: "PO/email auto daily parse",
      runSummary: {
        triggered_by: trigger,
        controlled_kind: "auto_daily_temporary_controlled_parse",
        temporary_controlled_revenue: true,
        trust_semantics: "not_trusted_month_end_audit_source",
        auto_daily_no_double_count_key: noDoubleCountKey,
        noDoubleCountKey,
        revenue_date_source: revenueDateSource,
        explicit_revenue_date: explicitRevenueDate,
        manual_recovery: manualRecovery,
        cron_scheduled_attempt: cronScheduledAttempt,
      },
      linePayloadMetadata: {
        controlled_kind: "auto_daily_temporary_controlled_parse",
        temporary_controlled_revenue: true,
        trust_semantics: "not_trusted_month_end_audit_source",
        owner_approval_required: false,
        auto_daily_no_double_count_key: noDoubleCountKey,
        noDoubleCountKey,
        revenue_date_source: revenueDateSource,
        explicit_revenue_date: explicitRevenueDate,
        manual_recovery: manualRecovery,
        cron_scheduled_attempt: cronScheduledAttempt,
      },
    });

    runId = String(asRecord(preview.run).id || "") || null;
    const { data, error } = await supabaseAdmin.rpc("auto_post_revenue_daily_parse", {
      _run_id: String(asRecord(preview.run).id || ""),
    });
    if (error) throw error;

    const postResult = asRecord(data);
    const postSummary = asRecord(postResult.summary);
    const previewSummary = asRecord(preview.summary);
    const sourceDocumentId = String(postResult.sourceDocumentId || "") || null;
    const rowCount = Number(postSummary.posted_line_count || postSummary.row_count || previewSummary.ledgerRows || previewSummary.rows || 0);
    const grossTotal = Number(postSummary.gross_total || previewSummary.dashboardGrossRevenue || previewSummary.grossRevenue || 0);
    const reviewFlaggedLineCount = Number(postSummary.review_flagged_line_count || previewSummary.reviewFlaggedRows || previewSummary.needsReview || 0);
    const gmailSyncSummary = asArray(previewSummary.gmailSync);

    await upsertAutoDailyParseLog(supabaseAdmin, {
      revenueDate: window.revenueDateFrom,
      period: window.period,
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      runId,
      sourceDocumentId,
      poReceivedFrom: window.poReceivedFrom,
      poReceivedTo: window.poReceivedTo,
      rowCount,
      grossTotal,
      reviewFlaggedLineCount,
      metadata: { revenueDateSource, manualRecovery, cronScheduledAttempt, noDoubleCountKey, gmailSyncSummary, postResult },
    });

    return jsonResponse(req, {
      success: true,
      action: "auto_daily_post",
      revenueDate: window.revenueDateFrom,
      revenueDateSource,
      cronScheduledAttempt,
      explicitRevenueDate: explicitRevenueDate,
      manualRecovery,
      noDoubleCountKey,
      poReceivedFrom: window.poReceivedFrom,
      poReceivedTo: window.poReceivedTo,
      stagingRunId: String(asRecord(preview.run).id || ""),
      previewSummary: preview.summary,
      postResult: data,
    });
  } catch (error) {
    const message = errorMessage(error);
    await upsertAutoDailyParseLog(supabaseAdmin, {
      revenueDate: window.revenueDateFrom,
      period: window.period,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      runId,
      poReceivedFrom: window.poReceivedFrom,
      poReceivedTo: window.poReceivedTo,
      errorMessage: message,
      metadata: { revenueDateSource, manualRecovery, cronScheduledAttempt, noDoubleCountKey },
    });
    throw error;
  }
}

function streamCurrentMonthPreview(req: Request, supabaseAdmin: ReturnType<typeof createClient>, userId: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: JsonRecord) => {
        controller.enqueue(encoder.encode(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`));
      };

      try {
        send({ type: "progress", stage: "start", message: "Bắt đầu parse PO/email" });
        const result = await runCurrentMonthPreview(req, supabaseAdmin, userId, send);
        send({ type: "done", stage: "preview_ready", ...result });
      } catch (error) {
        const message = errorMessage(error);
        send({ type: "error", stage: "error", error: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...getCorsHeaders(req),
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const corsHeaders = getCorsHeaders(req);
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "preview_current_month");

    if (action === "auto_daily_post") {
      requireRevenueCronSecret(req, corsHeaders);
      return await autoDailyPost(req, supabaseAdmin, body);
    }

    const { user } = await requireAuth(req, corsHeaders);

    if (action === "latest_auto_daily_report") {
      await ensureRevenueViewer(supabaseAdmin, user.id);
      return jsonResponse(req, {
        success: true,
        action: "latest_auto_daily_report",
        report: await fetchLatestAutoDailyReport(supabaseAdmin),
      });
    }

    await ensureOwner(supabaseAdmin, user.id);

    if (action === "preview_current_month") {
      if (body?.streamProgress) {
        return streamCurrentMonthPreview(req, supabaseAdmin, user.id);
      }
      return await previewCurrentMonth(req, supabaseAdmin, user.id);
    }


    if (action === "preview_daily_compare") {
      return await previewDailyCompare(req, supabaseAdmin, user.id, body);
    }

    if (action === "confirm_daily_overwrite" || action === "confirm_daily_post") {
      const runId = String(body?.runId || "");
      if (!runId) return jsonResponse(req, { error: "Missing runId" }, 400);
      const { data: run, error: runError } = await supabaseAdmin
        .from("revenue_monthly_parse_runs")
        .select("id,status,revenue_date_from,revenue_date_to,summary")
        .eq("id", runId)
        .maybeSingle();
      if (runError) throw runError;
      const runSummary = asRecord((run as JsonRecord | null)?.summary);
      if (
        !run ||
        run.status !== "preview_ready" ||
        run.revenue_date_from !== run.revenue_date_to ||
        runSummary.monthly_parse_kind !== "auto_daily_post" ||
        runSummary.chat_safe_preview_compare !== true
      ) {
        return jsonResponse(req, { error: "Invalid daily preview run for confirm." }, 400);
      }
      const { data, error } = await supabaseAdmin.rpc("auto_post_revenue_daily_parse", { _run_id: runId });
      if (error) throw error;
      return jsonResponse(req, {
        success: true,
        action,
        postResult: data,
      });
    }

    if (action === "cancel_daily_preview") {
      const runId = String(body?.runId || "");
      if (!runId) return jsonResponse(req, { error: "Missing runId" }, 400);
      const { data, error } = await supabaseAdmin.rpc("reject_revenue_monthly_parse", { _run_id: runId, _actor_id: user.id });
      if (error) throw error;
      return jsonResponse(req, data);
    }

    if (action === "approve_preview") {
      const runId = String(body?.runId || "");
      if (!runId) return jsonResponse(req, { error: "Missing runId" }, 400);
      const { data, error } = await supabaseAdmin.rpc("approve_revenue_monthly_parse", {
        _run_id: runId,
        _overwrite: Boolean(body?.overwrite),
        _actor_id: user.id,
      });
      if (error) throw error;
      const result = asRecord(data);
      const status = result.requiresOverwriteConfirmation ? 409 : 200;
      return jsonResponse(req, result, status);
    }

    if (action === "reject_preview") {
      const runId = String(body?.runId || "");
      if (!runId) return jsonResponse(req, { error: "Missing runId" }, 400);
      const { data, error } = await supabaseAdmin.rpc("reject_revenue_monthly_parse", { _run_id: runId, _actor_id: user.id });
      if (error) throw error;
      return jsonResponse(req, data);
    }

    return jsonResponse(req, { error: `Unsupported action: ${action}` }, 400);
  } catch (error) {
    if (error instanceof Response) return error;
    const message = errorMessage(error);
    const status = message.startsWith("Forbidden:") ? 403 : 500;
    return jsonResponse(req, { error: message }, status);
  }
});
