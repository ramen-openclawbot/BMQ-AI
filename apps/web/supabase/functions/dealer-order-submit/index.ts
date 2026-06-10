import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsPreflightResponse } from "../_shared/cors.ts";
import {
  createServiceClient,
  errorResponse,
  extractDealerSessionToken,
  jsonResponse,
  publicCustomerProfile,
  readJsonBody,
  resolveDealerSession,
} from "../_shared/dealer.ts";

type SubmitItemInput = {
  sku_id?: unknown;
  quantity?: unknown;
  ordered_quantity?: unknown;
  exchange_quantity?: unknown;
  makeup_quantity?: unknown;
  physical_quantity?: unknown;
  route_customer_id?: unknown;
  route_customer_name?: unknown;
  route_note?: unknown;
};

type NormalizedSubmitItem = {
  sku_id: string;
  quantity: number;
  exchange_quantity: number;
  makeup_quantity: number;
  physical_quantity: number;
  route_customer_id: string | null;
  route_customer_name: string | null;
  route_note: string | null;
};

type RouteCustomer = {
  id: string;
  customer_name: string | null;
};

type ProductSku = {
  id: string;
  sku_code: string;
  product_name: string;
  category?: string | null;
  sku_type?: "raw_material" | "finished_good" | null;
  unit: string | null;
  unit_price: number | null;
  cost_values?: Record<string, unknown> | null;
  hide_from_dealer_portal?: boolean | null;
};

const normalizeSkuText = (value: string | null | undefined) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d");

const isFinishedSku = (sku: ProductSku) => {
  if (sku.sku_type) return sku.sku_type === "finished_good";
  const category = normalizeSkuText(sku.category);
  return category.includes("thanh pham") || category.includes("finished");
};

const numberFromCostValues = (costValues: ProductSku["cost_values"], key: string) => {
  const value = costValues && typeof costValues === "object" ? costValues[key] : null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const dealerDisplayUnit = (sku: ProductSku) =>
  normalizeSkuText(`${sku.sku_code} ${sku.product_name}`).includes("banh mi que") ? "que" : (sku.unit || "đơn vị");

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = await readJsonBody<{
      dealer_token?: unknown;
      session_token?: unknown;
      items?: SubmitItemInput[];
      requested_delivery_date?: unknown;
      delivery_note?: unknown;
      customer_note?: unknown;
    }>(req);

    const supabase = createServiceClient();
    const token = extractDealerSessionToken(body, req);

    if (!token) {
      return errorResponse(req, "Vui lòng đăng nhập đại lý trước khi gửi đơn.", 401, "dealer_session_required");
    }

    const sessionContext = await resolveDealerSession(supabase, token);
    if (!sessionContext) {
      return errorResponse(req, "Phiên đại lý đã hết hạn. Vui lòng đăng nhập lại.", 401, "dealer_session_invalid");
    }

    const items = normalizeItems(body.items);
    if (!items.length) {
      return errorResponse(req, "Vui lòng chọn ít nhất một SKU.", 400, "empty_order");
    }

    const skuIds = Array.from(new Set(items.map((item) => item.sku_id)));
    const { data: skus, error: skuError } = await supabase
      .from("product_skus")
      .select("id, sku_code, product_name, category, sku_type, unit, unit_price, cost_values, hide_from_dealer_portal")
      .in("id", skuIds);

    if (skuError) throw skuError;

    const skuMap = new Map<string, ProductSku>();
    ((skus || []) as ProductSku[]).filter((sku) => isFinishedSku(sku) && !sku.hide_from_dealer_portal).forEach((sku) => skuMap.set(sku.id, sku));

    if (skuMap.size !== skuIds.length) {
      return errorResponse(req, "Một hoặc nhiều SKU không hợp lệ hoặc chưa thuộc nhóm thành phẩm.", 400, "invalid_sku");
    }

    const { data: priceRows, error: priceError } = await supabase
      .from("mini_crm_customer_price_list")
      .select("sku_id, price_vnd_per_unit")
      .eq("customer_id", sessionContext.customer.id)
      .eq("is_active", true)
      .in("sku_id", skuIds);

    if (priceError) throw priceError;

    const priceOverrides = new Map<string, number>();
    (priceRows || []).forEach((row: { sku_id: string; price_vnd_per_unit: number | string }) => {
      priceOverrides.set(row.sku_id, Number(row.price_vnd_per_unit || 0));
    });

    const requestedRouteIds = Array.from(new Set(items.map((item) => item.route_customer_id).filter(Boolean))) as string[];
    const routeMap = new Map<string, RouteCustomer>();
    if (requestedRouteIds.length > 0) {
      const { data: routeRows, error: routeError } = await supabase
        .from("mini_crm_customers")
        .select("id, customer_name")
        .eq("supplied_by_npp_customer_id", sessionContext.customer.id)
        .in("id", requestedRouteIds);
      if (routeError) throw routeError;
      ((routeRows || []) as RouteCustomer[]).forEach((route) => routeMap.set(route.id, route));
      if (routeMap.size !== requestedRouteIds.length) {
        return errorResponse(req, "Một hoặc nhiều điểm bán con không thuộc NPP đang đăng nhập.", 400, "invalid_dealer_route");
      }
    }

    const lines = items.map((item) => {
      const sku = skuMap.get(item.sku_id)!;
      const override = priceOverrides.get(item.sku_id);
      const unitPrice = override ?? numberFromCostValues(sku.cost_values, "selling_price");
      const priceSource = override === undefined ? "cost_values_selling_price" : "customer_override";

      if (unitPrice <= 0) {
        throw new Error(`SKU ${sku.sku_code} chưa có giá bán hợp lệ.`);
      }

      const lineTotal = roundMoney(item.quantity * unitPrice);

      const route = item.route_customer_id ? routeMap.get(item.route_customer_id) : null;

      return {
        sku,
        quantity: item.quantity,
        exchangeQuantity: item.exchange_quantity,
        makeupQuantity: item.makeup_quantity,
        physicalQuantity: item.physical_quantity,
        unitPrice: roundMoney(unitPrice),
        lineTotal,
        priceSource,
        routeCustomerId: item.route_customer_id,
        routeCustomerName: route?.customer_name || item.route_customer_name,
        routeNote: item.route_note,
      };
    });

    const subtotal = roundMoney(lines.reduce((sum, line) => sum + line.lineTotal, 0));
    const requestedDeliveryDate = normalizeDeliveryDate(body.requested_delivery_date);
    const deliveryNote = normalizeNullableText(body.delivery_note, 500);
    const customerNote = normalizeNullableText(body.customer_note, 500);
    const customerSnapshot = publicCustomerProfile(sessionContext.customer);

    const order = await insertOrderWithRetry(supabase, {
      customer_id: sessionContext.customer.id,
      contact_id: sessionContext.contact?.id ?? null,
      session_id: sessionContext.session.id,
      subtotal_amount_vnd: subtotal,
      total_amount_vnd: subtotal,
      requested_delivery_date: requestedDeliveryDate,
      delivery_note: deliveryNote,
      customer_note: customerNote,
      customer_snapshot: customerSnapshot,
    });

    const { error: itemError } = await supabase
      .from("dealer_order_items")
      .insert(
        lines.map((line) => ({
          order_id: order.id,
          sku_id: line.sku.id,
          sku_code: line.sku.sku_code,
          product_name: line.sku.product_name,
          unit: dealerDisplayUnit(line.sku),
          quantity: line.quantity,
          ordered_quantity: line.quantity,
          exchange_quantity: line.exchangeQuantity,
          makeup_quantity: line.makeupQuantity,
          physical_quantity: line.physicalQuantity,
          unit_price_vnd: line.unitPrice,
          line_total_vnd: line.lineTotal,
          price_source: line.priceSource,
          route_customer_id: line.routeCustomerId,
          route_customer_name: line.routeCustomerName,
          route_note: line.routeNote,
        })),
      );

    if (itemError) {
      await supabase.from("dealer_orders").delete().eq("id", order.id);
      throw itemError;
    }

    return jsonResponse(req, {
      success: true,
      order_id: order.id,
      order_number: order.order_number,
      total_amount_vnd: subtotal,
    });
  } catch (error) {
    console.error("[dealer-order-submit] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không gửi được đơn đại lý";
    const status = message.includes("chưa có giá") ? 400 : 500;
    return errorResponse(req, message, status, "dealer_order_submit_failed");
  }
});

function normalizeItems(items: SubmitItemInput[] | undefined): NormalizedSubmitItem[] {
  if (!Array.isArray(items)) return [];

  const quantitiesByLine = new Map<string, NormalizedSubmitItem>();
  items.forEach((item) => {
    const skuId = typeof item.sku_id === "string" ? item.sku_id.trim() : "";
    const quantity = Number(item.ordered_quantity ?? item.quantity);
    const exchangeQuantity = Math.max(0, Number(item.exchange_quantity || 0));
    const makeupQuantity = Math.max(0, Number(item.makeup_quantity || 0));
    const physicalQuantityInput = Number(item.physical_quantity);
    const physicalQuantity = Number.isFinite(physicalQuantityInput) && physicalQuantityInput > 0
      ? physicalQuantityInput
      : quantity + exchangeQuantity + makeupQuantity;
    const routeCustomerId = typeof item.route_customer_id === "string" && item.route_customer_id.trim()
      ? item.route_customer_id.trim()
      : null;
    const routeCustomerName = normalizeNullableText(item.route_customer_name, 160);
    const routeNote = normalizeNullableText(item.route_note, 180);

    if (!skuId || !Number.isFinite(quantity) || quantity < 0) return;
    if (!Number.isFinite(exchangeQuantity) || !Number.isFinite(makeupQuantity) || !Number.isFinite(physicalQuantity) || physicalQuantity <= 0) return;
    const key = `${skuId}::${routeCustomerId || "direct"}`;
    const current = quantitiesByLine.get(key);
    quantitiesByLine.set(key, {
      sku_id: skuId,
      quantity: roundQuantity((current?.quantity || 0) + quantity),
      exchange_quantity: roundQuantity((current?.exchange_quantity || 0) + exchangeQuantity),
      makeup_quantity: roundQuantity((current?.makeup_quantity || 0) + makeupQuantity),
      physical_quantity: roundQuantity((current?.physical_quantity || 0) + physicalQuantity),
      route_customer_id: routeCustomerId,
      route_customer_name: current?.route_customer_name || routeCustomerName,
      route_note: current?.route_note || routeNote,
    });
  });

  return Array.from(quantitiesByLine.values())
    .slice(0, 200)
    .filter((item) => item.physical_quantity > 0 && item.physical_quantity <= 10000 && item.quantity <= 10000);
}

function normalizeDeliveryDate(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeNullableText(value: unknown, maxLength: number): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, maxLength) : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundQuantity(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function insertOrderWithRetry(supabase: ReturnType<typeof createServiceClient>, payload: Record<string, unknown>) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const orderNumber = generateOrderNumber();
    const { data, error } = await supabase
      .from("dealer_orders")
      .insert({
        ...payload,
        order_number: orderNumber,
        status: "submitted",
      })
      .select("id, order_number")
      .single();

    if (!error) return data;
    lastError = error;

    if (!String(error.message || "").includes("duplicate key")) {
      break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Không tạo được mã đơn hàng");
}

function generateOrderNumber(): string {
  const dateStamp = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replace(/-/g, "");

  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

  return `DOP-${dateStamp}-${suffix}`;
}
