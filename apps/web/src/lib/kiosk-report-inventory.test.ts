import assert from "node:assert/strict";

import {
  calculateKioskChannelAmount,
  kioskRetailCustomerUnitPriceVnd,
  calculateConsumedQuantity,
  calculateEffectiveConsumedQuantity,
  calculateInventoryClosing,
  deriveBreadstickInventoryRow,
  isNegativeInventoryClosing,
  isRetailSaleAllowed,
  type ReportInventoryProduct,
  type ReportInventoryRow,
} from "./kiosk-report-inventory.ts";

const breadstick: ReportInventoryProduct = {
  code: "banh_mi_que",
  sale_allowed: true,
  breadstick_consumption_ratio: 0,
};
const pate: ReportInventoryProduct = {
  code: "pate",
  sale_allowed: false,
  breadstick_consumption_ratio: 1 / 20,
};
const chili: ReportInventoryProduct = {
  code: "ot",
  sale_allowed: false,
  breadstick_consumption_ratio: 0,
};

const pateRow: ReportInventoryRow = {
  openingQuantity: 5,
  receivedQuantity: 3,
  shortageQuantity: 0,
  transferQuantity: 0,
  wasteQuantity: 0,
  returnsQuantity: 0,
  soldQuantity: 0,
};

assert.equal(isRetailSaleAllowed(breadstick), true);
assert.equal(isRetailSaleAllowed(pate), false);
assert.equal(isRetailSaleAllowed(chili), false);
assert.equal(calculateConsumedQuantity(pate, 106), 5.3);
assert.equal(calculateConsumedQuantity(chili, 106), 0);
assert.equal(calculateInventoryClosing(pateRow, calculateConsumedQuantity(pate, 106)), 2.7);
assert.equal(isNegativeInventoryClosing(pateRow, calculateConsumedQuantity(pate, 180)), true);
assert.equal(isNegativeInventoryClosing(pateRow, calculateConsumedQuantity(pate, 160)), false);
assert.equal(calculateConsumedQuantity(pate, -10), 0);
assert.equal(calculateEffectiveConsumedQuantity(pate, 106, 99), 5.3);
assert.equal(calculateEffectiveConsumedQuantity(chili, 106, 2.5), 2.5);
assert.equal(calculateEffectiveConsumedQuantity(chili, 106, -2.5), 0);
assert.equal(calculateInventoryClosing(pateRow, calculateEffectiveConsumedQuantity(chili, 106, 2.5)), 5.5);
assert.equal(kioskRetailCustomerUnitPriceVnd("2026-08-14"), 12_000);
assert.equal(kioskRetailCustomerUnitPriceVnd("2026-08-15"), 14_000);
assert.equal(kioskRetailCustomerUnitPriceVnd("2026-08-16"), 14_000);
assert.equal(calculateKioskChannelAmount("khach_le", 0, 999_999, "2026-08-15"), 0);
assert.equal(calculateKioskChannelAmount("khach_le", 3, 999_999, "2026-08-14"), 36_000);
assert.equal(calculateKioskChannelAmount(" KHACH_LE ", 3, 999_999, "2026-08-15"), 42_000);
assert.equal(calculateKioskChannelAmount("khach_le", 2.5, 0, "2026-08-15"), 35_000);
assert.equal(calculateKioskChannelAmount("grabfood", 3, 240_000, "2026-08-15"), 240_000);
assert.equal(calculateKioskChannelAmount("grabfood", 3, -10, "2026-08-15"), 0);

const staleBreadstickRow: ReportInventoryRow = {
  openingQuantity: 50,
  receivedQuantity: 100,
  shortageQuantity: 0,
  transferQuantity: 1,
  wasteQuantity: 2,
  returnsQuantity: 0,
  soldQuantity: 0,
};
const derivedBreadstickRow = deriveBreadstickInventoryRow(staleBreadstickRow, 97);
assert.equal(derivedBreadstickRow.soldQuantity, 97);
assert.equal(calculateInventoryClosing(derivedBreadstickRow), 52);
assert.equal(isNegativeInventoryClosing(deriveBreadstickInventoryRow(staleBreadstickRow, 200)), true);

console.log("PASS kiosk report ingredient consumption");
