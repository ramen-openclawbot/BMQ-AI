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
  addMonths,
  buildDealerReport,
  type DealerReportRow,
  isReportMonthAllowed,
  isValidReportMonth,
  monthEndKey,
  monthStartKey,
  vietnamDateKey,
  vietnamDayStartIso,
} from "../_shared/dealer-report.ts";

const ORDER_PAGE_SIZE = 1000;
const ITEM_BATCH_SIZE = 200;
const ITEM_PAGE_SIZE = 1000;
const WEEKDAY_LOOKBACK_DAYS = 56;

type DealerReportRequest = {
  dealer_token?: unknown;
  session_token?: unknown;
  month?: unknown;
};

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  requested_delivery_date: string | null;
  submitted_at: string;
};

type ItemRow = {
  id: string;
  order_id: string;
  route_customer_name: string | null;
  quantity: number | string | null;
  exchange_quantity: number | string | null;
  makeup_quantity: number | string | null;
  line_total_vnd: number | string | null;
};

type SupabaseServiceClient = ReturnType<typeof createServiceClient>;

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return errorResponse(req, "Method not allowed", 405, "method_not_allowed");

  try {
    const body = await readJsonBody<DealerReportRequest>(req);
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

    const today = vietnamDateKey();
    const month = normalizeReportMonth(body.month, today);
    if (!month || !isReportMonthAllowed(month, today)) {
      return errorResponse(
        req,
        "Tháng báo cáo không hợp lệ. Vui lòng chọn tháng trong 24 tháng gần nhất.",
        400,
        "invalid_report_month",
      );
    }

    const currentMonth = today.slice(0, 7);
    const endDate = month === currentMonth ? today : monthEndKey(month);
    const fetchStart = addDays(monthStartKey(addMonths(month, -2)), -WEEKDAY_LOOKBACK_DAYS);
    const fetchEndExclusive = vietnamDayStartIso(addDays(endDate, 1));
    const deliveryFilter = [
      `and(requested_delivery_date.gte.${fetchStart},requested_delivery_date.lte.${endDate})`,
      `and(requested_delivery_date.is.null,submitted_at.gte.${vietnamDayStartIso(fetchStart)},submitted_at.lt.${fetchEndExclusive})`,
    ].join(",");

    const orders = await loadOrders(supabase, {
      customerId: sessionContext.customer.id,
      isTest: sessionContext.contact?.is_test === true,
      filter: deliveryFilter,
    });

    const items = await loadOrderItems(supabase, orders.map((order) => order.id));
    const rows = buildRows(orders, items);
    const report = buildDealerReport({
      rows,
      isNpp: sessionContext.customer.is_npp === true,
      month,
      today,
    });

    return jsonResponse(req, { success: true, report });
  } catch (error) {
    console.error("[dealer-report] Unexpected error", error);
    return errorResponse(req, "Không tải được báo cáo đại lý. Vui lòng thử lại.", 500, "dealer_report_failed");
  }
});

function normalizeReportMonth(value: unknown, today: string): string | null {
  if (value === undefined || value === null) return today.slice(0, 7);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return today.slice(0, 7);
  return isValidReportMonth(normalized) ? normalized : null;
}

async function loadOrders(
  supabase: SupabaseServiceClient,
  options: { customerId: string; isTest: boolean; filter: string },
): Promise<OrderRow[]> {
  const orders: OrderRow[] = [];

  for (let from = 0;; from += ORDER_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("dealer_orders")
      .select("id, order_number, status, requested_delivery_date, submitted_at")
      .eq("customer_id", options.customerId)
      .eq("is_test", options.isTest)
      .neq("status", "cancelled")
      .or(options.filter)
      .order("id", { ascending: true })
      .range(from, from + ORDER_PAGE_SIZE - 1);

    if (error) throw error;
    const batch = (data || []) as OrderRow[];
    orders.push(...batch);
    if (batch.length < ORDER_PAGE_SIZE) break;
  }

  return orders;
}

async function loadOrderItems(supabase: SupabaseServiceClient, orderIds: string[]): Promise<ItemRow[]> {
  const items: ItemRow[] = [];

  for (let offset = 0; offset < orderIds.length; offset += ITEM_BATCH_SIZE) {
    const batchIds = orderIds.slice(offset, offset + ITEM_BATCH_SIZE);

    for (let from = 0;; from += ITEM_PAGE_SIZE) {
      const { data, error } = await supabase
        .from("dealer_order_items")
        .select("id, order_id, route_customer_name, quantity, exchange_quantity, makeup_quantity, line_total_vnd")
        .in("order_id", batchIds)
        .order("id", { ascending: true })
        .range(from, from + ITEM_PAGE_SIZE - 1);

      if (error) throw error;
      const batch = (data || []) as ItemRow[];
      items.push(...batch);
      if (batch.length < ITEM_PAGE_SIZE) break;
    }
  }

  return items;
}

function buildRows(orders: OrderRow[], items: ItemRow[]): DealerReportRow[] {
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const rows: DealerReportRow[] = [];

  items.forEach((item) => {
    const order = orderById.get(item.order_id);
    if (!order) return;

    rows.push({
      order_number: order.order_number,
      status: order.status,
      requested_delivery_date: order.requested_delivery_date,
      submitted_at: order.submitted_at,
      route_customer_name: item.route_customer_name,
      quantity: item.quantity,
      exchange_quantity: item.exchange_quantity,
      makeup_quantity: item.makeup_quantity,
      line_total_vnd: item.line_total_vnd,
    });
  });

  return rows;
}
