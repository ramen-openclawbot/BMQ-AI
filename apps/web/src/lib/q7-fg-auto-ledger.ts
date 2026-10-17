/**
 * Pure helpers for the Q7 finished-goods auto ledger. The SQL RPCs own every
 * write; this module only parses and summarizes their JSON so the owner screen
 * can show the daily receive/dispatch run history safely.
 */

export interface Q7FgAutoLedgerSkuTotals {
  sku_id: string | null;
  sku_code: string;
  received_count: number;
  received_quantity: number;
  dispatched_count: number;
  dispatched_quantity: number;
  skipped_count: number;
  skipped_by_reason: Record<string, number>;
}

export interface Q7FgAutoLedgerOrderTotals {
  production_number: string;
  po_number: string | null;
  planned_start_date: string | null;
  received_count: number;
  received_quantity: number;
  dispatched_count: number;
  dispatched_quantity: number;
  skipped_count: number;
  skipped_by_reason: Record<string, number>;
}

export interface Q7FgDailyResult {
  mode: "daily";
  as_of: string;
  dry_run: boolean;
  cutover_date: string | null;
  received_count: number;
  received_quantity: number;
  dispatched_count: number;
  dispatched_quantity: number;
  skipped_count: number;
  skipped_by_reason: Record<string, number>;
  on_hand_delta: number;
  items: Q7FgAutoLedgerSkuTotals[];
  orders: Q7FgAutoLedgerOrderTotals[];
  run_id: string | null;
}

export interface Q7FgAutoLedgerRun {
  id: string;
  run_date: string;
  dry_run: boolean;
  created_by: string | null;
  created_at: string;
  result: Record<string, unknown>;
  totals: Q7FgAutoLedgerSkuTotals[];
  orders: Q7FgAutoLedgerOrderTotals[];
}

export interface Q7FgAutoLedgerStatus {
  generated_at: string | null;
  limit: number;
  runs: Q7FgAutoLedgerRun[];
}

export interface Q7FgAutoLedgerSummary {
  run_count: number;
  received_count: number;
  received_quantity: number;
  dispatched_count: number;
  dispatched_quantity: number;
  skipped_count: number;
  skipped_by_reason: Record<string, number>;
  on_hand_delta: number;
  by_sku: Q7FgAutoLedgerSkuTotals[];
  by_order: Q7FgAutoLedgerOrderTotals[];
}

const DEFAULT_SKU_TOTALS: Omit<Q7FgAutoLedgerSkuTotals, "sku_id" | "sku_code"> = {
  received_count: 0,
  received_quantity: 0,
  dispatched_count: 0,
  dispatched_quantity: 0,
  skipped_count: 0,
  skipped_by_reason: {},
};

const DEFAULT_ORDER_TOTALS: Omit<
  Q7FgAutoLedgerOrderTotals,
  "production_number" | "po_number" | "planned_start_date"
> = {
  received_count: 0,
  received_quantity: 0,
  dispatched_count: 0,
  dispatched_quantity: 0,
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

function asReasonCounts(value: unknown, path: string): Record<string, number> {
  if (value === null || value === undefined) return {};
  const record = asRecord(value, path);
  const counts: Record<string, number> = {};
  for (const [reason, count] of Object.entries(record)) {
    counts[reason] = asNumber(count, `${path}.${reason}`);
  }
  return counts;
}

/** Parse one per-SKU totals entry from the daily result or a run row. */
export function parseQ7FgAutoLedgerSkuTotals(
  raw: unknown,
  path = "totals",
): Q7FgAutoLedgerSkuTotals {
  const item = asRecord(raw, path);
  return {
    sku_id: asNullableString(item.sku_id, `${path}.sku_id`),
    sku_code: asString(item.sku_code, `${path}.sku_code`),
    received_count: asNumber(item.received_count, `${path}.received_count`),
    received_quantity: asNumber(item.received_quantity, `${path}.received_quantity`),
    dispatched_count: asNumber(item.dispatched_count, `${path}.dispatched_count`),
    dispatched_quantity: asNumber(
      item.dispatched_quantity,
      `${path}.dispatched_quantity`,
    ),
    skipped_count: asNumber(item.skipped_count, `${path}.skipped_count`),
    skipped_by_reason: asReasonCounts(
      item.skipped_by_reason,
      `${path}.skipped_by_reason`,
    ),
  };
}

/** Parse one per-production-order totals entry. */
export function parseQ7FgAutoLedgerOrderTotals(
  raw: unknown,
  path = "orders",
): Q7FgAutoLedgerOrderTotals {
  const item = asRecord(raw, path);
  return {
    production_number: asString(
      item.production_number,
      `${path}.production_number`,
    ),
    po_number: asNullableString(item.po_number, `${path}.po_number`),
    planned_start_date: asNullableString(
      item.planned_start_date,
      `${path}.planned_start_date`,
    ),
    received_count: asNumber(item.received_count, `${path}.received_count`),
    received_quantity: asNumber(item.received_quantity, `${path}.received_quantity`),
    dispatched_count: asNumber(item.dispatched_count, `${path}.dispatched_count`),
    dispatched_quantity: asNumber(
      item.dispatched_quantity,
      `${path}.dispatched_quantity`,
    ),
    skipped_count: asNumber(item.skipped_count, `${path}.skipped_count`),
    skipped_by_reason: asReasonCounts(
      item.skipped_by_reason,
      `${path}.skipped_by_reason`,
    ),
  };
}

function parseSkuItems(value: unknown, path: string): Q7FgAutoLedgerSkuTotals[] {
  return asArray(value ?? [], path).map((entry, index) =>
    parseQ7FgAutoLedgerSkuTotals(entry, `${path}[${index}]`),
  );
}

function parseOrderItems(
  value: unknown,
  path: string,
): Q7FgAutoLedgerOrderTotals[] {
  return asArray(value ?? [], path).map((entry, index) =>
    parseQ7FgAutoLedgerOrderTotals(entry, `${path}[${index}]`),
  );
}

/** Parse `run_q7_fg_daily_ledger` (dry-run or committed). */
export function parseQ7FgDailyResult(raw: unknown): Q7FgDailyResult {
  const root = asRecord(raw, "runQ7FgDailyLedger");
  if (root.mode !== "daily") {
    throw new TypeError("mode must be 'daily'");
  }
  return {
    mode: "daily",
    as_of: asString(root.as_of, "as_of"),
    dry_run: asBoolean(root.dry_run, "dry_run"),
    cutover_date: asNullableString(root.cutover_date, "cutover_date"),
    received_count: asNumber(root.received_count, "received_count"),
    received_quantity: asNumber(root.received_quantity, "received_quantity"),
    dispatched_count: asNumber(root.dispatched_count, "dispatched_count"),
    dispatched_quantity: asNumber(root.dispatched_quantity, "dispatched_quantity"),
    skipped_count: asNumber(root.skipped_count, "skipped_count"),
    skipped_by_reason: asReasonCounts(root.skipped_by_reason, "skipped_by_reason"),
    on_hand_delta: asNumber(root.on_hand_delta, "on_hand_delta"),
    items: parseSkuItems(root.items, "items"),
    orders: parseOrderItems(root.orders, "orders"),
    run_id: asNullableString(root.run_id, "run_id"),
  };
}

function parseRun(raw: unknown, path: string): Q7FgAutoLedgerRun {
  const run = asRecord(raw, path);
  const result = asRecord(run.result ?? {}, `${path}.result`);
  return {
    id: asString(run.id, `${path}.id`),
    run_date: asString(run.run_date, `${path}.run_date`),
    dry_run: asBoolean(run.dry_run, `${path}.dry_run`),
    created_by: asNullableString(run.created_by, `${path}.created_by`),
    created_at: asString(run.created_at, `${path}.created_at`),
    result,
    totals: parseSkuItems(
      run.totals ?? result.items,
      `${path}.totals`,
    ),
    orders: parseOrderItems(run.orders ?? result.orders, `${path}.orders`),
  };
}

/** Parse `get_q7_fg_auto_status`. */
export function parseQ7FgAutoLedgerStatus(raw: unknown): Q7FgAutoLedgerStatus {
  const root = asRecord(raw, "q7FgAutoLedgerStatus");
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
  target: Map<string, Q7FgAutoLedgerSkuTotals>,
  item: Q7FgAutoLedgerSkuTotals,
): void {
  const key = item.sku_id ?? item.sku_code;
  const current = target.get(key) ?? {
    ...DEFAULT_SKU_TOTALS,
    sku_id: item.sku_id,
    sku_code: item.sku_code,
    skipped_by_reason: {},
  };
  const skippedByReason = { ...current.skipped_by_reason };
  for (const [reason, count] of Object.entries(item.skipped_by_reason)) {
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + count;
  }
  target.set(key, {
    sku_id: current.sku_id ?? item.sku_id,
    sku_code: current.sku_code,
    received_count: current.received_count + item.received_count,
    received_quantity: current.received_quantity + item.received_quantity,
    dispatched_count: current.dispatched_count + item.dispatched_count,
    dispatched_quantity: current.dispatched_quantity + item.dispatched_quantity,
    skipped_count: current.skipped_count + item.skipped_count,
    skipped_by_reason: skippedByReason,
  });
}

function addOrderTotals(
  target: Map<string, Q7FgAutoLedgerOrderTotals>,
  item: Q7FgAutoLedgerOrderTotals,
): void {
  const current = target.get(item.production_number) ?? {
    ...DEFAULT_ORDER_TOTALS,
    production_number: item.production_number,
    po_number: item.po_number,
    planned_start_date: item.planned_start_date,
    skipped_by_reason: {},
  };
  const skippedByReason = { ...current.skipped_by_reason };
  for (const [reason, count] of Object.entries(item.skipped_by_reason)) {
    skippedByReason[reason] = (skippedByReason[reason] ?? 0) + count;
  }
  target.set(item.production_number, {
    production_number: current.production_number,
    po_number: current.po_number ?? item.po_number,
    planned_start_date: current.planned_start_date ?? item.planned_start_date,
    received_count: current.received_count + item.received_count,
    received_quantity: current.received_quantity + item.received_quantity,
    dispatched_count: current.dispatched_count + item.dispatched_count,
    dispatched_quantity: current.dispatched_quantity + item.dispatched_quantity,
    skipped_count: current.skipped_count + item.skipped_count,
    skipped_by_reason: skippedByReason,
  });
}

/** Roll several runs into one owner-facing summary (totals, SKU and order). */
export function summarizeQ7FgAutoLedgerRuns(
  runs: readonly Q7FgAutoLedgerRun[],
): Q7FgAutoLedgerSummary {
  const bySku = new Map<string, Q7FgAutoLedgerSkuTotals>();
  const byOrder = new Map<string, Q7FgAutoLedgerOrderTotals>();
  const skippedByReason: Record<string, number> = {};
  let receivedCount = 0;
  let receivedQuantity = 0;
  let dispatchedCount = 0;
  let dispatchedQuantity = 0;
  let skippedCount = 0;

  for (const run of runs) {
    for (const item of run.totals) {
      addSkuTotals(bySku, item);
      receivedCount += item.received_count;
      receivedQuantity += item.received_quantity;
      dispatchedCount += item.dispatched_count;
      dispatchedQuantity += item.dispatched_quantity;
      skippedCount += item.skipped_count;
      for (const [reason, count] of Object.entries(item.skipped_by_reason)) {
        skippedByReason[reason] = (skippedByReason[reason] ?? 0) + count;
      }
    }
    for (const order of run.orders) {
      addOrderTotals(byOrder, order);
    }
  }

  return {
    run_count: runs.length,
    received_count: receivedCount,
    received_quantity: receivedQuantity,
    dispatched_count: dispatchedCount,
    dispatched_quantity: dispatchedQuantity,
    skipped_count: skippedCount,
    skipped_by_reason: skippedByReason,
    on_hand_delta: receivedQuantity - dispatchedQuantity,
    by_sku: Array.from(bySku.values()).sort((a, b) =>
      a.sku_code.localeCompare(b.sku_code),
    ),
    by_order: Array.from(byOrder.values()).sort((a, b) =>
      (a.planned_start_date ?? "").localeCompare(b.planned_start_date ?? "") ||
      a.production_number.localeCompare(b.production_number),
    ),
  };
}
