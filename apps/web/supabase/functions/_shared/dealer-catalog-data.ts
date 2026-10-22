import type { createServiceClient, DealerSessionContext } from "./dealer.ts";

/**
 * Shared dealer catalog read used by dealer-catalog and dealer-cart-assistant.
 * The output fields and ordering must stay identical to the dealer-catalog
 * response so the portal keeps seeing the same products and the assistant only
 * ever proposes items this dealer can actually order.
 */

type DealerServiceClient = ReturnType<typeof createServiceClient>;

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
  discontinued_at?: string | null;
};

type ProductLabelSpec = {
  sku_id: string;
  shelf_life_days: number | null;
  net_weight_value: number | string | null;
  net_weight_unit: string | null;
};

export type DealerCatalogProduct = {
  id: string;
  sku_code: string;
  product_name: string;
  category: string | null;
  unit: string;
  unit_price: number;
  price_vnd: number;
  price_source: "cost_values_selling_price" | "customer_override";
  notes: string;
  image_url: string | null;
  image_path: string | null;
  image_updated_at: string | null;
  shelf_life_days: number | null;
  net_weight_value: number | string | null;
  net_weight_unit: string | null;
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

const dealerProductNames: Record<string, string> = {
  "bmcb-2026-v2": "Bánh Mì Chà Bông",
  "BMD-2026": "Bánh Mì Dark Rye",
  "BMQ-001": "Bánh Mì Que Pate",
  "cbc-2026-v2": "Bánh Mì Chà Bông Cay",
  "cpm-2026-v3": "Bánh Cua Phô Mai",
  "Croi-2026-v4": "Bánh Croissant 50g",
  "KF-CROFFLE-40G-T0526": "Croffle 40g",
  "KF-CROISSANT-40G-T0526": "Bánh Croissant 160g (40g x 4 cái)",
  "KF-XUCXICH-PHOMAI-40G-T0526": "Bánh Xúc Xích Phô Mai 40g",
  "rbn-2026-v5": "Bánh Cross Bun Nho",
  "rbso-2026-v6": "Bánh Cross Bun Socola",
  "SWD-2026": "Dark Rye Sandwich",
};

const dealerDisplayName = (sku: ProductSku) => dealerProductNames[sku.sku_code] || sku.product_name;
const dealerDisplayUnit = (sku: ProductSku) =>
  normalizeSkuText(`${sku.sku_code} ${dealerDisplayName(sku)}`).includes("banh mi que") ? "que" : (sku.unit || "đơn vị");

export async function loadDealerCatalog(
  supabase: DealerServiceClient,
  session: DealerSessionContext,
): Promise<DealerCatalogProduct[]> {
  const { data: skus, error: skuError } = await supabase
    .from("product_skus")
    .select("id, sku_code, product_name, category, sku_type, unit, unit_price, cost_values, notes, image_url, image_path, image_updated_at, hide_from_dealer_portal, discontinued_at")
    .order("sku_code", { ascending: true });

  if (skuError) throw skuError;

  const eligibleSkus = ((skus || []) as ProductSku[])
    .filter((sku) => isFinishedSku(sku) && !sku.hide_from_dealer_portal && !sku.discontinued_at);
  const skuIds = eligibleSkus.map((sku) => sku.id).filter(Boolean);
  const labelSpecBySkuId = new Map<string, ProductLabelSpec>();
  if (skuIds.length > 0) {
    const { data: labelSpecs, error: labelSpecError } = await supabase
      .from("product_label_specs")
      .select("sku_id, shelf_life_days, net_weight_value, net_weight_unit")
      .in("sku_id", skuIds);

    if (labelSpecError) throw labelSpecError;
    ((labelSpecs || []) as ProductLabelSpec[]).forEach((spec) => {
      if (spec.sku_id) labelSpecBySkuId.set(spec.sku_id, spec);
    });
  }

  const priceOverrides = new Map<string, number>();
  {
    const { data: prices, error: priceError } = await supabase
      .from("mini_crm_customer_price_list")
      .select("sku_id, price_vnd_per_unit")
      .eq("customer_id", session.customer.id)
      .eq("is_active", true);

    if (priceError) throw priceError;

    (prices || []).forEach((row: { sku_id: string; price_vnd_per_unit: number | string }) => {
      priceOverrides.set(row.sku_id, Number(row.price_vnd_per_unit || 0));
    });
  }

  return eligibleSkus.flatMap((sku) => {
    const override = priceOverrides.get(sku.id);
    const skuSellingPrice = numberFromCostValues(sku.cost_values, "selling_price");
    const price = override ?? skuSellingPrice;
    const labelSpec = labelSpecBySkuId.get(sku.id);

    if (!Number.isFinite(price) || price <= 0) return [];

    return [{
      id: sku.id,
      sku_code: sku.sku_code,
      product_name: dealerDisplayName(sku),
      category: sku.category,
      unit: dealerDisplayUnit(sku),
      unit_price: skuSellingPrice,
      price_vnd: price,
      price_source: override === undefined ? "cost_values_selling_price" : "customer_override",
      notes: "Sản phẩm thành phẩm BMQ.",
      image_url: sku.image_url ?? null,
      image_path: sku.image_path ?? null,
      image_updated_at: sku.image_updated_at ?? null,
      shelf_life_days: labelSpec?.shelf_life_days ?? null,
      net_weight_value: labelSpec?.net_weight_value ?? null,
      net_weight_unit: labelSpec?.net_weight_unit ?? null,
    }];
  });
}
