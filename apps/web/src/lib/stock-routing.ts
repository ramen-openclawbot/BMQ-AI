/**
 * Pure helpers for stock routing (Giai đoạn 3).
 *
 * Vietnamese labels for the receiving location and the fixed material category
 * codes, the two auto-apply thresholds shared with the edge function
 * supabase/functions/stock-routing-jev and strict parsers for the JSON returned
 * by get_stock_routing_review and by the edge function.
 */

export const STOCK_ROUTING_LOCATIONS = ["q7", "tan_tao", "non_stock"] as const;
export type StockRoutingLocation = (typeof STOCK_ROUTING_LOCATIONS)[number];

export const STOCK_ROUTING_LOCATION_LABELS: Record<StockRoutingLocation, string> = {
  q7: "Kho Q7",
  tan_tao: "Kho Tân Tạo",
  non_stock: "Không nhập kho",
};

export function stockRoutingLocationLabel(value: string | null | undefined): string {
  if (value && (STOCK_ROUTING_LOCATIONS as readonly string[]).includes(value)) {
    return STOCK_ROUTING_LOCATION_LABELS[value as StockRoutingLocation];
  }
  return value ?? "";
}

export const MATERIAL_CATEGORY_LABELS: Record<string, string> = {
  flour: "Bột và ngũ cốc",
  dairy_fat: "Sữa, bơ, chất béo",
  eggs: "Trứng",
  sugar_additives: "Đường và phụ gia",
  meat_filling: "Nhân thịt, chả, pate",
  cheese: "Phô mai",
  vegetables: "Rau củ, gia vị",
  packaging: "Bao bì",
  supplies: "Vật tư, dụng cụ",
  service: "Dịch vụ, phí",
  other: "Khác",
};

export function materialCategoryLabel(value: string | null | undefined): string {
  if (value && value in MATERIAL_CATEGORY_LABELS) return MATERIAL_CATEGORY_LABELS[value];
  return value ?? "";
}

/** Shared auto-apply thresholds with the edge function. */
export const STOCK_ROUTING_ROUTE_THRESHOLD = 0.9;
export const STOCK_ROUTING_CATEGORY_THRESHOLD = 0.85;

/**
 * A supplier route auto-applies at probability >= 0.9, unless the deterministic
 * rule_hint disagrees with the Jev result.
 */
export function shouldAutoApplyRouting(
  probability: number,
  ruleHint: string | null | undefined,
  result: string | null | undefined,
): boolean {
  if (!Number.isFinite(probability) || probability < STOCK_ROUTING_ROUTE_THRESHOLD) return false;
  if (ruleHint === null || ruleHint === undefined || ruleHint === "") return true;
  return ruleHint === result;
}

/** A material category auto-applies at probability >= 0.85. */
export function shouldAutoApplyCategory(probability: number): boolean {
  return Number.isFinite(probability) && probability >= STOCK_ROUTING_CATEGORY_THRESHOLD;
}

function isLocation(value: string): value is StockRoutingLocation {
  return (STOCK_ROUTING_LOCATIONS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${path} must be a string or null`);
  return value;
}

function asNumber(value: unknown, path: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${path} must be a finite number`);
  return numeric;
}

function asNullableNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, path);
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function asProbability(value: unknown, path: string): number {
  const probability = asNumber(value, path);
  if (probability < 0 || probability > 1) throw new TypeError(`${path} must be within 0..1`);
  return probability;
}

function asLocation(value: unknown, path: string): StockRoutingLocation {
  const location = asString(value, path);
  if (!isLocation(location)) throw new TypeError(`${path} is invalid`);
  return location;
}

function asRuleHint(value: unknown, path: string): StockRoutingLocation | null {
  if (value === null || value === undefined) return null;
  return asLocation(value, path);
}

function parseUsage(value: unknown, path: string): { usage_date: string; calls: number; cost: number; call_limit: number } {
  const usage = asRecord(value, path);
  return {
    usage_date: asString(usage.usage_date, `${path}.usage_date`),
    calls: asNumber(usage.calls ?? 0, `${path}.calls`),
    cost: asNumber(usage.cost ?? 0, `${path}.cost`),
    call_limit: asNumber(usage.call_limit ?? 600, `${path}.call_limit`),
  };
}

export interface StockRoutingSupplierPending {
  id: string;
  supplier_id: string;
  supplier_name: string | null;
  category: string | null;
  proposed_location: StockRoutingLocation;
  probability: number;
  evidence: Record<string, unknown> | null;
  rule_hint: StockRoutingLocation | null;
  conflict: boolean;
  prompt_version: string;
  cost: number | null;
  created_at: string;
}

export interface StockRoutingSupplierRecent {
  id: string;
  supplier_id: string;
  supplier_name: string | null;
  proposed_location: StockRoutingLocation;
  probability: number;
  status: "applied" | "reverted";
  applied_at: string | null;
  created_at: string;
  previous_location: StockRoutingLocation | null;
  previous_exempt: boolean | null;
}

export interface StockRoutingSupplierCounts {
  q7: number;
  tan_tao: number;
  non_stock: number;
  none: number;
}

export interface StockRoutingMaterialPending {
  id: string;
  material_id: string;
  material_code: string;
  canonical_name: string;
  current_category: string | null;
  proposed_category: string;
  proposed_label: string | null;
  probability: number;
  prompt_version: string;
  cost: number | null;
  created_at: string;
}

export interface StockRoutingCategoryRow {
  code: string;
  label_vi: string;
  sort_order: number;
}

export interface StockRoutingReview {
  supplier_pending: StockRoutingSupplierPending[];
  supplier_recent: StockRoutingSupplierRecent[];
  supplier_counts: StockRoutingSupplierCounts;
  material_pending: StockRoutingMaterialPending[];
  material_category_counts: Record<string, number>;
  categories: StockRoutingCategoryRow[];
  jev_usage: { usage_date: string; calls: number; cost: number; call_limit: number };
}

/** Parse and validate the JSON returned by `get_stock_routing_review`. */
export function parseStockRoutingReview(raw: unknown): StockRoutingReview {
  const root = asRecord(raw, "stockRoutingReview");

  const rawSupplierPending = root.supplier_pending;
  if (!Array.isArray(rawSupplierPending)) throw new TypeError("supplier_pending must be an array");
  const supplierPending = rawSupplierPending.map((entry, index): StockRoutingSupplierPending => {
    const path = `supplier_pending[${index}]`;
    const row = asRecord(entry, path);
    const evidence = row.evidence === null || row.evidence === undefined
      ? null
      : asRecord(row.evidence, `${path}.evidence`);
    return {
      id: asString(row.id, `${path}.id`),
      supplier_id: asString(row.supplier_id, `${path}.supplier_id`),
      supplier_name: asNullableString(row.supplier_name, `${path}.supplier_name`),
      category: asNullableString(row.category, `${path}.category`),
      proposed_location: asLocation(row.proposed_location, `${path}.proposed_location`),
      probability: asProbability(row.probability, `${path}.probability`),
      evidence,
      rule_hint: asRuleHint(row.rule_hint, `${path}.rule_hint`),
      conflict: asBoolean(row.conflict ?? false, `${path}.conflict`),
      prompt_version: asString(row.prompt_version, `${path}.prompt_version`),
      cost: asNullableNumber(row.cost, `${path}.cost`),
      created_at: asString(row.created_at, `${path}.created_at`),
    };
  });

  const rawSupplierRecent = root.supplier_recent;
  if (!Array.isArray(rawSupplierRecent)) throw new TypeError("supplier_recent must be an array");
  const supplierRecent = rawSupplierRecent.map((entry, index): StockRoutingSupplierRecent => {
    const path = `supplier_recent[${index}]`;
    const row = asRecord(entry, path);
    const status = asString(row.status, `${path}.status`);
    if (status !== "applied" && status !== "reverted") throw new TypeError(`${path}.status is invalid`);
    return {
      id: asString(row.id, `${path}.id`),
      supplier_id: asString(row.supplier_id, `${path}.supplier_id`),
      supplier_name: asNullableString(row.supplier_name, `${path}.supplier_name`),
      proposed_location: asLocation(row.proposed_location, `${path}.proposed_location`),
      probability: asProbability(row.probability, `${path}.probability`),
      status,
      applied_at: asNullableString(row.applied_at, `${path}.applied_at`),
      created_at: asString(row.created_at, `${path}.created_at`),
      previous_location: row.previous_location === null || row.previous_location === undefined
        ? null
        : asLocation(row.previous_location, `${path}.previous_location`),
      previous_exempt: row.previous_exempt === null || row.previous_exempt === undefined
        ? null
        : asBoolean(row.previous_exempt, `${path}.previous_exempt`),
    };
  });

  const countsRow = asRecord(root.supplier_counts, "supplier_counts");
  const supplierCounts: StockRoutingSupplierCounts = {
    q7: asNumber(countsRow.q7 ?? 0, "supplier_counts.q7"),
    tan_tao: asNumber(countsRow.tan_tao ?? 0, "supplier_counts.tan_tao"),
    non_stock: asNumber(countsRow.non_stock ?? 0, "supplier_counts.non_stock"),
    none: asNumber(countsRow.none ?? 0, "supplier_counts.none"),
  };

  const rawMaterialPending = root.material_pending;
  if (!Array.isArray(rawMaterialPending)) throw new TypeError("material_pending must be an array");
  const materialPending = rawMaterialPending.map((entry, index): StockRoutingMaterialPending => {
    const path = `material_pending[${index}]`;
    const row = asRecord(entry, path);
    return {
      id: asString(row.id, `${path}.id`),
      material_id: asString(row.material_id, `${path}.material_id`),
      material_code: asString(row.material_code, `${path}.material_code`),
      canonical_name: asString(row.canonical_name, `${path}.canonical_name`),
      current_category: asNullableString(row.current_category, `${path}.current_category`),
      proposed_category: asString(row.proposed_category, `${path}.proposed_category`),
      proposed_label: asNullableString(row.proposed_label, `${path}.proposed_label`),
      probability: asProbability(row.probability, `${path}.probability`),
      prompt_version: asString(row.prompt_version, `${path}.prompt_version`),
      cost: asNullableNumber(row.cost, `${path}.cost`),
      created_at: asString(row.created_at, `${path}.created_at`),
    };
  });

  const rawMaterialCounts = asRecord(root.material_category_counts, "material_category_counts");
  const materialCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawMaterialCounts)) {
    materialCounts[key] = asNumber(value, `material_category_counts.${key}`);
  }

  const rawCategories = root.categories;
  if (!Array.isArray(rawCategories)) throw new TypeError("categories must be an array");
  const categories = rawCategories.map((entry, index): StockRoutingCategoryRow => {
    const path = `categories[${index}]`;
    const row = asRecord(entry, path);
    return {
      code: asString(row.code, `${path}.code`),
      label_vi: asString(row.label_vi, `${path}.label_vi`),
      sort_order: asNumber(row.sort_order ?? 0, `${path}.sort_order`),
    };
  });

  return {
    supplier_pending: supplierPending,
    supplier_recent: supplierRecent,
    supplier_counts: supplierCounts,
    material_pending: materialPending,
    material_category_counts: materialCounts,
    categories,
    jev_usage: parseUsage(root.jev_usage, "jev_usage"),
  };
}

export type StockRoutingJevMode = "suppliers" | "materials";

export interface StockRoutingJevResponse {
  mode: StockRoutingJevMode;
  candidates: number;
  suggestions: number;
  applied: number;
  pending: number;
  failed: number;
  calls: number;
  cost: number;
  usage: { date: string; calls: number; limit: number };
  stopped: "daily_limit" | null;
}

/** Parse and validate the JSON returned by the `stock-routing-jev` edge function. */
export function parseStockRoutingJevResponse(raw: unknown): StockRoutingJevResponse {
  const root = asRecord(raw, "stockRoutingJev");
  const mode = asString(root.mode, "mode");
  if (mode !== "suppliers" && mode !== "materials") throw new TypeError("mode is invalid");
  const stopped = root.stopped;
  if (stopped !== null && stopped !== undefined && stopped !== "daily_limit") {
    throw new TypeError("stopped is invalid");
  }
  const usage = asRecord(root.usage, "usage");
  return {
    mode,
    candidates: asNumber(root.candidates ?? 0, "candidates"),
    suggestions: asNumber(root.suggestions ?? 0, "suggestions"),
    applied: asNumber(root.applied ?? 0, "applied"),
    pending: asNumber(root.pending ?? 0, "pending"),
    failed: asNumber(root.failed ?? 0, "failed"),
    calls: asNumber(root.calls ?? 0, "calls"),
    cost: asNumber(root.cost ?? 0, "cost"),
    usage: {
      date: asString(usage.date, "usage.date"),
      calls: asNumber(usage.calls, "usage.calls"),
      limit: asNumber(usage.limit, "usage.limit"),
    },
    stopped: stopped === "daily_limit" ? "daily_limit" : null,
  };
}
