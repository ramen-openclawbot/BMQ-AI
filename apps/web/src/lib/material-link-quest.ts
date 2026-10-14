/**
 * Pure helpers for the two-warehouse Material Master link quest (2026-11-01).
 *
 * The review parser validates the jsonb returned by
 *   public.get_material_link_review(text) and
 *   public.material_link_review_items(text),
 * which share the same shape as the older public.get_q7_material_link_review()
 * plus `skus`, `last_buy` and `receipt_photo_count`.
 *
 * The server is authoritative: these helpers only make a broken RPC response
 * render as an empty/safe value instead of a fake success.
 */

export type MaterialLinkLocation = "q7" | "tan_tao";

export type MaterialUnitStatus = "same" | "auto" | "needs_factor";

export interface MaterialLinkCandidate {
  id: string;
  material_code: string;
  canonical_name: string;
  default_unit: string;
  unit_status: MaterialUnitStatus;
  score: number;
  skus: string[];
}

export interface MaterialLinkLastBuy {
  supplier_name: string | null;
  date: string;
}

export type MaterialLinkDocKind = "po" | "gr";

/**
 * Newest purchase-order or goods-receipt line that matches the item's aliases
 * or the item's own accent-free name. `date` is an ISO date-only string.
 */
export interface MaterialLinkPurchaseLine {
  doc_kind: MaterialLinkDocKind;
  doc_number: string;
  date: string;
  supplier_name: string | null;
  raw_name: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
}

export interface MaterialLinkReviewItem {
  item_id: string;
  item_code: string | null;
  name: string;
  unit: string;
  exact_material: MaterialLinkCandidate | null;
  /** default_unit of the exact material, null when there is no exact match. */
  material_unit: string | null;
  /** null when there is no exact material. */
  unit_status: MaterialUnitStatus | null;
  /** Standard weight/volume factor for an auto pair, else null. */
  auto_factor: number | null;
  candidates: MaterialLinkCandidate[];
  last_buy: MaterialLinkLastBuy | null;
  /** Newest PO / receipt line matching the item, null when there is none. */
  last_purchase_line: MaterialLinkPurchaseLine | null;
  receipt_photo_count: number;
}

export interface MaterialLinkReviewCounts {
  /** Eligible unlinked items in `items`. */
  total: number;
  exact: number;
  auto: number;
  needs_factor: number;
  /** Eligible unlinked items without any candidate. */
  none: number;
  /** Eligible items of the location that already have a canonical material. */
  linked_total: number;
  /** Skipped items whose item belongs to the location. */
  skipped: number;
  /** Linked items of the location still waiting for a unit factor. */
  pending_factor: number;
}

export interface MaterialLinkReview {
  items: MaterialLinkReviewItem[];
  counts: MaterialLinkReviewCounts;
}

/** A linked item whose unit factor is still unknown (from the pending RPC). */
export interface MaterialLinkPendingFactor {
  item_id: string;
  name: string;
  unit: string;
  material_id: string;
  material_code: string;
  canonical_name: string;
  material_unit: string;
  last_purchase_line: MaterialLinkPurchaseLine | null;
}

// ---------------------------------------------------------------------------
// Small validators
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

function asCount(value: unknown, path: string): number {
  if (value === null || value === undefined) return 0;
  return asNumber(value, path);
}

function asNullableNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, path);
}

const UNIT_STATUSES: readonly MaterialUnitStatus[] = ["same", "auto", "needs_factor"];

function parseUnitStatus(value: unknown, path: string): MaterialUnitStatus {
  if (value === "same" || value === "auto" || value === "needs_factor") return value;
  throw new TypeError(`${path} must be one of ${UNIT_STATUSES.join(", ")}`);
}

/** Missing or malformed string arrays become an empty array. */
function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => asString(entry, `${path}[${index}]`));
}

// ---------------------------------------------------------------------------
// Review parser
// ---------------------------------------------------------------------------

function parseCandidate(
  value: unknown,
  path: string,
  fallbackStatus: MaterialUnitStatus | null,
): MaterialLinkCandidate {
  const row = asRecord(value, path);
  const unitStatus =
    row.unit_status === null || row.unit_status === undefined
      ? (fallbackStatus ?? "needs_factor")
      : parseUnitStatus(row.unit_status, `${path}.unit_status`);
  const score = row.score === null || row.score === undefined ? 1 : asNumber(row.score, `${path}.score`);
  return {
    id: asString(row.id, `${path}.id`),
    material_code: asString(row.material_code, `${path}.material_code`),
    canonical_name: asString(row.canonical_name, `${path}.canonical_name`),
    default_unit: asString(row.default_unit, `${path}.default_unit`),
    unit_status: unitStatus,
    score,
    skus: asStringArray(row.skus, `${path}.skus`),
  };
}

function parseLastBuy(value: unknown, path: string): MaterialLinkLastBuy | null {
  if (value === null || value === undefined) return null;
  const row = asRecord(value, path);
  return {
    supplier_name: asNullableString(row.supplier_name, `${path}.supplier_name`),
    date: asString(row.date, `${path}.date`),
  };
}

const DOC_KINDS: readonly MaterialLinkDocKind[] = ["po", "gr"];

function parseDocKind(value: unknown, path: string): MaterialLinkDocKind {
  if (value === "po" || value === "gr") return value;
  throw new TypeError(`${path} must be one of ${DOC_KINDS.join(", ")}`);
}

/** Missing/malformed line degrades to null so a broken payload never fakes a fact. */
function parsePurchaseLine(value: unknown, path: string): MaterialLinkPurchaseLine | null {
  if (value === null || value === undefined) return null;
  const row = asRecord(value, path);
  return {
    doc_kind: parseDocKind(row.doc_kind, `${path}.doc_kind`),
    doc_number: asString(row.doc_number, `${path}.doc_number`),
    date: asString(row.date, `${path}.date`),
    supplier_name: asNullableString(row.supplier_name, `${path}.supplier_name`),
    raw_name: asString(row.raw_name, `${path}.raw_name`),
    quantity: asNullableNumber(row.quantity, `${path}.quantity`),
    unit: asNullableString(row.unit, `${path}.unit`),
    unit_price: asNullableNumber(row.unit_price, `${path}.unit_price`),
  };
}

function parseReviewItem(value: unknown, path: string): MaterialLinkReviewItem {
  const row = asRecord(value, path);
  const unitStatus =
    row.unit_status === null || row.unit_status === undefined
      ? null
      : parseUnitStatus(row.unit_status, `${path}.unit_status`);
  const exactRaw = row.exact_material;
  const exactMaterial =
    exactRaw === null || exactRaw === undefined
      ? null
      : parseCandidate(exactRaw, `${path}.exact_material`, unitStatus);
  const candidates = Array.isArray(row.candidates)
    ? row.candidates.map((candidate, index) =>
        parseCandidate(candidate, `${path}.candidates[${index}]`, null),
      )
    : [];

  return {
    item_id: asString(row.item_id, `${path}.item_id`),
    item_code: asNullableString(row.item_code, `${path}.item_code`),
    name: asString(row.name, `${path}.name`),
    unit: asString(row.unit, `${path}.unit`),
    exact_material: exactMaterial,
    material_unit: asNullableString(row.material_unit, `${path}.material_unit`),
    unit_status: unitStatus,
    auto_factor: asNullableNumber(row.auto_factor, `${path}.auto_factor`),
    candidates,
    last_buy: parseLastBuy(row.last_buy, `${path}.last_buy`),
    last_purchase_line: parsePurchaseLine(
      row.last_purchase_line,
      `${path}.last_purchase_line`,
    ),
    receipt_photo_count: asCount(row.receipt_photo_count, `${path}.receipt_photo_count`),
  };
}

/**
 * Parse the jsonb returned by get_material_link_review /
 * material_link_review_items. Missing arrays and counts degrade to empty/zero.
 */
export function parseMaterialLinkReview(raw: unknown): MaterialLinkReview {
  if (raw === null || raw === undefined) {
    return {
      items: [],
      counts: {
        total: 0,
        exact: 0,
        auto: 0,
        needs_factor: 0,
        none: 0,
        linked_total: 0,
        skipped: 0,
        pending_factor: 0,
      },
    };
  }
  const root = asRecord(raw, "materialLinkReview");
  const counts = root.counts === null || root.counts === undefined ? {} : asRecord(root.counts, "materialLinkReview.counts");
  return {
    items: Array.isArray(root.items)
      ? root.items.map((item, index) => parseReviewItem(item, `materialLinkReview.items[${index}]`))
      : [],
    counts: {
      total: asCount(counts.total, "materialLinkReview.counts.total"),
      exact: asCount(counts.exact, "materialLinkReview.counts.exact"),
      auto: asCount(counts.auto, "materialLinkReview.counts.auto"),
      needs_factor: asCount(counts.needs_factor, "materialLinkReview.counts.needs_factor"),
      none: asCount(counts.none, "materialLinkReview.counts.none"),
      linked_total: asCount(counts.linked_total, "materialLinkReview.counts.linked_total"),
      skipped: asCount(counts.skipped, "materialLinkReview.counts.skipped"),
      pending_factor: asCount(counts.pending_factor, "materialLinkReview.counts.pending_factor"),
    },
  };
}

/**
 * Parse the jsonb returned by get_material_link_pending_factors, which is
 * `{items: [...]}`; a bare array is tolerated too. Missing data degrades to [].
 */
export function parseMaterialLinkPendingFactors(raw: unknown): MaterialLinkPendingFactor[] {
  if (raw === null || raw === undefined) return [];
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : (() => {
        const root = asRecord(raw, "materialLinkPendingFactors");
        return Array.isArray(root.items) ? root.items : [];
      })();
  return list.map((entry, index) => {
    const path = `materialLinkPendingFactors[${index}]`;
    const row = asRecord(entry, path);
    return {
      item_id: asString(row.item_id, `${path}.item_id`),
      name: asString(row.name, `${path}.name`),
      unit: asString(row.unit, `${path}.unit`),
      material_id: asString(row.material_id, `${path}.material_id`),
      material_code: asString(row.material_code, `${path}.material_code`),
      canonical_name: asString(row.canonical_name, `${path}.canonical_name`),
      material_unit: asString(row.material_unit, `${path}.material_unit`),
      last_purchase_line: parsePurchaseLine(
        row.last_purchase_line,
        `${path}.last_purchase_line`,
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const WEIGHT_VOLUME: Record<string, number> = { g: 1, gr: 1, gram: 1, kg: 1000, ml: 1, l: 1000, lit: 1000, "lít": 1000 };
const unitKey = (unit: string) => unit.trim().toLowerCase();

/**
 * "1 {material unit} = ? {item unit}" prefill, read from the item name ("Trứng gà 60gr" → 60 g/quả,
 * "Bột mì 25kg" → 25000 g/bao, "Sữa tươi 1L" → 1000 g/lít). Only for an item counted in g / ml.
 */
export function factorPrefill(name: string, itemUnit: string, materialUnit: string): number | null {
  const base = WEIGHT_VOLUME[unitKey(itemUnit)];
  if (base !== 1) return null;
  const match = name.toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(kg|gram|gr|g|lít|lit|ml|l)\b/u);
  if (match) {
    const qty = Number(match[1].replace(",", "."));
    const mult = WEIGHT_VOLUME[match[2]];
    if (Number.isFinite(qty) && qty > 0 && mult) return qty * mult;
  }
  // No size in the name: 1 lít of a liquid ≈ 1000 g / ml.
  const mat = unitKey(materialUnit);
  return mat === "lít" || mat === "lit" || mat === "l" ? 1000 : null;
}

/**
 * Size units read from a package name, expressed in a common g/ml base
 * (1 g = 1 ml for the business case). kg/lít are 1000 of the base.
 */
const ITEM_FACTOR_UNITS: Record<string, number> = {
  g: 1,
  gr: 1,
  gram: 1,
  kg: 1000,
  kgs: 1000,
  "ký": 1000,
  "kí": 1000,
  ml: 1,
  l: 1000,
  lit: 1000,
  "lít": 1000,
};

const ITEM_FACTOR_SIZE_PATTERN = /(\d+(?:[.,]\d+)?)\s*(kgs?|gram|gr|kg|ký|kí|lít|lit|ml|l)\b/u;

function sizeInBaseUnits(text: string): number | null {
  const match = text.toLowerCase().match(ITEM_FACTOR_SIZE_PATTERN);
  if (!match) return null;
  const qty = Number(match[1].replace(",", "."));
  const multiplier = ITEM_FACTOR_UNITS[match[2]];
  if (!Number.isFinite(qty) || qty <= 0 || !multiplier) return null;
  return qty * multiplier;
}

/**
 * Material units per 1 item unit, read from a package size in the item name
 * first and in the material name second. This is exactly the stored
 * material_unit_conversions convention (to_unit per from_unit):
 *   ('Nước uống Vĩnh Hảo', 'bình', 'Nước Vihawa 20L Bình Vòi', 'g') → 20000
 *   ('Bột mì 888 Cam', 'bao', 'Bột mì 888 Cam (25kg)', 'g')        → 25000
 *   ('Bột mì 888 Cam', 'bao', 'Bột mì 888 Cam', 'kg')              → null
 * Returns null when nothing is readable or materialUnit is a count unit.
 */
export function itemFactorPrefill(
  itemName: string,
  _itemUnit: string,
  materialName: string,
  materialUnit: string,
): number | null {
  const materialBase = ITEM_FACTOR_UNITS[unitKey(materialUnit)];
  if (!materialBase) return null;
  const size = sizeInBaseUnits(itemName) ?? sizeInBaseUnits(materialName);
  if (size === null) return null;
  const factor = size / materialBase;
  return Number.isFinite(factor) && factor > 0 ? factor : null;
}

function deckGroup(item: MaterialLinkReviewItem): number {
  if (item.exact_material) return 0;
  if (item.candidates.length > 0) return 1;
  return 2;
}

/**
 * Review order for the deck: exact first, then items with candidates, then the
 * rest; name order inside each group. Deferred items are pushed to the very end
 * in the order of `deferredIds` (unknown ids are ignored).
 */
export function deckOrder(
  items: MaterialLinkReviewItem[],
  deferredIds: string[],
): MaterialLinkReviewItem[] {
  const deferredIndex = new Map<string, number>();
  deferredIds.forEach((id, index) => {
    if (!deferredIndex.has(id)) deferredIndex.set(id, index);
  });
  const isDeferred = (item: MaterialLinkReviewItem) => deferredIndex.has(item.item_id);

  const active = items.filter((item) => !isDeferred(item));
  const held = items.filter((item) => isDeferred(item));

  active.sort(
    (a, b) =>
      deckGroup(a) - deckGroup(b) ||
      a.name.localeCompare(b.name, "vi") ||
      a.item_id.localeCompare(b.item_id),
  );
  held.sort(
    (a, b) => (deferredIndex.get(a.item_id) ?? 0) - (deferredIndex.get(b.item_id) ?? 0),
  );

  return [...active, ...held];
}

/** Items the bulk action can link right away (exact material, same/auto unit). */
export function bulkableRows(items: MaterialLinkReviewItem[]): MaterialLinkReviewItem[] {
  return items.filter(
    (item) =>
      item.exact_material !== null &&
      (item.unit_status === "same" || item.unit_status === "auto"),
  );
}
