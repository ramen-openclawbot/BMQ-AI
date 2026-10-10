import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceClient, timingSafeEqual } from "../_shared/dealer.ts";
import {
  refreshZaloOaAccessToken,
  sendZaloGmfText,
} from "../_shared/dealer-warehouse-notification.ts";
import {
  formatFinanceZaloMessage,
  type FinanceZaloEventType,
} from "../_shared/finance-zalo-notification.ts";

type FinanceNotificationJob = {
  id: string;
  event_type: FinanceZaloEventType;
  entity_id: string;
  group_key: string;
  message_body: string;
  attempts: number;
};

type PaymentRequestRow = {
  id: string;
  request_number: string;
  supplier_id: string | null;
  total_amount: number | string | null;
  purchase_order_id: string | null;
  goods_receipt_id: string | null;
  created_by: string | null;
};

type GoodsReceiptRow = {
  id: string;
  receipt_number: string;
  supplier_id: string | null;
  purchase_order_id: string | null;
};

type SalaryPayoutRow = {
  id: string;
  payout_number: string;
  period_name: string | null;
  employee_count: number | null;
};

const SALARY_PAYOUT_EVENT_TYPES = new Set<FinanceZaloEventType>([
  "salary_payout_created",
  "salary_payout_advanced",
  "salary_payout_completed",
]);

// These notices are snapshots written at enqueue time (submission totals and the
// auto-purchase PO/summary digests). The stored message_body is canonical, so the
// worker must not try to rehydrate them from another source table.
const SELF_CONTAINED_EVENT_TYPES = new Set<FinanceZaloEventType>([
  "payment_submission_created",
  "auto_purchase_order_sent",
  "auto_purchase_daily_summary",
]);

const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const MAX_ATTEMPTS = 5;
const UNCERTAIN_RETRY_AT = "9999-12-31T00:00:00.000Z";

const authorized = async (
  req: Request,
  serviceRoleKey: string,
  supabase: ReturnType<typeof createServiceClient>,
) => {
  const authorization = req.headers.get("authorization") || "";
  const suppliedBearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (suppliedBearer && timingSafeEqual(suppliedBearer, serviceRoleKey)) return true;

  const cronSecret = Deno.env.get("CRON_SECRET");
  const suppliedCronSecret = req.headers.get("x-cron-secret");
  if (cronSecret && suppliedCronSecret && timingSafeEqual(suppliedCronSecret, cronSecret)) return true;

  const suppliedWorkerSecret = req.headers.get("x-worker-secret");
  if (!suppliedWorkerSecret) return false;
  const { data, error } = await supabase
    .from("finance_zalo_notification_config")
    .select("worker_secret")
    .eq("id", "finance-zalo")
    .maybeSingle();
  const storedWorkerSecret = String(data?.worker_secret || "");
  return !error && Boolean(storedWorkerSecret) && timingSafeEqual(suppliedWorkerSecret, storedWorkerSecret);
};

type ZaloTokenState = {
  zalo_access_token: string | null;
  zalo_refresh_token: string | null;
  zalo_access_token_expires_at: string | null;
};

const readZaloTokenState = async (supabase: ReturnType<typeof createServiceClient>): Promise<ZaloTokenState> => {
  const { data, error } = await supabase
    .from("dealer_notification_worker_config")
    .select("zalo_access_token,zalo_refresh_token,zalo_access_token_expires_at")
    .eq("id", "warehouse-zalo")
    .single();
  if (error) throw new Error(`Unable to read Zalo token state: ${error.message}`);
  return data as ZaloTokenState;
};

const validStoredAccessToken = (state: ZaloTokenState): string | null => {
  const expiresAtMs = Date.parse(String(state.zalo_access_token_expires_at || ""));
  const token = String(state.zalo_access_token || "").trim();
  return token && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() + 5 * 60_000 ? token : null;
};

const releaseRefreshLock = async (supabase: ReturnType<typeof createServiceClient>, lockId: string) => {
  const { error } = await supabase.rpc("release_zalo_oauth_refresh_lock", { p_lock_id: lockId });
  if (error) console.error("[finance-zalo-notify] Could not release OAuth refresh lock", error.message);
};

const resolveZaloAccessToken = async (supabase: ReturnType<typeof createServiceClient>): Promise<string> => {
  const initialState = await readZaloTokenState(supabase);
  const storedToken = validStoredAccessToken(initialState);
  if (storedToken) return storedToken;

  const appId = Deno.env.get("ZALO_OA_APP_ID") || "";
  const appSecret = Deno.env.get("ZALO_OA_APP_SECRET") || "";
  const environmentRefreshToken = Deno.env.get("ZALO_OA_REFRESH_TOKEN") || "";
  const staticAccessToken = Deno.env.get("ZALO_OA_ACCESS_TOKEN") || "";
  if (!appId || !appSecret || (!initialState.zalo_refresh_token && !environmentRefreshToken)) {
    if (staticAccessToken) return staticAccessToken;
    throw new Error("Zalo OA credentials are not configured");
  }

  const lockId = crypto.randomUUID();
  const { data: lockClaimed, error: lockError } = await supabase.rpc("claim_zalo_oauth_refresh_lock", {
    p_lock_id: lockId,
  });
  if (lockError) throw new Error(`Unable to claim Zalo OAuth refresh lock: ${lockError.message}`);

  if (!lockClaimed) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const refreshedByPeer = validStoredAccessToken(await readZaloTokenState(supabase));
      if (refreshedByPeer) return refreshedByPeer;
    }
    throw new Error("Zalo OA token refresh is already in progress");
  }

  try {
    const lockedState = await readZaloTokenState(supabase);
    const tokenRefreshedBeforeLock = validStoredAccessToken(lockedState);
    if (tokenRefreshedBeforeLock) return tokenRefreshedBeforeLock;

    const refreshToken = String(lockedState.zalo_refresh_token || environmentRefreshToken).trim();
    const refreshed = await refreshZaloOaAccessToken({ appId, appSecret, refreshToken });
    const expiresAt = new Date(Date.now() + refreshed.expiresInSeconds * 1000).toISOString();
    let lastPersistError = "unknown_error";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await supabase
        .from("dealer_notification_worker_config")
        .update({
          zalo_access_token: refreshed.accessToken,
          zalo_refresh_token: refreshed.refreshToken,
          zalo_access_token_expires_at: expiresAt,
          zalo_refresh_lock_id: null,
          zalo_refresh_locked_at: null,
        })
        .eq("id", "warehouse-zalo")
        .eq("zalo_refresh_lock_id", lockId)
        .select("id")
        .maybeSingle();
      if (!error && data) return refreshed.accessToken;
      lastPersistError = error?.message || "refresh_lock_lost";
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw new Error(`Unable to persist refreshed Zalo token: ${lastPersistError}`);
  } finally {
    await releaseRefreshLock(supabase, lockId);
  }
};

const retryDelaySeconds = (attempts: number) => Math.min(3600, 60 * (5 ** Math.max(0, attempts - 1)));

const safeError = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 500);

// sendZaloGmfText throws a definitive provider rejection only for a parsed
// Zalo error response. Everything else (network/timeout/abort, non-JSON 2xx,
// succeeded-without-message_id) is an uncertain outcome and must never be
// auto-resent.
const isDefinitiveZaloRejection = (error: unknown) =>
  /Zalo GMF send failed:/.test(safeError(error));

const supplierNamesById = async (
  supabase: ReturnType<typeof createServiceClient>,
  supplierIds: string[],
): Promise<Map<string, string>> => {
  const names = new Map<string, string>();
  const unique = [...new Set(supplierIds.filter(Boolean))];
  if (unique.length === 0) return names;
  const { data, error } = await supabase.from("suppliers").select("id,name").in("id", unique);
  if (error) return names;
  for (const row of (data || []) as Array<{ id: string; name: string | null }>) {
    if (row.name) names.set(row.id, row.name);
  }
  return names;
};

const profileNamesById = async (
  supabase: ReturnType<typeof createServiceClient>,
  userIds: string[],
): Promise<Map<string, string>> => {
  const names = new Map<string, string>();
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return names;
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id,full_name,email")
    .in("user_id", unique);
  if (error) return names;
  for (const row of (data || []) as Array<{ user_id: string; full_name: string | null; email: string | null }>) {
    const name = String(row.full_name || "").trim() || String(row.email || "").trim();
    if (name) names.set(row.user_id, name);
  }
  return names;
};

const purchaseOrderCodesById = async (
  supabase: ReturnType<typeof createServiceClient>,
  poIds: string[],
): Promise<Map<string, string>> => {
  const codes = new Map<string, string>();
  const unique = [...new Set(poIds.filter(Boolean))];
  if (unique.length === 0) return codes;
  const { data, error } = await supabase.from("purchase_orders").select("id,po_number").in("id", unique);
  if (error) return codes;
  for (const row of (data || []) as Array<{ id: string; po_number: string | null }>) {
    if (row.po_number) codes.set(row.id, row.po_number);
  }
  return codes;
};

const goodsReceiptCodesById = async (
  supabase: ReturnType<typeof createServiceClient>,
  grIds: string[],
): Promise<Map<string, string>> => {
  const codes = new Map<string, string>();
  const unique = [...new Set(grIds.filter(Boolean))];
  if (unique.length === 0) return codes;
  const { data, error } = await supabase.from("goods_receipts").select("id,receipt_number").in("id", unique);
  if (error) return codes;
  for (const row of (data || []) as Array<{ id: string; receipt_number: string | null }>) {
    if (row.receipt_number) codes.set(row.id, row.receipt_number);
  }
  return codes;
};

const buildJobMessage = async (
  supabase: ReturnType<typeof createServiceClient>,
  job: FinanceNotificationJob,
): Promise<string> => {
  // Prefer the canonical shared formatter rehydrating current server state; fall
  // back to the outbox snapshot so a formatting error never blocks a notice.
  try {
    // Submission and auto-purchase notices are self-contained snapshots stored at
    // creation time; the outbox body is the canonical text for these events.
    if (SELF_CONTAINED_EVENT_TYPES.has(job.event_type)) {
      return job.message_body;
    }

    if (
      job.event_type === "payment_request_created"
      || job.event_type === "payment_request_paid"
      || job.event_type === "payment_cash_advanced"
      || job.event_type === "payment_cash_settled"
    ) {
      const { data } = await supabase
        .from("payment_requests")
        .select("id,request_number,supplier_id,total_amount,purchase_order_id,goods_receipt_id,created_by")
        .eq("id", job.entity_id)
        .maybeSingle();
      const row = data as PaymentRequestRow | null;
      if (!row) return job.message_body;

      // Cash notices name the requester instead of the supplier.
      if (job.event_type === "payment_cash_advanced" || job.event_type === "payment_cash_settled") {
        const requesterNames = await profileNamesById(supabase, row.created_by ? [row.created_by] : []);
        return formatFinanceZaloMessage(job.event_type, {
          id: row.id,
          requestNumber: row.request_number,
          requesterName: row.created_by ? requesterNames.get(row.created_by) ?? null : null,
          amount: Number(row.total_amount),
        });
      }

      const [supplierNames, poCodes, grCodes] = await Promise.all([
        supplierNamesById(supabase, row.supplier_id ? [row.supplier_id] : []),
        purchaseOrderCodesById(supabase, row.purchase_order_id ? [row.purchase_order_id] : []),
        goodsReceiptCodesById(supabase, row.goods_receipt_id ? [row.goods_receipt_id] : []),
      ]);
      return formatFinanceZaloMessage(job.event_type, {
        id: row.id,
        requestNumber: row.request_number,
        supplierName: row.supplier_id ? supplierNames.get(row.supplier_id) ?? null : null,
        amount: Number(row.total_amount),
        purchaseOrderCode: row.purchase_order_id ? poCodes.get(row.purchase_order_id) ?? null : null,
        goodsReceiptCode: row.goods_receipt_id ? grCodes.get(row.goods_receipt_id) ?? null : null,
      });
    }

    if (SALARY_PAYOUT_EVENT_TYPES.has(job.event_type)) {
      const { data } = await supabase
        .from("salary_payouts")
        .select("id,payout_number,period_name,employee_count")
        .eq("id", job.entity_id)
        .maybeSingle();
      const row = data as SalaryPayoutRow | null;
      if (!row) return job.message_body;
      return formatFinanceZaloMessage(job.event_type, {
        id: row.id,
        payoutNumber: row.payout_number,
        periodName: row.period_name,
        employeeCount: Number(row.employee_count),
      });
    }

    const { data } = await supabase
      .from("goods_receipts")
      .select("id,receipt_number,supplier_id,purchase_order_id")
      .eq("id", job.entity_id)
      .maybeSingle();
    const row = data as GoodsReceiptRow | null;
    if (!row) return job.message_body;
    const [supplierNames, poCodes] = await Promise.all([
      supplierNamesById(supabase, row.supplier_id ? [row.supplier_id] : []),
      purchaseOrderCodesById(supabase, row.purchase_order_id ? [row.purchase_order_id] : []),
    ]);
    let shortLineCount = 0;
    if (job.event_type === "goods_receipt_short") {
      const { count } = await supabase
        .from("goods_receipt_items")
        .select("id", { count: "exact", head: true })
        .eq("goods_receipt_id", row.id)
        .eq("line_status", "thieu");
      shortLineCount = Number(count || 0);
    }
    return formatFinanceZaloMessage(job.event_type, {
      id: row.id,
      receiptNumber: row.receipt_number,
      supplierName: row.supplier_id ? supplierNames.get(row.supplier_id) ?? null : null,
      purchaseOrderCode: row.purchase_order_id ? poCodes.get(row.purchase_order_id) ?? null : null,
      shortLineCount,
    });
  } catch (error) {
    console.error(`[finance-zalo-notify] Formatter fallback for ${job.id}: ${safeError(error)}`);
    return job.message_body;
  }
};

serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceRoleKey) return json({ success: false, error: "service_role_not_configured" }, 503);

  const supabase = createServiceClient();
  if (!await authorized(req, serviceRoleKey, supabase)) {
    return json({ success: false, error: "unauthorized" }, 401);
  }

  const { data: config, error: configError } = await supabase
    .from("finance_zalo_notification_config")
    .select("finance_zalo_notifications_enabled")
    .eq("id", "finance-zalo")
    .maybeSingle();
  if (configError) {
    console.error("[finance-zalo-notify] Config read failed", configError.message);
    return json({ success: false, error: "config_read_failed", claimed: 0, sent: 0 }, 500);
  }
  if (!config?.finance_zalo_notifications_enabled) {
    return json({
      success: true,
      skipped: true,
      reason: "finance_zalo_notifications_disabled",
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
    });
  }

  const financeGroupId = (Deno.env.get("ZALO_GMF_FINANCE_GROUP_ID") || "").trim();
  if (!financeGroupId) {
    return json({
      success: true,
      skipped: true,
      reason: "zalo_gmf_finance_group_not_configured",
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
    });
  }

  let batchSize = 10;
  try {
    const body = await req.json() as { batch_size?: unknown };
    const requested = Number(body.batch_size);
    if (Number.isFinite(requested)) batchSize = Math.max(1, Math.min(50, Math.trunc(requested)));
  } catch {
    // Empty body uses the default batch size.
  }

  const { data, error } = await supabase.rpc("claim_finance_zalo_notifications", { batch_size: batchSize });
  if (error) {
    console.error("[finance-zalo-notify] Claim failed", error.message);
    return json({ success: false, error: "claim_failed", claimed: 0, sent: 0 }, 500);
  }

  const jobs = (data || []) as FinanceNotificationJob[];
  if (jobs.length === 0) {
    return json({ success: true, claimed: 0, sent: 0, retried: 0, failed: 0 });
  }

  let accessToken: string;
  try {
    accessToken = await resolveZaloAccessToken(supabase);
  } catch (error) {
    console.error("[finance-zalo-notify] Zalo credentials unavailable", safeError(error));
    return json({ success: false, error: "zalo_oa_credentials_unavailable", claimed: jobs.length, sent: 0 }, 503);
  }

  let sent = 0;
  let retried = 0;
  let failed = 0;

  for (const job of jobs) {
    const messageBody = await buildJobMessage(supabase, job);
    const providerMessageId = await (async () => {
      try {
        const result = await sendZaloGmfText({
          accessToken,
          groupId: financeGroupId,
          text: messageBody,
        });
        return { ok: true as const, messageId: result.messageId, groupId: result.groupId };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();

    if (!providerMessageId.ok) {
      const message = safeError(providerMessageId.error);
      const definitive = isDefinitiveZaloRejection(providerMessageId.error);
      const exhausted = job.attempts >= MAX_ATTEMPTS;
      const nextStatus = definitive && !exhausted ? "pending" : "failed";
      const nextAttemptAt = definitive && !exhausted
        ? new Date(Date.now() + retryDelaySeconds(job.attempts) * 1000).toISOString()
        : UNCERTAIN_RETRY_AT;
      const { error: updateError } = await supabase
        .from("finance_zalo_notifications")
        .update({
          status: nextStatus,
          last_error: definitive ? message : `needs_review: ${message}`,
          next_attempt_at: nextAttemptAt,
          locked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      if (updateError) console.error("[finance-zalo-notify] Failure status update failed", updateError.message);
      console.error(`[finance-zalo-notify] Delivery ${definitive ? "rejected" : "uncertain"} for ${job.id}: ${message}`);
      if (nextStatus === "pending") retried += 1;
      else failed += 1;
      continue;
    }

    let finalized = false;
    let finalizeError = "unknown_error";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error: updateError } = await supabase
        .from("finance_zalo_notifications")
        .update({
          status: "sent",
          message_body: messageBody,
          provider_message_id: providerMessageId.messageId,
          last_error: null,
          sent_at: new Date().toISOString(),
          locked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      if (!updateError) {
        finalized = true;
        break;
      }
      finalizeError = updateError.message;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }

    if (finalized) {
      sent += 1;
    } else {
      // Zalo may have accepted the message; never auto-resend it.
      failed += 1;
      await supabase
        .from("finance_zalo_notifications")
        .update({
          status: "failed",
          last_error: `needs_review: sent-state finalization failed: ${finalizeError}`.slice(0, 500),
          locked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      console.error(`[finance-zalo-notify] Zalo accepted ${job.id} but finalize failed: ${finalizeError}`);
    }
  }

  return json({ success: true, claimed: jobs.length, sent, retried, failed });
});
