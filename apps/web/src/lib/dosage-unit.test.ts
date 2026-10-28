import assert from "node:assert/strict";
import test from "node:test";

import {
  DOSAGE_UNITS,
  dosageUnitCode,
  dosageUnitOptions,
  effectiveDosageUnit,
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
