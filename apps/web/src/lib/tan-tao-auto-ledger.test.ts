import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTanTaoAutoLedgerStatus,
  parseTanTaoCloseBeforeResult,
  parseTanTaoDailyResult,
  summarizeTanTaoAutoLedgerRuns,
} from "./tan-tao-auto-ledger.ts";

const skuTotals = (overrides: Record<string, unknown> = {}) => ({
  sku_code: "BMQ-001",
  cutover_date: "2026-10-17",
  received_count: 0,
  received_quantity: 0,
  dispatched_count: 0,
  dispatched_quantity: 0,
  closed_reservations: 0,
  closed_supplier_orders: 0,
  closed_quantity: 0,
  skipped_count: 0,
  skipped_by_reason: {},
  ...overrides,
});

test("dry close reports counts and per-SKU totals without requiring a run id", () => {
  const result = parseTanTaoCloseBeforeResult({
    mode: "close_before_cutover",
    dry_run: true,
    before: "2026-10-16",
    cutover_by_sku: { "BMQ-001": "2026-10-17" },
    closed_reservations: 3,
    closed_supplier_orders: 1,
    closed_quantity: 120,
    skipped_count: 0,
    skipped_by_reason: {},
    items: [
      skuTotals({
        closed_reservations: 3,
        closed_supplier_orders: 1,
        closed_quantity: 120,
      }),
    ],
    run_id: null,
  });

  assert.equal(result.mode, "close_before_cutover");
  assert.equal(result.dry_run, true);
  assert.equal(result.closed_reservations, 3);
  assert.equal(result.closed_supplier_orders, 1);
  assert.equal(result.closed_quantity, 120);
  assert.equal(result.items[0].sku_code, "BMQ-001");
  assert.equal(result.items[0].cutover_date, "2026-10-17");
  assert.equal(result.run_id, null);
});

test("daily result keeps received minus dispatched as the on-hand delta", () => {
  const result = parseTanTaoDailyResult({
    mode: "daily",
    as_of: "2026-10-18",
    dry_run: false,
    received_count: 1,
    received_quantity: 50,
    dispatched_count: 2,
    dispatched_quantity: 30,
    closed_count: 0,
    skipped_count: 1,
    skipped_by_reason: { insufficient_stock: 1 },
    on_hand_delta: 20,
    items: [
      skuTotals({
        received_count: 1,
        received_quantity: 50,
        dispatched_count: 2,
        dispatched_quantity: 30,
        skipped_count: 1,
        skipped_by_reason: { insufficient_stock: 1 },
      }),
    ],
    run_id: "run-1",
  });

  assert.equal(result.on_hand_delta, result.received_quantity - result.dispatched_quantity);
  assert.equal(result.items[0].received_quantity, 50);
  assert.equal(result.skipped_by_reason.insufficient_stock, 1);
});

test("status parser reads run history and per-SKU totals", () => {
  const status = parseTanTaoAutoLedgerStatus({
    generated_at: "2026-10-18T15:00:00.000Z",
    limit: 14,
    runs: [
      {
        id: "run-2",
        run_date: "2026-10-18",
        mode: "daily",
        dry_run: false,
        created_by: null,
        created_at: "2026-10-18T15:00:00.000Z",
        result: { mode: "daily", as_of: "2026-10-18" },
        totals: [
          skuTotals({
            received_count: 1,
            received_quantity: 50,
            dispatched_count: 1,
            dispatched_quantity: 20,
          }),
        ],
      },
      {
        id: "run-1",
        run_date: "2026-10-16",
        mode: "close_before_cutover",
        dry_run: false,
        created_by: "owner-id",
        created_at: "2026-10-16T15:00:00.000Z",
        result: {
          mode: "close_before_cutover",
          items: [
            skuTotals({
              closed_reservations: 2,
              closed_supplier_orders: 1,
              closed_quantity: 80,
            }),
          ],
        },
      },
    ],
  });

  assert.equal(status.limit, 14);
  assert.equal(status.runs.length, 2);
  assert.equal(status.runs[0].mode, "daily");
  assert.equal(status.runs[0].totals[0].dispatched_quantity, 20);
  assert.equal(status.runs[1].totals[0].closed_quantity, 80);
});

test("summary merges runs, skipped reasons and per-SKU counters", () => {
  const status = parseTanTaoAutoLedgerStatus({
    limit: 14,
    runs: [
      {
        id: "run-2",
        run_date: "2026-10-18",
        mode: "daily",
        dry_run: false,
        created_by: null,
        created_at: "2026-10-18T15:00:00.000Z",
        result: {},
        totals: [
          skuTotals({
            received_quantity: 50,
            received_count: 1,
            dispatched_quantity: 20,
            dispatched_count: 1,
            skipped_count: 2,
            skipped_by_reason: { insufficient_stock: 1, cancelled_order: 1 },
          }),
        ],
      },
      {
        id: "run-1",
        run_date: "2026-10-16",
        mode: "close_before_cutover",
        dry_run: false,
        created_by: null,
        created_at: "2026-10-16T15:00:00.000Z",
        result: {},
        totals: [
          skuTotals({
            closed_reservations: 2,
            closed_supplier_orders: 1,
            closed_quantity: 80,
            skipped_count: 1,
            skipped_by_reason: { already_evented: 1 },
          }),
        ],
      },
    ],
  });

  const summary = summarizeTanTaoAutoLedgerRuns(status.runs);
  assert.equal(summary.run_count, 2);
  assert.equal(summary.received_quantity, 50);
  assert.equal(summary.dispatched_quantity, 20);
  assert.equal(summary.closed_count, 3);
  assert.equal(summary.closed_quantity, 80);
  assert.equal(summary.skipped_count, 3);
  assert.equal(summary.skipped_by_reason.insufficient_stock, 1);
  assert.equal(summary.skipped_by_reason.cancelled_order, 1);
  assert.equal(summary.skipped_by_reason.already_evented, 1);
  assert.equal(summary.on_hand_delta, 30);
  assert.equal(summary.by_sku.length, 1);
  assert.equal(summary.by_sku[0].closed_reservations, 2);
});

test("status parser tolerates a legacy run without totals by falling back to result items", () => {
  const status = parseTanTaoAutoLedgerStatus({
    limit: 14,
    runs: [
      {
        id: "legacy",
        run_date: "2026-10-18",
        mode: "daily",
        dry_run: false,
        created_by: null,
        created_at: "2026-10-18T15:00:00.000Z",
        result: { items: [] },
      },
    ],
  });
  assert.deepEqual(status.runs[0].totals, []);
});

test("invalid action mode is rejected", () => {
  assert.throws(
    () =>
      parseTanTaoDailyResult({
        mode: "close_before_cutover",
        as_of: "2026-10-18",
        dry_run: false,
      }),
    /mode/,
  );
});
