/**
 * Pure server-side gates for the dealer cart assistant proposal.
 *
 * The model only ever supplies product ids and quantities. Everything the
 * dealer sees (SKU, name, unit, price) is filled from the dealer's own catalog
 * after the model answers, so invented products or prices can never reach the
 * client. No network access here.
 */

export const DEALER_ORDER_STEP = 10;
export const DEALER_CART_MAX_PER_LINE = 1000;
export const DEALER_CART_MAX_LINES = 60;

export type DealerCartCatalogItem = {
  id: string;
  sku_code?: string | null;
  product_name?: string | null;
  unit?: string | null;
  price_vnd?: number | string | null;
  unit_price?: number | string | null;
};

export type DealerCartLine = {
  product_id: string;
  sku_code: string;
  product_name: string;
  unit: string;
  unit_price: number;
  quantity: number;
};

export type NormalizeProposalOptions = {
  step?: number;
  maxPerLine?: number;
  maxLines?: number;
};

export type NormalizeProposalResult = {
  lines: DealerCartLine[];
  warnings: string[];
};

const positiveInteger = (value: unknown, fallback: number): number => {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeLookup = (value: string | null | undefined): string =>
  String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d");

const productLabel = (item: DealerCartCatalogItem, fallback: string): string =>
  String(item.product_name || item.sku_code || fallback);

export function normalizeProposal(
  rawLines: unknown,
  catalog: DealerCartCatalogItem[],
  opts: NormalizeProposalOptions = {},
): NormalizeProposalResult {
  const step = positiveInteger(opts.step, DEALER_ORDER_STEP);
  const maxPerLine = positiveInteger(opts.maxPerLine, DEALER_CART_MAX_PER_LINE);
  const maxLines = positiveInteger(opts.maxLines, DEALER_CART_MAX_LINES);
  const warnings: string[] = [];

  if (!Array.isArray(rawLines)) {
    warnings.push("Danh sách món trong giỏ không hợp lệ nên đã bỏ.");
    return { lines: [], warnings };
  }

  const byId = new Map<string, DealerCartCatalogItem>();
  const bySku = new Map<string, DealerCartCatalogItem>();
  catalog.forEach((item) => {
    if (item?.id) byId.set(String(item.id), item);
    const skuKey = normalizeLookup(item?.sku_code);
    if (skuKey) bySku.set(skuKey, item);
  });

  // Merge duplicate product ids before rounding so 3 + 4 becomes one 10-unit
  // line instead of two rounded lines.
  const merged = new Map<string, { product: DealerCartCatalogItem; quantity: number }>();

  rawLines.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      warnings.push(`Dòng ${index + 1} không hợp lệ nên đã bỏ.`);
      return;
    }

    const record = raw as Record<string, unknown>;
    const productId = typeof record.product_id === "string" ? record.product_id.trim() : "";
    const skuCode = typeof record.sku_code === "string" ? record.sku_code.trim() : "";
    const product = byId.get(productId) || bySku.get(normalizeLookup(skuCode));

    if (!product) {
      const label = skuCode || productId || `dòng ${index + 1}`;
      warnings.push(`Món "${label}" không có trong danh mục của đại lý nên đã bỏ.`);
      return;
    }

    const quantity = typeof record.quantity === "number"
      ? record.quantity
      : typeof record.quantity === "string" && record.quantity.trim() !== ""
      ? Number(record.quantity)
      : Number.NaN;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      warnings.push(`Số lượng của ${productLabel(product, `dòng ${index + 1}`)} không hợp lệ nên đã bỏ.`);
      return;
    }

    const existing = merged.get(String(product.id));
    if (existing) {
      existing.quantity += quantity;
      warnings.push(`Đã gộp dòng trùng cho ${productLabel(product, "món")}.`);
      return;
    }

    merged.set(String(product.id), { product, quantity });
  });

  const normalized: DealerCartLine[] = [];
  for (const { product, quantity: rawQuantity } of merged.values()) {
    const name = productLabel(product, "món");
    let quantity = Math.ceil(rawQuantity / step) * step;

    if (quantity !== rawQuantity) {
      warnings.push(`Số lượng ${name} đã làm tròn lên bội số ${step}.`);
    }

    if (quantity > maxPerLine) {
      quantity = maxPerLine;
      warnings.push(`Số lượng ${name} vượt ${maxPerLine} nên đã cắt còn ${maxPerLine}.`);
    }

    const price = Number(product.price_vnd ?? product.unit_price ?? 0);
    normalized.push({
      product_id: String(product.id),
      sku_code: String(product.sku_code || ""),
      product_name: String(product.product_name || product.sku_code || "Sản phẩm BMQ"),
      unit: String(product.unit || "đơn vị"),
      unit_price: Number.isFinite(price) && price >= 0 ? price : 0,
      quantity,
    });
  }

  const lines = normalized.slice(0, maxLines);
  if (normalized.length > maxLines) {
    warnings.push(`Chỉ giữ tối đa ${maxLines} dòng, đã bỏ ${normalized.length - maxLines} dòng.`);
  }

  return { lines, warnings };
}
