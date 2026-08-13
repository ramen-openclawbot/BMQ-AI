import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDailyBreadOrderMessage,
  forecastVehicleBread,
  isVehicleLocationClosed,
  nextVietnamDateKey,
  selectLatestVietjetQuantity,
} from "./daily-bread-order.ts";

test("closes BV and PVC only when the target delivery date is lunar day 30", () => {
  assert.equal(isVehicleLocationClosed("HCM001-BV", "2026-08-12"), true);
  assert.equal(isVehicleLocationClosed("HCM002-PVC", "2026-08-12"), true);
  assert.equal(isVehicleLocationClosed("HCM003-BVĐ", "2026-08-12"), false);
  assert.equal(isVehicleLocationClosed("HCM001-BV", "2026-08-13"), false);
});

test("forecast marks closed locations as zero and keeps the reason auditable", () => {
  const result = forecastVehicleBread([{
    locationId: "bv",
    locationCode: "HCM001-BV",
    reports: [{ reportDate: "2026-08-11", soldQuantity: 200, closingQuantity: 0 }],
  }], "2026-08-12");

  assert.equal(result.totalQuantity, 0);
  assert.equal(result.locations[0].recommendedQuantity, 0);
  assert.equal(result.locations[0].closureReason, "lunar_day_30_monthly_off");
});

test("forecasts every active reporting location from peak recent sales with stock and safety guard", () => {
  const result = forecastVehicleBread([
    {
      locationId: "a",
      locationCode: "HCM-A",
      reports: [
        { reportDate: "2026-08-09", soldQuantity: 80, closingQuantity: 25 },
        { reportDate: "2026-08-10", soldQuantity: 100, closingQuantity: 20 },
      ],
    },
    {
      locationId: "b",
      locationCode: "HCM-B",
      reports: [{ reportDate: "2026-08-10", soldQuantity: 55, closingQuantity: 10 }],
    },
  ]);

  assert.equal(result.totalQuantity, 150);
  assert.deepEqual(result.locations.map((row) => ({ code: row.locationCode, quantity: row.recommendedQuantity })), [
    { code: "HCM-A", quantity: 90 },
    { code: "HCM-B", quantity: 60 },
  ]);
  assert.equal(result.formulaVersion, "peak-7d-plus-10pct-minus-closing-round10-lunar-off-v2");
});

test("does not create vehicle demand for an active location without submitted bread reports", () => {
  const result = forecastVehicleBread([{ locationId: "new", locationCode: "HCM-NEW", reports: [] }]);
  assert.equal(result.totalQuantity, 0);
  assert.deepEqual(result.warnings, ["HCM-NEW:no_submitted_bread_report"]);
});

test("subtracts an exact negative latest closing so deficits increase the vehicle order", () => {
  const result = forecastVehicleBread([{
    locationId: "negative",
    locationCode: "HCM-NEG",
    reports: [{ reportDate: "2026-08-10", soldQuantity: 100, closingQuantity: -10 }],
  }]);

  assert.equal(result.locations[0].latestClosingQuantity, -10);
  assert.equal(result.totalQuantity, 120);
});

test("uses exact quantity from the latest VietJet cumulative email for target service date", () => {
  const result = selectLatestVietjetQuantity([
    {
      inboxId: "older",
      receivedAt: "2026-08-09T08:00:00Z",
      productionItems: [{ service_date: "2026-08-11", product_code: "40000294", qty: 188 }],
    },
    {
      inboxId: "latest",
      receivedAt: "2026-08-10T08:00:00Z",
      productionItems: [{ service_date: "2026-08-11", product_code: "40000294", qty: 196 }],
    },
    {
      inboxId: "other-product",
      receivedAt: "2026-08-10T09:00:00Z",
      productionItems: [{ service_date: "2026-08-11", product_code: "OTHER", qty: 999 }],
    },
  ], "2026-08-11");

  assert.equal(result.quantity, 196);
  assert.equal(result.inboxId, "latest");
});

test("rounds only Total BMQ and VietJet upward to the next 10 while keeping source lines exact", () => {
  const message = buildDailyBreadOrderMessage({
    orderDate: "2026-08-11",
    dealerOrderedQuantity: 1460,
    dealerExtraQuantity: 32,
    vehicleQuantity: 600,
    vietjetQuantity: 196,
  });

  assert.equal(message, [
    "Đặt bánh ngày 11/8/2026",
    "ĐL: 1460+ 32",
    "Xe: 600",
    "Tổng BMQ: 2100",
    "Viet Jet: 200",
  ].join("\n"));
  assert.doesNotMatch(message, /Coop/);
});

test("omits dealer plus suffix when there is no exchange or makeup quantity", () => {
  const message = buildDailyBreadOrderMessage({
    orderDate: "2026-08-12",
    dealerOrderedQuantity: 100,
    dealerExtraQuantity: 0,
    vehicleQuantity: 50,
    vietjetQuantity: 0,
  });
  assert.match(message, /^Đặt bánh ngày 12\/8\/2026\nĐL: 100\n/m);
  assert.match(message, /Tổng BMQ: 150/);
});

test("locks at 23:59 Vietnam and targets the next Vietnam calendar day", () => {
  assert.equal(nextVietnamDateKey(new Date("2026-08-10T16:59:00Z")), "2026-08-11");
  assert.equal(nextVietnamDateKey(new Date("2026-12-31T16:59:00Z")), "2027-01-01");
  assert.equal(nextVietnamDateKey(new Date("invalid")), null);
});
