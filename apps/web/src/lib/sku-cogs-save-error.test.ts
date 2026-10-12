import assert from "node:assert/strict";
import test from "node:test";

import {
  describeSkuCogsSaveError,
  type SkuCogsSaveErrorRow,
} from "./sku-cogs-save-error.ts";

// The six NVL rows from the production save error (form order).
const formRows: SkuCogsSaveErrorRow[] = [
  { material_code: "TP-PATE", name: "Pate heo" },
  { material_code: "NVL-DA BAO", name: "Da bao TVP" },
  { material_code: "NVL-CHA-BONG", name: "Chà bông" },
  { material_code: "NVL-BANH-MI-TUOI", name: "Bánh mì tươi" },
  { material_code: "TP - BO BML", name: "Bơ Bánh mì" },
  { material_code: "NVL-CHA LUA LA", name: "Chả lụa lá TVP" },
];

const sixMissingStandardCost = {
  ready: false,
  status: "blocked",
  blockers: formRows.map((_, index) => ({
    row: index + 1,
    blockers: ["missing_standard_cost"],
    request_id: null,
  })),
  rows: [],
};

test("lists all six missing-standard-cost rows with code and name", () => {
  const message = `Lưu SKU lỗi: sku_cogs_material_blocked_before_publish: ${JSON.stringify(sixMissingStandardCost)}`;
  assert.equal(
    describeSkuCogsSaveError(message, formRows),
    "Không lưu được SKU: " +
      "dòng 1 (TP-PATE – Pate heo) chưa có giá chuẩn; " +
      "dòng 2 (NVL-DA BAO – Da bao TVP) chưa có giá chuẩn; " +
      "dòng 3 (NVL-CHA-BONG – Chà bông) chưa có giá chuẩn; " +
      "dòng 4 (NVL-BANH-MI-TUOI – Bánh mì tươi) chưa có giá chuẩn; " +
      "dòng 5 (TP - BO BML – Bơ Bánh mì) chưa có giá chuẩn; " +
      "dòng 6 (NVL-CHA LUA LA – Chả lụa lá TVP) chưa có giá chuẩn.",
  );
});

test("reads the payload through a PostgREST prefix", () => {
  const message = `PostgREST error: sku_cogs_material_blocked_before_publish: ${JSON.stringify({
    ready: false,
    blockers: [{ row: 2, blockers: ["missing_standard_cost"] }],
  })}`;
  assert.equal(
    describeSkuCogsSaveError(message, formRows),
    "Không lưu được SKU: dòng 2 (NVL-DA BAO – Da bao TVP) chưa có giá chuẩn.",
  );
});

test("names the unit, supplier, purchase and unknown blockers", () => {
  const message = `sku_cogs_material_blocked_before_publish: ${JSON.stringify({
    ready: false,
    blockers: [
      { row: 1, blockers: ["unit_unmapped"] },
      { row: 2, blockers: ["supplier_unmapped"] },
      { row: 3, blockers: ["missing_purchase_price"] },
      { row: 4, blockers: ["material_resolution_required"] },
      { row: 5, blockers: ["some_future_blocker"] },
    ],
  })}`;
  assert.equal(
    describeSkuCogsSaveError(message, formRows),
    "Không lưu được SKU: " +
      "dòng 1 (TP-PATE – Pate heo) chưa khớp đơn vị; " +
      "dòng 2 (NVL-DA BAO – Da bao TVP) chưa gắn nhà cung cấp; " +
      "dòng 3 (NVL-CHA-BONG – Chà bông) chưa có giá mua; " +
      "dòng 4 (NVL-BANH-MI-TUOI – Bánh mì tươi) chưa xác định được NVL; " +
      "dòng 5 (TP - BO BML – Bơ Bánh mì) chưa xác định được NVL.",
  );
});

test("falls back to the row number when the form row is missing", () => {
  const message = `sku_cogs_material_blocked_before_publish: ${JSON.stringify({
    ready: false,
    blockers: [{ row: 3, blockers: ["missing_standard_cost"] }],
  })}`;
  assert.equal(
    describeSkuCogsSaveError(message, []),
    "Không lưu được SKU: dòng 3 chưa có giá chuẩn.",
  );
});

test("reads the material name from ingredient_name", () => {
  const message = `sku_cogs_material_blocked_before_publish: ${JSON.stringify({
    ready: false,
    blockers: [{ row: 1, blockers: ["missing_standard_cost"] }],
  })}`;
  assert.equal(
    describeSkuCogsSaveError(message, [
      { material_code: "TP-PATE", ingredient_name: "Pate heo" },
    ]),
    "Không lưu được SKU: dòng 1 (TP-PATE – Pate heo) chưa có giá chuẩn.",
  );
});

test("returns null for broken JSON", () => {
  const message =
    'Lưu SKU lỗi: sku_cogs_material_blocked_before_publish: {"ready":false,"blockers":[{"row":1,';
  assert.equal(describeSkuCogsSaveError(message, formRows), null);
});

test("returns null for an unrelated error string", () => {
  assert.equal(
    describeSkuCogsSaveError("Có lỗi khi lưu dữ liệu, anh thử lại giúp Ramen.", formRows),
    null,
  );
  assert.equal(describeSkuCogsSaveError("sku_cogs_material_blocked_before_publish:", formRows), null);
  assert.equal(describeSkuCogsSaveError(null, formRows), null);
  assert.equal(describeSkuCogsSaveError(undefined, formRows), null);
});
