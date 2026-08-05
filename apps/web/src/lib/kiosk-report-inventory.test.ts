import assert from "node:assert/strict";

import {
  calculateConsumedQuantity,
  calculateInventoryClosing,
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
assert.equal(calculateConsumedQuantity(pate, -10), 0);

console.log("PASS kiosk report ingredient consumption");
