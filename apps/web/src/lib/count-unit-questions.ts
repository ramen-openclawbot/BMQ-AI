/**
 * Pure helpers for the 16/10 stock-count unit questions game (2026-11-01).
 *
 * The parsers validate the jsonb returned by
 *   public.get_stock_count_unit_questions(text) and
 *   public.answer_stock_count_unit_question(uuid, uuid, numeric, text, text, boolean, text).
 *
 * The server is authoritative: these helpers only turn a broken RPC response
 * into a safe value instead of a fake success.
 */

export type StockCountUnitLocation = "q7" | "tan_tao";
export type StockCountUnitQuestionStatus = "open" | "answered" | "skipped";

/** Suggested / chosen catalog item shown on a question card. */
export interface StockCountUnitItem {
  id: string;
  code: string | null;
  name: string;
  unit: string;
}

/** One selectable standard unit (`public.stock_units`). */
export interface StockCountUnitOption {
  code: string;
  label: string;
}

export interface StockCountUnitQuestion {
  id: string;
  batch: string;
  location: StockCountUnitLocation;
  sort_order: number;
  file_label: string;
  file_qty: number;
  file_unit: string;
  suggested_item_id: string | null;
  suggested_factor: number | null;
  status: StockCountUnitQuestionStatus;
  item_id: string | null;
  factor: number | null;
  counted_qty: number | null;
  record_result: Record<string, unknown> | null;
  note: string | null;
  answered_by: string | null;
  answered_at: string | null;
  suggested_item: StockCountUnitItem | null;
  chosen_item: StockCountUnitItem | null;
  item_units: StockCountUnitOption[];
  /** True when the answer RPC replayed an already answered/skipped question. */
  replay: boolean;
}

/** What the answer mutation sends for one question. */
export interface CountUnitAnswerInput {
  itemId?: string | null;
  factor?: number | null;
  newItemName?: string | null;
  newItemUnit?: string | null;
  skip?: boolean;
  note?: string | null;
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

function asNullableNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, path);
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function parseLocation(value: unknown, path: string): StockCountUnitLocation {
  if (value === "q7" || value === "tan_tao") return value;
  throw new TypeError(`${path} must be one of q7, tan_tao`);
}

function parseStatus(value: unknown, path: string): StockCountUnitQuestionStatus {
  if (value === "open" || value === "answered" || value === "skipped") return value;
  throw new TypeError(`${path} must be one of open, answered, skipped`);
}

function parseItem(value: unknown, path: string): StockCountUnitItem | null {
  if (value === null || value === undefined) return null;
  const row = asRecord(value, path);
  return {
    id: asString(row.id, `${path}.id`),
    code: asNullableString(row.code, `${path}.code`),
    name: asString(row.name, `${path}.name`),
    unit: asString(row.unit, `${path}.unit`),
  };
}

function parseUnits(value: unknown, path: string): StockCountUnitOption[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const row = asRecord(entry, `${path}[${index}]`);
    return {
      code: asString(row.code, `${path}[${index}].code`),
      label: asString(row.label, `${path}[${index}].label`),
    };
  });
}

/** One question row; a replay answer carries the same shape plus `replay`. */
export function parseStockCountUnitQuestion(
  raw: unknown,
  path = "countUnitQuestion",
): StockCountUnitQuestion {
  const row = asRecord(raw, path);
  return {
    id: asString(row.id, `${path}.id`),
    batch: asString(row.batch, `${path}.batch`),
    location: parseLocation(row.location, `${path}.location`),
    sort_order: asNumber(row.sort_order, `${path}.sort_order`),
    file_label: asString(row.file_label, `${path}.file_label`),
    file_qty: asNumber(row.file_qty, `${path}.file_qty`),
    file_unit: asString(row.file_unit, `${path}.file_unit`),
    suggested_item_id: asNullableString(row.suggested_item_id, `${path}.suggested_item_id`),
    suggested_factor: asNullableNumber(row.suggested_factor, `${path}.suggested_factor`),
    status: parseStatus(row.status, `${path}.status`),
    item_id: asNullableString(row.item_id, `${path}.item_id`),
    factor: asNullableNumber(row.factor, `${path}.factor`),
    counted_qty: asNullableNumber(row.counted_qty, `${path}.counted_qty`),
    record_result:
      row.record_result === null || row.record_result === undefined
        ? null
        : asRecord(row.record_result, `${path}.record_result`),
    note: asNullableString(row.note, `${path}.note`),
    answered_by: asNullableString(row.answered_by, `${path}.answered_by`),
    answered_at: asNullableString(row.answered_at, `${path}.answered_at`),
    suggested_item: parseItem(row.suggested_item, `${path}.suggested_item`),
    chosen_item: parseItem(row.chosen_item, `${path}.chosen_item`),
    item_units: parseUnits(row.item_units, `${path}.item_units`),
    replay: row.replay === null || row.replay === undefined
      ? false
      : asBoolean(row.replay, `${path}.replay`),
  };
}

/**
 * Parse the jsonb returned by get_stock_count_unit_questions (a bare array).
 * A `{questions: [...]}` wrapper and null are tolerated.
 */
export function parseStockCountUnitQuestions(raw: unknown): StockCountUnitQuestion[] {
  if (raw === null || raw === undefined) return [];
  let list: unknown[];
  if (Array.isArray(raw)) {
    list = raw;
  } else {
    const root = asRecord(raw, "countUnitQuestions");
    list = Array.isArray(root.questions) ? root.questions : [];
  }
  return list.map((entry, index) =>
    parseStockCountUnitQuestion(entry, `countUnitQuestions[${index}]`),
  );
}

// ---------------------------------------------------------------------------
// Pure gameplay helpers
// ---------------------------------------------------------------------------

/** counted_qty = round(file_qty × factor, 3), matching the SQL RPC. */
export function computeCountedQty(fileQty: number, factor: number): number {
  const product = fileQty * factor;
  if (!Number.isFinite(product)) return Number.NaN;
  return Math.round(product * 1000) / 1000;
}

/** "1 cây = ? cuộn" — the factor the operator has to read off the file line. */
export function factorPrompt(fileUnit: string, itemUnit: string): string {
  const from = fileUnit.trim() || "?";
  const to = itemUnit.trim() || "?";
  return `1 ${from} = ? ${to}`;
}

/** Whether the current card input can be submitted to the answer RPC. */
export function canSubmit(row: StockCountUnitQuestion, input: CountUnitAnswerInput): boolean {
  if (row.status !== "open") return false;
  if (input.skip === true) return true;

  const newName = (input.newItemName ?? "").trim();
  const hasItem = Boolean(input.itemId);
  if (hasItem === (newName !== "")) return false;

  const factor = input.factor;
  if (factor === null || factor === undefined) return false;
  if (!Number.isFinite(factor) || factor <= 0) return false;

  if (newName !== "" && (input.newItemUnit ?? "").trim() === "") return false;
  return true;
}
