import assert from "node:assert/strict";
import test from "node:test";

import {
  isWarehouseDailyDigestTime,
  isWarehouseNotificationWindow,
  warehouseVietnamDayRange,
} from "./dealer-warehouse-schedule.ts";

test("warehouse scan is closed before 20:00 Vietnam time", () => {
  assert.equal(isWarehouseNotificationWindow(new Date("2026-08-03T12:59:59.000Z")), false);
});

test("warehouse scan opens at 20:00 Vietnam time", () => {
  assert.equal(isWarehouseNotificationWindow(new Date("2026-08-03T13:00:00.000Z")), true);
});

test("warehouse scan remains open through 23:59 Vietnam time", () => {
  assert.equal(isWarehouseNotificationWindow(new Date("2026-08-03T16:59:59.000Z")), true);
});

test("warehouse scan closes at midnight Vietnam time", () => {
  assert.equal(isWarehouseNotificationWindow(new Date("2026-08-03T17:00:00.000Z")), false);
});

test("warehouse scan rejects invalid timestamps", () => {
  assert.equal(isWarehouseNotificationWindow(new Date("invalid")), false);
});

test("daily digest runs only during the final 23:59 Vietnam scan", () => {
  assert.equal(isWarehouseDailyDigestTime(new Date("2026-08-03T16:58:59.000Z")), false);
  assert.equal(isWarehouseDailyDigestTime(new Date("2026-08-03T16:59:00.000Z")), true);
  assert.equal(isWarehouseDailyDigestTime(new Date("2026-08-03T16:59:59.999Z")), true);
  assert.equal(isWarehouseDailyDigestTime(new Date("2026-08-03T17:00:00.000Z")), false);
  assert.equal(isWarehouseDailyDigestTime(new Date("invalid")), false);
});

test("daily digest queries the exact Vietnam calendar day", () => {
  assert.deepEqual(warehouseVietnamDayRange(new Date("2026-08-03T16:59:00.000Z")), {
    dateKey: "2026-08-03",
    startsAt: "2026-08-02T17:00:00.000Z",
    endsBefore: "2026-08-03T17:00:00.000Z",
  });
  assert.equal(warehouseVietnamDayRange(new Date("invalid")), null);
});
