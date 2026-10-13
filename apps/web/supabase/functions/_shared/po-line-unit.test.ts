import assert from "node:assert/strict";
import test from "node:test";

import { applyNameSuffixUnits, unitFromNameSuffix } from "./po-line-unit.ts";

test("unitFromNameSuffix reads kg from a trailing (kg)", () => {
  assert.equal(unitFromNameSuffix("BAO XỚP ZIN TRẮNG 30 (kg)"), "kg");
  assert.equal(unitFromNameSuffix("BAO PE 15X25 (kg)"), "kg");
});

test("unitFromNameSuffix reads uppercase and multi-word brackets by first token", () => {
  assert.equal(unitFromNameSuffix("MÀNG PVC -ST 612-30CM (CUỘN)"), "cuộn");
  assert.equal(unitFromNameSuffix("BAO TAY Y TẾ ĐEN SIZE L (HỘP 100 CÁI)"), "hộp");
  assert.equal(unitFromNameSuffix("THỚI B BĂNG KEO VÀNG -VP (Bao 100 Cái)"), "bao");
  assert.equal(unitFromNameSuffix("BAO PE 13X23 (BAO 10 KG)"), "bao");
  assert.equal(unitFromNameSuffix("GVS PREMIER JUMBO 700GR (CUỘN)"), "cuộn");
});

test("unitFromNameSuffix returns null when the bracket is not a unit", () => {
  assert.equal(unitFromNameSuffix("Hộp dùng bánh Vuông nâu Kraft ( Hàng Nhập)"), null);
  assert.equal(unitFromNameSuffix("Giấy gói thảm 14x18cm (40/50gsm)"), null);
  assert.equal(unitFromNameSuffix("Phô mai 84 lát (1kg/khối 12 khối/thùng)"), null);
});

test("unitFromNameSuffix returns null without a trailing bracket", () => {
  assert.equal(unitFromNameSuffix("Bột mì 888 Cam"), null);
  assert.equal(unitFromNameSuffix(""), null);
  assert.equal(unitFromNameSuffix(null), null);
  assert.equal(unitFromNameSuffix("Bao (kg) tay"), null);
});

test("applyNameSuffixUnits overrides only unit and keeps every other field", () => {
  const original = [
    {
      product_name: "BAO PE 15X25 (kg)",
      unit: "cái",
      quantity: 12,
      unit_price: 25_000,
      line_total: 300_000,
    },
    {
      product_name: "Bột mì 888 Cam",
      unit: "bao",
      quantity: 5,
      unit_price: 100_000,
    },
  ];

  const result = applyNameSuffixUnits(original) as Array<Record<string, unknown>>;

  assert.deepEqual(result[0], {
    product_name: "BAO PE 15X25 (kg)",
    unit: "kg",
    quantity: 12,
    unit_price: 25_000,
    line_total: 300_000,
  });
  assert.equal(result[1].unit, "bao");
  assert.equal(result[1].quantity, 5);
  assert.equal(result[1].product_name, "Bột mì 888 Cam");

  // The input array and its objects are left untouched.
  assert.equal(original[0].unit, "cái");
  assert.notEqual(result[0], original[0]);
});

test("applyNameSuffixUnits tolerates non-array and non-object entries", () => {
  assert.deepEqual(applyNameSuffixUnits(null), []);
  assert.deepEqual(applyNameSuffixUnits("nope"), []);

  const mixed = [{ product_name: "BAO PE (kg)", unit: "cái" }, "raw", null];
  const result = applyNameSuffixUnits(mixed);

  assert.equal((result[0] as Record<string, unknown>).unit, "kg");
  assert.equal(result[1], "raw");
  assert.equal(result[2], null);
});
