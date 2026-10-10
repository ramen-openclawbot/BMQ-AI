/**
 * Pure helpers for the automatic Q7 raw-material purchasing flow.
 *
 * The formulas here mirror the SQL in
 * supabase/migrations/20261014100000_q7_auto_purchase.sql (simulateReorder,
 * suggested quantity rounding, the auto-send downgrade rules and the package
 * regex) so the same behaviour is exercised by node:test and by the SQL smoke.
 * Keep `parsePackFromName` in sync with `public.q7_pack_from_name` in the
 * migration.
 */

export type Q7PurchaseMode = "off" | "suggest" | "auto_draft" | "auto_send";

export type Q7AutoPurchaseDecision = "skip" | "suggest" | "draft" | "auto_send";

export const Q7_PURCHASE_MODES: readonly Q7PurchaseMode[] = [
  "off",
  "suggest",
  "auto_draft",
  "auto_send",
];

export type Q7ForecastFlagCode =
  | "no_stock_count"
  | "stale_stock_count"
  | "short_history"
  | "no_supplier"
  | "no_pack_size"
  | "no_price"
  | "duplicate_material"
  | "high_backtest_error";

export type Q7ReasonCode =
  | "mode_off"
  | "mode_suggest"
  | "mode_auto_draft"
  | "auto_send"
  | "over_po_limit"
  | "over_daily_limit"
  | "system_error"
  | Q7ForecastFlagCode;

export const Q7_REASON_LABELS: Readonly<Record<string, string>> = {
  mode_off: "Mặt hàng đang tắt tự động đặt",
  mode_suggest: "Chế độ chỉ đề xuất, không tạo phiếu",
  mode_auto_draft: "Tạo phiếu nháp chờ duyệt",
  auto_send: "Đủ điều kiện tự động gửi",
  no_stock_count: "Chưa có kiểm kê tồn kho",
  stale_stock_count: "Kiểm kê tồn kho đã cũ",
  short_history: "Chưa đủ 4 tuần dữ liệu xuất kho",
  no_supplier: "Chưa gán nhà cung cấp",
  no_pack_size: "Chưa có quy cách đóng gói",
  no_price: "Chưa có giá mua gần nhất",
  duplicate_material: "Trùng mặt hàng với vật tư khác",
  high_backtest_error: "Sai số dự báo vượt ngưỡng an toàn",
  over_po_limit: "Vượt hạn mức một phiếu",
  over_daily_limit: "Vượt hạn mức trong ngày",
  system_error: "Lỗi khi gửi phiếu, giữ nháp để xử lý",
};

/** Vietnamese label for a decision/reason code (fallback: the raw code). */
export function reasonLabel(code: string): string {
  return Q7_REASON_LABELS[code] ?? code;
}

export interface Q7ForecastFlags {
  no_stock_count: boolean;
  stale_stock_count: boolean;
  short_history: boolean;
  no_supplier: boolean;
  no_pack_size: boolean;
  no_price: boolean;
  duplicate_material: boolean;
  high_backtest_error: boolean;
}

export interface Q7PurchaseForecastItem {
  item_id: string;
  item_code: string | null;
  item_name: string;
  unit: string;
  mode: Q7PurchaseMode;
  daily_usage: number;
  avg_14d: number;
  avg_28d: number;
  stddev_28d: number;
  days_with_data: number;
  weekday_factor: number;
  scheduled_usage: number;
  on_hand: number | null;
  last_count_date: string | null;
  open_po_qty: number;
  supplier_id: string | null;
  pack_size: number | null;
  pack_label: string | null;
  lead_time_days: number;
  safety_days: number;
  order_cycle_days: number;
  reorder_date: string | null;
  suggested_qty: number;
  last_unit_price: number | null;
  estimated_amount: number | null;
  flags: Q7ForecastFlags;
}

export interface Q7PurchaseForecast {
  as_of: string;
  horizon_days: number;
  items: Q7PurchaseForecastItem[];
}

export interface Q7AutoPurchaseSettings {
  id: number;
  enabled: boolean;
  system_actor_id: string | null;
  max_po_amount: number;
  max_daily_amount: number;
  max_stock_count_age_days: number;
  max_backtest_error: number;
  run_hour_vn: number;
  updated_by: string | null;
  updated_at: string | null;
}

export interface Q7AutoPurchaseRun {
  id: string;
  run_date: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: Record<string, unknown>;
}

export interface Q7AutoPurchaseDecisionRecord {
  id: string;
  run_id: string;
  item_id: string;
  item_name: string | null;
  decision: Q7AutoPurchaseDecision;
  reason_codes: string[];
  suggested_qty: number | null;
  estimated_amount: number | null;
  purchase_order_id: string | null;
  purchase_order_number: string | null;
  created_at: string;
}

export interface Q7AutoPurchaseStatus {
  settings: Q7AutoPurchaseSettings;
  latest_run: Q7AutoPurchaseRun | null;
  decisions: Q7AutoPurchaseDecisionRecord[];
}

export interface Q7DayTotals {
  /** Value already committed to auto-send POs for the same run day. */
  autoSentAmount?: number;
  /** Value of the PO currently being evaluated (defaults to the item amount). */
  poAmount?: number;
}

export interface DecideAutoPurchaseResult {
  decision: Q7AutoPurchaseDecision;
  reasonCodes: Q7ReasonCode[];
}

// ---------------------------------------------------------------------------
// Package parsing (mirrors public.q7_pack_from_name)
// ---------------------------------------------------------------------------

export interface ParsedPack {
  /** Human label copied from the material name, e.g. "25kg" / "5L x 4 chai". */
  label: string;
  /** Leading quantity (e.g. 25 for "25kg"); null for a bare "x 6 chai". */
  baseQty: number | null;
  /** Leading unit (e.g. "kg", "l", "chai"); null when absent. */
  baseUnit: string | null;
  /** Multiplier from "x N" (1 when absent). */
  multiplier: number;
}

const PACK_COUNT_UNITS = new Set([
  "chai",
  "thung",
  "hop",
  "goi",
  "bao",
  "can",
  "bich",
  "cai",
  "vi",
  "kg",
  "g",
  "gr",
  "gram",
  "l",
  "lit",
  "ml",
]);

/**
 * Read a package specification out of a material name. Mirrors the SQL regex:
 * an optional leading number + unit, followed by an optional "x N" multiplier.
 * Examples: "25kg", "5L x 4 chai", "Bột mì (25kg)", "x 6 chai".
 */
export function parsePackFromName(name: string | null | undefined): ParsedPack | null {
  const text = String(name ?? "");
  if (!text.trim()) return null;

  const match = text.match(
    /(\d+(?:[.,]\d+)?)\s*(kg|g|gr|gram|l|lit|ml|chai|thùng|thung|hộp|hop|gói|goi|bao|can|bịch|bich|cái|cai|vỉ|vi)?\s*(?:x\s*(\d+))?/i,
  );
  if (!match) return null;

  const baseQty = match[1] !== undefined ? Number(match[1].replace(",", ".")) : null;
  const rawUnit = match[2] ? match[2].toLowerCase() : null;
  const multiplier = match[3] !== undefined ? Number(match[3]) : 1;
  if ((baseQty === null || !Number.isFinite(baseQty)) && multiplier <= 1) return null;

  const label = text.trim();
  return { label, baseQty, baseUnit: rawUnit, multiplier };
}

const MASS_TO_G: Readonly<Record<string, number>> = {
  kg: 1000,
  g: 1,
  gr: 1,
  gram: 1,
};

const VOLUME_TO_ML: Readonly<Record<string, number>> = {
  l: 1000,
  lit: 1000,
  ml: 1,
};

function normalizedUnit(unit: string | null | undefined): string {
  return String(unit ?? "").trim().toLowerCase();
}

/**
 * Convert a parsed pack into the Q7 book unit. Handles mass (kg/g) and volume
 * (l/ml) conversions and plain count units. Returns null when the pack cannot
 * be expressed in the book unit.
 */
export function packSizeInBookUnit(
  parsed: ParsedPack | null,
  bookUnit: string | null | undefined,
): number | null {
  if (!parsed) return null;
  const target = normalizedUnit(bookUnit);
  const multiplier = Number.isFinite(parsed.multiplier) && parsed.multiplier > 0 ? parsed.multiplier : 1;

  if (parsed.baseQty === null || !Number.isFinite(parsed.baseQty)) {
    // Bare "x 6 chai": the pack is exactly the multiplier of the base unit.
    if (target && parsed.baseUnit && normalizedUnit(parsed.baseUnit) !== target) return null;
    const size = multiplier;
    return size > 0 ? size : null;
  }

  const base = parsed.baseUnit ? normalizedUnit(parsed.baseUnit) : null;
  const massBase = base ? MASS_TO_G[base] : undefined;
  const volumeBase = base ? VOLUME_TO_ML[base] : undefined;
  const massTarget = target ? MASS_TO_G[target] : undefined;
  const volumeTarget = target ? VOLUME_TO_ML[target] : undefined;

  let size: number | null = null;
  if (massBase !== undefined && massTarget !== undefined) {
    size = (parsed.baseQty * massBase) / massTarget;
  } else if (volumeBase !== undefined && volumeTarget !== undefined) {
    size = (parsed.baseQty * volumeBase) / volumeTarget;
  } else if (base && target && base === target) {
    size = parsed.baseQty;
  } else if (base === null) {
    size = parsed.baseQty;
  } else if (target && PACK_COUNT_UNITS.has(target) && target === base) {
    size = parsed.baseQty;
  }

  if (size === null) return null;
  const total = size * multiplier;
  return total > 0 ? total : null;
}

// ---------------------------------------------------------------------------
// Quantity maths (mirror the SQL forecast)
// ---------------------------------------------------------------------------

export interface SuggestedQtyInput {
  dailyUsage: number;
  leadTimeDays: number;
  safetyDays: number;
  orderCycleDays: number;
  onHand: number | null;
  openPoQty: number;
  packSize: number | null;
  maxOrderQty: number | null;
}

/** Quantity to cover lead + safety + cycle days, net of on-hand and inbound POs. */
export function computeSuggestedQty(input: SuggestedQtyInput): number {
  const dailyUsage = Number.isFinite(input.dailyUsage) ? input.dailyUsage : 0;
  const need =
    dailyUsage *
    ((input.leadTimeDays || 0) + (input.safetyDays || 0) + (input.orderCycleDays || 0));
  const available = (input.onHand ?? 0) + (input.openPoQty ?? 0);
  const raw = Math.max(0, need - available);
  if (raw <= 0) return 0;

  const packSize = input.packSize && input.packSize > 0 ? input.packSize : null;
  let suggested = packSize ? Math.ceil(raw / packSize) * packSize : Math.ceil(raw);
  if (input.maxOrderQty !== null && input.maxOrderQty !== undefined && input.maxOrderQty > 0) {
    suggested = Math.min(suggested, input.maxOrderQty);
  }
  return roundQty(suggested);
}

export function roundQty(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Reorder simulation (mirror the SQL simulateReorder)
// ---------------------------------------------------------------------------

export interface SimulateReorderInput {
  asOf: string;
  onHand: number | null;
  dailyUsage: number;
  safetyDays: number;
  leadTimeDays: number;
  horizonDays: number;
  scheduledByDate?: Record<string, number> | null;
}

export interface SimulateReorderResult {
  reorderDate: string | null;
  /** Projected on-hand at the first breach (or end of horizon). */
  projectedOnHand: number;
}

function parseIsoDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  const date = parseIsoDate(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

/**
 * Walk the next `horizonDays` days subtracting either the scheduled issue or the
 * baseline daily usage. Returns the first breach date shifted back by the lead
 * time. A null on-hand means "unknown": treat as due immediately.
 */
export function simulateReorder(input: SimulateReorderInput): SimulateReorderResult {
  const horizon = Math.max(1, Math.trunc(input.horizonDays || 1));
  const dailyUsage = Number.isFinite(input.dailyUsage) ? input.dailyUsage : 0;
  const safetyDays = Number.isFinite(input.safetyDays) ? input.safetyDays : 0;
  const leadTime = Math.max(0, Math.trunc(input.leadTimeDays || 0));

  if (input.onHand === null || input.onHand === undefined || !Number.isFinite(input.onHand)) {
    return { reorderDate: input.asOf, projectedOnHand: Number.NaN };
  }
  if (dailyUsage <= 0) {
    return { reorderDate: null, projectedOnHand: input.onHand };
  }

  const threshold = dailyUsage * safetyDays;
  let projected = input.onHand;
  for (let offset = 1; offset <= horizon; offset += 1) {
    const day = addDays(input.asOf, offset);
    const scheduled = input.scheduledByDate?.[day];
    const usage = scheduled !== undefined && Number.isFinite(scheduled) ? scheduled : dailyUsage;
    projected -= usage;
    if (projected < threshold) {
      return { reorderDate: addDays(day, -leadTime), projectedOnHand: roundQty(projected) };
    }
  }
  return { reorderDate: null, projectedOnHand: roundQty(projected) };
}

// ---------------------------------------------------------------------------
// Decision rules (mirror run_q7_auto_purchase)
// ---------------------------------------------------------------------------

export function decideAutoPurchase(
  item: Pick<
    Q7PurchaseForecastItem,
    | "mode"
    | "on_hand"
    | "last_count_date"
    | "estimated_amount"
    | "flags"
    | "suggested_qty"
  >,
  settings: Pick<Q7AutoPurchaseSettings, "max_po_amount" | "max_daily_amount">,
  dayTotals: Q7DayTotals = {},
): DecideAutoPurchaseResult {
  const mode = item.mode ?? "suggest";

  if (mode === "off") return { decision: "skip", reasonCodes: ["mode_off"] };
  if (mode === "suggest") return { decision: "suggest", reasonCodes: ["mode_suggest"] };
  if (mode === "auto_draft") return { decision: "draft", reasonCodes: ["mode_auto_draft"] };

  const reasons: Q7ReasonCode[] = [];
  const flags = item.flags;
  const hasOnHand = item.on_hand !== null && Number.isFinite(item.on_hand);

  if (!hasOnHand || flags.no_stock_count) reasons.push("no_stock_count");
  if (flags.stale_stock_count) reasons.push("stale_stock_count");
  if (flags.high_backtest_error) reasons.push("high_backtest_error");
  if (flags.no_supplier) reasons.push("no_supplier");
  if (flags.no_pack_size) reasons.push("no_pack_size");
  if (flags.no_price) reasons.push("no_price");
  if (flags.duplicate_material) reasons.push("duplicate_material");

  const amount = Number.isFinite(item.estimated_amount)
    ? Number(item.estimated_amount)
    : 0;
  const poAmount = Number.isFinite(dayTotals.poAmount) ? Number(dayTotals.poAmount) : amount;
  const autoSentAmount = Number.isFinite(dayTotals.autoSentAmount)
    ? Number(dayTotals.autoSentAmount)
    : 0;

  if (poAmount > settings.max_po_amount) reasons.push("over_po_limit");
  if (autoSentAmount + amount > settings.max_daily_amount) reasons.push("over_daily_limit");

  if (reasons.length > 0) return { decision: "draft", reasonCodes: reasons };
  return { decision: "auto_send", reasonCodes: ["auto_send"] };
}

// ---------------------------------------------------------------------------
// Parsers for the read RPCs
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

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asFlags(value: unknown, path: string): Q7ForecastFlags {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  return {
    no_stock_count: asBoolean(raw.no_stock_count),
    stale_stock_count: asBoolean(raw.stale_stock_count),
    short_history: asBoolean(raw.short_history),
    no_supplier: asBoolean(raw.no_supplier),
    no_pack_size: asBoolean(raw.no_pack_size),
    no_price: asBoolean(raw.no_price),
    duplicate_material: asBoolean(raw.duplicate_material),
    high_backtest_error: asBoolean(raw.high_backtest_error),
  };
}

function asMode(value: unknown, path: string): Q7PurchaseMode {
  const mode = asString(value ?? "suggest", path);
  if (!Q7_PURCHASE_MODES.includes(mode as Q7PurchaseMode)) {
    throw new TypeError(`${path} must be one of ${Q7_PURCHASE_MODES.join(", ")}`);
  }
  return mode as Q7PurchaseMode;
}

function parseForecastItem(entry: unknown, index: number): Q7PurchaseForecastItem {
  const item = asRecord(entry, `items[${index}]`);
  return {
    item_id: asString(item.item_id, `items[${index}].item_id`),
    item_code: asNullableString(item.item_code, `items[${index}].item_code`),
    item_name: asString(item.item_name, `items[${index}].item_name`),
    unit: asString(item.unit, `items[${index}].unit`),
    mode: asMode(item.mode, `items[${index}].mode`),
    daily_usage: asNumber(item.daily_usage ?? 0, `items[${index}].daily_usage`),
    avg_14d: asNumber(item.avg_14d ?? 0, `items[${index}].avg_14d`),
    avg_28d: asNumber(item.avg_28d ?? 0, `items[${index}].avg_28d`),
    stddev_28d: asNumber(item.stddev_28d ?? 0, `items[${index}].stddev_28d`),
    days_with_data: asNumber(item.days_with_data ?? 0, `items[${index}].days_with_data`),
    weekday_factor: asNumber(item.weekday_factor ?? 1, `items[${index}].weekday_factor`),
    scheduled_usage: asNumber(item.scheduled_usage ?? 0, `items[${index}].scheduled_usage`),
    on_hand: asNullableNumber(item.on_hand, `items[${index}].on_hand`),
    last_count_date: asNullableString(
      item.last_count_date,
      `items[${index}].last_count_date`,
    ),
    open_po_qty: asNumber(item.open_po_qty ?? 0, `items[${index}].open_po_qty`),
    supplier_id: asNullableString(item.supplier_id, `items[${index}].supplier_id`),
    pack_size: asNullableNumber(item.pack_size, `items[${index}].pack_size`),
    pack_label: asNullableString(item.pack_label, `items[${index}].pack_label`),
    lead_time_days: asNumber(item.lead_time_days ?? 2, `items[${index}].lead_time_days`),
    safety_days: asNumber(item.safety_days ?? 2, `items[${index}].safety_days`),
    order_cycle_days: asNumber(
      item.order_cycle_days ?? 7,
      `items[${index}].order_cycle_days`,
    ),
    reorder_date: asNullableString(item.reorder_date, `items[${index}].reorder_date`),
    suggested_qty: asNumber(item.suggested_qty ?? 0, `items[${index}].suggested_qty`),
    last_unit_price: asNullableNumber(
      item.last_unit_price,
      `items[${index}].last_unit_price`,
    ),
    estimated_amount: asNullableNumber(
      item.estimated_amount,
      `items[${index}].estimated_amount`,
    ),
    flags: asFlags(item.flags, `items[${index}].flags`),
  };
}

/** Parse and validate the JSON returned by `get_q7_purchase_forecast`. */
export function parseQ7PurchaseForecast(raw: unknown): Q7PurchaseForecast {
  const root = asRecord(raw, "purchaseForecast");
  const rawItems = root.items;
  if (!Array.isArray(rawItems)) throw new TypeError("items must be an array");
  return {
    as_of: asString(root.as_of, "as_of"),
    horizon_days: asNumber(root.horizon_days ?? 14, "horizon_days"),
    items: rawItems.map(parseForecastItem),
  };
}

function asReasonCodes(value: unknown, path: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((entry, index) => asString(entry, `${path}[${index}]`));
}

function parseDecision(
  entry: unknown,
  index: number,
): Q7AutoPurchaseDecisionRecord {
  const decision = asRecord(entry, `decisions[${index}]`);
  const rawDecision = asString(decision.decision, `decisions[${index}].decision`);
  if (!["skip", "suggest", "draft", "auto_send"].includes(rawDecision)) {
    throw new TypeError(`decisions[${index}].decision is invalid`);
  }
  return {
    id: asString(decision.id, `decisions[${index}].id`),
    run_id: asString(decision.run_id, `decisions[${index}].run_id`),
    item_id: asString(decision.item_id, `decisions[${index}].item_id`),
    item_name: asNullableString(decision.item_name, `decisions[${index}].item_name`),
    decision: rawDecision as Q7AutoPurchaseDecision,
    reason_codes: asReasonCodes(decision.reason_codes, `decisions[${index}].reason_codes`),
    suggested_qty: asNullableNumber(
      decision.suggested_qty,
      `decisions[${index}].suggested_qty`,
    ),
    estimated_amount: asNullableNumber(
      decision.estimated_amount,
      `decisions[${index}].estimated_amount`,
    ),
    purchase_order_id: asNullableString(
      decision.purchase_order_id,
      `decisions[${index}].purchase_order_id`,
    ),
    purchase_order_number: asNullableString(
      decision.purchase_order_number,
      `decisions[${index}].purchase_order_number`,
    ),
    created_at: asString(decision.created_at, `decisions[${index}].created_at`),
  };
}

function parseRun(value: unknown): Q7AutoPurchaseRun | null {
  if (value === null || value === undefined) return null;
  const run = asRecord(value, "latest_run");
  return {
    id: asString(run.id, "latest_run.id"),
    run_date: asString(run.run_date, "latest_run.run_date"),
    status: asString(run.status, "latest_run.status"),
    started_at: asString(run.started_at, "latest_run.started_at"),
    finished_at: asNullableString(run.finished_at, "latest_run.finished_at"),
    summary:
      run.summary && typeof run.summary === "object" && !Array.isArray(run.summary)
        ? (run.summary as Record<string, unknown>)
        : {},
  };
}

/** Parse and validate the JSON returned by `get_q7_auto_purchase_status`. */
export function parseQ7AutoPurchaseStatus(raw: unknown): Q7AutoPurchaseStatus {
  const root = asRecord(raw, "autoPurchaseStatus");
  const settings = asRecord(root.settings, "settings");
  const rawDecisions = root.decisions;
  if (!Array.isArray(rawDecisions)) throw new TypeError("decisions must be an array");

  return {
    settings: {
      id: asNumber(settings.id ?? 1, "settings.id"),
      enabled: settings.enabled === true,
      system_actor_id: asNullableString(settings.system_actor_id, "settings.system_actor_id"),
      max_po_amount: asNumber(settings.max_po_amount ?? 0, "settings.max_po_amount"),
      max_daily_amount: asNumber(
        settings.max_daily_amount ?? 0,
        "settings.max_daily_amount",
      ),
      max_stock_count_age_days: asNumber(
        settings.max_stock_count_age_days ?? 10,
        "settings.max_stock_count_age_days",
      ),
      max_backtest_error: asNumber(
        settings.max_backtest_error ?? 0.25,
        "settings.max_backtest_error",
      ),
      run_hour_vn: asNumber(settings.run_hour_vn ?? 6, "settings.run_hour_vn"),
      updated_by: asNullableString(settings.updated_by, "settings.updated_by"),
      updated_at: asNullableString(settings.updated_at, "settings.updated_at"),
    },
    latest_run: parseRun(root.latest_run),
    decisions: rawDecisions.map(parseDecision),
  };
}
