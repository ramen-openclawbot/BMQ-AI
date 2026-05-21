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
  unit: string | null;
  unit_price: number | null;
  notes: string | null;
  image_url?: string | null;
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
      .select("id, sku_code, product_name, category, unit, unit_price, notes, image_url")
      .eq("sku_type", "finished_good")
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

    const products = ((skus || []) as ProductSku[]).map((sku) => {
      const override = priceOverrides.get(sku.id);
      const price = override ?? Number(sku.unit_price || 0);

      return {
        id: sku.id,
        sku_code: sku.sku_code,
        product_name: sku.product_name,
        category: sku.category,
        unit: sku.unit,
        unit_price: Number(sku.unit_price || 0),
        price_vnd: price,
        price_source: override === undefined ? "sku_unit_price" : "customer_override",
        notes: sku.notes,
        image_url: sku.image_url ?? null,
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
