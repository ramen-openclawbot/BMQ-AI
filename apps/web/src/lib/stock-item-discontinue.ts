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
  pastry_q7: boolean;
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
    items.push({
      item_id: itemId,
      item_code: asStringOrNull(record.item_code),
      name: asStringOrNull(record.name) ?? "",
      unit: asStringOrNull(record.unit) ?? "",
      pastry_q7: record.pastry_q7 === true,
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
  if (code === "item_in_open_count") return "Món đang nằm trong phiếu kiểm kê chưa chốt";
  if (code === "item_merged") return "Món đã được gộp vào món khác";
  if (code === "insufficient_privilege") return "Bạn không có quyền ngưng món này";
  return "Chưa ngưng được món này";
}
