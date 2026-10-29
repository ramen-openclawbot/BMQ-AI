import assert from "node:assert/strict";
import test from "node:test";

import {
  DOSAGE_UNITS,
  dosageUnitCode,
  dosageUnitOptions,
  effectiveDosageUnit,
  effectivePriceUnit,
  lineCost,
  unitConversionFactor,
  withDosageUnit,
} from "./dosage-unit.ts";

test("DOSAGE_UNITS reuses the shared stock unit codes", () => {
  for (const unit of ["g", "kg", "ml", "l", "cái", "gói", "hộp"]) {
    assert.ok(DOSAGE_UNITS.includes(unit), `missing dosage unit ${unit}`);
  }
});

test("effectiveDosageUnit falls back to unit and then g", () => {
  assert.equal(effectiveDosageUnit(null), "g");
  assert.equal(effectiveDosageUnit(undefined), "g");
  assert.equal(effectiveDosageUnit({}), "g");
  assert.equal(effectiveDosageUnit({ dosage_unit: null, unit: null }), "g");
  assert.equal(effectiveDosageUnit({ dosage_unit: "", unit: "" }), "g");
  assert.equal(effectiveDosageUnit({ dosage_unit: "   ", unit: "  " }), "g");
});

test("effectiveDosageUnit prefers a trimmed dosage_unit", () => {
  assert.equal(effectiveDosageUnit({ dosage_unit: " Kg ", unit: "g" }), "Kg");
  assert.equal(effectiveDosageUnit({ dosage_unit: "", unit: " ml " }), "ml");
  assert.equal(effectiveDosageUnit({ dosage_unit: "   ", unit: "l" }), "l");
});

test("withDosageUnit keeps an existing value, else uses the material default", () => {
  assert.equal(withDosageUnit({ dosage_unit: "l" }, "Kg").dosage_unit, "l");
  assert.equal(withDosageUnit({ dosage_unit: " l " }, "Kg").dosage_unit, "l");
  assert.equal(withDosageUnit({}, "Kg").dosage_unit, "Kg");
  assert.equal(withDosageUnit({ dosage_unit: "" }, " Kg ").dosage_unit, "Kg");
  assert.equal(withDosageUnit({ dosage_unit: "  " }, "  ").dosage_unit, "g");
  assert.equal(withDosageUnit({}, null).dosage_unit, "g");
});

test("withDosageUnit does not borrow the row unit as the dosage unit", () => {
  assert.equal(withDosageUnit({ unit: "kg" }, null).dosage_unit, "g");
  assert.equal(withDosageUnit({ dosage_unit: "  ", unit: "kg" }, "").dosage_unit, "g");
});

test("withDosageUnit returns a copy and leaves the input untouched", () => {
  const row = { unit: "g", dosage_qty: 0.5 };
  const result = withDosageUnit(row, "Kg");
  assert.equal(result.dosage_qty, 0.5);
  assert.equal(result.dosage_unit, "Kg");
  assert.equal("dosage_unit" in row, false);
});

test("dosageUnitCode maps stored labels onto the shared codes", () => {
  assert.equal(dosageUnitCode("Kg"), "kg");
  assert.equal(dosageUnitCode(" Cuộn "), "cuộn");
  assert.equal(dosageUnitCode("phần"), "phần");
  assert.equal(dosageUnitCode(null), "");
});

test("dosageUnitOptions keeps an unknown current unit selectable", () => {
  assert.deepEqual(dosageUnitOptions("Kg"), [...DOSAGE_UNITS]);
  assert.equal(dosageUnitOptions("phần")[0], "phần");
  assert.equal(dosageUnitOptions("phần").length, DOSAGE_UNITS.length + 1);
});

const assertCost = (actual: number, expected: number, tolerance = 0.005) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `cost ${actual} is not ${expected}`,
  );

test("effectivePriceUnit prefers price_unit, else the effective dosage unit", () => {
  assert.equal(effectivePriceUnit({ price_unit: " Kg ", dosage_unit: "g" }), "Kg");
  assert.equal(effectivePriceUnit({ price_unit: "", dosage_unit: "ml" }), "ml");
  assert.equal(effectivePriceUnit({ price_unit: "  ", dosage_unit: "", unit: "kg" }), "kg");
  assert.equal(effectivePriceUnit({}), "g");
});

test("unitConversionFactor uses the shared stock units case-insensitively", () => {
  assert.equal(unitConversionFactor("g", "kg"), 0.001);
  assert.equal(unitConversionFactor("Kg", "g"), 1000);
  assert.equal(unitConversionFactor("ml", "l"), 0.001);
  assert.equal(unitConversionFactor("l", "ml"), 1000);
  assert.equal(unitConversionFactor("KG", "Kg"), 1);
  assert.equal(unitConversionFactor("cái", "kg"), null);
  assert.equal(unitConversionFactor("phần", "g"), null);
  assert.equal(unitConversionFactor("phần", "phần"), 1);
  assert.equal(unitConversionFactor("", "g"), null);
});

test("lineCost converts a gram dosage quoted per kg", () => {
  const result = lineCost({
    dosage_qty: 25,
    dosage_unit: "g",
    unit_price: 94418,
    price_unit: "kg",
  });
  assert.equal(result.convertible, true);
  assert.equal(result.factor, 0.001);
  assertCost(result.cost, 2360.45);
});

test("lineCost keeps a kg dosage quoted per kg unchanged", () => {
  const result = lineCost({
    dosage_qty: 0.025,
    dosage_unit: "kg",
    unit_price: 94418,
    price_unit: "kg",
  });
  assert.equal(result.factor, 1);
  assertCost(result.cost, 2360.45);
});

test("lineCost keeps a saved line without price_unit at its old cost", () => {
  const result = lineCost({
    dosage_qty: 0.44444,
    dosage_unit: "Kg",
    unit_price: 31000,
  });
  assert.equal(result.factor, 1);
  assertCost(result.cost, 13777.64);
});

test("lineCost without dosage or price unit costs dosage × price", () => {
  const result = lineCost({ dosage_qty: 12.5, unit_price: 2000 });
  assert.equal(result.factor, 1);
  assertCost(result.cost, 25000);
});

test("lineCost converts millilitres quoted per litre", () => {
  assertCost(
    lineCost({
      dosage_qty: 500,
      dosage_unit: "ml",
      unit_price: 20000,
      price_unit: "l",
    }).cost,
    10000,
  );
});

test("lineCost reports an unconvertible pair and keeps factor 1", () => {
  const result = lineCost({
    dosage_qty: 2,
    dosage_unit: "cái",
    unit_price: 1500,
    price_unit: "kg",
  });
  assert.equal(result.factor, null);
  assert.equal(result.convertible, false);
  assertCost(result.cost, 3000);
});

test("lineCost applies wastage after the unit conversion", () => {
  const result = lineCost({
    dosage_qty: 25,
    dosage_unit: "g",
    unit_price: 94418,
    price_unit: "kg",
    wastage_percent: 10,
  });
  assertCost(result.cost, 2360.45 * 1.1);
});

test("lineCost treats non-numeric inputs as 0", () => {
  const result = lineCost({
    dosage_qty: "không rõ",
    unit_price: undefined,
    wastage_percent: null,
  });
  assert.equal(result.cost, 0);
});
