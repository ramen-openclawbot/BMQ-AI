import assert from "node:assert/strict";
import test from "node:test";

import {
  parseQ7FgAutoLedgerStatus,
  parseQ7FgDailyResult,
  summarizeQ7FgAutoLedgerRuns,
} from "./q7-fg-auto-ledger.ts";

const skuTotals = (overrides: Record<string, unknown> = {}) => ({
  sku_id: "sku-1",
  sku_code: "BMQ-Q7-001",
  received_count: 0,
  received_quantity: 0,
  dispatched_count: 0,
  dispatched_quantity: 0,
  skipped_count: 0,
  skipped_by_reason: {},
  ...overrides,
});

const orderTotals = (overrides: Record<string, unknown> = {}) => ({
  production_number: "SX-20261017-001",
  po_number: "PO-KFM-001",
  planned_start_date: "2026-10-17",
  received_count: 0,
  received_quantity: 0,
  dispatched_count: 0,
  dispatched_quantity: 0,
  skipped_count: 0,
  skipped_by_reason: {},
  ...overrides,
});

test("dry daily result parses totals and writes no run id", () => {
  const result = parseQ7FgDailyResult({
    mode: "daily",
    as_of: "2026-10-17",
    dry_run: true,
    cutover_date: "2026-10-16",
    received_count: 1,
    received_quantity: 100,
    dispatched_count: 1,
    dispatched_quantity: 100,
    skipped_count: 1,
    skipped_by_reason: { before_cutover: 1 },
    on_hand_delta: 0,
    items: [
      skuTotals({
        received_count: 1,
        received_quantity: 100,
        dispatched_count: 1,
        dispatched_quantity: 100,
        skipped_count: 1,
        skipped_by_reason: { before_cutover: 1 },
      }),
    ],
    orders: [
      orderTotals({
        received_count: 1,
        received_quantity: 100,
        dispatched_count: 1,
        dispatched_quantity: 100,
        skipped_count: 1,
        skipped_by_reason: { before_cutover: 1 },
      }),
    ],
    run_id: null,
  });

  assert.equal(result.mode, "daily");
  assert.equal(result.dry_run, true);
  assert.equal(result.cutover_date, "2026-10-16");
  assert.equal(result.items[0].received_quantity, 100);
  assert.equal(result.orders[0].production_number, "SX-20261017-001");
  assert.equal(result.orders[0].po_number, "PO-KFM-001");
  assert.equal(result.run_id, null);
});

test("real daily result keeps received minus dispatched as the on-hand delta", () => {
  const result = parseQ7FgDailyResult({
    mode: "daily",
    as_of: "2026-10-17",
    dry_run: false,
    cutover_date: "2026-10-16",
    received_count: 2,
    received_quantity: 160,
    dispatched_count: 2,
    dispatched_quantity: 160,
    skipped_count: 2,
    skipped_by_reason: { manual_receipt: 1, insufficient_stock: 1 },
    on_hand_delta: 0,
    items: [
      skuTotals({
        received_count: 2,
        received_quantity: 160,
        dispatched_count: 2,
        dispatched_quantity: 160,
      }),
    ],
    orders: [orderTotals()],
    run_id: "run-1",
  });

  assert.equal(
    result.on_hand_delta,
    result.received_quantity - result.dispatched_quantity,
  );
  assert.equal(result.skipped_by_reason.manual_receipt, 1);
  assert.equal(result.skipped_by_reason.insufficient_stock, 1);
  assert.equal(result.run_id, "run-1");
});

test("status parser reads run history, totals and orders", () => {
  const status = parseQ7FgAutoLedgerStatus({
    generated_at: "2026-10-17T15:10:00.000Z",
    limit: 14,
    runs: [
      {
        id: "run-2",
        run_date: "2026-10-17",
        dry_run: false,
        created_by: null,
        created_at: "2026-10-17T15:10:00.000Z",
        result: { mode: "daily", as_of: "2026-10-17" },
        totals: [
          skuTotals({
            received_count: 1,
            received_quantity: 100,
            dispatched_count: 1,
            dispatched_quantity: 100,
          }),
        ],
        orders: [orderTotals()],
      },
      {
        id: "run-1",
        run_date: "2026-10-16",
        dry_run: false,
        created_by: "owner-id",
        created_at: "2026-10-16T15:10:00.000Z",
        result: {
          mode: "daily",
          items: [
            skuTotals({
              skipped_count: 1,
              skipped_by_reason: { before_cutover: 1 },
            }),
          ],
          orders: [
            orderTotals({
              production_number: "SX-20261016-001",
              planned_start_date: "2026-10-16",
              skipped_count: 1,
              skipped_by_reason: { before_cutover: 1 },
            }),
          ],
        },
      },
    ],
  });

  assert.equal(status.limit, 14);
  assert.equal(status.runs.length, 2);
  assert.equal(status.runs[0].totals[0].dispatched_quantity, 100);
  assert.equal(status.runs[0].orders[0].production_number, "SX-20261017-001");
  assert.equal(status.runs[1].totals[0].skipped_by_reason.before_cutover, 1);
  assert.equal(status.runs[1].orders[0].planned_start_date, "2026-10-16");
});

test("summary merges runs, skipped reasons, per SKU and per order", () => {
  const status = parseQ7FgAutoLedgerStatus({
    limit: 14,
    runs: [
      {
        id: "run-2",
        run_date: "2026-10-17",
        dry_run: false,
        created_by: null,
        created_at: "2026-10-17T15:10:00.000Z",
        result: {},
        totals: [
          skuTotals({
            received_count: 1,
            received_quantity: 100,
            dispatched_count: 1,
            dispatched_quantity: 80,
            skipped_count: 2,
            skipped_by_reason: { insufficient_stock: 1, manual_receipt: 1 },
          }),
        ],
        orders: [
          orderTotals({
            received_quantity: 100,
            dispatched_quantity: 80,
            skipped_count: 1,
            skipped_by_reason: { manual_receipt: 1 },
          }),
        ],
      },
      {
        id: "run-1",
        run_date: "2026-10-16",
        dry_run: false,
        created_by: null,
        created_at: "2026-10-16T15:10:00.000Z",
        result: {},
        totals: [
          skuTotals({
            skipped_count: 1,
            skipped_by_reason: { before_cutover: 1 },
          }),
        ],
        orders: [
          orderTotals({
            production_number: "SX-20261016-001",
            planned_start_date: "2026-10-16",
            skipped_count: 1,
            skipped_by_reason: { before_cutover: 1 },
          }),
        ],
      },
    ],
  });

  const summary = summarizeQ7FgAutoLedgerRuns(status.runs);
  assert.equal(summary.run_count, 2);
  assert.equal(summary.received_quantity, 100);
  assert.equal(summary.dispatched_quantity, 80);
  assert.equal(summary.skipped_count, 3);
  assert.equal(summary.skipped_by_reason.insufficient_stock, 1);
  assert.equal(summary.skipped_by_reason.manual_receipt, 1);
  assert.equal(summary.skipped_by_reason.before_cutover, 1);
  assert.equal(summary.on_hand_delta, 20);
  assert.equal(summary.by_sku.length, 1);
  assert.equal(summary.by_order.length, 2);
  assert.equal(summary.by_order[0].production_number, "SX-20261016-001");
});

test("status parser tolerates a legacy run without totals", () => {
  const status = parseQ7FgAutoLedgerStatus({
    limit: 14,
    runs: [
      {
        id: "legacy",
        run_date: "2026-10-17",
        dry_run: false,
        created_by: null,
        created_at: "2026-10-17T15:10:00.000Z",
        result: {},
      },
    ],
  });
  assert.deepEqual(status.runs[0].totals, []);
  assert.deepEqual(status.runs[0].orders, []);
});

test("invalid mode is rejected", () => {
  assert.throws(
    () =>
      parseQ7FgDailyResult({
        mode: "close_before_cutover",
        as_of: "2026-10-17",
        dry_run: false,
      }),
    /mode/,
  );
});
