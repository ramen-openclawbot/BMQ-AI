/**
 * Trừ kho chờ duyệt (owner 28/10): days the revenue-based stock deduction (COGS backflush) held back
 * instead of posting. A day is held when its quantity is more than 5x the item's 30-day median daily
 * usage, or when the item has fewer than 5 days of usage history to compare with.
 *
 * Rows come from public.cogs_backflush_list_holds (owner-only); decisions go through
 * public.cogs_backflush_decide_hold. An approved day is posted by the next hourly run, not here.
 */

export type KhoHoldLocation = "q7" | "tan_tao";
export type KhoHoldReason = "outlier" | "no_reference";
export type KhoHoldStatus = "held" | "approved" | "rejected";
export type KhoHoldDecision = "approve" | "reject";

export interface KhoHoldRow {
  id: string;
  location: KhoHoldLocation;
  item_id: string;
  item_name: string;
  item_unit: string;
  movement_date: string;
  desired_qty: number;
  delta_qty: number;
  reference_qty: number | null;
  reference_days: number;
  reason: KhoHoldReason;
  status: KhoHoldStatus;
  approved_desired_qty: number | null;
  decided_at: string | null;
  updated_at: string | null;
}

export const KHO_HOLD_STATUSES: KhoHoldStatus[] = ["held", "approved", "rejected"];
export const KHO_HOLD_STATUS_LABELS: Record<KhoHoldStatus, string> = {
  held: "Đang chờ",
  approved: "Đã duyệt",
  rejected: "Đã bỏ",
};
export const KHO_HOLD_REASON_LABELS: Record<KhoHoldReason, string> = {
  outlier: "Cao bất thường",
  no_reference: "Chưa đủ lịch sử",
};

const LOCATIONS: KhoHoldLocation[] = ["q7", "tan_tao"];
const REASONS: KhoHoldReason[] = ["outlier", "no_reference"];

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** One RPC row → a typed row, or null when it lacks the fields the page needs. */
export function parseKhoHold(raw: unknown): KhoHoldRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = text(r.id);
  const location = text(r.location) as KhoHoldLocation | null;
  const itemId = text(r.kitchen_inventory_item_id);
  const date = text(r.movement_date);
  const desired = num(r.desired_qty);
  const reason = text(r.reason) as KhoHoldReason | null;
  const status = text(r.status) as KhoHoldStatus | null;
  if (!id || !itemId || !date || desired === null) return null;
  if (!location || !LOCATIONS.includes(location)) return null;
  if (!reason || !REASONS.includes(reason)) return null;
  if (!status || !KHO_HOLD_STATUSES.includes(status)) return null;
  return {
    id,
    location,
    item_id: itemId,
    item_name: text(r.item_name) ?? "Món không rõ tên",
    item_unit: text(r.item_unit) ?? "",
    movement_date: date.slice(0, 10),
    desired_qty: desired,
    delta_qty: num(r.delta_qty) ?? desired,
    reference_qty: num(r.reference_qty),
    reference_days: Math.max(0, Math.trunc(num(r.reference_days) ?? 0)),
    reason,
    status,
    approved_desired_qty: num(r.approved_desired_qty),
    decided_at: text(r.decided_at),
    updated_at: text(r.updated_at),
  };
}

/** The list RPC returns a JSON array; anything else is treated as empty. Bad rows are dropped. */
export function parseKhoHolds(data: unknown): KhoHoldRow[] {
  if (!Array.isArray(data)) return [];
  return data.map(parseKhoHold).filter((row): row is KhoHoldRow => row !== null);
}

/** How many times the usual day this is (rounded to one decimal), or null with no usual figure. */
export function holdMultiple(row: KhoHoldRow): number | null {
  if (row.reference_qty === null || row.reference_qty <= 0) return null;
  return Math.round((row.desired_qty / row.reference_qty) * 10) / 10;
}

export interface KhoHoldFilters {
  location: KhoHoldLocation | "all";
  reason: KhoHoldReason | "all";
}

export function filterKhoHolds(rows: KhoHoldRow[], filters: KhoHoldFilters): KhoHoldRow[] {
  return rows.filter((row) =>
    (filters.location === "all" || row.location === filters.location)
    && (filters.reason === "all" || row.reason === filters.reason));
}

export interface KhoHoldDay {
  day: string;
  rows: KhoHoldRow[];
}

/** Newest day first; within a day, the most abnormal first, then by name. */
export function groupKhoHoldsByDay(rows: KhoHoldRow[]): KhoHoldDay[] {
  const byDay = new Map<string, KhoHoldRow[]>();
  for (const row of rows) {
    const list = byDay.get(row.movement_date) ?? [];
    list.push(row);
    byDay.set(row.movement_date, list);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, list]) => ({
      day,
      rows: [...list].sort((a, b) => {
        const ma = holdMultiple(a) ?? -1;
        const mb = holdMultiple(b) ?? -1;
        if (ma !== mb) return mb - ma;
        return a.item_name.localeCompare(b.item_name, "vi");
      }),
    }));
}

/** The decision RPC refuses a different decision on a row someone already decided. */
export function holdDecisionError(error: unknown): string {
  const raw = error as { code?: string; message?: string } | null;
  const message = raw?.message ?? "";
  if (raw?.code === "42501" || /insufficient_privilege/.test(message)) return "Chỉ chủ mới duyệt được.";
  if (/hold_already_decided/.test(message)) return "Dòng này đã được người khác quyết định. Tải lại để xem.";
  if (/hold_not_found/.test(message)) return "Dòng này không còn nữa. Tải lại để xem.";
  return "Chưa lưu được quyết định. Thử lại sau ít giây.";
}
