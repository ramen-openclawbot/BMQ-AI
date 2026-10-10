/**
 * Pure helpers for the automatic stock ledger (Q7 / Tân Tạo).
 *
 * The normalization below mirrors `public.normalize_stock_item_name(text)` in
 * supabase/migrations/20261013100000_stock_ledger_flow.sql byte for byte so the
 * same test-case table can be shared by the SQL smoke test and the node test.
 */

/** Characters mapped away by the SQL translate() call (lowercase input). */
export const STOCK_ITEM_DIACRITICS_FROM =
  "aáàảãạăắằẳẵặâấầẩẫậeéèẻẽẹêếềểễệiíìỉĩịoóòỏõọôốồổỗộơớờởỡợuúùủũụưứừửữựyýỳỷỹỵdđ";

/** ASCII replacement for STOCK_ITEM_DIACRITICS_FROM, same length (74). */
export const STOCK_ITEM_DIACRITICS_TO =
  "aaaaaaaaaaaaaaaaaaeeeeeeeeeeeeiiiiiioooooooooooooooooouuuuuuuuuuuuyyyyyydd";

const DIACRITIC_MAP: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const from = Array.from(STOCK_ITEM_DIACRITICS_FROM);
  const to = Array.from(STOCK_ITEM_DIACRITICS_TO);
  for (let i = 0; i < from.length; i += 1) {
    map.set(from[i], to[i] ?? from[i]);
  }
  return map;
})();

/** Shared normalization test cases: [input, expected]. */
export const NORMALIZE_STOCK_ITEM_NAME_TEST_CASES: ReadonlyArray<
  readonly [string, string]
> = [
  ["tỏi ngày 10", "toi"],
  ["bánh mì lớn 17", "banh mi lon"],
  ["Chả lụa lá TVP XL (kg)", "cha lua la tvp xl"],
];

/**
 * Lowercase, strip Vietnamese diacritics, collapse whitespace, drop a trailing
 * parenthesised unit and drop a trailing date/number such as "ngày 10" or " 17".
 * Returns an empty string when nothing meaningful is left (SQL returns null).
 */
export function normalizeStockItemName(name: string | null | undefined): string {
  const lowered = (name ?? "").toLowerCase();
  let mapped = "";
  for (const char of lowered) {
    mapped += DIACRITIC_MAP.get(char) ?? char;
  }

  const collapsed = mapped.replace(/\s+/g, " ");
  const withoutUnit = collapsed.replace(/\s*\([^()]*\)\s*$/, "");
  const withoutSuffix = withoutUnit.replace(/\s*(ngay\s*[0-9]+|[0-9]+)\s*$/, "");
  return withoutSuffix.trim();
}

export type StockLedgerLocation = "q7" | "tan_tao";

export interface StockLedgerOverviewItem {
  /** kitchen_inventory_items.id for Q7, product_skus.id for Tân Tạo. */
  item_id: string;
  item_code: string;
  item_name: string;
  unit: string;
  current_qty: number;
  in_qty_7d: number;
  out_qty_7d: number;
  last_count_date: string | null;
  last_count_difference: number | null;
  is_low_stock: boolean;
}

export interface StockLedgerPendingAlias {
  goods_receipt_item_id: string;
  receipt_number: string;
  supplier: string | null;
  product_name: string;
  normalized_name: string | null;
  quantity: number;
  receipt_date: string;
}

export interface StockLedgerOverview {
  location: StockLedgerLocation;
  location_name: string;
  as_of: string;
  cutover_date: string | null;
  items: StockLedgerOverviewItem[];
  pending_aliases: StockLedgerPendingAlias[];
}

/**
 * Low stock when the current quantity is below three times the average daily
 * outgoing quantity over the last seven days.
 */
export function isLowStock(currentQty: number, outQty7d: number): boolean {
  if (!Number.isFinite(currentQty) || !Number.isFinite(outQty7d) || outQty7d <= 0) {
    return false;
  }
  return currentQty < (outQty7d / 7) * 3;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be a string`);
  }
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be a string or null`);
  }
  return value;
}

function asNumber(value: unknown, path: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return numeric;
}

function asNullableNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, path);
}

/** Parse and validate the JSON returned by `get_stock_ledger_overview`. */
export function parseStockLedgerOverview(raw: unknown): StockLedgerOverview {
  const root = asRecord(raw, "stockLedgerOverview");
  const location = asString(root.location, "location");
  if (location !== "q7" && location !== "tan_tao") {
    throw new TypeError("location must be 'q7' or 'tan_tao'");
  }

  const rawItems = root.items;
  if (!Array.isArray(rawItems)) {
    throw new TypeError("items must be an array");
  }
  const items = rawItems.map((entry, index): StockLedgerOverviewItem => {
    const item = asRecord(entry, `items[${index}]`);
    const currentQty = asNumber(item.current_qty, `items[${index}].current_qty`);
    const outQty7d = asNumber(item.out_qty_7d, `items[${index}].out_qty_7d`);
    return {
      item_id: asString(item.item_id, `items[${index}].item_id`),
      item_code: asString(item.item_code, `items[${index}].item_code`),
      item_name: asString(item.item_name, `items[${index}].item_name`),
      unit: asString(item.unit, `items[${index}].unit`),
      current_qty: currentQty,
      in_qty_7d: asNumber(item.in_qty_7d, `items[${index}].in_qty_7d`),
      out_qty_7d: outQty7d,
      last_count_date: asNullableString(
        item.last_count_date,
        `items[${index}].last_count_date`,
      ),
      last_count_difference: asNullableNumber(
        item.last_count_difference,
        `items[${index}].last_count_difference`,
      ),
      is_low_stock:
        typeof item.is_low_stock === "boolean"
          ? item.is_low_stock
          : isLowStock(currentQty, outQty7d),
    };
  });

  const rawPending = root.pending_aliases;
  if (!Array.isArray(rawPending)) {
    throw new TypeError("pending_aliases must be an array");
  }
  const pending = rawPending.map((entry, index): StockLedgerPendingAlias => {
    const alias = asRecord(entry, `pending_aliases[${index}]`);
    return {
      goods_receipt_item_id: asString(
        alias.goods_receipt_item_id,
        `pending_aliases[${index}].goods_receipt_item_id`,
      ),
      receipt_number: asString(
        alias.receipt_number,
        `pending_aliases[${index}].receipt_number`,
      ),
      supplier: asNullableString(alias.supplier, `pending_aliases[${index}].supplier`),
      product_name: asString(
        alias.product_name,
        `pending_aliases[${index}].product_name`,
      ),
      normalized_name: asNullableString(
        alias.normalized_name,
        `pending_aliases[${index}].normalized_name`,
      ),
      quantity: asNumber(alias.quantity, `pending_aliases[${index}].quantity`),
      receipt_date: asString(
        alias.receipt_date,
        `pending_aliases[${index}].receipt_date`,
      ),
    };
  });

  return {
    location,
    location_name: asString(root.location_name, "location_name"),
    as_of: asString(root.as_of, "as_of"),
    cutover_date: asNullableString(root.cutover_date, "cutover_date"),
    items,
    pending_aliases: pending,
  };
}
