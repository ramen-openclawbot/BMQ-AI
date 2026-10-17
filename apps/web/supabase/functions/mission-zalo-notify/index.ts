import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceClient, timingSafeEqual } from "../_shared/dealer.ts";
import { sendZaloGmfText } from "../_shared/dealer-warehouse-notification.ts";
import { resolveZaloAccessToken } from "../_shared/zalo-oa-token.ts";

type MissionNotificationJob = {
  id: string;
  event_type: string;
  mission_id: string | null;
  batch_id: string | null;
  message_body: string;
  attempts: number;
};

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

  const suppliedWorkerSecret = req.headers.get("x-worker-secret");
  if (!suppliedWorkerSecret) return false;
  const { data, error } = await supabase
    .from("mission_zalo_notification_config")
    .select("worker_secret")
    .eq("id", "mission-zalo")
    .maybeSingle();
  const storedWorkerSecret = String(data?.worker_secret || "");
  return !error && Boolean(storedWorkerSecret) && timingSafeEqual(suppliedWorkerSecret, storedWorkerSecret);
};

const retryDelaySeconds = (attempts: number) => Math.min(3600, 60 * (5 ** Math.max(0, attempts - 1)));

const safeError = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 500);

// sendZaloGmfText throws a definitive provider rejection only for a parsed
// Zalo error response. Everything else (network/timeout/abort, non-JSON 2xx,
// succeeded-without-message_id) is an uncertain outcome and must never be
// auto-resent.
const isDefinitiveZaloRejection = (error: unknown) =>
  /Zalo GMF send failed:/.test(safeError(error));

serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceRoleKey) return json({ success: false, error: "service_role_not_configured" }, 503);

  const supabase = createServiceClient();
  if (!await authorized(req, serviceRoleKey, supabase)) {
    return json({ success: false, error: "unauthorized" }, 401);
  }

  const { data: config, error: configError } = await supabase
    .from("mission_zalo_notification_config")
    .select("enabled")
    .eq("id", "mission-zalo")
    .maybeSingle();
  if (configError) {
    console.error("[mission-zalo-notify] Config read failed", configError.message);
    return json({ success: false, error: "config_read_failed", claimed: 0, sent: 0 }, 500);
  }
  if (!config?.enabled) {
    return json({
      success: true,
      skipped: true,
      reason: "mission_zalo_notifications_disabled",
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
    });
  }

  const warehouseGroupId = (Deno.env.get("ZALO_GMF_WAREHOUSE_GROUP_ID") || "").trim();
  if (!warehouseGroupId) {
    return json({
      success: true,
      skipped: true,
      reason: "zalo_gmf_warehouse_group_not_configured",
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

  const { data, error } = await supabase.rpc("claim_mission_zalo_notifications", { batch_size: batchSize });
  if (error) {
    console.error("[mission-zalo-notify] Claim failed", error.message);
    return json({ success: false, error: "claim_failed", claimed: 0, sent: 0 }, 500);
  }

  const jobs = (data || []) as MissionNotificationJob[];
  if (jobs.length === 0) {
    return json({ success: true, claimed: 0, sent: 0, retried: 0, failed: 0 });
  }

  let accessToken: string;
  try {
    accessToken = await resolveZaloAccessToken(supabase);
  } catch (error) {
    console.error("[mission-zalo-notify] Zalo credentials unavailable", safeError(error));
    return json({ success: false, error: "zalo_oa_credentials_unavailable", claimed: jobs.length, sent: 0 }, 503);
  }

  let sent = 0;
  let retried = 0;
  let failed = 0;

  for (const job of jobs) {
    // The queued message_body is the canonical text written by the SQL enqueue
    // helpers, so the worker sends it without rehydrating any source table.
    const delivered = await (async () => {
      try {
        const result = await sendZaloGmfText({
          accessToken,
          groupId: warehouseGroupId,
          text: job.message_body,
        });
        return { ok: true as const, messageId: result.messageId };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();

    if (!delivered.ok) {
      const message = safeError(delivered.error);
      const definitive = isDefinitiveZaloRejection(delivered.error);
      const exhausted = job.attempts >= MAX_ATTEMPTS;
      const nextStatus = definitive && !exhausted ? "pending" : "failed";
      const nextAttemptAt = definitive && !exhausted
        ? new Date(Date.now() + retryDelaySeconds(job.attempts) * 1000).toISOString()
        : UNCERTAIN_RETRY_AT;
      const { error: updateError } = await supabase
        .from("mission_zalo_notifications")
        .update({
          status: nextStatus,
          last_error: definitive ? message : `needs_review: ${message}`,
          next_attempt_at: nextAttemptAt,
          locked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      if (updateError) console.error("[mission-zalo-notify] Failure status update failed", updateError.message);
      console.error(`[mission-zalo-notify] Delivery ${definitive ? "rejected" : "uncertain"} for ${job.id}: ${message}`);
      if (nextStatus === "pending") retried += 1;
      else failed += 1;
      continue;
    }

    let finalized = false;
    let finalizeError = "unknown_error";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error: updateError } = await supabase
        .from("mission_zalo_notifications")
        .update({
          status: "sent",
          provider_message_id: delivered.messageId,
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
        .from("mission_zalo_notifications")
        .update({
          status: "failed",
          last_error: `needs_review: sent-state finalization failed: ${finalizeError}`.slice(0, 500),
          locked_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id);
      console.error(`[mission-zalo-notify] Zalo accepted ${job.id} but finalize failed: ${finalizeError}`);
    }
  }

  return json({ success: true, claimed: jobs.length, sent, retried, failed });
});
