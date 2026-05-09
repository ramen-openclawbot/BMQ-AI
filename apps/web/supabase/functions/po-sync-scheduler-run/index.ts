import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireAuth, requireCronSecret } from "../_shared/auth.ts";

type ScheduleScopeMode = "all_root_customers" | "single_customer" | "tier1_only";

type ScheduleRow = {
  id: string;
  config_key: string;
  customer_id: string | null;
  is_enabled: boolean;
  scope_mode: ScheduleScopeMode;
  schedule_mode: "daily";
  run_hour_local: string;
  timezone: string;
  lookback_days: number;
  notes: string | null;
  last_job_id: string | null;
  last_run_at: string | null;
};

type ManualDateRange = {
  dateFrom: string;
  dateTo: string;
};

type InboxRow = {
  id: string;
  matched_customer_id: string | null;
  po_number?: string | null;
  email_subject: string | null;
  delivery_date: string | null;
  subtotal_amount: number | null;
  vat_amount: number | null;
  total_amount: number | null;
  revenue_channel: string | null;
  production_items: unknown[] | null;
  raw_payload: Record<string, any> | null;
  mini_crm_customers?: {
    id?: string | null;
    customer_name?: string | null;
    product_group?: string | null;
    is_tier1?: boolean | null;
  } | null;
};

const jsonResponse = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });

const normalizeChannel = (ch?: string | null) => {
  const key = String(ch || "").trim();
  return key === "wholesale_kfm" ? "cake_kingfoodmart" : key;
};

const inferProductGroupFromRow = (row: InboxRow): string => {
  const direct = String(row?.mini_crm_customers?.product_group || "").trim();
  if (direct === "banhngot") return "banhngot";
  const channel = normalizeChannel(row?.revenue_channel);
  if (channel.startsWith("cake_") || channel === "wholesale_kfm") return "banhngot";
  return "banhmi";
};

const calcAmountFromRow = (row: InboxRow): number => {
  const posted = Number(row?.raw_payload?.revenue_post?.total || row?.raw_payload?.revenue_post?.amount || 0);
  if (posted > 0) return posted;
  const direct = Number(row?.total_amount || row?.subtotal_amount || 0);
  if (direct > 0) return direct;
  const items = Array.isArray(row?.raw_payload?.parsed_items_preview) ? row?.raw_payload?.parsed_items_preview : [];
  return items.reduce((sum: number, item: any) => sum + Number(item?.line_total || item?.amount || 0), 0);
};

const extractPoNumberFromSubject = (subject?: string | null) => {
  const raw = String(subject || "");
  const match = raw.match(/PO\s*([0-9]{6,})/i) || raw.match(/\b(PO[0-9]{6,})\b/i);
  if (!match) return null;
  return match[1].toUpperCase().startsWith("PO") ? match[1].toUpperCase() : `PO${match[1]}`;
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
    hour: Number(map.hour || 0),
    minute: Number(map.minute || 0),
  };
};

const parseLocalRunTime = (value?: string | null) => {
  const match = String(value || "23:59").trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return { hour: 23, minute: 59 };
  const hour = Math.min(Math.max(Number(match[1] || 0), 0), 23);
  const minute = Math.min(Math.max(Number(match[2] || 0), 0), 59);
  return { hour, minute };
};

const isCronRunDue = (schedule: ScheduleRow, now = new Date()) => {
  const timeZone = schedule.timezone || "Asia/Ho_Chi_Minh";
  const scheduled = parseLocalRunTime(schedule.run_hour_local);
  const current = getDatePartsInTimeZone(now, timeZone);
  if (current.hour !== scheduled.hour || current.minute !== scheduled.minute) {
    return {
      due: false,
      reason: `Outside scheduled minute (${schedule.run_hour_local || "23:59"} ${timeZone})`,
    };
  }

  if (schedule.last_run_at) {
    const lastRun = getDatePartsInTimeZone(new Date(schedule.last_run_at), timeZone);
    if (lastRun.date === current.date) {
      return {
        due: false,
        reason: `Already ran for ${current.date} (${timeZone})`,
      };
    }
  }

  return { due: true };
};

const timeZoneOffsetMinutes = (timeZone: string) => {
  // The production automation is currently scheduled in Vietnam time. Keep this
  // explicit so received_at windows line up with local business days instead of
  // UTC calendar days at the 23:59 ICT cron tick.
  if (timeZone === "Asia/Ho_Chi_Minh") return 7 * 60;
  return 0;
};

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

const isIsoLocalDate = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => Number(part));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};

const localDateRangeDaysInclusive = (dateFrom: string, dateTo: string) => {
  const fromMs = Date.parse(`${dateFrom}T00:00:00Z`);
  const toMs = Date.parse(`${dateTo}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return Number.NaN;
  return Math.floor((toMs - fromMs) / 86_400_000) + 1;
};

const buildDateRange = (lookbackDays: number, timeZone = "Asia/Ho_Chi_Minh", now = new Date()) => {
  const current = getDatePartsInTimeZone(now, timeZone);
  const endLocalDate = current.date;
  const startLocalDate = shiftLocalDate(endLocalDate, -Math.max(0, lookbackDays - 1));
  const receivedFrom = dateFromLocalParts(startLocalDate, timeZone).toISOString();
  const receivedTo = dateFromLocalParts(endLocalDate, timeZone, true).toISOString();
  return {
    dateFrom: startLocalDate,
    dateTo: endLocalDate,
    receivedFrom,
    receivedTo,
  };
};

const buildExplicitDateRange = (dateFrom: string, dateTo: string, timeZone = "Asia/Ho_Chi_Minh") => ({
  dateFrom,
  dateTo,
  receivedFrom: dateFromLocalParts(dateFrom, timeZone).toISOString(),
  receivedTo: dateFromLocalParts(dateTo, timeZone, true).toISOString(),
});

async function ensureAuthorized(supabaseAdmin: any, userId: string) {
  const { data: roleRows, error: roleErr } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);

  if (roleErr) throw roleErr;

  const roles = (roleRows || []).map((row: { role: string }) => row.role);
  if (roles.includes("owner")) {
    return;
  }

  throw new Error("Forbidden: owner role required for manual run now");
}

const AUTOMATION_LOCK_KEY = "po_sync_scheduler_default";
const CRON_TRIGGERED_BY = "vercel-cron";
const CRON_SECRET_ENV_KEY = "PO_SYNC_CRON_SECRET";
const THUY_DIRECT_DEALER_SENDER = "thuy@bmq.vn";
const AUTOMATION_REVIEW_STATUSES = [
  "cancel_signal",
  "pdf_only_needs_review",
  "parse_failed_needs_review",
  "parsed_needs_review",
  "needs_manual_review",
  "po_evidence_only",
  "manual_trusted_ledger_only",
  "line_level_manual_revenue_ready",
  "superseded_duplicate_needs_review",
] as const;

type RequestContext = {
  triggeredBy: string;
  ignoreDisabled: boolean;
  manualDateRange?: ManualDateRange;
};

async function resolveRequestContext(req: Request): Promise<RequestContext> {
  const corsHeaders = getCorsHeaders(req);
  const body = await req.json().catch(() => ({}));
  const hasCronSecret = Boolean(req.headers.get("x-cron-secret"));

  if (hasCronSecret) {
    requireCronSecret(req, CRON_SECRET_ENV_KEY, corsHeaders);
    return {
      triggeredBy: CRON_TRIGGERED_BY,
      ignoreDisabled: false,
    };
  }

  const { user } = await requireAuth(req, corsHeaders);
  const rawDateFrom = body?.dateFrom ?? body?.startDate;
  const rawDateTo = body?.dateTo ?? body?.endDate;
  const isManualRangeMode = body?.mode === "manual_range" || rawDateFrom || rawDateTo;

  let manualDateRange: ManualDateRange | undefined;
  if (isManualRangeMode) {
    if (!isIsoLocalDate(rawDateFrom) || !isIsoLocalDate(rawDateTo)) {
      throw new Error("Invalid manual date range: dateFrom and dateTo must use YYYY-MM-DD");
    }
    const days = localDateRangeDaysInclusive(rawDateFrom, rawDateTo);
    if (!Number.isFinite(days) || days < 1) {
      throw new Error("Invalid manual date range: dateFrom must be before or equal to dateTo");
    }
    if (days > 31) {
      throw new Error("Invalid manual date range: maximum range is 31 days");
    }
    manualDateRange = { dateFrom: rawDateFrom, dateTo: rawDateTo };
  }

  return {
    triggeredBy: user?.id || "manual",
    ignoreDisabled: Boolean(body?.ignoreDisabled),
    manualDateRange,
  };
}

async function acquireAutomationLock(supabaseAdmin: any, triggeredBy: string) {
  const { data, error } = await supabaseAdmin
    .from("po_sync_runtime_locks")
    .insert({ lock_key: AUTOMATION_LOCK_KEY, locked_by: triggeredBy, locked_at: new Date().toISOString() })
    .select("lock_key")
    .maybeSingle();

  if (error) {
    if (String(error.code || "") === "23505") return false;
    throw error;
  }
  return Boolean(data?.lock_key);
}

async function releaseAutomationLock(supabaseAdmin: any) {
  const { error } = await supabaseAdmin
    .from("po_sync_runtime_locks")
    .delete()
    .eq("lock_key", AUTOMATION_LOCK_KEY);
  if (error) throw error;
}

async function fetchScopedCustomerIds(supabaseAdmin: any, scopeMode: ScheduleScopeMode, customerId: string | null) {
  if (scopeMode === "single_customer") {
    if (!customerId) throw new Error("Schedule scope single_customer requires customer_id");
    return [customerId];
  }

  const pageSize = 1000;
  const ids: string[] = [];
  let offset = 0;

  while (true) {
    let query = supabaseAdmin
      .from("mini_crm_customers")
      .select("id")
      .eq("is_active", true)
      .range(offset, offset + pageSize - 1);

    if (scopeMode === "tier1_only") query = query.eq("is_tier1", true);
    if (scopeMode === "all_root_customers") query = query.is("supplied_by_npp_customer_id", null);

    const { data, error } = await query;
    if (error) throw error;

    const batch = (data || []).map((row: { id: string }) => row.id).filter(Boolean);
    ids.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  return ids;
}

async function fetchInboxRows(supabaseAdmin: any, receivedFrom: string, receivedTo: string, scopedCustomerIds: string[]) {
  const pageSize = 1000;
  const rowsById = new Map<string, InboxRow>();

  const fetchPages = async (applyScope: (query: any) => any) => {
    let offset = 0;
    while (true) {
      const query = applyScope(
        supabaseAdmin
          .from("customer_po_inbox")
          .select("*, mini_crm_customers(id, customer_name, product_group, is_tier1)")
          .gte("received_at", receivedFrom)
          .lte("received_at", receivedTo),
      )
        .order("received_at", { ascending: false })
        .range(offset, offset + pageSize - 1);

      const { data, error } = await query;
      if (error) throw error;

      const batch = (data || []) as InboxRow[];
      for (const row of batch) rowsById.set(row.id, row);
      if (batch.length < pageSize) break;
      offset += pageSize;
    }
  };

  if (scopedCustomerIds.length > 0) {
    await fetchPages((query) => query.in("matched_customer_id", scopedCustomerIds));
  }

  // Thúy route-level evidence stores final customer matches inside production_items;
  // matched_customer_id can remain null, so fetch sender-scoped rows separately and
  // keep them in the manual Quản lý doanh thu review path instead of silently skipping them.
  await fetchPages((query) => query.eq("from_email", THUY_DIRECT_DEALER_SENDER));

  return Array.from(rowsById.values());
}

async function createSyncSnapshot(args: {
  supabaseAdmin: any;
  syncJobId: string;
  triggeredBy: string;
  customerId: string | null;
}) {
  const { supabaseAdmin, syncJobId, triggeredBy, customerId } = args;
  const { data: draftRows, error: draftErr } = await supabaseAdmin
    .from("revenue_drafts")
    .select("status, total_amount");
  if (draftErr) throw draftErr;

  const totals = {
    total: 0,
    pendingCount: 0,
    approvedCount: 0,
    rejectedCount: 0,
    exceptionCount: 0,
    pendingAmount: 0,
    approvedAmount: 0,
  };

  for (const row of draftRows || []) {
    const status = String(row.status || "");
    const amount = Number(row.total_amount || 0);
    totals.total += amount;
    if (status === "pending") {
      totals.pendingCount += 1;
      totals.pendingAmount += amount;
    } else if (status === "approved") {
      totals.approvedCount += 1;
      totals.approvedAmount += amount;
    } else if (status === "rejected") {
      totals.rejectedCount += 1;
    } else if (status === "exception") {
      totals.exceptionCount += 1;
    }
  }

  const { error: snapshotErr } = await supabaseAdmin
    .from("po_sync_snapshots")
    .upsert({
      sync_job_id: syncJobId,
      customer_id: customerId,
      triggered_by: triggeredBy,
      snapshot_kind: "post_sync",
      snapshot_date: new Date().toISOString().slice(0, 10),
      total_drafts_count: (draftRows || []).length,
      pending_drafts_count: totals.pendingCount,
      approved_drafts_count: totals.approvedCount,
      rejected_drafts_count: totals.rejectedCount,
      exception_drafts_count: totals.exceptionCount,
      cumulative_total_amount: totals.total,
      cumulative_pending_amount: totals.pendingAmount,
      cumulative_approved_amount: totals.approvedAmount,
      updated_at: new Date().toISOString(),
    }, { onConflict: "sync_job_id" });
  if (snapshotErr) throw snapshotErr;
}

async function runScheduledSync(args: {
  supabaseAdmin: any;
  schedule: ScheduleRow;
  triggeredBy: string;
  ignoreDisabled: boolean;
  manualDateRange?: ManualDateRange;
}) {
  const { supabaseAdmin, schedule, triggeredBy, ignoreDisabled, manualDateRange } = args;

  if (!ignoreDisabled && !schedule.is_enabled) {
    return {
      skipped: true,
      reason: "Automation schedule is disabled",
    };
  }

  if (triggeredBy === CRON_TRIGGERED_BY) {
    const dueCheck = isCronRunDue(schedule);
    if (!dueCheck.due) {
      return {
        skipped: true,
        reason: dueCheck.reason,
      };
    }
  }

  const { dateFrom, dateTo, receivedFrom, receivedTo } = manualDateRange
    ? buildExplicitDateRange(manualDateRange.dateFrom, manualDateRange.dateTo)
    : buildDateRange(Number(schedule.lookback_days || 1), schedule.timezone || "Asia/Ho_Chi_Minh");
  const scopedCustomerIds = await fetchScopedCustomerIds(supabaseAdmin, schedule.scope_mode, schedule.customer_id);

  const { data: job, error: jobErr } = await supabaseAdmin
    .from("po_sync_jobs")
    .insert({
      customer_id: schedule.scope_mode === "single_customer" ? schedule.customer_id : null,
      date_from: dateFrom,
      date_to: dateTo,
      status: "running",
      triggered_by: triggeredBy,
    })
    .select()
    .single();
  if (jobErr) throw jobErr;

  const finishSchedule = async (fields: Record<string, unknown>) => {
    const { error } = await supabaseAdmin
      .from("po_sync_schedules")
      .update(fields)
      .eq("config_key", "default");
    if (error) throw error;
  };

  const updateJob = async (fields: Record<string, unknown>) => {
    const { error } = await supabaseAdmin
      .from("po_sync_jobs")
      .update(fields)
      .eq("id", job.id);
    if (error) throw error;
  };

  try {
    const rows = await fetchInboxRows(supabaseAdmin, receivedFrom, receivedTo, scopedCustomerIds);

    const ids = rows.map((row) => row.id).filter(Boolean);
    const { data: existingDocs, error: existingErr } = ids.length
      ? await supabaseAdmin
          .from("sales_po_documents")
          .select("id, inbox_row_id, customer_id, po_number, po_order_date, delivery_date, subtotal_amount, vat_amount, total_amount, revenue_channel, status, exception_reason")
          .in("inbox_row_id", ids)
      : { data: [], error: null };
    if (existingErr) throw existingErr;
    const existingDocByInboxId = new Map<string, any>((existingDocs || []).map((doc: any) => [doc.inbox_row_id as string, doc]));

    const existingDocIds = (existingDocs || []).map((doc: any) => doc.id).filter(Boolean);
    const { data: existingDrafts, error: existingDraftErr } = existingDocIds.length
      ? await supabaseAdmin.from("revenue_drafts").select("id, sales_po_doc_id").in("sales_po_doc_id", existingDocIds)
      : { data: [], error: null };
    if (existingDraftErr) throw existingDraftErr;
    const existingDraftDocIds = new Set<string>((existingDrafts || []).map((draft: any) => draft.sales_po_doc_id as string));

    const customerIds = [...new Set(rows.map((row) => row.matched_customer_id).filter(Boolean))] as string[];
    const { data: kbProfiles, error: kbErr } = customerIds.length
      ? await supabaseAdmin.from("mini_crm_knowledge_profiles").select("id, customer_id").in("customer_id", customerIds)
      : { data: [], error: null };
    if (kbErr) throw kbErr;
    const kbByCustomer = new Map<string, string>((kbProfiles || []).map((kb: { id: string; customer_id: string }) => [kb.customer_id, kb.id]));

    let draftsCreated = 0;
    let exceptionsCreated = 0;
    let skipped = 0;
    let processed = 0;
    let rowErrors = 0;

    for (const row of rows) {
      const existingDoc = existingDocByInboxId.get(row.id);
      if (existingDoc && existingDraftDocIds.has(existingDoc.id)) {
        skipped += 1;
        continue;
      }

      const isTier1 = Boolean(row.mini_crm_customers?.is_tier1);
      const poAutomation = row.raw_payload?.po_automation || null;
      const automationStatus = String(poAutomation?.automation_status || "");
      const automationNeedsReview = AUTOMATION_REVIEW_STATUSES.includes(automationStatus as typeof AUTOMATION_REVIEW_STATUSES[number]);
      const amount = calcAmountFromRow(row);
      const productGroup = String(row.mini_crm_customers?.product_group || inferProductGroupFromRow(row));
      const resolvedCustomerId = row.matched_customer_id || null;
      const kbProfileId = resolvedCustomerId ? kbByCustomer.get(resolvedCustomerId) ?? null : null;
      const canCreatePendingDraft = isTier1 && !automationNeedsReview;
      const automationRule = String(poAutomation?.rule || "");
      const automationReviewLabel = automationRule === "dam_xesg_text_body"
        ? "Dam/XESG PO evidence cần review"
        : automationRule === "thuy_direct_dealer_text"
          ? "Thúy đại lý trực tiếp cần đối soát Quản lý doanh thu"
        : automationRule === "kingfood_po_automation"
          ? "Kingfood PO cần review"
          : "PO automation cần review";
      const reviewExceptionReason = automationNeedsReview
        ? `${automationReviewLabel}: ${automationStatus || "unknown"} - ${poAutomation?.reason || "Không đủ điều kiện auto-parse"}`
        : "Khách hàng chưa được phân loại Tier-1";

      try {
        const doc = existingDoc || await (async () => {
          const { data: parseRun, error: parseErr } = await supabaseAdmin
            .from("po_parse_runs")
            .insert({
              sync_job_id: job.id,
              inbox_row_id: row.id,
              customer_id: resolvedCustomerId,
              status: canCreatePendingDraft ? "ok" : "exception",
              outcome: canCreatePendingDraft ? "draft_created" : (automationNeedsReview ? `exception_${automationStatus}` : "exception_non_tier1"),
              kb_profile_id: kbProfileId,
              parse_source: row.raw_payload?.parse_meta?.source || "auto",
              parsed_item_count: Array.isArray(row.production_items) ? row.production_items.length : 0,
            })
            .select()
            .single();
          if (parseErr) throw parseErr;

          const { data: insertedDoc, error: docErr } = await supabaseAdmin
            .from("sales_po_documents")
            .insert({
              inbox_row_id: row.id,
              customer_id: resolvedCustomerId,
              sync_job_id: job.id,
              parse_run_id: parseRun?.id || null,
              po_number: row.po_number || extractPoNumberFromSubject(row.email_subject) || null,
              po_order_date: row.raw_payload?.parse_meta?.po_order_date || null,
              delivery_date: row.delivery_date || null,
              subtotal_amount: Number(row.subtotal_amount || row.raw_payload?.parse_meta?.subtotal || 0),
              vat_amount: Number(row.vat_amount ?? row.raw_payload?.parse_meta?.vat_amount ?? 0),
              total_amount: amount,
              revenue_channel: row.revenue_channel || null,
              parse_source: row.raw_payload?.parse_meta?.source || "auto",
              items: row.production_items || row.raw_payload?.parsed_items_preview || [],
              kb_profile_id: kbProfileId,
              status: canCreatePendingDraft ? "pending_review" : "exception",
              exception_reason: canCreatePendingDraft ? null : reviewExceptionReason,
            })
            .select("id, inbox_row_id, customer_id, po_number, po_order_date, delivery_date, subtotal_amount, vat_amount, total_amount, revenue_channel, status, exception_reason")
            .single();
          if (docErr) throw docErr;
          return insertedDoc;
        })();

        if (!existingDraftDocIds.has(doc.id)) {
          const draftPayload = {
            sales_po_doc_id: doc.id,
            customer_id: doc.customer_id || resolvedCustomerId,
            sync_job_id: job.id,
            po_number: doc.po_number || row.po_number || extractPoNumberFromSubject(row.email_subject) || null,
            po_order_date: doc.po_order_date || row.raw_payload?.parse_meta?.po_order_date || null,
            delivery_date: doc.delivery_date || row.delivery_date || null,
            subtotal_amount: Number(doc.subtotal_amount ?? row.subtotal_amount ?? row.raw_payload?.parse_meta?.subtotal ?? 0),
            vat_amount: Number(doc.vat_amount ?? row.vat_amount ?? row.raw_payload?.parse_meta?.vat_amount ?? 0),
            total_amount: Number(doc.total_amount ?? amount),
            revenue_channel: doc.revenue_channel || row.revenue_channel || null,
            product_group: productGroup,
            status: canCreatePendingDraft ? "pending" : "exception",
            exception_reason: canCreatePendingDraft ? null : (doc.exception_reason || reviewExceptionReason),
          };
          const { error: draftErr } = await supabaseAdmin
            .from("revenue_drafts")
            .upsert(draftPayload, { onConflict: "sales_po_doc_id" });
          if (draftErr) throw draftErr;
        }

        if (canCreatePendingDraft) draftsCreated += 1;
        else exceptionsCreated += 1;
        processed += 1;
      } catch (rowErr) {
        rowErrors += 1;
        console.error("[po-sync-scheduler-run] row error", row.id, rowErr);
      }
    }

    const errorMessage = rowErrors > 0 ? `Processed with ${rowErrors} row errors` : null;

    await updateJob({
      status: "done",
      inbox_rows_found: rows.length,
      inbox_rows_processed: processed,
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
    });

    await createSyncSnapshot({
      supabaseAdmin,
      syncJobId: job.id,
      triggeredBy,
      customerId: schedule.scope_mode === "single_customer" ? schedule.customer_id : null,
    });

    if (!manualDateRange) {
      await finishSchedule({
        last_job_id: job.id,
        last_run_at: new Date().toISOString(),
      });
    }

    return {
      skipped: false,
      jobId: job.id,
      dateFrom,
      dateTo,
      receivedFrom,
      receivedTo,
      rowsFound: rows.length,
      rowsProcessed: processed,
      draftsCreated,
      exceptionsCreated,
      skippedRows: skipped,
      rowErrors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    try {
      await updateJob({
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
      });
      if (!manualDateRange) {
        await finishSchedule({
          last_job_id: job.id,
          last_run_at: new Date().toISOString(),
        });
      }
    } catch (auditError) {
      const auditMessage = auditError instanceof Error ? auditError.message : "Unknown audit error";
      throw new Error(`${message}; audit update failed: ${auditMessage}`);
    }

    throw error;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const { triggeredBy, ignoreDisabled, manualDateRange } = await resolveRequestContext(req);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    if (triggeredBy !== CRON_TRIGGERED_BY) {
      await ensureAuthorized(supabaseAdmin, triggeredBy);
    }

    const lockAcquired = await acquireAutomationLock(supabaseAdmin, triggeredBy);
    if (!lockAcquired) {
      return jsonResponse(req, { error: "Automation is already running. Please wait for the current run to finish." }, 409);
    }

    try {
      const { data: schedule, error: scheduleErr } = await supabaseAdmin
        .from("po_sync_schedules")
        .select("*")
        .eq("config_key", "default")
        .maybeSingle();
      if (scheduleErr) throw scheduleErr;
      if (!schedule) {
        return jsonResponse(req, { error: "Automation schedule not found. Save configuration first." }, 404);
      }

      const result = await runScheduledSync({
        supabaseAdmin,
        schedule: schedule as ScheduleRow,
        triggeredBy,
        ignoreDisabled,
        manualDateRange,
      });

      return jsonResponse(req, { success: true, result });
    } finally {
      await releaseAutomationLock(supabaseAdmin);
    }
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.startsWith("Forbidden:") ? 403 : 500;
    return jsonResponse(req, { error: message }, status);
  }
});
