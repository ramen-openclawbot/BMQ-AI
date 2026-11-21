import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  extractDealerSessionToken,
  jsonResponse,
  readJsonBody,
  resolveDealerSessionWithLock,
} from "../_shared/dealer.ts";
import { dealerOrderLockedResponseBody } from "../_shared/dealer-order-lock.ts";
import {
  addDays,
  vietnamDateKey,
  vietnamDayStartIso,
} from "../_shared/dealer-report.ts";
import {
  computeHeoSummary,
  HEO_CAMPAIGN_CODE,
  HEO_NOV_BASELINE_DAYS,
  HEO_NOV_BASELINE_END,
  HEO_NOV_BASELINE_START,
  heoSpinShortfall,
  previewOrderExtra,
  type HeoDailyQuantity,
  type HeoSpinInput,
  type HeoSummary,
} from "../_shared/dealer-heo.ts";

const ORDER_PAGE_SIZE = 1000;
const ITEM_BATCH_SIZE = 200;
const ITEM_PAGE_SIZE = 1000;
const HEO_BASELINE_MONTH = "2026-11";

const HEO_ERROR_MESSAGES: Record<string, string> = {
  heo_order_not_found: "Không tìm thấy đơn hàng.",
  heo_order_not_eligible: "Đơn hàng chưa đủ điều kiện lắc Heo.",
  heo_outside_window: "Đơn hàng ngoài khung thời gian chương trình.",
  heo_spin_disabled: "Lắc Heo đang tắt.",
  heo_campaign_not_found: "Chương trình Heo Đất Tết chưa được cấu hình.",
  heo_not_enrolled: "Anh/chị cần bấm Tham gia chương trình trước khi lắc heo.",
  heo_invalid_status: "Trạng thái tham gia không hợp lệ.",
};

type CampaignRow = {
  id: string;
  code: string;
  title: string;
  starts_on: string;
  ends_on: string;
  break_on: string | null;
  test_starts_on: string | null;
  rate_per_extra_que_vnd: number;
  spin_enabled: boolean;
  spin_budget_vnd: number | string;
  weekly_jackpot_vnd: number;
  prizes: unknown;
  excluded_customer_ids: string[] | null;
};

type OrderRow = {
  id: string;
  status: string;
  requested_delivery_date: string | null;
  submitted_at: string;
  is_test: boolean;
};

type ItemRow = {
  id: string;
  order_id: string;
  quantity: number | string | null;
  sku_code: string;
};

type SpinRow = HeoSpinInput & { id?: string };

type DealerHeoEnrollment = {
  status: "none" | "joined" | "declined";
  joined_on: string | null;
};

type DealerHeoRequest = {
  dealer_token?: unknown;
  session_token?: unknown;
  action?: unknown;
  delivery_date?: unknown;
  quantity?: unknown;
  order_id?: unknown;
  order_number?: unknown;
};

type SupabaseServiceClient = ReturnType<typeof createServiceClient>;

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return errorResponse(req, "Method not allowed", 405, "method_not_allowed");

  try {
    const body = await readJsonBody<DealerHeoRequest>(req);
    const supabase = createServiceClient();
    const token = extractDealerSessionToken(body, req);
    const resolution = token ? await resolveDealerSessionWithLock(supabase, token) : null;

    if (resolution?.locked) {
      return jsonResponse(req, dealerOrderLockedResponseBody(), 423);
    }

    const sessionContext = resolution?.session ?? null;
    if (!sessionContext) {
      return errorResponse(req, "Phiên đại lý đã hết hạn. Vui lòng đăng nhập lại.", 401, "dealer_session_required");
    }

    const campaign = await loadCampaign(supabase);
    if (!campaign) {
      return errorResponse(
        req,
        HEO_ERROR_MESSAGES.heo_campaign_not_found,
        500,
        "heo_campaign_not_found",
      );
    }

    const isTest = sessionContext.contact?.is_test === true;
    const customerId = sessionContext.customer.id;
    const today = vietnamDateKey();
    const isExcluded = (campaign.excluded_customer_ids ?? []).includes(customerId);

    if (isExcluded || (!isTest && today < campaign.starts_on)) {
      return jsonResponse(req, { success: true, active: false });
    }

    const windowStart = isTest
      ? (campaign.test_starts_on ?? campaign.starts_on)
      : campaign.starts_on;
    const windowEnd = campaign.ends_on;
    const [baselineAvgPerDay, enrollment] = await Promise.all([
      loadBaseline(supabase, campaign.id, customerId),
      loadEnrollment(supabase, campaign.id, customerId, isTest),
    ]);
    const spinRequiredQuantity = requiredQueToSpin(baselineAvgPerDay);

    const action = typeof body.action === "string" ? body.action.trim() : "status";

    if (action === "status") {
      const summary = await loadSummary(supabase, {
        campaign,
        customerId,
        isTest,
        baselineAvgPerDay,
        windowStart,
        windowEnd,
        today,
        enrollment,
      });

      return jsonResponse(req, {
        success: true,
        active: true,
        campaign: publicCampaign(campaign, isTest),
        baseline_avg_per_day: baselineAvgPerDay,
        baseline_month: HEO_BASELINE_MONTH,
        spin_required_quantity: spinRequiredQuantity,
        enrollment,
        summary,
      });
    }

    if (action === "preview") {
      const deliveryDate = normalizeDateKey(body.delivery_date);
      const quantity = Number(body.quantity);

      if (!deliveryDate || !Number.isFinite(quantity) || quantity < 0) {
        return errorResponse(req, "Ngày giao hoặc số que không hợp lệ.", 400, "invalid_preview_input");
      }

      const existingDayQuantity = await loadDayQuantity(supabase, customerId, deliveryDate);
      const preview = previewOrderExtra({
        baselineAvgPerDay,
        existingDayQuantity,
        orderQuantity: quantity,
        ratePerExtraQue: campaign.rate_per_extra_que_vnd,
      });
      const shortfall = heoSpinShortfall({
        baselineAvgPerDay,
        orderQuantity: quantity,
      });

      return jsonResponse(req, {
        success: true,
        preview: {
          ...preview,
          spin_required_quantity: shortfall.required_quantity,
          spin_missing_quantity: shortfall.missing_quantity,
        },
      });
    }

    if (action === "enroll" || action === "decline") {
      const { data, error } = await supabase.rpc("dealer_heo_set_enrollment", {
        p_campaign_id: campaign.id,
        p_customer_id: customerId,
        p_is_test: isTest,
        p_status: action === "enroll" ? "joined" : "declined",
        p_today: today,
      });

      if (error) {
        const code = extractHeoErrorCode(error);
        if (code) {
          return errorResponse(req, HEO_ERROR_MESSAGES[code] ?? code, 409, code);
        }
        throw error;
      }

      const nextEnrollment = normalizeEnrollment(data);
      const summary = await loadSummary(supabase, {
        campaign,
        customerId,
        isTest,
        baselineAvgPerDay,
        windowStart,
        windowEnd,
        today,
        enrollment: nextEnrollment,
      });

      return jsonResponse(req, {
        success: true,
        enrollment: nextEnrollment,
        summary,
      });
    }

    if (action === "spin") {
      let orderId = typeof body.order_id === "string" ? body.order_id.trim() : "";
      const orderNumber = typeof body.order_number === "string" ? body.order_number.trim() : "";
      // The portal only knows the order number right after submit; resolve it
      // strictly inside this dealer's own orders.
      if (!orderId && /^[A-Z0-9-]{6,40}$/.test(orderNumber)) {
        const { data: orderRow, error: orderError } = await supabase
          .from("dealer_orders")
          .select("id")
          .eq("customer_id", customerId)
          .eq("order_number", orderNumber)
          .maybeSingle();
        if (orderError) throw orderError;
        orderId = (orderRow as { id?: string } | null)?.id ?? "";
        if (!orderId) return errorResponse(req, HEO_ERROR_MESSAGES.heo_order_not_found, 409, "heo_order_not_found");
      }
      if (!isUuid(orderId)) {
        return errorResponse(req, "Đơn hàng không hợp lệ.", 400, "invalid_order_id");
      }

      const { data, error } = await supabase.rpc("dealer_heo_spin", {
        p_campaign_id: campaign.id,
        p_customer_id: customerId,
        p_order_id: orderId,
        p_is_test: isTest,
        p_window_start: windowStart,
        p_window_end: windowEnd,
      });

      if (error) {
        const code = extractHeoErrorCode(error);
        if (code) {
          return errorResponse(req, HEO_ERROR_MESSAGES[code] ?? code, 409, code);
        }
        throw error;
      }

      const summary = await loadSummary(supabase, {
        campaign,
        customerId,
        isTest,
        baselineAvgPerDay,
        windowStart,
        windowEnd,
        today,
        enrollment,
      });

      return jsonResponse(req, { success: true, spin: data, summary });
    }

    return errorResponse(req, "Hành động không hợp lệ.", 400, "invalid_action");
  } catch (error) {
    console.error("[dealer-heo] Unexpected error", error);
    return errorResponse(
      req,
      "Không tải được chương trình Heo Đất Tết. Vui lòng thử lại.",
      500,
      "dealer_heo_failed",
    );
  }
});

function publicCampaign(campaign: CampaignRow, isTest: boolean) {
  return {
    title: campaign.title,
    starts_on: campaign.starts_on,
    ends_on: campaign.ends_on,
    break_on: campaign.break_on,
    rate: campaign.rate_per_extra_que_vnd,
    spin_enabled_for_me: campaign.spin_enabled === true || isTest,
    is_test: isTest,
    prizes: normalizePrizeLabels(campaign.prizes),
  };
}

function normalizePrizeLabels(prizes: unknown): { label: string }[] {
  if (!Array.isArray(prizes)) return [];
  return prizes.map((prize) => {
    const row = prize && typeof prize === "object" ? prize as Record<string, unknown> : {};
    return { label: String(row.label ?? "") };
  });
}

async function loadCampaign(supabase: SupabaseServiceClient): Promise<CampaignRow | null> {
  const { data, error } = await supabase
    .from("dealer_heo_campaigns")
    .select("*")
    .eq("code", HEO_CAMPAIGN_CODE)
    .maybeSingle();

  if (error) throw error;
  return (data as unknown as CampaignRow | null) ?? null;
}

async function loadBaseline(
  supabase: SupabaseServiceClient,
  campaignId: string,
  customerId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("dealer_heo_baselines")
    .select("baseline_avg_per_day")
    .eq("campaign_id", campaignId)
    .eq("customer_id", customerId)
    .maybeSingle();

  if (error) throw error;
  if (data) return toNumber((data as { baseline_avg_per_day?: unknown }).baseline_avg_per_day);

  // No baseline row yet: compute this dealer's November 2026 average on demand.
  const orders = await loadOrdersInRange(supabase, {
    customerId,
    isTest: false,
    start: HEO_NOV_BASELINE_START,
    end: HEO_NOV_BASELINE_END,
  });
  const items = await loadBmqItems(supabase, orders.map((order) => order.id));
  const total = items.reduce((sum, item) => sum + toNumber(item.quantity), 0);
  return total / HEO_NOV_BASELINE_DAYS;
}

async function loadEnrollment(
  supabase: SupabaseServiceClient,
  campaignId: string,
  customerId: string,
  isTest: boolean,
): Promise<DealerHeoEnrollment> {
  const { data, error } = await supabase
    .from("dealer_heo_enrollments")
    .select("status, joined_on")
    .eq("campaign_id", campaignId)
    .eq("customer_id", customerId)
    .eq("is_test", isTest)
    .maybeSingle();

  if (error) throw error;
  return normalizeEnrollment(data);
}

function normalizeEnrollment(value: unknown): DealerHeoEnrollment {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const status = row.status === "joined" || row.status === "declined" ? row.status : "none";

  return {
    status,
    joined_on: status === "none" ? null : normalizeDateKey(row.joined_on),
  };
}

function requiredQueToSpin(baselineAvgPerDay: number): number {
  return baselineAvgPerDay > 0 ? Math.ceil(baselineAvgPerDay) : 1;
}

async function loadSummary(
  supabase: SupabaseServiceClient,
  options: {
    campaign: CampaignRow;
    customerId: string;
    isTest: boolean;
    baselineAvgPerDay: number;
    windowStart: string;
    windowEnd: string;
    today: string;
    enrollment: DealerHeoEnrollment;
  },
): Promise<HeoSummary> {
  const base = {
    baselineAvgPerDay: options.baselineAvgPerDay,
    ratePerExtraQue: options.campaign.rate_per_extra_que_vnd,
    windowStart: options.windowStart,
    windowEnd: options.windowEnd,
    breakOn: options.campaign.break_on ?? options.campaign.ends_on,
    today: options.today,
  };

  // Dealers that have not joined (or declined) see no money at all, but still
  // see the countdown to the day the pig is broken.
  if (options.enrollment.status !== "joined") {
    return computeHeoSummary({ ...base, dailyQuantities: [], spins: [] });
  }

  const [dailyQuantities, spins] = await Promise.all([
    loadDailyQuantities(supabase, options.customerId, options.windowStart, options.windowEnd),
    loadSpins(supabase, options.campaign.id, options.customerId, options.isTest),
  ]);

  return computeHeoSummary({
    ...base,
    dailyQuantities,
    spins,
    joinedOn: options.enrollment.joined_on,
  });
}

/** Real, non-cancelled BMQ-001 que grouped by the order's delivery day. */
async function loadDailyQuantities(
  supabase: SupabaseServiceClient,
  customerId: string,
  windowStart: string,
  windowEnd: string,
): Promise<HeoDailyQuantity[]> {
  const orders = await loadOrdersInRange(supabase, {
    customerId,
    isTest: false,
    start: windowStart,
    end: windowEnd,
  });
  const items = await loadBmqItems(supabase, orders.map((order) => order.id));
  const orderDates = new Map<string, string>();

  orders.forEach((order) => {
    const date = deliveryDateKey(order);
    if (date) orderDates.set(order.id, date);
  });

  const daily = new Map<string, number>();
  items.forEach((item) => {
    const date = orderDates.get(item.order_id);
    if (!date) return;
    daily.set(date, (daily.get(date) ?? 0) + toNumber(item.quantity));
  });

  return [...daily.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, quantity]) => ({ date, quantity }));
}

async function loadDayQuantity(
  supabase: SupabaseServiceClient,
  customerId: string,
  deliveryDate: string,
): Promise<number> {
  const daily = await loadDailyQuantities(supabase, customerId, deliveryDate, deliveryDate);
  return daily.reduce((sum, row) => sum + toNumber(row.quantity), 0);
}

async function loadSpins(
  supabase: SupabaseServiceClient,
  campaignId: string,
  customerId: string,
  isTest: boolean,
): Promise<HeoSpinInput[]> {
  const spins: HeoSpinInput[] = [];

  for (let from = 0;; from += ORDER_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("dealer_heo_spins")
      .select("amount_vnd, bread_qty, prize_kind, is_jackpot, iso_week, created_at, order_id")
      .eq("campaign_id", campaignId)
      .eq("customer_id", customerId)
      .eq("is_test", isTest)
      .order("created_at", { ascending: false })
      .order("order_id", { ascending: false })
      .range(from, from + ORDER_PAGE_SIZE - 1);

    if (error) throw error;
    const batch = (data ?? []) as unknown as SpinRow[];
    spins.push(...batch);
    if (batch.length < ORDER_PAGE_SIZE) break;
  }

  return spins;
}

async function loadOrdersInRange(
  supabase: SupabaseServiceClient,
  options: { customerId: string; isTest: boolean; start: string; end: string },
): Promise<OrderRow[]> {
  const startIso = vietnamDayStartIso(options.start);
  const endExclusiveIso = vietnamDayStartIso(addDays(options.end, 1));
  const deliveryFilter = [
    `and(requested_delivery_date.gte.${options.start},requested_delivery_date.lte.${options.end})`,
    `and(requested_delivery_date.is.null,submitted_at.gte.${startIso},submitted_at.lt.${endExclusiveIso})`,
  ].join(",");
  const orders: OrderRow[] = [];

  for (let from = 0;; from += ORDER_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("dealer_orders")
      .select("id, status, requested_delivery_date, submitted_at, is_test")
      .eq("customer_id", options.customerId)
      .eq("is_test", options.isTest)
      .neq("status", "cancelled")
      .or(deliveryFilter)
      .order("id", { ascending: true })
      .range(from, from + ORDER_PAGE_SIZE - 1);

    if (error) throw error;
    const batch = (data ?? []) as unknown as OrderRow[];
    orders.push(...batch);
    if (batch.length < ORDER_PAGE_SIZE) break;
  }

  return orders;
}

async function loadBmqItems(
  supabase: SupabaseServiceClient,
  orderIds: string[],
): Promise<ItemRow[]> {
  const items: ItemRow[] = [];

  for (let offset = 0; offset < orderIds.length; offset += ITEM_BATCH_SIZE) {
    const batchIds = orderIds.slice(offset, offset + ITEM_BATCH_SIZE);

    for (let from = 0;; from += ITEM_PAGE_SIZE) {
      const { data, error } = await supabase
        .from("dealer_order_items")
        .select("id, order_id, quantity, sku_code")
        .in("order_id", batchIds)
        .eq("sku_code", "BMQ-001")
        .order("id", { ascending: true })
        .range(from, from + ITEM_PAGE_SIZE - 1);

      if (error) throw error;
      const batch = (data ?? []) as unknown as ItemRow[];
      items.push(...batch);
      if (batch.length < ITEM_PAGE_SIZE) break;
    }
  }

  return items;
}

function deliveryDateKey(order: OrderRow): string | null {
  if (order.requested_delivery_date) return order.requested_delivery_date.slice(0, 10);
  const submitted = new Date(order.submitted_at);
  if (Number.isNaN(submitted.getTime())) return null;
  return vietnamDateKey(submitted);
}

function normalizeDateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function extractHeoErrorCode(error: { message?: string; details?: string; hint?: string }): string | null {
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  return Object.keys(HEO_ERROR_MESSAGES).find((code) => text.includes(code)) ?? null;
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
