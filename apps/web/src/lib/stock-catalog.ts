/**
 * Pure helpers for the Q7 stock catalog cleanup (Giai đoạn 1).
 *
 * The unit-factor table below mirrors `public.stock_unit_factor(text, text)` in
 * supabase/migrations/20261015100000_stock_catalog_cleanup.sql byte for byte so
 * the same test-case table can be shared by the SQL smoke test and the node test.
 * Token matching mirrors `public.stock_catalog_item_tokens` / `_token_jaccard`.
 */

import { normalizeStockItemName } from "./stock-ledger.ts";

export const STOCK_ITEM_CLASSES = [
  "raw_material",
  "packaging_supply",
  "finished_goods",
  "non_stock",
] as const;
export type StockItemClass = (typeof STOCK_ITEM_CLASSES)[number];

export const STOCK_CATALOG_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "applied",
  "reverted",
  "superseded",
] as const;
export type StockCatalogStatus = (typeof STOCK_CATALOG_STATUSES)[number];

export const ITEM_CLASS_LABELS: Record<StockItemClass, string> = {
  raw_material: "Nguyên liệu",
  packaging_supply: "Bao bì / vật tư",
  finished_goods: "Thành phẩm",
  non_stock: "Không tồn kho",
};

export const STOCK_CATALOG_STATUS_LABELS: Record<StockCatalogStatus, string> = {
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Đã bỏ",
  applied: "Đã gộp",
  reverted: "Đã hoàn tác",
  superseded: "Đã thay thế",
};

export function itemClassLabel(value: string | null | undefined): string {
  if (value && value in ITEM_CLASS_LABELS) return ITEM_CLASS_LABELS[value as StockItemClass];
  return "Chưa phân loại";
}

export function stockCatalogStatusLabel(value: string | null | undefined): string {
  if (value && value in STOCK_CATALOG_STATUS_LABELS) return STOCK_CATALOG_STATUS_LABELS[value as StockCatalogStatus];
  return value ?? "";
}

/** Shared unit-factor test cases: [from, to, expected]. */
export const STOCK_UNIT_FACTOR_TEST_CASES: ReadonlyArray<
  readonly [string, string, number | null]
> = [
  ["kg", "g", 1000],
  ["g", "kg", 0.001],
  ["l", "ml", 1000],
  ["ml", "l", 0.001],
  ["lít", "ml", 1000],
  ["Kilogram", "g", 1000],
  ["gr", "kg", 0.001],
  ["Quả", "g", null],
  ["chai", "chai", 1],
  ["kg", "KG", 1],
];

const UNIT_TOKENS = new Set([
  "kg", "g", "gr", "gram", "kilogram",
  "l", "lit", "ml",
  "qua", "hop", "cai", "chiec", "chai", "goi", "bao", "thung", "ky",
]);

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/** Lowercase, accentless and alias-normalized unit (or null when blank). */
export function normalizeStockUnit(unit: string | null | undefined): string | null {
  const normalized = stripDiacritics((unit ?? "").toLowerCase()).trim();
  if (normalized === "") return null;
  if (normalized === "kilogram" || normalized === "kg") return "kg";
  if (normalized === "gram" || normalized === "gr" || normalized === "g") return "g";
  if (normalized === "lit" || normalized === "l") return "l";
  if (normalized === "ml") return "ml";
  return normalized;
}

/**
 * Conversion factor from one unit to another, or null when they are not the same
 * dimension. Mass (kg/g) and volume (l/ml) convert; counting units only match
 * themselves; everything else is null unless the unit is identical.
 */
export function stockUnitFactor(from: string | null | undefined, to: string | null | undefined): number | null {
  const source = normalizeStockUnit(from);
  const target = normalizeStockUnit(to);
  if (source === null || target === null) return null;
  if (source === target) return 1;
  if (source === "kg" && target === "g") return 1000;
  if (source === "g" && target === "kg") return 0.001;
  if (source === "l" && target === "ml") return 1000;
  if (source === "ml" && target === "l") return 0.001;
  return null;
}

/**
 * Normalized words of an item name without pure-number tokens or unit tokens,
 * sorted and de-duplicated. Mirrors `public.stock_catalog_item_tokens`.
 */
export function normalizeTokens(name: string | null | undefined): string[] {
  const normalized = normalizeStockItemName(name);
  const tokens = new Set<string>();
  for (const token of normalized.split(/\s+/)) {
    if (token === "") continue;
    if (/^[0-9]+$/.test(token)) continue;
    if (UNIT_TOKENS.has(token)) continue;
    tokens.add(token);
  }
  return [...tokens].sort();
}

/** Jaccard similarity of the normalized token sets; 0 when either side is empty. */
export function tokenJaccard(left: string | null | undefined, right: string | null | undefined): number {
  const a = normalizeTokens(left);
  const b = normalizeTokens(right);
  if (a.length === 0 || b.length === 0) return 0;
  const rightSet = new Set(b);
  let intersection = 0;
  for (const token of a) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = a.length + b.length - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

export interface StockCatalogPendingSuggestion {
  id: string;
  kind: "merge" | "classify";
  item_id: string;
  item_name: string;
  item_unit: string;
  other_item_id: string | null;
  other_item_name: string | null;
  other_item_unit: string | null;
  proposed_target_id: string | null;
  target_name: string | null;
  target_unit: string | null;
  probability: number;
  proposed_factor: number | null;
  factor_source: "unit_rule" | "none" | null;
  proposed_class: StockItemClass | null;
  prompt_version: string;
  cost: number | null;
  created_at: string;
  /** Production issue lines in the last 90 days, used to show which side is in use. */
  item_issue_count_90d: number;
  other_issue_count_90d: number | null;
}

export interface StockCatalogRecentMerge {
  merge_id: string;
  source_id: string;
  source_name: string;
  target_id: string;
  target_name: string;
  factor: number;
  status: "applied" | "reverted";
  applied_at: string;
  reverted_at: string | null;
  can_revert: boolean;
}

export interface StockCatalogJevUsage {
  usage_date: string;
  calls: number;
  cost: number;
  call_limit: number;
}

export interface StockCatalogReview {
  pending_suggestions: StockCatalogPendingSuggestion[];
  recent_merges: StockCatalogRecentMerge[];
  item_class_counts: Record<string, number>;
  jev_usage: StockCatalogJevUsage;
}

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

function asItemClass(value: unknown, path: string): StockItemClass | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !STOCK_ITEM_CLASSES.includes(value as StockItemClass)) {
    throw new TypeError(`${path} must be one of ${STOCK_ITEM_CLASSES.join(", ")}`);
  }
  return value as StockItemClass;
}

/** Parse and validate the JSON returned by `get_stock_catalog_review`. */
export function parseStockCatalogReview(raw: unknown): StockCatalogReview {
  const root = asRecord(raw, "stockCatalogReview");

  const rawPending = root.pending_suggestions;
  if (!Array.isArray(rawPending)) throw new TypeError("pending_suggestions must be an array");
  const pending = rawPending.map((entry, index): StockCatalogPendingSuggestion => {
    const path = `pending_suggestions[${index}]`;
    const row = asRecord(entry, path);
    const kind = asString(row.kind, `${path}.kind`);
    if (kind !== "merge" && kind !== "classify") throw new TypeError(`${path}.kind is invalid`);
    const probability = asNumber(row.probability, `${path}.probability`);
    if (probability < 0 || probability > 1) throw new TypeError(`${path}.probability must be within 0..1`);
    const factorSource = row.factor_source;
    if (factorSource !== null && factorSource !== undefined && factorSource !== "unit_rule" && factorSource !== "none") {
      throw new TypeError(`${path}.factor_source is invalid`);
    }
    return {
      id: asString(row.id, `${path}.id`),
      kind,
      item_id: asString(row.item_id, `${path}.item_id`),
      item_name: asString(row.item_name, `${path}.item_name`),
      item_unit: asString(row.item_unit, `${path}.item_unit`),
      other_item_id: asNullableString(row.other_item_id, `${path}.other_item_id`),
      other_item_name: asNullableString(row.other_item_name, `${path}.other_item_name`),
      other_item_unit: asNullableString(row.other_item_unit, `${path}.other_item_unit`),
      proposed_target_id: asNullableString(row.proposed_target_id, `${path}.proposed_target_id`),
      target_name: asNullableString(row.target_name, `${path}.target_name`),
      target_unit: asNullableString(row.target_unit, `${path}.target_unit`),
      probability,
      proposed_factor: asNullableNumber(row.proposed_factor, `${path}.proposed_factor`),
      factor_source: (factorSource ?? null) as "unit_rule" | "none" | null,
      proposed_class: asItemClass(row.proposed_class, `${path}.proposed_class`),
      prompt_version: asString(row.prompt_version, `${path}.prompt_version`),
      cost: asNullableNumber(row.cost, `${path}.cost`),
      created_at: asString(row.created_at, `${path}.created_at`),
      item_issue_count_90d: asNumber(row.item_issue_count_90d ?? 0, `${path}.item_issue_count_90d`),
      other_issue_count_90d: asNullableNumber(row.other_issue_count_90d, `${path}.other_issue_count_90d`),
    };
  });

  const rawMerges = root.recent_merges;
  if (!Array.isArray(rawMerges)) throw new TypeError("recent_merges must be an array");
  const merges = rawMerges.map((entry, index): StockCatalogRecentMerge => {
    const path = `recent_merges[${index}]`;
    const row = asRecord(entry, path);
    const status = asString(row.status, `${path}.status`);
    if (status !== "applied" && status !== "reverted") throw new TypeError(`${path}.status is invalid`);
    return {
      merge_id: asString(row.merge_id, `${path}.merge_id`),
      source_id: asString(row.source_id, `${path}.source_id`),
      source_name: asString(row.source_name, `${path}.source_name`),
      target_id: asString(row.target_id, `${path}.target_id`),
      target_name: asString(row.target_name, `${path}.target_name`),
      factor: asNumber(row.factor, `${path}.factor`),
      status,
      applied_at: asString(row.applied_at, `${path}.applied_at`),
      reverted_at: asNullableString(row.reverted_at, `${path}.reverted_at`),
      can_revert: asBoolean(row.can_revert, `${path}.can_revert`),
    };
  });

  const rawCounts = asRecord(root.item_class_counts, "item_class_counts");
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawCounts)) {
    counts[key] = asNumber(value, `item_class_counts.${key}`);
  }

  const usageRow = asRecord(root.jev_usage, "jev_usage");
  const usage: StockCatalogJevUsage = {
    usage_date: asString(usageRow.usage_date, "jev_usage.usage_date"),
    calls: asNumber(usageRow.calls, "jev_usage.calls"),
    cost: asNumber(usageRow.cost, "jev_usage.cost"),
    call_limit: asNumber(usageRow.call_limit, "jev_usage.call_limit"),
  };

  return {
    pending_suggestions: pending,
    recent_merges: merges,
    item_class_counts: counts,
    jev_usage: usage,
  };
}
