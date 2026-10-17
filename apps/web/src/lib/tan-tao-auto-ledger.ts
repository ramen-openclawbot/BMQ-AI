/**
 * Pure helpers for the Tân Tạo auto ledger (close-before-cutover + daily
 * receive/dispatch). The SQL RPCs own every write; this module only parses and
 * summarizes their JSON so the owner screen can render run history safely.
 */

export type TanTaoAutoLedgerMode = "close_before_cutover" | "daily";

export type TanTaoAutoLedgerAction =
  | "closed_reservation"
  | "closed_supplier_order"
  | "dispatched"
  | "received"
  | "skipped";

export interface TanTaoAutoLedgerSkuTotals {
  sku_code: string;
  cutover_date: string | null;
  received_count: number;
  received_quantity: number;
  dispatched_count: number;
  dispatched_quantity: number;
  closed_reservations: number;
  closed_supplier_orders: number;
  closed_quantity: number;
  skipped_count: number;
  skipped_by_reason: Record<string, number>;
}

export interface TanTaoCloseBeforeResult {
  mode: "close_before_cutover";
  dry_run: boolean;
  before: string | null;
  cutover_by_sku: Record<string, string | null>;
  closed_reservations: number;
  closed_supplier_orders: number;
  closed_quantity: number;
  skipped_count: number;
  skipped_by_reason: Record<string, number>;
  items: TanTaoAutoLedgerSkuTotals[];
  run_id: string | null;
}

export interface TanTaoDailyResult {
  mode: "daily";
  as_of: string;
  dry_run: boolean;
  received_count: number;
  received_quantity: number;
  dispatched_count: number;
  dispatched_quantity: number;
  closed_count: number;
  skipped_count: number;
  skipped_by_reason: Record<string, number>;
  on_hand_delta: number;
  items: TanTaoAutoLedgerSkuTotals[];
  run_id: string | null;
}

export interface TanTaoAutoLedgerRun {
  id: string;
  run_date: string;
  mode: TanTaoAutoLedgerMode;
  dry_run: boolean;
  created_by: string | null;
  created_at: string;
  result: Record<string, unknown>;
  totals: TanTaoAutoLedgerSkuTotals[];
}

export interface TanTaoAutoLedgerStatus {
  generated_at: string | null;
  limit: number;
  runs: TanTaoAutoLedgerRun[];
}

export interface TanTaoAutoLedgerSummary {
  run_count: number;
  received_count: number;
  received_quantity: number;
  dispatched_count: number;
  dispatched_quantity: number;
  closed_count: number;
  closed_quantity: number;
  skipped_count: number;
  skipped_by_reason: Record<string, number>;
  on_hand_delta: number;
  by_sku: TanTaoAutoLedgerSkuTotals[];
}

const DEFAULT_SKU_TOTALS: Omit<TanTaoAutoLedgerSkuTotals, "sku_code"> = {
  cutover_date: null,
  received_count: 0,
  received_quantity: 0,
  dispatched_count: 0,
  dispatched_quantity: 0,
  closed_reservations: 0,
  closed_supplier_orders: 0,
  closed_quantity: 0,
  skipped_count: 0,
  skipped_by_reason: {},
};

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be a string or null`);
  }
  return value;
}

function asNumber(value: unknown, path: string): number {
  const numeric = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return numeric;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "false") return value === "true";
  throw new TypeError(`${path} must be a boolean`);
}

function asMode(value: unknown, path: string): TanTaoAutoLedgerMode {
  if (value === "close_before_cutover" || value === "daily") return value;
  throw new TypeError(`${path} must be 'close_before_cutover' or 'daily'`);
}

function asReasonCounts(value: unknown, path: string): Record<string, number> {
  if (value === null || value === undefined) return {};
  const record = asRecord(value, path);
  const counts: Record<string, number> = {};
  for (const [reason, count] of Object.entries(record)) {
    counts[reason] = asNumber(count, `${path}.${reason}`);
  }
  return counts;
}

/** Parse one per-SKU item; close-mode items omit receive/dispatch counters. */
export function parseTanTaoAutoLedgerSkuTotals(
  raw: unknown,
  path = "totals",
): TanTaoAutoLedgerSkuTotals {
  const item = asRecord(raw, path);
  return {
    sku_code: asString(item.sku_code, `${path}.sku_code`),
    cutover_date: asNullableString(item.cutover_date, `${path}.cutover_date`),
    received_count: asNumber(item.received_count, `${path}.received_count`),
    received_quantity: asNumber(item.received_quantity, `${path}.received_quantity`),
    dispatched_count: asNumber(item.dispatched_count, `${path}.dispatched_count`),
    dispatched_quantity: asNumber(item.dispatched_quantity, `${path}.dispatched_quantity`),
    closed_reservations: asNumber(item.closed_reservations, `${path}.closed_reservations`),
    closed_supplier_orders: asNumber(
      item.closed_supplier_orders,
      `${path}.closed_supplier_orders`,
    ),
    closed_quantity: asNumber(item.closed_quantity, `${path}.closed_quantity`),
    skipped_count: asNumber(item.skipped_count, `${path}.skipped_count`),
    skipped_by_reason: asReasonCounts(
      item.skipped_by_reason,
      `${path}.skipped_by_reason`,
    ),
  };
}

function parseItems(value: unknown, path: string): TanTaoAutoLedgerSkuTotals[] {
  return asArray(value ?? [], path).map((entry, index) =>
    parseTanTaoAutoLedgerSkuTotals(entry, `${path}[${index}]`),
  );
}

/** Parse `close_tan_tao_open_before` (dry-run or committed). */
export function parseTanTaoCloseBeforeResult(raw: unknown): TanTaoCloseBeforeResult {
  const root = asRecord(raw, "closeTanTaoOpenBefore");
  const mode = asMode(root.mode, "mode");
  if (mode !== "close_before_cutover") {
    throw new TypeError("mode must be 'close_before_cutover'");
  }
  const cutovers = asRecord(root.cutover_by_sku ?? {}, "cutover_by_sku");
  const cutoverBySku: Record<string, string | null> = {};
  for (const [skuCode, date] of Object.entries(cutovers)) {
    cutoverBySku[skuCode] = asNullableString(date, `cutover_by_sku.${skuCode}`);
  }
  return {
    mode,
    dry_run: asBoolean(root.dry_run, "dry_run"),
    before: asNullableString(root.before, "before"),
    cutover_by_sku: cutoverBySku,
    closed_reservations: asNumber(root.closed_reservations, "closed_reservations"),
    closed_supplier_orders: asNumber(
      root.closed_supplier_orders,
      "closed_supplier_orders",
    ),
    closed_quantity: asNumber(root.closed_quantity, "closed_quantity"),
    skipped_count: asNumber(root.skipped_count, "skipped_count"),
    skipped_by_reason: asReasonCounts(root.skipped_by_reason, "skipped_by_reason"),
    items: parseItems(root.items, "items"),
    run_id: asNullableString(root.run_id, "run_id"),
  };
}

/** Parse `run_tan_tao_daily_ledger` (dry-run or committed). */
export function parseTanTaoDailyResult(raw: unknown): TanTaoDailyResult {
  const root = asRecord(raw, "runTanTaoDailyLedger");
  const mode = asMode(root.mode, "mode");
  if (mode !== "daily") {
    throw new TypeError("mode must be 'daily'");
  }
  return {
    mode,
    as_of: asString(root.as_of, "as_of"),
    dry_run: asBoolean(root.dry_run, "dry_run"),
    received_count: asNumber(root.received_count, "received_count"),
    received_quantity: asNumber(root.received_quantity, "received_quantity"),
    dispatched_count: asNumber(root.dispatched_count, "dispatched_count"),
    dispatched_quantity: asNumber(root.dispatched_quantity, "dispatched_quantity"),
    closed_count: asNumber(root.closed_count, "closed_count"),
    skipped_count: asNumber(root.skipped_count, "skipped_count"),
    skipped_by_reason: asReasonCounts(root.skipped_by_reason, "skipped_by_reason"),
    on_hand_delta: asNumber(root.on_hand_delta, "on_hand_delta"),
    items: parseItems(root.items, "items"),
    run_id: asNullableString(root.run_id, "run_id"),
  };
}

function parseRun(raw: unknown, path: string): TanTaoAutoLedgerRun {
  const run = asRecord(raw, path);
  const result = asRecord(run.result ?? {}, `${path}.result`);
  const rawTotals = run.totals ?? result.items;
  return {
    id: asString(run.id, `${path}.id`),
    run_date: asString(run.run_date, `${path}.run_date`),
    mode: asMode(run.mode, `${path}.mode`),
    dry_run: asBoolean(run.dry_run, `${path}.dry_run`),
    created_by: asNullableString(run.created_by, `${path}.created_by`),
    created_at: asString(run.created_at, `${path}.created_at`),
    result,
    totals: parseItems(rawTotals, `${path}.totals`),
  };
}

/** Parse `get_tan_tao_auto_ledger_status`. */
export function parseTanTaoAutoLedgerStatus(raw: unknown): TanTaoAutoLedgerStatus {
  const root = asRecord(raw, "tanTaoAutoLedgerStatus");
  const runs = asArray(root.runs ?? [], "runs").map((entry, index) =>
    parseRun(entry, `runs[${index}]`),
  );
  return {
    generated_at: asNullableString(root.generated_at, "generated_at"),
    limit: asNumber(root.limit, "limit"),
    runs,
  };
}

function addSkuTotals(
  target: Map<string, TanTaoAutoLedgerSkuTotals>,
  item: TanTaoAutoLedgerSkuTotals,
): void {
  const current = target.get(item.sku_code) ?? {
    ...DEFAULT_SKU_TOTALS,
    sku_code: item.sku_code,
    skipped_by_reason: {},
  };
  const skippedByReason = { ...current.skipped_by_reason };
  for (const [reason, count] of Object.entries(item.skipped_by_reason)) {
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + count;
  }
  target.set(item.sku_code, {
    sku_code: item.sku_code,
    cutover_date: item.cutover_date ?? current.cutover_date,
    received_count: current.received_count + item.received_count,
    received_quantity: current.received_quantity + item.received_quantity,
    dispatched_count: current.dispatched_count + item.dispatched_count,
    dispatched_quantity: current.dispatched_quantity + item.dispatched_quantity,
    closed_reservations: current.closed_reservations + item.closed_reservations,
    closed_supplier_orders:
      current.closed_supplier_orders + item.closed_supplier_orders,
    closed_quantity: current.closed_quantity + item.closed_quantity,
    skipped_count: current.skipped_count + item.skipped_count,
    skipped_by_reason: skippedByReason,
  });
}

/** Roll several runs into one owner-facing summary (totals and per SKU). */
export function summarizeTanTaoAutoLedgerRuns(
  runs: readonly TanTaoAutoLedgerRun[],
): TanTaoAutoLedgerSummary {
  const bySku = new Map<string, TanTaoAutoLedgerSkuTotals>();
  const skippedByReason: Record<string, number> = {};
  let receivedCount = 0;
  let receivedQuantity = 0;
  let dispatchedCount = 0;
  let dispatchedQuantity = 0;
  let closedCount = 0;
  let closedQuantity = 0;
  let skippedCount = 0;

  for (const run of runs) {
    for (const item of run.totals) {
      addSkuTotals(bySku, item);
      receivedCount += item.received_count;
      receivedQuantity += item.received_quantity;
      dispatchedCount += item.dispatched_count;
      dispatchedQuantity += item.dispatched_quantity;
      closedCount += item.closed_reservations + item.closed_supplier_orders;
      closedQuantity += item.closed_quantity;
      skippedCount += item.skipped_count;
      for (const [reason, count] of Object.entries(item.skipped_by_reason)) {
        skippedByReason[reason] = (skippedByReason[reason] ?? 0) + count;
      }
    }
  }

  return {
    run_count: runs.length,
    received_count: receivedCount,
    received_quantity: receivedQuantity,
    dispatched_count: dispatchedCount,
    dispatched_quantity: dispatchedQuantity,
    closed_count: closedCount,
    closed_quantity: closedQuantity,
    skipped_count: skippedCount,
    skipped_by_reason: skippedByReason,
    on_hand_delta: receivedQuantity - dispatchedQuantity,
    by_sku: Array.from(bySku.values()).sort((a, b) =>
      a.sku_code.localeCompare(b.sku_code),
    ),
  };
}
