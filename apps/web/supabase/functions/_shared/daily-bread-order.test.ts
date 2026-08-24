import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDailyBreadOrderCorrectionMessage,
  buildDailyBreadOrderMessage,
  buildWarehouseKioskBreadDispatchCorrectionMessage,
  buildWarehouseKioskBreadDispatchMessage,
  forecastVehicleBread,
  isVehicleLocationClosed,
  nextVietnamDateKey,
  selectLatestVietjetQuantity,
} from "./daily-bread-order.ts";

test("formats the warehouse kiosk bread dispatch from automatic orders plus report shortages and exchanges", () => {
  const message = buildWarehouseKioskBreadDispatchMessage({
    orderDate: "2026-08-18",
    locations: [
      { locationCode: "HCM001-BV", locationName: "91 Bùi Viện", orderQuantity: 100, shortageQuantity: 6, returnsQuantity: 11, wasteQuantity: 0 },
      { locationCode: "HCM002-PVC", locationName: "213 Phạm Văn Chí", orderQuantity: 120, shortageQuantity: 4, returnsQuantity: 0, wasteQuantity: 0 },
      { locationCode: "HCM003-BVĐ", locationName: "323 Bến Vân Đồn", orderQuantity: 100, shortageQuantity: 2, returnsQuantity: 0, wasteQuantity: 1 },
      { locationCode: "HCM004-BHN", locationName: "276 Bùi Hữu Nghĩa", orderQuantity: 140, shortageQuantity: 0, returnsQuantity: 0, wasteQuantity: 0 },
      { locationCode: "HCM005-TN", locationName: "230 Thống Nhất", orderQuantity: 80, shortageQuantity: 0, returnsQuantity: 0, wasteQuantity: 0 },
    ],
  });

  assert.equal(message, [
    "ĐẶT BÁNH 18/8",
    "",
    "Bùi Viện: đặt 100 que | bù 6 | đổi 11",
    "Bùi Hữu Nghĩa: đặt 140 que",
    "Bến Vân Đồn: đặt 100 que | bù 2 | đổi 1",
    "Phạm Văn Chí: đặt 120 que | bù 4",
    "Thống Nhất: đặt 80 que",
    "",
    "Tổng đặt mới: 540 que",
    "Tổng bù: 12 que",
    "Tổng đổi: 12 que",
    "KHO CẦN GIAO: 564 QUE",
  ].join("\n"));
});

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

  assert.equal(result.totalQuantity, 140);
  assert.deepEqual(result.locations.map((row) => ({
    code: row.locationCode,
    quantity: row.recommendedQuantity,
    decision: row.roundingDecision,
  })), [
    { code: "HCM-A", quantity: 80, decision: "round_down_existing_stock_buffer" },
    { code: "HCM-B", quantity: 60, decision: "round_up_to_prevent_peak_stockout" },
  ]);
  assert.equal(result.formulaVersion, "peak-7d-plus-10pct-minus-closing-smart-round20-lunar-off-v3");
});

test("rounds a 100-versus-120 decision up only when stock is too low", () => {
  const result = forecastVehicleBread([
    {
      locationId: "low-stock",
      locationCode: "HCM-LOW",
      reports: [{ reportDate: "2026-08-20", soldQuantity: 100, closingQuantity: 0 }],
    },
    {
      locationId: "has-stock",
      locationCode: "HCM-STOCK",
      reports: [{ reportDate: "2026-08-20", soldQuantity: 100, closingQuantity: 10 }],
    },
    {
      locationId: "some-stock",
      locationCode: "HCM-SOME",
      reports: [{ reportDate: "2026-08-20", soldQuantity: 100, closingQuantity: 5 }],
    },
  ]);

  assert.deepEqual(result.locations.map((row) => ({
    code: row.locationCode,
    closing: row.latestClosingQuantity,
    net: row.netDemandQuantity,
    lower: row.lowerBatchQuantity,
    upper: row.upperBatchQuantity,
    quantity: row.recommendedQuantity,
    decision: row.roundingDecision,
  })), [
    { code: "HCM-LOW", closing: 0, net: 110, lower: 100, upper: 120, quantity: 120, decision: "round_up_to_preserve_low_stock_safety" },
    { code: "HCM-STOCK", closing: 10, net: 100, lower: 100, upper: 100, quantity: 100, decision: "exact_20_stick_batch" },
    { code: "HCM-SOME", closing: 5, net: 105, lower: 100, upper: 120, quantity: 120, decision: "round_up_to_preserve_low_stock_safety" },
  ]);
});

test("rounds down from 120 to 100 when existing stock already protects peak sales", () => {
  const result = forecastVehicleBread([{
    locationId: "bhn",
    locationCode: "HCM004-BHN",
    reports: [
      { reportDate: "2026-08-20", soldQuantity: 148, closingQuantity: 89 },
      { reportDate: "2026-08-16", soldQuantity: 183, closingQuantity: 19 },
    ],
  }]);

  assert.equal(result.locations[0].peakSoldQuantity, 183);
  assert.equal(result.locations[0].protectedDemandQuantity, 201.3);
  assert.ok(Math.abs(result.locations[0].netDemandQuantity - 112.3) < 1e-9);
  assert.equal(result.locations[0].lowerBatchQuantity, 100);
  assert.equal(result.locations[0].upperBatchQuantity, 120);
  assert.equal(result.locations[0].recommendedQuantity, 100);
  assert.equal(result.locations[0].roundingDecision, "round_down_existing_stock_buffer");
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

test("supplier message orders dealer exchange and makeup from the bakery and audits the credit", () => {
  const message = buildDailyBreadOrderMessage({
    orderDate: "2026-08-11",
    dealerOrderedQuantity: 1460,
    dealerExchangeQuantity: 12,
    dealerMakeupQuantity: 20,
    vehicleQuantity: 600,
    vietjetQuantity: 196,
  });

  assert.equal(message, [
    "Đặt bánh ngày 11/8/2026",
    "ĐL: 1460 | Đổi: 12 | Bù: 20 | Giao: 1492",
    "Xe: 600",
    "Tổng BMQ giao: 2100",
    "Khấu trừ công nợ lò: 32",
    "Lò tính tiền: 2068",
    "Viet Jet: 200",
  ].join("\n"));
  assert.doesNotMatch(message, /Coop/);
  assert.doesNotMatch(message, /tồn nội bộ/i);
});

test("rounds BMQ totals upward to complete 20-stick pate batches", () => {
  const cases = [
    { raw: 230, expected: 240 },
    { raw: 250, expected: 260 },
    { raw: 260, expected: 260 },
  ];

  for (const { raw, expected } of cases) {
    const message = buildDailyBreadOrderMessage({
      orderDate: "2026-08-12",
      dealerOrderedQuantity: raw,
      dealerExchangeQuantity: 0,
      dealerMakeupQuantity: 0,
      vehicleQuantity: 0,
      vietjetQuantity: 0,
    });
    assert.match(message, new RegExp(`Tổng BMQ giao: ${expected}$`, "m"));
  }
});

test("keeps supplier dealer line exact when there is no internal exchange or makeup", () => {
  const message = buildDailyBreadOrderMessage({
    orderDate: "2026-08-12",
    dealerOrderedQuantity: 100,
    vehicleQuantity: 50,
    vietjetQuantity: 0,
  });
  assert.match(message, /^Đặt bánh ngày 12\/8\/2026\nĐL: 100\n/m);
  assert.match(message, /Tổng BMQ giao: 160/);
});

test("formats supplier correction as full replacement with corrected totals", () => {
  const message = buildDailyBreadOrderCorrectionMessage({
    orderDate: "2026-08-20",
    dealerOrderedQuantity: 100,
    dealerExchangeQuantity: 8,
    dealerMakeupQuantity: 12,
    vehicleQuantity: 220,
    vietjetQuantity: 196,
    affectedLocationName: "Bùi Hữu Nghĩa",
    affectedDeltaQuantity: 150,
  });

  assert.equal(message, [
    "ĐIỀU CHỈNH ĐẶT BÁNH - THAY THẾ TOÀN BỘ",
    "Chênh lệch điểm bị sửa (Bùi Hữu Nghĩa): 150 que tăng",
    "Tổng đúng sau chỉnh sửa:",
    "Đặt bánh ngày 20/8/2026",
    "ĐL: 100 | Đổi: 8 | Bù: 12 | Giao: 120",
    "Xe: 220",
    "Tổng BMQ giao: 340",
    "Khấu trừ công nợ lò: 20",
    "Lò tính tiền: 320",
    "Viet Jet: 200",
  ].join("\n"));
});

test("formats warehouse correction as full replacement with affected point adjustment", () => {
  const message = buildWarehouseKioskBreadDispatchCorrectionMessage({
    orderDate: "2026-08-20",
    affectedLocationName: "Bùi Hữu Nghĩa",
    previousAffectedQuantity: 0,
    correctedAffectedQuantity: 220,
    locations: [
      { locationCode: "HCM004-BHN", locationName: "276 Bùi Hữu Nghĩa", orderQuantity: 220, shortageQuantity: 0, returnsQuantity: 0, wasteQuantity: 0 },
    ],
  });

  assert.equal(message, [
    "ĐIỀU CHỈNH GIAO BÁNH KHO - THAY THẾ TOÀN BỘ",
    "Chênh lệch điểm bị sửa (Bùi Hữu Nghĩa): 220 que tăng",
    "Tổng đúng sau chỉnh sửa:",
    "ĐẶT BÁNH 20/8",
    "",
    "Bùi Hữu Nghĩa: đặt 220 que",
    "",
    "Tổng đặt mới: 220 que",
    "Tổng bù: 0 que",
    "Tổng đổi: 0 que",
    "KHO CẦN GIAO: 220 QUE",
  ].join("\n"));
});

test("formats supplier correction decrease as full replacement", () => {
  const message = buildDailyBreadOrderCorrectionMessage({
    orderDate: "2026-08-20",
    dealerOrderedQuantity: 100,
    vehicleQuantity: 60,
    vietjetQuantity: 0,
    affectedLocationName: "Điểm A",
    affectedDeltaQuantity: -40,
  });

  assert.match(message, /40 que giảm/);
  assert.match(message, /Tổng BMQ giao: 160/);
});

test("formats warehouse correction decrease as full replacement", () => {
  const message = buildWarehouseKioskBreadDispatchCorrectionMessage({
    orderDate: "2026-08-20",
    affectedLocationName: "Điểm A",
    previousAffectedQuantity: 80,
    correctedAffectedQuantity: 40,
    locations: [
      { locationCode: "HCM-A", locationName: "Điểm A", orderQuantity: 40, shortageQuantity: 0, returnsQuantity: 0, wasteQuantity: 0 },
    ],
  });

  assert.match(message, /40 que giảm/);
  assert.match(message, /KHO CẦN GIAO: 40 QUE/);
});

test("locks at 23:59 Vietnam and targets the next Vietnam calendar day", () => {
  assert.equal(nextVietnamDateKey(new Date("2026-08-10T16:59:00Z")), "2026-08-11");
  assert.equal(nextVietnamDateKey(new Date("2026-12-31T16:59:00Z")), "2027-01-01");
  assert.equal(nextVietnamDateKey(new Date("invalid")), null);
});
