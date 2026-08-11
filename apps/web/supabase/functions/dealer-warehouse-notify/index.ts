import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceClient, timingSafeEqual } from "../_shared/dealer.ts";
import {
  formatWarehouseDealerDailyDigest,
  formatWarehousePointDailyDigest,
  refreshZaloOaAccessToken,
  sendZaloGmfText,
  type WarehouseOrderMessageInput,
} from "../_shared/dealer-warehouse-notification.ts";
import {
  buildDailyBreadOrderMessage,
  forecastVehicleBread,
  nextVietnamDateKey,
  roundBreadOrderMessageQuantity,
} from "../_shared/daily-bread-order.ts";
import {
  isWarehouseDailyDigestTime,
  isWarehouseNotificationWindow,
  warehouseVietnamDayRange,
} from "../_shared/dealer-warehouse-schedule.ts";

type NotificationJob = {
  id: string;
  order_id: string | null;
  channel: string;
  group_name: string;
  message_body: string;
  attempt_count: number;
  max_attempts: number;
};

type DailyDigestOrderRow = {
  id: string;
  order_number: string;
  customer_snapshot: Record<string, unknown> | null;
  submitted_at: string;
  requested_delivery_date: string | null;
  delivery_note: string | null;
  customer_note: string | null;
};

type DailyDigestItemRow = {
  order_id: string;
  product_name: string;
  unit: string;
  ordered_quantity: number | string;
  exchange_quantity: number | string;
  makeup_quantity: number | string;
  physical_quantity: number | string;
  route_customer_name: string | null;
  route_note: string | null;
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

const quantity = (value: number | string | null | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const signedQuantity = (value: number | string | null | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

type DailyBreadDealerOrderRow = { id: string };
type DailyBreadDealerItemRow = {
  id: string;
  order_id: string;
  ordered_quantity: number | string | null;
  quantity: number | string;
  exchange_quantity: number | string | null;
  makeup_quantity: number | string | null;
};
type DailyBreadVehicleHistoryRow = {
  location_id: string;
  location_code: string;
  report_date: string | null;
  sold_quantity: number | string | null;
  closing_quantity: number | string | null;
};
type DailyBreadVietjetQuantityRow = {
  quantity: number | string;
  inbox_id: string;
  received_at: string;
};

const enqueueDailyBreadOrder = async (
  supabase: ReturnType<typeof createServiceClient>,
  now: Date,
): Promise<{ id: string; messageBody: string }> => {
  const dayRange = warehouseVietnamDayRange(now);
  const orderDate = nextVietnamDateKey(now);
  if (!dayRange || !orderDate) throw new Error("Unable to resolve Vietnam bread-order date");

  const { data: dealerOrderData, error: dealerOrderError } = await supabase
    .from("dealer_orders")
    .select("id")
    .eq("requested_delivery_date", orderDate)
    .neq("status", "cancelled");
  if (dealerOrderError) throw new Error(`Unable to read dealer bread orders: ${dealerOrderError.message}`);
  const dealerOrders = (dealerOrderData || []) as DailyBreadDealerOrderRow[];

  let dealerItems: DailyBreadDealerItemRow[] = [];
  if (dealerOrders.length > 0) {
    const { data, error } = await supabase
      .from("dealer_order_items")
      .select("id,order_id,ordered_quantity,quantity,exchange_quantity,makeup_quantity")
      .in("order_id", dealerOrders.map((order) => order.id))
      .eq("sku_code", "BMQ-001");
    if (error) throw new Error(`Unable to read dealer bread-order items: ${error.message}`);
    dealerItems = (data || []) as DailyBreadDealerItemRow[];
  }
  const dealerOrderedQuantity = dealerItems.reduce(
    (sum, item) => sum + quantity(item.ordered_quantity ?? item.quantity),
    0,
  );
  const dealerExtraQuantity = dealerItems.reduce(
    (sum, item) => sum + quantity(item.exchange_quantity ?? 0) + quantity(item.makeup_quantity ?? 0),
    0,
  );

  const { data: vehicleHistoryData, error: vehicleHistoryError } = await supabase.rpc(
    "get_daily_bread_vehicle_history",
    { p_cutoff_date: dayRange.dateKey },
  );
  if (vehicleHistoryError) {
    throw new Error(`Unable to read kiosk vehicle history: ${vehicleHistoryError.message}`);
  }
  const vehicleHistory = (vehicleHistoryData || []) as DailyBreadVehicleHistoryRow[];
  if (vehicleHistory.length === 0) throw new Error("No active kiosk locations available for vehicle forecast");

  const vehicleLocations = new Map<string, {
    locationId: string;
    locationCode: string;
    reports: Array<{ reportDate: string; soldQuantity: number; closingQuantity: number }>;
  }>();
  vehicleHistory.forEach((row) => {
    const location = vehicleLocations.get(row.location_id) || {
      locationId: row.location_id,
      locationCode: row.location_code,
      reports: [],
    };
    if (row.report_date) {
      location.reports.push({
        reportDate: row.report_date,
        soldQuantity: quantity(row.sold_quantity),
        closingQuantity: signedQuantity(row.closing_quantity),
      });
    }
    vehicleLocations.set(row.location_id, location);
  });
  const vehicleForecast = forecastVehicleBread([...vehicleLocations.values()]);

  const { data: vietjetData, error: vietjetError } = await supabase.rpc(
    "get_latest_vietjet_bread_quantity",
    { p_order_date: orderDate },
  );
  if (vietjetError) throw new Error(`Unable to read VietJet parsed orders: ${vietjetError.message}`);
  const vietjetRow = ((vietjetData || []) as DailyBreadVietjetQuantityRow[])[0] || null;
  const vietjet = {
    quantity: quantity(vietjetRow?.quantity ?? 0),
    inboxId: vietjetRow?.inbox_id || null,
    receivedAt: vietjetRow?.received_at || null,
  };

  const rawTotalBmq = dealerOrderedQuantity + dealerExtraQuantity + vehicleForecast.totalQuantity;
  const roundedTotalBmq = roundBreadOrderMessageQuantity(rawTotalBmq);
  const roundedVietjet = roundBreadOrderMessageQuantity(vietjet.quantity);
  const messageBody = buildDailyBreadOrderMessage({
    orderDate,
    dealerOrderedQuantity,
    dealerExtraQuantity,
    vehicleQuantity: vehicleForecast.totalQuantity,
    vietjetQuantity: vietjet.quantity,
  });
  if (dealerOrderedQuantity + dealerExtraQuantity + vehicleForecast.totalQuantity + vietjet.quantity <= 0) {
    throw new Error("Daily bread order has no positive quantity");
  }

  const sourceSnapshot = {
    cutoff_at: now.toISOString(),
    cutoff_timezone: "Asia/Ho_Chi_Minh",
    order_date: orderDate,
    rounding: {
      rule: "ceil-to-multiple-10-v1",
      applies_to: ["total_bmq", "vietjet"],
      total_bmq: { raw_quantity: rawTotalBmq, sent_quantity: roundedTotalBmq },
      vietjet: { raw_quantity: vietjet.quantity, sent_quantity: roundedVietjet },
    },
    dealer: {
      source: "dathang.banhmique.vn",
      sku_code: "BMQ-001",
      order_ids: dealerOrders.map((order) => order.id),
      item_ids: dealerItems.map((item) => item.id),
      ordered_quantity: dealerOrderedQuantity,
      extra_quantity: dealerExtraQuantity,
    },
    vehicle: {
      source: "baocao.banhmique.vn",
      formula_version: vehicleForecast.formulaVersion,
      total_quantity: vehicleForecast.totalQuantity,
      locations: vehicleForecast.locations,
      warnings: vehicleForecast.warnings,
    },
    vietjet: {
      source: "customer_po_inbox",
      product_code: "40000294",
      quantity: vietjet.quantity,
      inbox_id: vietjet.inboxId,
      received_at: vietjet.receivedAt,
    },
    coop: { included: false },
  };

  const { data: notificationId, error: queueError } = await supabase.rpc("upsert_daily_bread_order_notification", {
    p_order_date: orderDate,
    p_message_body: messageBody,
    p_source_snapshot: sourceSnapshot,
  });
  if (queueError) throw new Error(`Unable to queue daily bread order: ${queueError.message}`);
  return { id: String(notificationId || ""), messageBody };
};

const enqueueWarehouseDailyDigests = async (
  supabase: ReturnType<typeof createServiceClient>,
  now: Date,
): Promise<number> => {
  const range = warehouseVietnamDayRange(now);
  if (!range) return 0;

  const { data: orderData, error: orderError } = await supabase
    .from("dealer_orders")
    .select("id,order_number,customer_snapshot,submitted_at,requested_delivery_date,delivery_note,customer_note")
    .gte("submitted_at", range.startsAt)
    .lt("submitted_at", range.endsBefore)
    .neq("status", "cancelled")
    .order("submitted_at", { ascending: true });
  if (orderError) throw new Error(`Unable to read daily dealer orders: ${orderError.message}`);

  const orderRows = (orderData || []) as DailyDigestOrderRow[];
  if (orderRows.length === 0) return 0;

  const { data: itemData, error: itemError } = await supabase
    .from("dealer_order_items")
    .select(
      "order_id,product_name,unit,ordered_quantity,exchange_quantity,makeup_quantity,physical_quantity,route_customer_name,route_note,created_at",
    )
    .in("order_id", orderRows.map((order) => order.id))
    .order("created_at", { ascending: true });
  if (itemError) throw new Error(`Unable to read daily dealer order items: ${itemError.message}`);

  const itemsByOrder = new Map<string, DailyDigestItemRow[]>();
  ((itemData || []) as DailyDigestItemRow[]).forEach((item) => {
    const items = itemsByOrder.get(item.order_id) || [];
    items.push(item);
    itemsByOrder.set(item.order_id, items);
  });

  const orders: WarehouseOrderMessageInput[] = orderRows.map((order) => ({
    orderNumber: order.order_number,
    customerName: String(order.customer_snapshot?.name || order.order_number),
    submittedAt: order.submitted_at,
    requestedDeliveryDate: order.requested_delivery_date,
    deliveryNote: order.delivery_note,
    customerNote: order.customer_note,
    lines: (itemsByOrder.get(order.id) || []).map((item) => ({
      productName: item.product_name,
      unit: item.unit,
      orderedQuantity: quantity(item.ordered_quantity),
      exchangeQuantity: quantity(item.exchange_quantity),
      makeupQuantity: quantity(item.makeup_quantity),
      physicalQuantity: quantity(item.physical_quantity),
      routeCustomerName: item.route_customer_name,
      routeNote: item.route_note,
    })),
  })).filter((order) => order.lines.length > 0);
  if (orders.length === 0) return 0;

  const digestInput = {
    digestDate: range.dateKey,
    generatedAt: now.toISOString(),
    orders,
  };
  const dealerMessageBody = formatWarehouseDealerDailyDigest(digestInput);
  const pointMessageBody = formatWarehousePointDailyDigest(digestInput);
  if (dealerMessageBody.length > 10_000 || pointMessageBody.length > 10_000) {
    throw new Error("Daily digest exceeds the private outbox limit");
  }

  const { data, error } = await supabase.rpc("upsert_dealer_warehouse_daily_digests", {
    p_digest_date: range.dateKey,
    p_dealer_message_body: dealerMessageBody,
    p_point_message_body: pointMessageBody,
  });
  if (error) throw new Error(`Unable to queue daily warehouse digests: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
};

serve(async (req) => {
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!serviceRoleKey) return json({ success: false, error: "service_role_not_configured" }, 503);

  const supabase = createServiceClient();
  if (!await authorized(req, serviceRoleKey, supabase)) {
    return json({ success: false, error: "unauthorized" }, 401);
  }

  const now = new Date();
  if (!isWarehouseNotificationWindow(now)) {
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

  const warehouseGroupId = Deno.env.get("ZALO_GMF_WAREHOUSE_GROUP_ID");
  const tuyetAnhGroupId = Deno.env.get("ZALO_GMF_TUYET_ANH_GROUP_ID");
  if (!warehouseGroupId) {
    return json({ success: false, error: "zalo_gmf_group_not_configured" }, 503);
  }

  let digestsQueued = 0;
  let digestError: string | null = null;
  let breadOrderQueued = false;
  let breadOrderError: string | null = null;
  if (isWarehouseDailyDigestTime(now)) {
    try {
      digestsQueued = await enqueueWarehouseDailyDigests(supabase, now);
    } catch (error) {
      digestError = String(error instanceof Error ? error.message : error).slice(0, 500);
      console.error(`[dealer-warehouse-notify] Daily digest queue failed: ${digestError}`);
    }
    try {
      await enqueueDailyBreadOrder(supabase, now);
      breadOrderQueued = true;
    } catch (error) {
      breadOrderError = String(error instanceof Error ? error.message : error).slice(0, 500);
      console.error(`[dealer-warehouse-notify] Daily bread-order queue failed: ${breadOrderError}`);
    }
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
      const targetGroupId = job.group_name === "BMQ - HKD Tuyết Anh"
        ? tuyetAnhGroupId
        : warehouseGroupId;
      if (!targetGroupId) throw new Error(`Zalo GMF group is not configured for ${job.group_name}`);
      result = await sendZaloGmfText({
        accessToken,
        groupId: targetGroupId,
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

  return json({
    success: true,
    claimed: jobs.length,
    sent,
    retried,
    failed,
    digests: {
      notification_types: ["daily_dealer_digest", "daily_point_digest"],
      queued: digestsQueued,
      error: digestError,
    },
    production_bread_order: {
      notification_type: "production_bread_order",
      queued: breadOrderQueued,
      error: breadOrderError,
    },
  });
});
