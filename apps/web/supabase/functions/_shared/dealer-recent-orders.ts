import type { createServiceClient, DealerSessionContext } from "./dealer.ts";

/**
 * Read-only recent order history for the dealer cart assistant. Only columns
 * needed to describe the last orders are selected; nothing is written here.
 */

type DealerServiceClient = ReturnType<typeof createServiceClient>;

export type DealerRecentOrderItem = {
  product_id: string | null;
  sku_code: string | null;
  product_name: string;
  unit: string;
  quantity: number;
  route_customer_id: string | null;
  route_customer_name: string | null;
  exchange_quantity: number;
  makeup_quantity: number;
  route_note: string | null;
};

export type DealerRecentOrder = {
  order_number: string;
  status: string;
  requested_delivery_date: string | null;
  submitted_at: string;
  items: DealerRecentOrderItem[];
};

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  requested_delivery_date: string | null;
  submitted_at: string;
};

type ItemRow = {
  order_id: string;
  sku_id: string | null;
  sku_code: string | null;
  product_name: string | null;
  unit: string | null;
  quantity: number | string | null;
  ordered_quantity: number | string | null;
  route_customer_id: string | null;
  route_customer_name: string | null;
  exchange_quantity: number | string | null;
  makeup_quantity: number | string | null;
  route_note: string | null;
};

const MAX_RECENT_ORDERS = 8;

const numberValue = (value: number | string | null | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function loadDealerRecentOrders(
  supabase: DealerServiceClient,
  session: DealerSessionContext,
  limit = MAX_RECENT_ORDERS,
): Promise<DealerRecentOrder[]> {
  const take = Math.min(MAX_RECENT_ORDERS, Math.max(1, Math.floor(Number(limit) || MAX_RECENT_ORDERS)));
  const isTestSession = session.contact?.is_test === true;

  const { data: orderRows, error: orderError } = await supabase
    .from("dealer_orders")
    .select("id, order_number, status, requested_delivery_date, submitted_at")
    .eq("customer_id", session.customer.id)
    .eq("is_test", isTestSession)
    .neq("status", "cancelled")
    .order("submitted_at", { ascending: false })
    .limit(take);

  if (orderError) throw orderError;

  const orders = (orderRows || []) as OrderRow[];
  if (orders.length === 0) return [];

  const orderIds = orders.map((order) => order.id);
  const { data: itemRows, error: itemError } = await supabase
    .from("dealer_order_items")
    .select("order_id, sku_id, sku_code, product_name, unit, quantity, ordered_quantity, route_customer_id, route_customer_name, exchange_quantity, makeup_quantity, route_note")
    .in("order_id", orderIds)
    .order("created_at", { ascending: true });

  if (itemError) throw itemError;

  const itemsByOrder = new Map<string, DealerRecentOrderItem[]>();
  ((itemRows || []) as ItemRow[]).forEach((item) => {
    const current = itemsByOrder.get(item.order_id) || [];
    current.push({
      product_id: item.sku_id || null,
      sku_code: item.sku_code || null,
      product_name: item.product_name || item.sku_code || "Sản phẩm BMQ",
      unit: item.unit || "đơn vị",
      quantity: numberValue(item.ordered_quantity ?? item.quantity),
      route_customer_id: item.route_customer_id || null,
      route_customer_name: item.route_customer_name || null,
      exchange_quantity: numberValue(item.exchange_quantity),
      makeup_quantity: numberValue(item.makeup_quantity),
      route_note: item.route_note || null,
    });
    itemsByOrder.set(item.order_id, current);
  });

  return orders.map((order) => ({
    order_number: order.order_number,
    status: order.status,
    requested_delivery_date: order.requested_delivery_date,
    submitted_at: order.submitted_at,
    items: itemsByOrder.get(order.id) || [],
  }));
}
