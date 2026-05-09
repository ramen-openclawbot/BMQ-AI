import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";

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

const TIME_ZONE = "Asia/Ho_Chi_Minh";
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

const currentMonthWindow = (now = new Date()) => {
  const current = getDatePartsInTimeZone(now, TIME_ZONE);
  const period = `${current.year}-${String(current.month).padStart(2, "0")}`;
  const revenueDateFrom = `${period}-01`;
  const revenueDateTo = shiftLocalDate(current.date, -1);
  const poReceivedFrom = shiftLocalDate(revenueDateFrom, -1);
  const poReceivedTo = shiftLocalDate(revenueDateTo, -1);
  const hasRevenueWindow = Date.parse(`${revenueDateTo}T00:00:00Z`) >= Date.parse(`${revenueDateFrom}T00:00:00Z`);
  return { period, revenueDateFrom, revenueDateTo, poReceivedFrom, poReceivedTo, hasRevenueWindow };
};

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
  const quantity = numberValue(item.quantity, item.qty, item.ordered_qty, item.count);
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

const buildPreviewLines = (runId: string, period: string, revenueFrom: string, revenueTo: string, rows: InboxRow[]) => {
  const lines: PreviewLine[] = [];
  let sourceRowNumber = 1;

  for (const row of rows) {
    const poReceivedDate = localDateFromTimestamp(row.received_at);
    if (!poReceivedDate) continue;
    const revenueDate = shiftLocalDate(poReceivedDate, 1);
    if (revenueDate < revenueFrom || revenueDate > revenueTo) continue;

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

    for (const item of effectiveItems) {
      const line = lineFromItem(item, effectiveItems.length === 1 ? fallbackAmount : 0);
      const customerName = stringValue(
        item.customer_name,
        item.route_name,
        row.mini_crm_customers?.customer_name,
        raw.customer_name,
        row.email_subject,
      ) || "Chưa xác định customer";
      const gross = Number(line.gross || 0);
      lines.push({
        run_id: runId,
        source_row_number: sourceRowNumber,
        revenue_date: revenueDate,
        po_received_date: poReceivedDate,
        period,
        channel: stringValue(row.revenue_channel, raw.revenue_channel, row.mini_crm_customers?.product_group) || "po_email",
        source_tab: "PO/email monthly parse",
        branch: stringValue(raw.branch, item.branch),
        invoice_no: stringValue(row.po_number, raw.po_number, extractPoNumberFromSubject(row.email_subject)),
        customer_id: row.matched_customer_id || null,
        parent_customer_id: stringValue(row.mini_crm_customers?.supplied_by_npp_customer_id),
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
          date_mapping: "po_received_local_date_plus_1_day",
          automation_status: automationStatus || null,
          automation_rule: poAutomation.rule || null,
          monthly_parse_kind: "manual_current_month_to_yesterday",
          trust_semantics: "not_trusted_month_end_audit_source",
        },
      });
      sourceRowNumber += 1;
    }
  }

  return lines;
};

const summarizeLines = (lines: PreviewLine[], window: ReturnType<typeof currentMonthWindow>) => {
  const customers = new Set(lines.map((line) => line.customer_id || line.customer_name));
  const channels = new Map<string, { channel: string; rows: number; grossRevenue: number; quantity: number }>();
  let grossRevenue = 0;
  let quantity = 0;
  let needsReview = 0;

  for (const line of lines) {
    grossRevenue += Number(line.gross_revenue || 0);
    quantity += Number(line.quantity || 0);
    if (line.review_status === "needs_manual_review") needsReview += 1;
    const cur = channels.get(line.channel) || { channel: line.channel, rows: 0, grossRevenue: 0, quantity: 0 };
    cur.rows += 1;
    cur.grossRevenue += Number(line.gross_revenue || 0);
    cur.quantity += Number(line.quantity || 0);
    channels.set(line.channel, cur);
  }

  return {
    period: window.period,
    revenueDateFrom: window.revenueDateFrom,
    revenueDateTo: window.revenueDateTo,
    poReceivedFrom: window.poReceivedFrom,
    poReceivedTo: window.poReceivedTo,
    rows: lines.length,
    grossRevenue,
    quantity,
    customers: customers.size,
    needsReview,
    channels: Array.from(channels.values()).sort((a, b) => b.grossRevenue - a.grossRevenue),
  };
};

async function previewCurrentMonth(req: Request, supabaseAdmin: ReturnType<typeof createClient>, userId: string) {
  const window = currentMonthWindow();
  if (!window.hasRevenueWindow) {
    return jsonResponse(req, {
      success: false,
      code: "no_parseable_revenue_window",
      message: "Chưa có ngày doanh thu trong tháng hiện tại để parse. Hãy chạy từ ngày 02 trở đi.",
      window,
    }, 422);
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
      summary: { receivedFrom, receivedTo, timezone: TIME_ZONE },
    })
    .select("*")
    .single();
  if (runErr) throw runErr;

  try {
    const rows = await fetchInboxRows(supabaseAdmin, receivedFrom, receivedTo);
    const lines = buildPreviewLines(String(run.id), window.period, window.revenueDateFrom, window.revenueDateTo, rows);
    const summary = summarizeLines(lines, window);

    for (let index = 0; index < lines.length; index += 500) {
      const batch = lines.slice(index, index + 500);
      if (batch.length === 0) continue;
      const { error: insertErr } = await supabaseAdmin.from("revenue_monthly_parse_lines").insert(batch);
      if (insertErr) throw insertErr;
    }

    const { data: updatedRun, error: updateErr } = await supabaseAdmin
      .from("revenue_monthly_parse_runs")
      .update({ status: "preview_ready", summary })
      .eq("id", run.id)
      .select("*")
      .single();
    if (updateErr) throw updateErr;

    return jsonResponse(req, {
      success: true,
      run: updatedRun,
      summary,
      lines: lines.slice(0, 200),
      truncated: lines.length > 200,
    });
  } catch (error) {
    await supabaseAdmin
      .from("revenue_monthly_parse_runs")
      .delete()
      .eq("id", run.id);
    throw error;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const corsHeaders = getCorsHeaders(req);
    const { user } = await requireAuth(req, corsHeaders);
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    await ensureOwner(supabaseAdmin, user.id);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "preview_current_month");

    if (action === "preview_current_month") {
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
