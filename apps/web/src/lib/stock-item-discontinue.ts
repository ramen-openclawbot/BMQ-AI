/**
 * Pure helpers for the "Ngưng dùng" (discontinue) action on one kitchen item.
 *
 * The review parser validates the jsonb returned by
 *   public.get_discontinued_stock_items(),
 * which is an array of the inactive items that still have a discontinuation row.
 *
 * The server is authoritative: these helpers only make a broken RPC response
 * render as an empty/safe value instead of a fake success, and map the known
 * server error codes to short Vietnamese texts.
 */

export interface DiscontinuedStockItem {
  item_id: string;
  item_code: string | null;
  name: string;
  unit: string;
  item_class: string | null;
  pastry_q7: boolean;
  /** On-hand at Tân Tạo today, same formula as discontinue_stock_item. */
  tan_tao_qty: number;
  /** On-hand at Q7 today, same formula as discontinue_stock_item. */
  q7_qty: number;
  /** True when the item lives at Q7 (pastry_q7 or a Q7 movement). */
  in_q7: boolean;
  /** True when a production_usage movement happened in the last 7 Vietnam days. */
  used_7d: boolean;
  /** On-hand recorded when the item was stopped; null for older rows. */
  tan_tao_qty_at_stop: number | null;
  q7_qty_at_stop: number | null;
  reason: string | null;
  discontinued_by_name: string | null;
  discontinued_at: string;
}

export interface DiscontinueResult {
  item_id: string;
  name: string;
  active: boolean;
}

const DISCONTINUE_ERROR_CODES = [
  "item_has_stock",
  "item_in_open_count",
  "item_merged",
  "insufficient_privilege",
  "item_not_found",
] as const;

export type DiscontinueErrorCode = (typeof DISCONTINUE_ERROR_CODES)[number] | "unknown";

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumberOr(value: unknown, fallback: number): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) ? numeric : fallback;
}

function asNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Tolerant reader for public.get_discontinued_stock_items(). A malformed
 * payload (not an array, non-object entries, a missing item_id) is skipped
 * instead of throwing.
 */
export function parseDiscontinuedStockItems(raw: unknown): DiscontinuedStockItem[] {
  if (!Array.isArray(raw)) return [];
  const items: DiscontinuedStockItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const itemId = asStringOrNull(record.item_id);
    if (itemId === null) continue;
    const pastryQ7 = record.pastry_q7 === true;
    items.push({
      item_id: itemId,
      item_code: asStringOrNull(record.item_code),
      name: asStringOrNull(record.name) ?? "",
      unit: asStringOrNull(record.unit) ?? "",
      item_class: asStringOrNull(record.item_class),
      pastry_q7: pastryQ7,
      tan_tao_qty: asNumberOr(record.tan_tao_qty, 0),
      q7_qty: asNumberOr(record.q7_qty, 0),
      // Older payloads only had pastry_q7: fall back to it when in_q7 is absent.
      in_q7:
        record.in_q7 === true ? true : record.in_q7 === false ? false : pastryQ7,
      used_7d: record.used_7d === true,
      tan_tao_qty_at_stop: asNumberOrNull(record.tan_tao_qty_at_stop),
      q7_qty_at_stop: asNumberOrNull(record.q7_qty_at_stop),
      reason: asStringOrNull(record.reason),
      discontinued_by_name: asStringOrNull(record.discontinued_by_name),
      discontinued_at: asStringOrNull(record.discontinued_at) ?? "",
    });
  }
  return items;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/**
 * Extract one known discontinue RPC error code from an error, or "unknown".
 * Both item_has_stock and item_in_open_count share SQLSTATE 22023, so the
 * raised message is what identifies them.
 */
export function discontinueErrorCode(error: unknown): DiscontinueErrorCode {
  const message = errorMessage(error);
  if (!message) return "unknown";
  for (const code of DISCONTINUE_ERROR_CODES) {
    if (message.includes(code)) return code;
  }
  return "unknown";
}

/** Short Vietnamese text for a discontinue error code. */
export function discontinueErrorText(code: string): string {
  if (code === "item_has_stock") return "Món còn tồn — kiểm kê hoặc xuất hết trước khi ngưng";
  if (code === "item_in_open_count") return "Món đã được đếm trong phiếu kiểm kê chưa chốt — chốt phiếu trước";
  if (code === "item_merged") return "Món đã được gộp vào món khác";
  if (code === "insufficient_privilege") return "Bạn không có quyền ngưng món này";
  return "Chưa ngưng được món này";
}
