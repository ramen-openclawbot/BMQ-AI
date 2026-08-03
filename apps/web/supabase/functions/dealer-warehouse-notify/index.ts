import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceClient, timingSafeEqual } from "../_shared/dealer.ts";
import { refreshZaloOaAccessToken, sendZaloGmfText } from "../_shared/dealer-warehouse-notification.ts";
import { isWarehouseNotificationWindow } from "../_shared/dealer-warehouse-schedule.ts";

type NotificationJob = {
  id: string;
  order_id: string;
  channel: string;
  group_name: string;
  message_body: string;
  attempt_count: number;
  max_attempts: number;
};

const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

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
    .from("dealer_notification_worker_config")
    .select("worker_secret")
    .eq("id", "warehouse-zalo")
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
  if (error) console.error("[dealer-warehouse-notify] Could not release OAuth refresh lock", error.message);
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

const retryDelaySeconds = (attemptCount: number) => Math.min(3600, 60 * (5 ** Math.max(0, attemptCount - 1)));

serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceRoleKey) return json({ success: false, error: "service_role_not_configured" }, 503);

  const supabase = createServiceClient();
  if (!await authorized(req, serviceRoleKey, supabase)) {
    return json({ success: false, error: "unauthorized" }, 401);
  }

  if (!isWarehouseNotificationWindow(new Date())) {
    return json({
      success: true,
      skipped: true,
      reason: "outside_vietnam_evening_window",
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
    });
  }

  const groupId = Deno.env.get("ZALO_GMF_WAREHOUSE_GROUP_ID");
  if (!groupId) {
    return json({ success: false, error: "zalo_gmf_group_not_configured" }, 503);
  }

  let accessToken: string;
  try {
    accessToken = await resolveZaloAccessToken(supabase);
  } catch (error) {
    console.error("[dealer-warehouse-notify] Zalo credentials unavailable", error instanceof Error ? error.message : error);
    return json({ success: false, error: "zalo_oa_credentials_unavailable" }, 503);
  }

  let batchSize = 10;
  try {
    const body = await req.json() as { batch_size?: unknown };
    const requested = Number(body.batch_size);
    if (Number.isFinite(requested)) batchSize = Math.max(1, Math.min(50, Math.trunc(requested)));
  } catch {
    // Empty body uses the default batch size.
  }

  const { data, error } = await supabase.rpc("claim_dealer_order_notifications", {
    batch_size: batchSize,
  });
  if (error) {
    console.error("[dealer-warehouse-notify] Claim failed", error.message);
    return json({ success: false, error: "claim_failed" }, 500);
  }

  const jobs = (data || []) as NotificationJob[];
  let sent = 0;
  let retried = 0;
  let failed = 0;

  for (const job of jobs) {
    let result: Awaited<ReturnType<typeof sendZaloGmfText>>;
    try {
      result = await sendZaloGmfText({
        accessToken,
        groupId,
        text: job.message_body,
      });
    } catch (error) {
      const exhausted = job.attempt_count >= job.max_attempts;
      const nextAttemptAt = new Date(Date.now() + retryDelaySeconds(job.attempt_count) * 1000).toISOString();
      const safeError = String(error instanceof Error ? error.message : error).slice(0, 500);
      const { error: updateError } = await supabase
        .from("dealer_order_notifications")
        .update({
          status: exhausted ? "failed" : "pending",
          last_error: safeError,
          next_attempt_at: nextAttemptAt,
          locked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      if (updateError) console.error("[dealer-warehouse-notify] Failure status update failed", updateError.message);
      console.error(`[dealer-warehouse-notify] Delivery failed for notification ${job.id}: ${safeError}`);
      if (exhausted) failed += 1;
      else retried += 1;
      continue;
    }

    let finalized = false;
    let finalizeError = "unknown_error";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error: updateError } = await supabase
        .from("dealer_order_notifications")
        .update({
          status: "sent",
          message_id: result.messageId,
          provider_response: {
            error: 0,
            message_id: result.messageId,
            group_id: result.groupId,
          },
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
      // Keep the row processing rather than immediately resending an already accepted Zalo message.
      // The stale-lock recovery remains an at-least-once safety net when all finalize writes fail.
      failed += 1;
      console.error(`[dealer-warehouse-notify] Zalo accepted notification ${job.id}, but sent-state finalization failed: ${finalizeError}`);
    }
  }

  return json({ success: true, claimed: jobs.length, sent, retried, failed });
});
