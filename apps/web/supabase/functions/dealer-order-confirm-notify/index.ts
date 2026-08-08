import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceClient, timingSafeEqual } from "../_shared/dealer.ts";
import {
  buildDealerOrderConfirmationTemplateData,
  dealerOrderConfirmationFailureTransition,
  sendDealerOrderConfirmationZns,
} from "../_shared/dealer-order-confirmation.ts";

type ConfirmationJob = {
  id: string;
  order_id: string;
  contact_id: string;
  template_key: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
};

const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const numberValue = (value: unknown) => {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
};

const enabledValue = (value: unknown) => ["true", "1", "yes", "enabled"]
  .includes(String(value || "").trim().toLowerCase());

const authorized = async (
  req: Request,
  serviceRoleKey: string,
  supabase: ReturnType<typeof createServiceClient>,
) => {
  const authorization = req.headers.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (bearer && timingSafeEqual(bearer, serviceRoleKey)) return true;

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

const featureEnabled = async (supabase: ReturnType<typeof createServiceClient>) => {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "dealer_order_confirmation_enabled")
    .maybeSingle();
  if (error) throw new Error(`Unable to read order-confirmation setting: ${error.message}`);
  return enabledValue(data?.value);
};

serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceRoleKey) return json({ success: false, error: "service_role_not_configured" }, 503);

  const supabase = createServiceClient();
  if (!await authorized(req, serviceRoleKey, supabase)) {
    return json({ success: false, error: "unauthorized" }, 401);
  }

  try {
    if (!await featureEnabled(supabase)) {
      return json({ success: true, skipped: true, reason: "feature_disabled", claimed: 0, sent: 0 });
    }
  } catch (error) {
    console.error("[dealer-order-confirm-notify] Feature setting unavailable", error instanceof Error ? error.message : error);
    return json({ success: false, error: "feature_setting_unavailable" }, 503);
  }

  const accessToken = Deno.env.get("DEALER_VIETGUYS_ACCESS_TOKEN") || "";
  const username = Deno.env.get("DEALER_VIETGUYS_USERNAME") || "";
  const oaId = Deno.env.get("DEALER_VIETGUYS_OA_ID") || "";
  const templateId = Deno.env.get("DEALER_VIETGUYS_ORDER_CONFIRM_TEMPLATE_ID") || "";
  const endpoint = Deno.env.get("DEALER_VIETGUYS_ENDPOINT") || "https://api-v2.vietguys.biz:4438/zalo/v4/send";
  const relayUrl = Deno.env.get("DEALER_OTP_RELAY_URL") || "";
  const relaySecret = Deno.env.get("DEALER_OTP_RELAY_SECRET") || "";
  if (!accessToken || !username || !oaId || !templateId) {
    return json({ success: false, error: "order_confirmation_template_not_configured" }, 503);
  }

  let batchSize = 10;
  try {
    const body = await req.json() as { batch_size?: unknown };
    const requested = Number(body.batch_size);
    if (Number.isFinite(requested)) batchSize = Math.max(1, Math.min(50, Math.trunc(requested)));
  } catch {
    // Empty body keeps the default.
  }

  const { data, error } = await supabase.rpc("claim_dealer_customer_order_confirmations", {
    batch_size: batchSize,
  });
  if (error) {
    console.error("[dealer-order-confirm-notify] Claim failed", error.message);
    return json({ success: false, error: "claim_failed" }, 500);
  }

  const jobs = (data || []) as ConfirmationJob[];
  let sent = 0;
  let retried = 0;
  let failed = 0;
  let suppressed = 0;

  for (const job of jobs) {
    const { data: contact, error: contactError } = await supabase
      .from("dealer_customer_contacts")
      .select("phone_normalized")
      .eq("id", job.contact_id)
      .eq("is_active", true)
      .maybeSingle();

    if (contactError) {
      const { error: requeueError } = await supabase
        .from("dealer_customer_order_confirmations")
        .update({
          status: "pending",
          locked_at: null,
          last_error: "contact_lookup_unavailable",
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("status", "processing");
      if (requeueError) console.error("[dealer-order-confirm-notify] Contact lookup requeue failed", requeueError.message);
      retried += 1;
      continue;
    }

    if (!contact?.phone_normalized) {
      const { error: suppressError } = await supabase
        .from("dealer_customer_order_confirmations")
        .update({
          status: "suppressed",
          locked_at: null,
          last_error: "active_order_contact_not_found",
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("status", "processing");
      if (suppressError) console.error("[dealer-order-confirm-notify] Could not suppress missing contact", suppressError.message);
      suppressed += 1;
      continue;
    }

    const payload = job.payload || {};
    let sendLeaseCommitted = false;
    try {
      const templateData = buildDealerOrderConfirmationTemplateData({
        customerName: String(payload.customer_name || ""),
        orderNumber: String(payload.order_number || ""),
        submittedAt: String(payload.submitted_at || ""),
        requestedDeliveryDate: String(payload.requested_delivery_date || ""),
        orderedQuantity: numberValue(payload.ordered_quantity),
        exchangeQuantity: numberValue(payload.exchange_quantity),
        makeupQuantity: numberValue(payload.makeup_quantity),
        physicalQuantity: numberValue(payload.physical_quantity),
        totalAmountVnd: numberValue(payload.total_amount_vnd),
      });

      // Linearization point: cancellation may suppress pending/processing rows,
      // but cannot revoke a send lease committed while the order was submitted.
      const { data: sendCommitted, error: commitError } = await supabase.rpc(
        "commit_dealer_customer_order_confirmation_send",
        { p_confirmation_id: job.id },
      );
      if (commitError) {
        const { error: requeueError } = await supabase
          .from("dealer_customer_order_confirmations")
          .update({
            status: "pending",
            locked_at: null,
            last_error: "send_commit_unavailable",
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("status", "processing");
        if (requeueError) console.error("[dealer-order-confirm-notify] Send-commit requeue failed", requeueError.message);
        retried += 1;
        continue;
      }
      if (sendCommitted !== true) {
        const { error: suppressError } = await supabase
          .from("dealer_customer_order_confirmations")
          .update({
            status: "suppressed",
            locked_at: null,
            last_error: "order_not_submitted_before_send",
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("status", "processing");
        if (suppressError) console.error("[dealer-order-confirm-notify] Send-commit suppression failed", suppressError.message);
        suppressed += 1;
        continue;
      }
      sendLeaseCommitted = true;

      const result = await sendDealerOrderConfirmationZns({
        endpoint,
        accessToken,
        username,
        phoneNormalized: String(contact.phone_normalized),
        trackingId: `dealer-order-confirm-${job.order_id}`,
        oaId,
        templateId,
        templateData,
        relayUrl,
        relaySecret,
      });

      let finalized = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { data: finalizedRow, error: finalizeError } = await supabase
          .from("dealer_customer_order_confirmations")
          .update({
            status: "sent",
            message_id: result.messageId,
            provider_response: {
              accepted: true,
              provider: result.provider,
              message_id: result.messageId,
            },
            last_error: null,
            sent_at: new Date().toISOString(),
            locked_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("status", "send_committed")
          .select("id")
          .maybeSingle();
        if (!finalizeError && finalizedRow?.id) {
          finalized = true;
          break;
        }
        console.error("[dealer-order-confirm-notify] Finalize retry failed", finalizeError?.message || "row_not_updated");
      }
      if (finalized) sent += 1;
      else console.error(`[dealer-order-confirm-notify] Provider accepted but finalization is pending for ${job.id}`);
    } catch (sendError) {
      // Pre-commit validation failures are terminal data errors. Once the send
      // lease is committed, any provider ambiguity requires manual reconciliation.
      const transition = dealerOrderConfirmationFailureTransition(sendLeaseCommitted, sendError);
      const { error: updateError } = await supabase
        .from("dealer_customer_order_confirmations")
        .update({
          status: transition.nextStatus,
          locked_at: null,
          last_error: transition.lastError,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("status", transition.expectedStatus);
      if (updateError) console.error("[dealer-order-confirm-notify] Terminal failure status update failed", updateError.message);
      failed += 1;
    }
  }

  return json({
    success: true,
    claimed: jobs.length,
    sent,
    retried,
    failed,
    suppressed,
  });
});
