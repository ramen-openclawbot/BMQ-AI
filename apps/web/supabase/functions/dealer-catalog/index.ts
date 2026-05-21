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

type ProductSku = {
  id: string;
  sku_code: string;
  product_name: string;
  category: string | null;
  sku_type?: "raw_material" | "finished_good" | null;
  unit: string | null;
  unit_price: number | null;
  cost_values?: Record<string, unknown> | null;
  notes: string | null;
  image_url?: string | null;
  image_path?: string | null;
  image_updated_at?: string | null;
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse(req, "Method not allowed", 405, "method_not_allowed");
  }

  try {
    const body = req.method === "POST" ? await readJsonBody<Record<string, unknown>>(req) : {};
    const supabase = createServiceClient();
    const token = extractDealerSessionToken(body, req);
    const sessionContext = token ? await resolveDealerSession(supabase, token) : null;

    if (!sessionContext) {
      return errorResponse(req, "Phiên đại lý đã hết hạn. Vui lòng đăng nhập lại để xem catalog.", 401, "dealer_session_required");
    }

    const { data: skus, error: skuError } = await supabase
      .from("product_skus")
      .select("id, sku_code, product_name, category, sku_type, unit, unit_price, cost_values, notes, image_url, image_path, image_updated_at, hide_from_dealer_portal")
      .order("sku_code", { ascending: true });

    if (skuError) throw skuError;

    const priceOverrides = new Map<string, number>();
    if (sessionContext) {
      const { data: prices, error: priceError } = await supabase
        .from("mini_crm_customer_price_list")
        .select("sku_id, price_vnd_per_unit")
        .eq("customer_id", sessionContext.customer.id)
        .eq("is_active", true);

      if (priceError) throw priceError;

      (prices || []).forEach((row: { sku_id: string; price_vnd_per_unit: number | string }) => {
        priceOverrides.set(row.sku_id, Number(row.price_vnd_per_unit || 0));
      });
    }

    const products = ((skus || []) as ProductSku[]).filter((sku) => isFinishedSku(sku) && !sku.hide_from_dealer_portal).map((sku) => {
      const override = priceOverrides.get(sku.id);
      const skuSellingPrice = numberFromCostValues(sku.cost_values, "selling_price");
      const price = override ?? skuSellingPrice;

      return {
        id: sku.id,
        sku_code: sku.sku_code,
        product_name: sku.product_name,
        category: sku.category,
        unit: sku.unit,
        unit_price: skuSellingPrice,
        price_vnd: price,
        price_source: override === undefined ? "cost_values_selling_price" : "customer_override",
        notes: sku.notes,
        image_url: sku.image_url ?? null,
        image_path: sku.image_path ?? null,
        image_updated_at: sku.image_updated_at ?? null,
      };
    });

    const now = new Date().toISOString();
    const { data: announcements, error: announcementError } = await supabase
      .from("dealer_announcements")
      .select("id, title, body, severity, starts_at, ends_at")
      .eq("is_active", true)
      .or(`starts_at.is.null,starts_at.lte.${now}`)
      .or(`ends_at.is.null,ends_at.gt.${now}`)
      .order("created_at", { ascending: false });

    if (announcementError) throw announcementError;

    return jsonResponse(req, {
      success: true,
      products,
      announcements: announcements || [],
      customer: sessionContext ? publicCustomerProfile(sessionContext.customer) : null,
    });
  } catch (error) {
    console.error("[dealer-catalog] Unexpected error", error);
    const message = error instanceof Error ? error.message : "Không tải được catalog đại lý";
    return errorResponse(req, message, 500, "dealer_catalog_failed");
  }
});
