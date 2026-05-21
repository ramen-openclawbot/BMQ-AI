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
};

type ProductSku = {
  id: string;
  sku_code: string;
  product_name: string;
  unit: string | null;
  unit_price: number | null;
};

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

    const skuIds = items.map((item) => item.sku_id);
    const { data: skus, error: skuError } = await supabase
      .from("product_skus")
      .select("id, sku_code, product_name, unit, unit_price")
      .eq("sku_type", "finished_good")
      .in("id", skuIds);

    if (skuError) throw skuError;

    const skuMap = new Map<string, ProductSku>();
    ((skus || []) as ProductSku[]).forEach((sku) => skuMap.set(sku.id, sku));

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

    const lines = items.map((item) => {
      const sku = skuMap.get(item.sku_id)!;
      const override = priceOverrides.get(item.sku_id);
      const unitPrice = override ?? Number(sku.unit_price || 0);
      const priceSource = override === undefined ? "sku_unit_price" : "customer_override";

      if (unitPrice <= 0) {
        throw new Error(`SKU ${sku.sku_code} chưa có giá bán hợp lệ.`);
      }

      const lineTotal = roundMoney(item.quantity * unitPrice);

      return {
        sku,
        quantity: item.quantity,
        unitPrice: roundMoney(unitPrice),
        lineTotal,
        priceSource,
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
          unit: line.sku.unit,
          quantity: line.quantity,
          unit_price_vnd: line.unitPrice,
          line_total_vnd: line.lineTotal,
          price_source: line.priceSource,
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

function normalizeItems(items: SubmitItemInput[] | undefined) {
  if (!Array.isArray(items)) return [];

  const quantitiesBySku = new Map<string, number>();
  items.forEach((item) => {
    const skuId = typeof item.sku_id === "string" ? item.sku_id.trim() : "";
    const quantity = Number(item.quantity);

    if (!skuId || !Number.isFinite(quantity) || quantity <= 0) return;
    quantitiesBySku.set(skuId, roundQuantity((quantitiesBySku.get(skuId) || 0) + quantity));
  });

  return Array.from(quantitiesBySku.entries())
    .slice(0, 50)
    .map(([sku_id, quantity]) => ({ sku_id, quantity }))
    .filter((item) => item.quantity > 0 && item.quantity <= 10000);
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

async function insertOrderWithRetry(supabase: any, payload: Record<string, unknown>) {
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
