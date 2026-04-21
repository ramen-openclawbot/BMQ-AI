import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";

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

const buildDateRange = (lookbackDays: number) => {
  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - Math.max(0, lookbackDays - 1));
  return {
    dateFrom: isoDate(start),
    dateTo: isoDate(end),
  };
};

async function ensureAuthorized(supabaseAdmin: any, userId: string) {
  const [{ data: roleRows, error: roleErr }, { data: permRows, error: permErr }] = await Promise.all([
    supabaseAdmin.from("user_roles").select("role").eq("user_id", userId),
    supabaseAdmin.from("user_module_permissions").select("module_key, can_edit").eq("user_id", userId),
  ]);

  if (roleErr) throw roleErr;
  if (permErr) throw permErr;

  const roles = (roleRows || []).map((row: { role: string }) => row.role);
  const editableModules = new Set(
    (permRows || [])
      .filter((row: { module_key: string; can_edit: boolean }) => Boolean(row.can_edit))
      .map((row: { module_key: string }) => row.module_key)
  );

  if (roles.includes("owner") || editableModules.has("finance_revenue") || editableModules.has("sales_po_inbox")) {
    return;
  }

  throw new Error("Forbidden: owner or finance revenue / sales PO edit permission required");
}

const AUTOMATION_LOCK_KEY = "po_sync_scheduler_default";

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

async function fetchInboxRows(supabaseAdmin: any, dateFrom: string, dateTo: string, scopedCustomerIds: string[]) {
  if (scopedCustomerIds.length === 0) return [] as InboxRow[];

  const pageSize = 1000;
  const rows: InboxRow[] = [];
  let offset = 0;

  while (true) {
    let query = supabaseAdmin
      .from("customer_po_inbox")
      .select("*, mini_crm_customers(id, customer_name, product_group, is_tier1)")
      .gte("received_at", `${dateFrom}T00:00:00.000Z`)
      .lte("received_at", `${dateTo}T23:59:59.999Z`)
      .in("matched_customer_id", scopedCustomerIds)
      .order("received_at", { ascending: false })
      .range(offset, offset + pageSize - 1);

    const { data, error } = await query;
    if (error) throw error;

    const batch = (data || []) as InboxRow[];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

async function runScheduledSync(args: {
  supabaseAdmin: any;
  schedule: ScheduleRow;
  triggeredBy: string;
  ignoreDisabled: boolean;
}) {
  const { supabaseAdmin, schedule, triggeredBy, ignoreDisabled } = args;

  if (!ignoreDisabled && !schedule.is_enabled) {
    return {
      skipped: true,
      reason: "Automation schedule is disabled",
    };
  }

  const { dateFrom, dateTo } = buildDateRange(Number(schedule.lookback_days || 1));
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
    const rows = await fetchInboxRows(supabaseAdmin, dateFrom, dateTo, scopedCustomerIds);

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
      const amount = calcAmountFromRow(row);
      const productGroup = String(row.mini_crm_customers?.product_group || inferProductGroupFromRow(row));
      const resolvedCustomerId = row.matched_customer_id || null;
      const kbProfileId = resolvedCustomerId ? kbByCustomer.get(resolvedCustomerId) ?? null : null;

      try {
        const doc = existingDoc || await (async () => {
          const { data: parseRun, error: parseErr } = await supabaseAdmin
            .from("po_parse_runs")
            .insert({
              sync_job_id: job.id,
              inbox_row_id: row.id,
              customer_id: resolvedCustomerId,
              status: isTier1 ? "ok" : "exception",
              outcome: isTier1 ? "draft_created" : "exception_non_tier1",
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
              status: isTier1 ? "pending_review" : "exception",
              exception_reason: isTier1 ? null : "Khách hàng chưa được phân loại Tier-1",
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
            status: isTier1 ? "pending" : "exception",
            exception_reason: isTier1 ? null : (doc.exception_reason || "Khách hàng chưa được phân loại Tier-1"),
          };
          const { error: draftErr } = await supabaseAdmin
            .from("revenue_drafts")
            .upsert(draftPayload, { onConflict: "sales_po_doc_id" });
          if (draftErr) throw draftErr;
        }

        if (isTier1) draftsCreated += 1;
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

    await finishSchedule({
      last_job_id: job.id,
      last_run_at: new Date().toISOString(),
    });

    return {
      skipped: false,
      jobId: job.id,
      dateFrom,
      dateTo,
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
      await finishSchedule({
        last_job_id: job.id,
        last_run_at: new Date().toISOString(),
      });
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
    const { user } = await requireAuth(req, getCorsHeaders(req));
    const body = await req.json().catch(() => ({}));
    const ignoreDisabled = Boolean(body?.ignoreDisabled);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    await ensureAuthorized(supabaseAdmin, user?.id || "");
    const lockAcquired = await acquireAutomationLock(supabaseAdmin, user?.id || "manual");
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
        triggeredBy: user?.id || "manual",
        ignoreDisabled,
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
