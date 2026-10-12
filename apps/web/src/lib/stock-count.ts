/**
 * Pure helpers for physical stock count sessions (2026-10-30).
 *
 * The parsers validate the jsonb returned by
 *   public.start_stock_count(text, text),
 *   public.save_stock_count_line(uuid, uuid, numeric, text),
 *   public.submit_stock_count(uuid, text),
 *   public.cancel_stock_count(uuid) and
 *   public.get_stock_count_review(text, integer).
 *
 * A session always carries its lines. History entries (submitted / cancelled)
 * may arrive without any line, so a missing `lines` key parses as [].
 */

import { STOCK_ITEM_CLASSES } from "./stock-catalog.ts";

export type StockCountLocation = "q7" | "tan_tao";
export type StockCountStatus = "open" | "submitted" | "cancelled";
export type StockCountTargetKind = "item" | "sku";

/** `null` item_class is shown as this group, like in the warehouse game. */
export const STOCK_COUNT_UNCLASSIFIED = "unclassified";

export interface StockCountLine {
  id: string;
  target_kind: StockCountTargetKind;
  target_id: string;
  target_code: string;
  target_name: string;
  unit: string;
  item_class: string;
  book_qty: number;
  counted_qty: number | null;
  note: string | null;
  counted_by: string | null;
  counted_at: string | null;
  difference_qty: number | null;
  result: Record<string, unknown> | null;
}

export interface StockCountSummary {
  counted: number;
  skipped: number;
  adjusted: number;
  total_abs_diff: number;
  lines_with_diff: number;
}

export interface StockCountSession {
  id: string;
  location: StockCountLocation;
  count_date: string;
  status: StockCountStatus;
  opened_by: string | null;
  submitted_by: string | null;
  submitted_by_name: string | null;
  opened_at: string;
  submitted_at: string | null;
  note: string | null;
  summary: StockCountSummary | null;
  lines: StockCountLine[];
}

export interface StockCountReview {
  open_session: StockCountSession | null;
  history: StockCountSession[];
  cutover_date: string | null;
  can_edit: boolean;
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

function asLocation(value: unknown, path: string): StockCountLocation {
  const location = asString(value, path);
  if (location !== "q7" && location !== "tan_tao") throw new TypeError(`${path} is invalid`);
  return location;
}

function asStatus(value: unknown, path: string): StockCountStatus {
  const status = asString(value, path);
  if (status !== "open" && status !== "submitted" && status !== "cancelled") {
    throw new TypeError(`${path} is invalid`);
  }
  return status;
}

function asTargetKind(value: unknown, path: string): StockCountTargetKind {
  const kind = asString(value, path);
  if (kind !== "item" && kind !== "sku") throw new TypeError(`${path} is invalid`);
  return kind;
}

function asItemClass(value: unknown, path: string): string {
  const itemClass = asString(value, path);
  if (
    itemClass !== STOCK_COUNT_UNCLASSIFIED &&
    !(STOCK_ITEM_CLASSES as readonly string[]).includes(itemClass)
  ) {
    throw new TypeError(`${path} is invalid`);
  }
  return itemClass;
}

function asNullableRecord(value: unknown, path: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return asRecord(value, path);
}

/** Parse and validate one stock count line (also the save_stock_count_line result). */
export function parseStockCountLine(raw: unknown, path = "stockCountLine"): StockCountLine {
  const row = asRecord(raw, path);
  return {
    id: asString(row.id, `${path}.id`),
    target_kind: asTargetKind(row.target_kind, `${path}.target_kind`),
    target_id: asString(row.target_id, `${path}.target_id`),
    target_code: asString(row.target_code, `${path}.target_code`),
    target_name: asString(row.target_name, `${path}.target_name`),
    unit: asString(row.unit, `${path}.unit`),
    item_class: asItemClass(row.item_class, `${path}.item_class`),
    book_qty: asNumber(row.book_qty, `${path}.book_qty`),
    counted_qty: asNullableNumber(row.counted_qty, `${path}.counted_qty`),
    note: asNullableString(row.note, `${path}.note`),
    counted_by: asNullableString(row.counted_by, `${path}.counted_by`),
    counted_at: asNullableString(row.counted_at, `${path}.counted_at`),
    difference_qty: asNullableNumber(row.difference_qty, `${path}.difference_qty`),
    result: asNullableRecord(row.result, `${path}.result`),
  };
}

/** Parse the summary written by submit_stock_count. */
function parseStockCountSummary(raw: unknown, path: string): StockCountSummary {
  const row = asRecord(raw, path);
  return {
    counted: asNumber(row.counted, `${path}.counted`),
    skipped: asNumber(row.skipped, `${path}.skipped`),
    adjusted: asNumber(row.adjusted, `${path}.adjusted`),
    total_abs_diff: asNumber(row.total_abs_diff, `${path}.total_abs_diff`),
    lines_with_diff: asNumber(row.lines_with_diff, `${path}.lines_with_diff`),
  };
}

/** Parse and validate the jsonb returned by start / submit / cancel. */
export function parseStockCountSession(raw: unknown, path = "stockCountSession"): StockCountSession {
  const root = asRecord(raw, path);
  const rawLines = root.lines;
  if (rawLines !== undefined && rawLines !== null && !Array.isArray(rawLines)) {
    throw new TypeError(`${path}.lines must be an array`);
  }
  const lines = Array.isArray(rawLines)
    ? rawLines.map((line, index) => parseStockCountLine(line, `${path}.lines[${index}]`))
    : [];
  return {
    id: asString(root.id, `${path}.id`),
    location: asLocation(root.location, `${path}.location`),
    count_date: asString(root.count_date, `${path}.count_date`),
    status: asStatus(root.status, `${path}.status`),
    opened_by: asNullableString(root.opened_by, `${path}.opened_by`),
    submitted_by: asNullableString(root.submitted_by, `${path}.submitted_by`),
    submitted_by_name: asNullableString(root.submitted_by_name, `${path}.submitted_by_name`),
    opened_at: asString(root.opened_at, `${path}.opened_at`),
    submitted_at: asNullableString(root.submitted_at, `${path}.submitted_at`),
    note: asNullableString(root.note, `${path}.note`),
    summary:
      root.summary === null || root.summary === undefined
        ? null
        : parseStockCountSummary(root.summary, `${path}.summary`),
    lines,
  };
}

/** Parse and validate the jsonb returned by get_stock_count_review. */
export function parseStockCountReview(raw: unknown): StockCountReview {
  const root = asRecord(raw, "stockCountReview");
  const rawHistory = root.history;
  if (!Array.isArray(rawHistory)) throw new TypeError("stockCountReview.history must be an array");
  return {
    open_session:
      root.open_session === null || root.open_session === undefined
        ? null
        : parseStockCountSession(root.open_session, "stockCountReview.open_session"),
    history: rawHistory.map((session, index) =>
      parseStockCountSession(session, `stockCountReview.history[${index}]`),
    ),
    cutover_date: asNullableString(root.cutover_date, "stockCountReview.cutover_date"),
    can_edit: asBoolean(root.can_edit, "stockCountReview.can_edit"),
  };
}

/** Parse and validate the jsonb returned by save_stock_count_line. */
export function parseSaveLineResult(raw: unknown): StockCountLine {
  return parseStockCountLine(raw, "saveStockCountLine");
}

/**
 * Client-side totals of one session, independent of the server summary:
 * null lines are skipped, every non-null line counts, a difference against the
 * book quantity counts as one adjustment.
 */
export function summarizeStockCount(lines: readonly StockCountLine[]): StockCountSummary {
  let counted = 0;
  let skipped = 0;
  let adjusted = 0;
  let linesWithDiff = 0;
  let totalAbsDiff = 0;
  for (const line of lines) {
    if (line.counted_qty === null) {
      skipped += 1;
      continue;
    }
    counted += 1;
    const diff = line.counted_qty - line.book_qty;
    if (diff !== 0) {
      adjusted += 1;
      linesWithDiff += 1;
      totalAbsDiff += Math.abs(diff);
    }
  }
  return {
    counted,
    skipped,
    adjusted,
    total_abs_diff: totalAbsDiff,
    lines_with_diff: linesWithDiff,
  };
}
