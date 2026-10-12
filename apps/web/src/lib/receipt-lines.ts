/**
 * Pure helpers for the Kho 2D delivery-note panel (2026-10-28).
 *
 * The parser validates the jsonb arrays returned by
 *   public.get_crate_receipt_lines(text, uuid, text, integer) and
 *   public.get_item_receipt_lines(uuid, integer).
 *
 * Every row carries the delivery-note path in `image_path` (a storage path in
 * the `invoices` bucket, e.g. 'goods-receipts/delivery-note-<id>-<ts>.jpg')
 * plus `photo_paths` for any extra product photos. Numbers may arrive as
 * numeric strings, so they are coerced; `photo_paths` defaults to [].
 */

export interface ReceiptLine {
  goods_receipt_id: string;
  goods_receipt_item_id: string;
  receipt_number: string;
  receipt_date: string;
  status: string;
  supplier_name: string | null;
  raw_name: string;
  quantity: number;
  unit: string | null;
  unit_price: number | null;
  line_total: number | null;
  image_path: string | null;
  photo_paths: string[];
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
  return asString(value, path);
}

function asNumber(value: unknown, path: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${path} must be a finite number`);
  return numeric;
}

function asNullableNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  return asNumber(value, path);
}

function asStringArray(value: unknown, path: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((entry, index) => asString(entry, `${path}[${index}]`));
}

/** Parse and validate one receipt line returned by either RPC. */
function parseReceiptLine(raw: unknown, path: string): ReceiptLine {
  const row = asRecord(raw, path);
  return {
    goods_receipt_id: asString(row.goods_receipt_id, `${path}.goods_receipt_id`),
    goods_receipt_item_id: asString(row.goods_receipt_item_id, `${path}.goods_receipt_item_id`),
    receipt_number: asString(row.receipt_number, `${path}.receipt_number`),
    receipt_date: asString(row.receipt_date, `${path}.receipt_date`),
    status: asString(row.status, `${path}.status`),
    supplier_name: asNullableString(row.supplier_name, `${path}.supplier_name`),
    raw_name: asString(row.raw_name, `${path}.raw_name`),
    quantity: asNumber(row.quantity, `${path}.quantity`),
    unit: asNullableString(row.unit, `${path}.unit`),
    unit_price: asNullableNumber(row.unit_price, `${path}.unit_price`),
    line_total: asNullableNumber(row.line_total, `${path}.line_total`),
    image_path: asNullableString(row.image_path, `${path}.image_path`),
    photo_paths: asStringArray(row.photo_paths, `${path}.photo_paths`),
  };
}

/**
 * Parse the jsonb array returned by `get_crate_receipt_lines` /
 * `get_item_receipt_lines`. A missing / null payload is an empty list so an
 * older server keeps the UI usable.
 */
export function parseReceiptLines(raw: unknown): ReceiptLine[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new TypeError("receiptLines must be an array");
  return raw.map((entry, index) => parseReceiptLine(entry, `receiptLines[${index}]`));
}
