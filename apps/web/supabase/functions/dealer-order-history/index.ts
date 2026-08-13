import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  extractDealerSessionToken,
  jsonResponse,
  readJsonBody,
  resolveDealerSession,
} from "../_shared/dealer.ts";

const PAGE_SIZE = 10;
const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

type Granularity = "day" | "month" | "year";

type HistoryRequest = {
  dealer_token?: unknown;
  session_token?: unknown;
  granularity?: unknown;
  anchor?: unknown;
  page?: unknown;
  page_size?: unknown;
  order_number?: unknown;
};

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  currency: string;
  total_amount_vnd: number | string;
  requested_delivery_date: string | null;
  delivery_note: string | null;
  customer_note: string | null;
  submitted_at: string;
};

type ItemRow = {
  id: string;
  order_id: string;
  sku_code: string;
  product_name: string;
  unit: string | null;
  quantity: number | string;
  ordered_quantity: number | string | null;
  exchange_quantity: number | string;
  makeup_quantity: number | string;
  physical_quantity: number | string | null;
  unit_price_vnd: number | string;
  line_total_vnd: number | string;
  route_customer_name: string | null;
  route_note: string | null;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return errorResponse(req, "Method not allowed", 405, "method_not_allowed");

  try {
    const body = await readJsonBody<HistoryRequest>(req);
    const supabase = createServiceClient();
    const token = extractDealerSessionToken(body, req);
    const sessionContext = token ? await resolveDealerSession(supabase, token) : null;

    if (!sessionContext) {
      return errorResponse(req, "Phiên đại lý đã hết hạn. Vui lòng đăng nhập lại.", 401, "dealer_session_required");
    }

    const requestedOrderNumber = normalizeOrderNumber(body.order_number);
    if (body.order_number !== undefined && !requestedOrderNumber) {
      return errorResponse(req, "Mã đơn hàng không hợp lệ.", 400, "invalid_order_number");
    }

    if (requestedOrderNumber) {
      const { data: exactOrderRow, error: exactOrderError } = await supabase
        .from("dealer_orders")
        .select("id, order_number, status, currency, total_amount_vnd, requested_delivery_date, delivery_note, customer_note, submitted_at")
        .eq("customer_id", sessionContext.customer.id)
        .eq("order_number", requestedOrderNumber)
        .neq("status", "cancelled")
        .maybeSingle();
      if (exactOrderError) throw exactOrderError;
      if (!exactOrderRow) {
        return jsonResponse(req, { success: false, code: "order_not_found" }, 404);
      }

      const exactOrder = exactOrderRow as OrderRow;
      const { data: exactItemRows, error: exactItemsError } = await supabase
        .from("dealer_order_items")
        .select("id, order_id, sku_code, product_name, unit, quantity, ordered_quantity, exchange_quantity, makeup_quantity, physical_quantity, unit_price_vnd, line_total_vnd, route_customer_name, route_note")
        .eq("order_id", exactOrder.id)
        .order("created_at", { ascending: true });
      if (exactItemsError) throw exactItemsError;
      const exactItems = ((exactItemRows || []) as ItemRow[]).map(publicItem);
      return jsonResponse(req, { success: true, exact_order: publicOrder(exactOrder, exactItems) });
    }

    const granularity = normalizeGranularity(body.granularity);
    const anchor = normalizeAnchor(granularity, body.anchor);
    if (!anchor) {
      return errorResponse(req, "Khoảng thời gian không hợp lệ. Vui lòng chọn lại.", 400, "invalid_history_period");
    }

    const { start, end } = periodBoundaries(granularity, anchor);
    const page = Math.max(1, Math.floor(Number(body.page) || 1));
    const requestedPageSize = Math.max(1, Math.floor(Number(body.page_size) || PAGE_SIZE));
    const pageSize = Math.min(PAGE_SIZE, requestedPageSize);
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data: summaryRows, error: summaryError } = await supabase
      .rpc("dealer_order_history_summary", {
        p_customer_id: sessionContext.customer.id,
        p_start: start,
        p_end: end,
      });
    if (summaryError) throw summaryError;

    const { data: orderRows, error: orderError, count } = await supabase
      .from("dealer_orders")
      .select("id, order_number, status, currency, total_amount_vnd, requested_delivery_date, delivery_note, customer_note, submitted_at", { count: "exact" })
      .eq("customer_id", sessionContext.customer.id)
      .neq("status", "cancelled")
      .gte("submitted_at", start)
      .lt("submitted_at", end)
      .order("submitted_at", { ascending: false })
      .range(from, to);
    if (orderError) throw orderError;

    const orders = (orderRows || []) as OrderRow[];
    const orderIds = orders.map((order) => order.id);
    let items: ItemRow[] = [];

    if (orderIds.length > 0) {
      const { data: itemRows, error: itemError } = await supabase
        .from("dealer_order_items")
        .select("id, order_id, sku_code, product_name, unit, quantity, ordered_quantity, exchange_quantity, makeup_quantity, physical_quantity, unit_price_vnd, line_total_vnd, route_customer_name, route_note")
        .in("order_id", orderIds)
        .order("created_at", { ascending: true });
      if (itemError) throw itemError;
      items = (itemRows || []) as ItemRow[];
    }

    const itemsByOrder = new Map<string, ReturnType<typeof publicItem>[] >();
    items.forEach((item) => {
      const current = itemsByOrder.get(item.order_id) || [];
      current.push(publicItem(item));
      itemsByOrder.set(item.order_id, current);
    });

    const totalOrders = count || 0;
    const summary = Array.isArray(summaryRows) && summaryRows[0] ? summaryRows[0] : {};

    return jsonResponse(req, {
      success: true,
      period: { granularity, anchor, start, end, time_zone: VIETNAM_TIME_ZONE },
      summary: {
        order_count: Number(summary.order_count || 0),
        total_physical_quantity: Number(summary.total_physical_quantity || 0),
        total_amount_vnd: Number(summary.total_amount_vnd || 0),
      },
      pagination: {
        page,
        page_size: pageSize,
        total_orders: totalOrders,
        total_pages: Math.max(1, Math.ceil(totalOrders / pageSize)),
      },
      orders: orders.map((order) => publicOrder(order, itemsByOrder.get(order.id) || [])),
    });
  } catch (error) {
    console.error("[dealer-order-history] Unexpected error", error);
    return errorResponse(req, "Không tải được lịch sử đơn hàng. Vui lòng thử lại.", 500, "dealer_order_history_failed");
  }
});

function publicItem(item: ItemRow) {
  const orderedQuantity = numberValue(item.ordered_quantity ?? item.quantity);
  const exchangeQuantity = numberValue(item.exchange_quantity);
  const makeupQuantity = numberValue(item.makeup_quantity);
  const physicalQuantity = item.physical_quantity === null
    ? orderedQuantity + exchangeQuantity + makeupQuantity
    : numberValue(item.physical_quantity);

  return {
    id: item.id,
    sku_code: item.sku_code,
    product_name: item.product_name,
    unit: item.unit || "đơn vị",
    ordered_quantity: orderedQuantity,
    exchange_quantity: exchangeQuantity,
    makeup_quantity: makeupQuantity,
    physical_quantity: physicalQuantity,
    unit_price_vnd: numberValue(item.unit_price_vnd),
    line_total_vnd: numberValue(item.line_total_vnd),
    route_customer_name: item.route_customer_name,
    route_note: item.route_note,
  };
}

function publicOrder(order: OrderRow, items: ReturnType<typeof publicItem>[]) {
  return {
    id: order.id,
    order_number: order.order_number,
    status: order.status,
    currency: order.currency,
    total_amount_vnd: Number(order.total_amount_vnd || 0),
    requested_delivery_date: order.requested_delivery_date,
    delivery_note: order.delivery_note,
    customer_note: order.customer_note,
    submitted_at: order.submitted_at,
    physical_quantity: items.reduce((sum, item) => sum + item.physical_quantity, 0),
    items,
  };
}

function normalizeOrderNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Z0-9-]{6,80}$/i.test(normalized) ? normalized : null;
}

function normalizeGranularity(value: unknown): Granularity {
  return value === "day" || value === "year" ? value : "month";
}

function normalizeAnchor(granularity: Granularity, value: unknown): string | null {
  const supplied = typeof value === "string" ? value.trim() : "";
  const vietnamToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: VIETNAM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const anchor = supplied || (granularity === "day" ? vietnamToday : granularity === "month" ? vietnamToday.slice(0, 7) : vietnamToday.slice(0, 4));

  if (granularity === "year") return /^\d{4}$/.test(anchor) ? anchor : null;
  if (granularity === "month") {
    const match = anchor.match(/^(\d{4})-(\d{2})$/);
    return match && Number(match[2]) >= 1 && Number(match[2]) <= 12 ? anchor : null;
  }

  const match = anchor.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day ? anchor : null;
}

function periodBoundaries(granularity: Granularity, anchor: string) {
  const parts = anchor.split("-").map(Number);
  const year = parts[0];
  const month = granularity === "year" ? 1 : parts[1];
  const day = granularity === "day" ? parts[2] : 1;
  const startUtcMs = Date.UTC(year, month - 1, day) - VIETNAM_OFFSET_MS;
  let endUtcMs: number;

  if (granularity === "day") endUtcMs = Date.UTC(year, month - 1, day + 1) - VIETNAM_OFFSET_MS;
  else if (granularity === "month") endUtcMs = Date.UTC(year, month, 1) - VIETNAM_OFFSET_MS;
  else endUtcMs = Date.UTC(year + 1, 0, 1) - VIETNAM_OFFSET_MS;

  return { start: new Date(startUtcMs).toISOString(), end: new Date(endUtcMs).toISOString() };
}

function numberValue(value: number | string | null | undefined) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
