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
  const poReceivedTo = current.date;
  return { period, revenueDateFrom, revenueDateTo, poReceivedFrom, poReceivedTo, hasRevenueWindow: true };
};

const explicitRevenueDateWindow = (revenueDate: string) => ({
  period: revenueDate.slice(0, 7),
  revenueDateFrom: revenueDate,
  revenueDateTo: revenueDate,
  poReceivedFrom: shiftLocalDate(revenueDate, -1),
  poReceivedTo: revenueDate,
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

async function ensureOwner(supabaseAdmin: ReturnType<typeof createClient>, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) throw error;
  const roles = (data || []).map((row: { role: string }) => row.role);
  if (!roles.includes("owner")) throw new Error("Forbidden: owner role required for monthly parse");
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

    for (const item of effectiveItems) {
      const revenueDate = lineRevenueDate(row, item, poReceivedDate);
      if (!revenueDate || revenueDate < revenueFrom || revenueDate > revenueTo) continue;
      const line = lineFromItem(item, effectiveItems.length === 1 ? fallbackAmount : 0);
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
      const gross = Number(line.gross || 0);
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
        quantity: Number(line.quantity || 0),
        unit_price: Number(line.unit || 0),
        gross_revenue: gross,
        source_type: "po_email_parse",
        source_ref: row.id,
        confidence_status: needsReview ? "manual_review" : "matched",
        reconciliation_status: "not_reconciled",
        review_status: needsReview ? "needs_manual_review" : "not_required",
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
    const lines = buildPreviewLines(String(run.id), window.period, window.revenueDateFrom, window.revenueDateTo, rows, emit, {
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

function requireRevenueCronSecret(req: Request, corsHeaders: Record<string, string>) {
  const envKey = Deno.env.get(REVENUE_CRON_SECRET_ENV_KEY)
    ? REVENUE_CRON_SECRET_ENV_KEY
    : LEGACY_PO_CRON_SECRET_ENV_KEY;
  requireCronSecret(req, envKey, corsHeaders);
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
  const revenueDateSource = explicitRevenueDate ? "explicit" : "auto_daily_window";
  const manualRecovery = Boolean(explicitRevenueDate);
  const preview = await runCurrentMonthPreview(req, supabaseAdmin, null, undefined, {
    window,
    syncGmail: true,
    monthlyParseKind: "auto_daily_post",
    sourceTab: "PO/email auto daily parse",
    runSummary: {
      triggered_by: "vercel_cron",
      controlled_kind: "auto_daily_temporary_controlled_parse",
      temporary_controlled_revenue: true,
      trust_semantics: "not_trusted_month_end_audit_source",
      auto_daily_no_double_count_key: noDoubleCountKey,
      noDoubleCountKey,
      revenue_date_source: revenueDateSource,
      explicit_revenue_date: explicitRevenueDate,
      manual_recovery: manualRecovery,
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
    },
  });

  const { data, error } = await supabaseAdmin.rpc("auto_post_revenue_daily_parse", {
    _run_id: String(asRecord(preview.run).id || ""),
  });
  if (error) throw error;

  return jsonResponse(req, {
    success: true,
    action: "auto_daily_post",
    revenueDate: window.revenueDateFrom,
    revenueDateSource,
    explicitRevenueDate: explicitRevenueDate,
    manualRecovery,
    noDoubleCountKey,
    poReceivedFrom: window.poReceivedFrom,
    poReceivedTo: window.poReceivedTo,
    stagingRunId: String(asRecord(preview.run).id || ""),
    previewSummary: preview.summary,
    postResult: data,
  });
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
        const message = error instanceof Error ? error.message : "Unknown error";
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
    await ensureOwner(supabaseAdmin, user.id);

    if (action === "preview_current_month") {
      if (body?.streamProgress) {
        return streamCurrentMonthPreview(req, supabaseAdmin, user.id);
      }
      return await previewCurrentMonth(req, supabaseAdmin, user.id);
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
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Forbidden:") ? 403 : 500;
    return jsonResponse(req, { error: message }, status);
  }
});
