import assert from "node:assert/strict";
import test from "node:test";

import { countUnitsFor, displayUnitFor, toDisplayAmount } from "./kho-display-unit.ts";

test("displayUnitFor accepts kg only on a g item", () => {
  assert.equal(displayUnitFor("g", "kg"), "kg");
  assert.equal(displayUnitFor(" G ", "kg"), "kg");
  assert.equal(displayUnitFor("ml", "kg"), null);
  assert.equal(displayUnitFor("cái", "kg"), null);
  assert.equal(displayUnitFor("g", null), null);
  assert.equal(displayUnitFor("g", ""), null);
});

test("displayUnitFor accepts lít only on an ml item", () => {
  assert.equal(displayUnitFor("ml", "lít"), "lít");
  assert.equal(displayUnitFor(" ML ", "lít"), "lít");
  assert.equal(displayUnitFor("g", "lít"), null);
  assert.equal(displayUnitFor("cái", "lít"), null);
  assert.equal(displayUnitFor("ml", undefined), null);
});

test("toDisplayAmount turns 500 g into 0,5 kg when kg is on", () => {
  assert.deepEqual(toDisplayAmount(500, "g", "kg"), { value: 0.5, unit: "kg" });
  assert.deepEqual(toDisplayAmount(1250, "g", "kg"), { value: 1.25, unit: "kg" });
  assert.deepEqual(toDisplayAmount(2000, "ml", "lít"), { value: 2, unit: "lít" });
});

test("toDisplayAmount keeps the ledger amount when the display unit is off", () => {
  assert.deepEqual(toDisplayAmount(500, "g", null), { value: 500, unit: "g" });
  assert.deepEqual(toDisplayAmount(500, "g", undefined), { value: 500, unit: "g" });
  assert.deepEqual(toDisplayAmount(500, "cái", "kg"), { value: 500, unit: "cái" });
});

test("countUnitsFor offers exactly kg / lít when a display unit is on", () => {
  assert.deepEqual(countUnitsFor("g", "kg"), [{ label: "kg", factor: 1000 }]);
  assert.deepEqual(countUnitsFor("ml", "lít"), [{ label: "lít", factor: 1000 }]);
});

test("countUnitsFor keeps the old choices when the display unit is off", () => {
  assert.deepEqual(countUnitsFor("g", null), [
    { label: "kg", factor: 1000 },
    { label: "g", factor: 1 },
  ]);
  assert.deepEqual(countUnitsFor("ml", undefined), [
    { label: "lít", factor: 1000 },
    { label: "ml", factor: 1 },
  ]);
  assert.deepEqual(countUnitsFor("cái", "kg"), [{ label: "cái", factor: 1 }]);
});
