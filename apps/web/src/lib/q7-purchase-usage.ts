/**
 * Pure helpers for the Q7 "Mua so với Dùng" report.
 *
 * The SQL side lives in
 * supabase/migrations/20261102230000_q7_purchase_usage_report.sql. The parsers
 * below are deliberately lenient: the RPC returns jsonb, and a malformed or
 * partially missing payload must never break the page. Numbers are coerced,
 * missing arrays / objects become empty, and nothing throws.
 */

export type Q7PurchaseUsageStatus =
  | "big_gap"
  | "needs_conversion"
  | "no_purchase_link"
  | "ok"
  | "not_in_recipe";

export type Q7PurchaseUsageFactorSource = "line_unit" | "pack_name" | "alias";

export type Q7PurchaseUsagePurchaseSource =
  | "goods_receipt"
  | "payment_request";

export interface Q7PurchaseUsageCell {
  used_qty: number;
  bought_qty: number;
  unknown_lines: number;
  purchase_lines: number;
}

export interface Q7PurchaseUsageItem {
  kitchen_inventory_item_id: string;
  name: string;
  unit: string;
  status: Q7PurchaseUsageStatus;
  ratio: number | null;
  total: Q7PurchaseUsageCell;
  months: Record<string, Q7PurchaseUsageCell>;
}

export interface Q7PurchaseUsageExtraPurchase {
  kitchen_inventory_item_id: string;
  name: string;
  unit: string;
  bought_qty: number;
  unknown_lines: number;
  purchase_lines: number;
  status: "not_in_recipe";
}

export interface Q7PurchaseUsageReport {
  from: string;
  to: string;
  months: string[];
  generated_at: string;
  items: Q7PurchaseUsageItem[];
  q7_extra_purchases: Q7PurchaseUsageExtraPurchase[];
}

export interface Q7PurchaseUsagePurchaseLine {
  source: Q7PurchaseUsagePurchaseSource;
  document_id: string;
  document_number: string | null;
  doc_date: string | null;
  month: string;
  receiving_location: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  product_name: string;
  quantity: number;
  unit: string | null;
  factor: number | null;
  factor_source: Q7PurchaseUsageFactorSource | null;
  book_qty: number | null;
  kitchen_inventory_item_id: string;
  image_url: string | null;
  photo_count: number;
}

export interface Q7PurchaseUsageByProduct {
  finished_sku_id: string | null;
  sku_code: string | null;
  product_name: string | null;
  used_qty: number;
  issue_count: number;
}

export interface Q7PurchaseUsageItemDetail {
  kitchen_inventory_item_id: string;
  name: string;
  unit: string;
  from: string;
  to: string;
  purchases: Q7PurchaseUsagePurchaseLine[];
  usage_by_product: Q7PurchaseUsageByProduct[];
  used_qty: number;
  bought_qty: number;
  unknown_lines: number;
}

// ---------------------------------------------------------------------------
// Lenient JSON readers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function asNumber(value: unknown, fallback = 0): number {
  return asFiniteNumber(value) ?? fallback;
}

function asNullableNumber(value: unknown): number | null {
  return asFiniteNumber(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const STATUS_VALUES: readonly Q7PurchaseUsageStatus[] = [
  "big_gap",
  "needs_conversion",
  "no_purchase_link",
  "ok",
  "not_in_recipe",
];

function asStatus(value: unknown): Q7PurchaseUsageStatus {
  return typeof value === "string" &&
    (STATUS_VALUES as readonly string[]).includes(value)
    ? (value as Q7PurchaseUsageStatus)
    : "ok";
}

function asPurchaseSource(value: unknown): Q7PurchaseUsagePurchaseSource {
  return value === "payment_request" ? "payment_request" : "goods_receipt";
}

function asFactorSource(value: unknown): Q7PurchaseUsageFactorSource | null {
  return value === "line_unit" || value === "pack_name" || value === "alias"
    ? value
    : null;
}

function parseCell(value: unknown): Q7PurchaseUsageCell {
  const cell = asRecord(value);
  return {
    used_qty: asNumber(cell.used_qty),
    bought_qty: asNumber(cell.bought_qty),
    unknown_lines: asNumber(cell.unknown_lines),
    purchase_lines: asNumber(cell.purchase_lines),
  };
}

function parseItem(value: unknown): Q7PurchaseUsageItem {
  const item = asRecord(value);
  const rawMonths = asRecord(item.months);
  const months: Record<string, Q7PurchaseUsageCell> = {};
  for (const [month, cell] of Object.entries(rawMonths)) {
    months[month] = parseCell(cell);
  }
  return {
    kitchen_inventory_item_id: asText(item.kitchen_inventory_item_id),
    name: asText(item.name),
    unit: asText(item.unit),
    status: asStatus(item.status),
    ratio: asNullableNumber(item.ratio),
    total: parseCell(item.total),
    months,
  };
}

function parseExtraPurchase(value: unknown): Q7PurchaseUsageExtraPurchase {
  const item = asRecord(value);
  return {
    kitchen_inventory_item_id: asText(item.kitchen_inventory_item_id),
    name: asText(item.name),
    unit: asText(item.unit),
    bought_qty: asNumber(item.bought_qty),
    unknown_lines: asNumber(item.unknown_lines),
    purchase_lines: asNumber(item.purchase_lines),
    status: "not_in_recipe",
  };
}

function parsePurchaseLine(value: unknown): Q7PurchaseUsagePurchaseLine {
  const line = asRecord(value);
  return {
    source: asPurchaseSource(line.source),
    document_id: asText(line.document_id),
    document_number: asNullableText(line.document_number),
    doc_date: asNullableText(line.doc_date),
    month: asText(line.month),
    receiving_location: asNullableText(line.receiving_location),
    supplier_id: asNullableText(line.supplier_id),
    supplier_name: asNullableText(line.supplier_name),
    product_name: asText(line.product_name),
    quantity: asNumber(line.quantity),
    unit: asNullableText(line.unit),
    factor: asNullableNumber(line.factor),
    factor_source: asFactorSource(line.factor_source),
    book_qty: asNullableNumber(line.book_qty),
    kitchen_inventory_item_id: asText(line.kitchen_inventory_item_id),
    image_url: asNullableText(line.image_url),
    photo_count: asNumber(line.photo_count),
  };
}

function parseUsageByProduct(value: unknown): Q7PurchaseUsageByProduct {
  const row = asRecord(value);
  return {
    finished_sku_id: asNullableText(row.finished_sku_id),
    sku_code: asNullableText(row.sku_code),
    product_name: asNullableText(row.product_name),
    used_qty: asNumber(row.used_qty),
    issue_count: asNumber(row.issue_count),
  };
}

/** Parse and normalise `get_q7_purchase_usage_report`; never throws. */
export function parseQ7PurchaseUsageReport(data: unknown): Q7PurchaseUsageReport {
  const root = asRecord(data);
  return {
    from: asText(root.from),
    to: asText(root.to),
    months: asArray(root.months).filter(
      (month): month is string => typeof month === "string",
    ),
    generated_at: asText(root.generated_at),
    items: asArray(root.items).map((entry) => parseItem(entry)),
    q7_extra_purchases: asArray(root.q7_extra_purchases).map((entry) =>
      parseExtraPurchase(entry),
    ),
  };
}

/** Parse and normalise `get_q7_purchase_usage_item_detail`; never throws. */
export function parseQ7PurchaseUsageItemDetail(
  data: unknown,
): Q7PurchaseUsageItemDetail {
  const root = asRecord(data);
  return {
    kitchen_inventory_item_id: asText(root.kitchen_inventory_item_id),
    name: asText(root.name),
    unit: asText(root.unit),
    from: asText(root.from),
    to: asText(root.to),
    purchases: asArray(root.purchases).map((entry) => parsePurchaseLine(entry)),
    usage_by_product: asArray(root.usage_by_product).map((entry) =>
      parseUsageByProduct(entry),
    ),
    used_qty: asNumber(root.used_qty),
    bought_qty: asNumber(root.bought_qty),
    unknown_lines: asNumber(root.unknown_lines),
  };
}

// ---------------------------------------------------------------------------
// Labels and formatting
// ---------------------------------------------------------------------------

export const Q7_PURCHASE_USAGE_STATUS_LABELS: Readonly<
  Record<Q7PurchaseUsageStatus, string>
> = {
  big_gap: "Lệch lớn – xem lại phiếu",
  needs_conversion: "Cần quy đổi",
  no_purchase_link: "Chưa nối hàng mua",
  ok: "So được",
  not_in_recipe: "Không có trong công thức",
};

export function purchaseUsageStatusLabel(status: Q7PurchaseUsageStatus): string {
  return Q7_PURCHASE_USAGE_STATUS_LABELS[status] ?? status;
}

const QTY_FORMATTER = new Intl.NumberFormat("vi-VN", {
  maximumFractionDigits: 1,
});

const RATIO_FORMATTER = new Intl.NumberFormat("vi-VN", {
  maximumFractionDigits: 2,
});

/** Format a book quantity; g/ml switch to kg/l from 1000 up. */
export function formatStockQty(qty: number | null, unit: string): string {
  if (qty === null || !Number.isFinite(qty)) return "—";
  const normalizedUnit = unit.trim();
  const lowerUnit = normalizedUnit.toLowerCase();
  if (lowerUnit === "g" && Math.abs(qty) >= 1000) {
    return `${QTY_FORMATTER.format(qty / 1000)} kg`;
  }
  if (lowerUnit === "ml" && Math.abs(qty) >= 1000) {
    return `${QTY_FORMATTER.format(qty / 1000)} l`;
  }
  return `${QTY_FORMATTER.format(qty)} ${normalizedUnit}`.trim();
}

type GapItem = Pick<Q7PurchaseUsageItem, "status" | "ratio" | "total">;

/** One-line explanation of the report status. */
export function purchaseUsageGapText(item: GapItem): string {
  switch (item.status) {
    case "needs_conversion":
      return `${item.total.unknown_lines} dòng mua chưa quy đổi được`;
    case "no_purchase_link":
      return "Chưa nối tên hàng mua với món này";
    case "not_in_recipe":
      return "Không có trong công thức Q7";
    case "big_gap":
    case "ok": {
      if (item.ratio === null) return "";
      if (item.ratio > 1) {
        return `Mua gấp ${RATIO_FORMATTER.format(item.ratio)} lần lượng dùng`;
      }
      if (item.ratio < 1) {
        return `Mua bằng ${RATIO_FORMATTER.format(item.ratio)} lần lượng dùng`;
      }
      return "";
    }
    default:
      return "";
  }
}

/** `2026-09` -> `T9/2026`. */
export function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  return `T${Number(match[2])}/${match[1]}`;
}

const FACTOR_SOURCE_LABELS: Readonly<
  Record<Q7PurchaseUsageFactorSource, string>
> = {
  line_unit: "Theo đơn vị trên phiếu",
  pack_name: "Theo quy cách trong tên",
  alias: "Theo quy đổi đã khai",
};

export function factorSourceLabel(
  source: Q7PurchaseUsageFactorSource | null | undefined,
): string {
  if (source === null || source === undefined) return "Chưa quy đổi được";
  return FACTOR_SOURCE_LABELS[source] ?? "Chưa quy đổi được";
}
