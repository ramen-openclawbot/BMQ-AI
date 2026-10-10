import assert from "node:assert/strict";
import test from "node:test";

import {
  computeSuggestedQty,
  decideAutoPurchase,
  packSizeInBookUnit,
  parsePackFromName,
  parseQ7AutoPurchaseStatus,
  parseQ7PurchaseForecast,
  reasonLabel,
  simulateReorder,
  type Q7ForecastFlags,
  type Q7PurchaseForecastItem,
} from "./purchase-forecast.ts";

const NO_FLAGS: Q7ForecastFlags = {
  no_stock_count: false,
  stale_stock_count: false,
  short_history: false,
  no_supplier: false,
  no_pack_size: false,
  no_price: false,
  duplicate_material: false,
  high_backtest_error: false,
};

function buildItem(overrides: Partial<Q7PurchaseForecastItem> = {}): Q7PurchaseForecastItem {
  return {
    item_id: "11111111-1111-4111-8111-111111111111",
    item_code: "NVL-001",
    item_name: "Bột mì",
    unit: "kg",
    mode: "auto_send",
    daily_usage: 10,
    avg_14d: 10,
    avg_28d: 10,
    stddev_28d: 1,
    days_with_data: 28,
    weekday_factor: 1,
    scheduled_usage: 0,
    on_hand: 100,
    last_count_date: "2026-10-13",
    open_po_qty: 0,
    supplier_id: "22222222-2222-4222-8222-222222222222",
    pack_size: 25,
    pack_label: "25kg",
    lead_time_days: 2,
    safety_days: 2,
    order_cycle_days: 7,
    reorder_date: "2026-10-13",
    suggested_qty: 25,
    last_unit_price: 20000,
    estimated_amount: 500000,
    flags: { ...NO_FLAGS },
    ...overrides,
  };
}

const SETTINGS = { max_po_amount: 10_000_000, max_daily_amount: 30_000_000 };

test("rounds the suggested quantity up to whole 25kg packs", () => {
  const suggested = computeSuggestedQty({
    dailyUsage: 10,
    leadTimeDays: 2,
    safetyDays: 2,
    orderCycleDays: 7,
    onHand: 80,
    openPoQty: 0,
    packSize: 25,
    maxOrderQty: null,
  });
  // need = 10 * 11 = 110; net = 30; ceil(30/25)*25 = 50
  assert.equal(suggested, 50);
});

test("subtracts inbound purchase orders from the suggested quantity", () => {
  const noPo = computeSuggestedQty({
    dailyUsage: 10,
    leadTimeDays: 2,
    safetyDays: 2,
    orderCycleDays: 7,
    onHand: 30,
    openPoQty: 0,
    packSize: 25,
    maxOrderQty: null,
  });
  const withPo = computeSuggestedQty({
    dailyUsage: 10,
    leadTimeDays: 2,
    safetyDays: 2,
    orderCycleDays: 7,
    onHand: 30,
    openPoQty: 50,
    packSize: 25,
    maxOrderQty: null,
  });
  // need = 10 * 11 = 110; net 80 -> 4 packs = 100; with 50 inbound -> 3 packs = 50.
  assert.equal(noPo, 100);
  assert.equal(withPo, 50);
});

test("dry run without on-hand is due immediately", () => {
  const result = simulateReorder({
    asOf: "2026-10-14",
    onHand: null,
    dailyUsage: 10,
    safetyDays: 2,
    leadTimeDays: 2,
    horizonDays: 14,
  });
  assert.equal(result.reorderDate, "2026-10-14");
});

test("scheduled issue replaces the baseline average on its day", () => {
  const result = simulateReorder({
    asOf: "2026-10-14",
    onHand: 100,
    dailyUsage: 10,
    safetyDays: 2,
    leadTimeDays: 0,
    horizonDays: 5,
    scheduledByDate: { "2026-10-15": 90 },
  });
  // 100 - 90 = 10 < 20 on day 1 -> reorder that same day with lead 0.
  assert.equal(result.reorderDate, "2026-10-15");
});

test("parses package specs from material names", () => {
  const kg = parsePackFromName("Bột mì (25kg)");
  assert.ok(kg);
  assert.equal(kg?.baseQty, 25);
  assert.equal(kg?.baseUnit, "kg");
  assert.equal(packSizeInBookUnit(kg, "g"), 25000);
  assert.equal(packSizeInBookUnit(kg, "kg"), 25);

  const bottles = parsePackFromName("Dầu ăn 5L x 4 chai");
  assert.ok(bottles);
  assert.equal(bottles?.baseQty, 5);
  assert.equal(bottles?.baseUnit, "l");
  assert.equal(bottles?.multiplier, 4);
  assert.equal(packSizeInBookUnit(bottles, "ml"), 20000);
  assert.equal(packSizeInBookUnit(bottles, "chai"), null);

  const bare = parsePackFromName("Nước tương x 6 chai");
  assert.ok(bare);
  assert.equal(bare?.baseQty, 6);
  assert.equal(bare?.baseUnit, "chai");
  assert.equal(bare?.multiplier, 1);
  assert.equal(packSizeInBookUnit(bare, "chai"), 6);
});

test("auto_send falls back to draft when there is no stock count", () => {
  const item = buildItem({ on_hand: null, flags: { ...NO_FLAGS, no_stock_count: true } });
  const result = decideAutoPurchase(item, SETTINGS, {});
  assert.equal(result.decision, "draft");
  assert.deepEqual(result.reasonCodes, ["no_stock_count"]);
});

test("auto_send falls back to draft on a stale stock count", () => {
  const item = buildItem({ flags: { ...NO_FLAGS, stale_stock_count: true } });
  const result = decideAutoPurchase(item, SETTINGS, {});
  assert.equal(result.decision, "draft");
  assert.deepEqual(result.reasonCodes, ["stale_stock_count"]);
});

test("auto_send falls back to draft on a high backtest error", () => {
  const item = buildItem({ flags: { ...NO_FLAGS, high_backtest_error: true } });
  const result = decideAutoPurchase(item, SETTINGS, {});
  assert.equal(result.decision, "draft");
  assert.deepEqual(result.reasonCodes, ["high_backtest_error"]);
});

test("auto_send falls back to draft on a duplicate material", () => {
  const item = buildItem({ flags: { ...NO_FLAGS, duplicate_material: true } });
  const result = decideAutoPurchase(item, SETTINGS, {});
  assert.equal(result.decision, "draft");
  assert.deepEqual(result.reasonCodes, ["duplicate_material"]);
});

test("auto_send falls back to draft over the per-PO limit", () => {
  const item = buildItem({ estimated_amount: 12_000_000 });
  const result = decideAutoPurchase(item, SETTINGS, {});
  assert.equal(result.decision, "draft");
  assert.deepEqual(result.reasonCodes, ["over_po_limit"]);
});

test("auto_send falls back to draft over the daily limit", () => {
  const item = buildItem({ estimated_amount: 8_000_000 });
  const result = decideAutoPurchase(item, SETTINGS, { autoSentAmount: 25_000_000 });
  assert.equal(result.decision, "draft");
  assert.deepEqual(result.reasonCodes, ["over_daily_limit"]);
});

test("auto_send passes when every safety condition is met", () => {
  const item = buildItem();
  const result = decideAutoPurchase(item, SETTINGS, { autoSentAmount: 0 });
  assert.equal(result.decision, "auto_send");
  assert.deepEqual(result.reasonCodes, ["auto_send"]);
});

test("suggest mode never creates a purchase order", () => {
  for (const mode of ["off", "suggest"] as const) {
    const item = buildItem({ mode });
    const result = decideAutoPurchase(item, SETTINGS, {});
    assert.ok(result.decision === "skip" || result.decision === "suggest");
    assert.notEqual(result.decision, "draft");
    assert.notEqual(result.decision, "auto_send");
  }
  assert.equal(decideAutoPurchase(buildItem({ mode: "suggest" }), SETTINGS, {}).decision, "suggest");
  assert.equal(decideAutoPurchase(buildItem({ mode: "off" }), SETTINGS, {}).decision, "skip");
});

test("reason labels translate the known codes", () => {
  assert.match(reasonLabel("stale_stock_count"), /cũ/);
  assert.match(reasonLabel("over_po_limit"), /hạn mức/);
  assert.equal(reasonLabel("something_else"), "something_else");
});

test("parses the forecast RPC payload", () => {
  const forecast = parseQ7PurchaseForecast({
    as_of: "2026-10-14",
    horizon_days: 14,
    items: [
      {
        item_id: "11111111-1111-4111-8111-111111111111",
        item_code: "NVL-001",
        item_name: "Bột mì",
        unit: "kg",
        mode: "auto_send",
        daily_usage: 10,
        avg_14d: 10,
        avg_28d: 9,
        stddev_28d: 1,
        days_with_data: 28,
        weekday_factor: 1,
        scheduled_usage: 0,
        on_hand: 100,
        last_count_date: "2026-10-13",
        open_po_qty: 25,
        supplier_id: null,
        pack_size: 25,
        pack_label: "25kg",
        lead_time_days: 2,
        safety_days: 2,
        order_cycle_days: 7,
        reorder_date: "2026-10-12",
        suggested_qty: 25,
        last_unit_price: 20000,
        estimated_amount: 500000,
        flags: { no_price: false },
      },
    ],
  });
  assert.equal(forecast.items[0].mode, "auto_send");
  assert.equal(forecast.items[0].flags.no_price, false);
  assert.equal(forecast.items[0].open_po_qty, 25);
});

test("rejects malformed forecast payloads", () => {
  assert.throws(() => parseQ7PurchaseForecast(null));
  assert.throws(() => parseQ7PurchaseForecast({ as_of: "2026-10-14", items: [{ mode: "bogus" }] }));
});

test("parses the auto purchase status RPC payload", () => {
  const status = parseQ7AutoPurchaseStatus({
    settings: {
      id: 1,
      enabled: true,
      system_actor_id: "33333333-3333-4333-8333-333333333333",
      max_po_amount: 10000000,
      max_daily_amount: 30000000,
      max_stock_count_age_days: 10,
      max_backtest_error: 0.25,
      run_hour_vn: 6,
      updated_by: "33333333-3333-4333-8333-333333333333",
      updated_at: "2026-10-14T00:00:00Z",
    },
    latest_run: {
      id: "44444444-4444-4444-8444-444444444444",
      run_date: "2026-10-14",
      status: "done",
      started_at: "2026-10-14T00:00:00Z",
      finished_at: "2026-10-14T00:01:00Z",
      summary: { auto_sent: 1 },
    },
    decisions: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        run_id: "44444444-4444-4444-8444-444444444444",
        item_id: "11111111-1111-4111-8111-111111111111",
        item_name: "Bột mì",
        decision: "auto_send",
        reason_codes: ["auto_send"],
        suggested_qty: 25,
        estimated_amount: 500000,
        purchase_order_id: "66666666-6666-4666-8666-666666666666",
        purchase_order_number: "PO-20261014-0001",
        created_at: "2026-10-14T00:00:30Z",
      },
    ],
  });
  assert.equal(status.settings.enabled, true);
  assert.equal(status.latest_run?.status, "done");
  assert.equal(status.decisions[0].decision, "auto_send");
  assert.equal(status.decisions[0].purchase_order_number, "PO-20261014-0001");
});
