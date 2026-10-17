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
export const DEALER_CART_MAX_EXCHANGE = 500;
export const DEALER_CART_MAX_MAKEUP = 500;
export const DEALER_CART_NOTE_MAX_CHARS = 160;

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

export type DealerRouteRef = {
  id: string;
  name?: string | null;
};

export type DealerRouteLine = {
  route_id: string;
  route_name: string;
  product_id: string;
  sku_code: string;
  product_name: string;
  unit: string;
  unit_price: number;
  quantity: number;
  exchange_quantity: number;
  makeup_quantity: number;
  note: string;
  line_total: number;
};

export type NormalizeRouteProposalOptions = {
  step?: number;
  maxPerLine?: number;
  maxLines?: number;
  maxExchange?: number;
  maxMakeup?: number;
  maxNoteChars?: number;
};

export type NormalizeRouteProposalResult = {
  lines: DealerRouteLine[];
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

const routeNumber = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
};

const routeExtra = (
  value: unknown,
  label: string,
  productName: string,
  routeName: string,
  max: number,
  warnings: string[],
): number => {
  if (value === undefined || value === null || value === "") return 0;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    warnings.push(`${label} của ${productName} tại ${routeName} không hợp lệ nên đã bỏ.`);
    return 0;
  }

  let result = Math.max(0, Math.round(parsed));
  if (result !== parsed) {
    warnings.push(`${label} của ${productName} tại ${routeName} đã làm tròn.`);
  }

  if (result > max) {
    result = max;
    warnings.push(`${label} của ${productName} tại ${routeName} vượt ${max} nên đã cắt còn ${max}.`);
  }

  return result;
};

/**
 * Route-aware gate for NPP orders: one line per point of sale and product.
 * Route ids must belong to the NPP, products and prices always come from the
 * dealer catalog, and "đổi"/"bù" are free extras that never add to quantity.
 */
export function normalizeRouteProposal(
  rawLines: unknown,
  catalog: DealerCartCatalogItem[],
  routes: DealerRouteRef[],
  opts: NormalizeRouteProposalOptions = {},
): NormalizeRouteProposalResult {
  const step = positiveInteger(opts.step, DEALER_ORDER_STEP);
  const maxPerLine = positiveInteger(opts.maxPerLine, DEALER_CART_MAX_PER_LINE);
  const maxLines = positiveInteger(opts.maxLines, DEALER_CART_MAX_LINES);
  const maxExchange = positiveInteger(opts.maxExchange, DEALER_CART_MAX_EXCHANGE);
  const maxMakeup = positiveInteger(opts.maxMakeup, DEALER_CART_MAX_MAKEUP);
  const maxNoteChars = positiveInteger(opts.maxNoteChars, DEALER_CART_NOTE_MAX_CHARS);
  const warnings: string[] = [];

  if (!Array.isArray(rawLines)) {
    warnings.push("Danh sách điểm bán trong giỏ không hợp lệ nên đã bỏ.");
    return { lines: [], warnings };
  }

  const byId = new Map<string, DealerCartCatalogItem>();
  const bySku = new Map<string, DealerCartCatalogItem>();
  catalog.forEach((item) => {
    if (item?.id) byId.set(String(item.id), item);
    const skuKey = normalizeLookup(item?.sku_code);
    if (skuKey) bySku.set(skuKey, item);
  });

  const routesById = new Map<string, DealerRouteRef>();
  routes.forEach((route) => {
    if (route?.id) routesById.set(String(route.id), route);
  });

  const defaultProduct = bySku.get(normalizeLookup("BMQ-001")) || null;

  type MergedRouteLine = {
    route: DealerRouteRef;
    product: DealerCartCatalogItem;
    quantity: number;
    exchange: number;
    makeup: number;
    notes: string[];
  };
  const merged = new Map<string, MergedRouteLine>();

  rawLines.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      warnings.push(`Dòng ${index + 1} không hợp lệ nên đã bỏ.`);
      return;
    }

    const record = raw as Record<string, unknown>;
    const routeId = typeof record.route_id === "string" ? record.route_id.trim() : "";
    const route = routesById.get(routeId);
    const routeLabel = route?.name || routeId || `dòng ${index + 1}`;

    if (!route) {
      warnings.push(`Điểm bán "${routeLabel}" không có trong danh sách của NPP nên đã bỏ.`);
      return;
    }

    const productId = typeof record.product_id === "string" ? record.product_id.trim() : "";
    const skuCode = typeof record.sku_code === "string" ? record.sku_code.trim() : "";
    const product = byId.get(productId) || bySku.get(normalizeLookup(skuCode)) ||
      (!productId && !skuCode ? defaultProduct : null);

    if (!product) {
      const label = skuCode || productId || `dòng ${index + 1}`;
      warnings.push(`Món "${label}" không có trong danh mục của đại lý nên đã bỏ.`);
      return;
    }

    const quantity = routeNumber(record.quantity);
    const routeName = String(route.name || "Điểm bán");
    if (!Number.isFinite(quantity) || quantity < 0) {
      warnings.push(
        `Số lượng của ${productLabel(product, `dòng ${index + 1}`)} tại ${routeName} không hợp lệ nên đã bỏ.`,
      );
      return;
    }

    const exchange = routeExtra(
      record.exchange_quantity,
      "Số lượng đổi",
      productLabel(product, "món"),
      routeName,
      maxExchange,
      warnings,
    );
    const makeup = routeExtra(
      record.makeup_quantity,
      "Số lượng bù",
      productLabel(product, "món"),
      routeName,
      maxMakeup,
      warnings,
    );
    const note = typeof record.note === "string" ? record.note.trim() : "";
    const key = `${route.id}::${product.id}`;
    const existing = merged.get(key);

    if (existing) {
      existing.quantity += quantity;
      existing.exchange += exchange;
      existing.makeup += makeup;
      if (note) existing.notes.push(note);
      warnings.push(
        `Đã gộp dòng trùng cho ${productLabel(product, "món")} tại ${routeName}.`,
      );
      return;
    }

    merged.set(key, {
      route,
      product,
      quantity,
      exchange,
      makeup,
      notes: note ? [note] : [],
    });
  });

  const normalized: DealerRouteLine[] = [];
  for (const entry of merged.values()) {
    const name = productLabel(entry.product, "món");
    const routeName = String(entry.route.name || "Điểm bán");

    let quantity = Math.ceil(entry.quantity / step) * step;
    if (quantity !== entry.quantity) {
      warnings.push(`Số lượng ${name} tại ${routeName} đã làm tròn lên bội số ${step}.`);
    }

    if (quantity > maxPerLine) {
      quantity = maxPerLine;
      warnings.push(`Số lượng ${name} tại ${routeName} vượt ${maxPerLine} nên đã cắt còn ${maxPerLine}.`);
    }

    let exchange = entry.exchange;
    if (exchange > maxExchange) {
      exchange = maxExchange;
      warnings.push(`Số lượng đổi của ${name} tại ${routeName} vượt ${maxExchange} nên đã cắt còn ${maxExchange}.`);
    }

    let makeup = entry.makeup;
    if (makeup > maxMakeup) {
      makeup = maxMakeup;
      warnings.push(`Số lượng bù của ${name} tại ${routeName} vượt ${maxMakeup} nên đã cắt còn ${maxMakeup}.`);
    }

    if (quantity + exchange + makeup === 0) {
      warnings.push(`Dòng ${name} tại ${routeName} không có số lượng, đổi hay bù nên đã bỏ.`);
      continue;
    }

    let note = entry.notes.join("; ").trim();
    if (note.length > maxNoteChars) {
      note = note.slice(0, maxNoteChars);
      warnings.push(`Ghi chú của ${name} tại ${routeName} đã cắt còn ${maxNoteChars} ký tự.`);
    }

    const price = Number(entry.product.price_vnd ?? entry.product.unit_price ?? 0);
    const unitPrice = Number.isFinite(price) && price >= 0 ? price : 0;
    normalized.push({
      route_id: String(entry.route.id),
      route_name: routeName,
      product_id: String(entry.product.id),
      sku_code: String(entry.product.sku_code || ""),
      product_name: String(entry.product.product_name || entry.product.sku_code || "Sản phẩm BMQ"),
      unit: String(entry.product.unit || "đơn vị"),
      unit_price: unitPrice,
      quantity,
      exchange_quantity: exchange,
      makeup_quantity: makeup,
      note,
      line_total: quantity * unitPrice,
    });
  }

  const lines = normalized.slice(0, maxLines);
  if (normalized.length > maxLines) {
    warnings.push(`Chỉ giữ tối đa ${maxLines} dòng, đã bỏ ${normalized.length - maxLines} dòng.`);
  }

  return { lines, warnings };
}
