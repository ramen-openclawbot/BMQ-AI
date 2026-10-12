import assert from "node:assert/strict";
import test from "node:test";

import { parseReceiptLines } from "./receipt-lines.ts";

const FULL_ROW = {
  goods_receipt_id: "11111111-1111-1111-1111-111111111111",
  goods_receipt_item_id: "22222222-2222-2222-2222-222222222222",
  receipt_number: "GRN-QA-0001",
  receipt_date: "2026-10-11",
  status: "received",
  supplier_name: "Tuyết Anh",
  raw_name: "Bánh mì que ngày 1",
  quantity: 12.5,
  unit: "kg",
  unit_price: 42000,
  line_total: 525000,
  image_path: "goods-receipts/delivery-note-1-1729000000.jpg",
  photo_paths: ["goods-receipts/product-1.jpg"],
};

test("parses a full receipt line", () => {
  const [line] = parseReceiptLines([FULL_ROW]);
  assert.deepEqual(line, FULL_ROW);
});

test("coerces numeric strings and a numeric-string quantity", () => {
  const [line] = parseReceiptLines([
    {
      ...FULL_ROW,
      quantity: "3",
      unit_price: "1000.5",
      line_total: "3001.5",
    },
  ]);
  assert.equal(line.quantity, 3);
  assert.equal(line.unit_price, 1000.5);
  assert.equal(line.line_total, 3001.5);
});

test("photo_paths defaults to [] when null or missing", () => {
  const [nullPhotos] = parseReceiptLines([{ ...FULL_ROW, photo_paths: null }]);
  assert.deepEqual(nullPhotos.photo_paths, []);

  const { photo_paths: _omitted, ...withoutPhotos } = FULL_ROW;
  const [missingPhotos] = parseReceiptLines([withoutPhotos]);
  assert.deepEqual(missingPhotos.photo_paths, []);
});

test("blank optional fields stay null", () => {
  const [line] = parseReceiptLines([
    {
      ...FULL_ROW,
      supplier_name: null,
      unit: null,
      unit_price: null,
      line_total: null,
      image_path: "",
    },
  ]);
  assert.equal(line.supplier_name, null);
  assert.equal(line.unit, null);
  assert.equal(line.unit_price, null);
  assert.equal(line.line_total, null);
  assert.equal(line.image_path, "");
});

test("missing / null payload is an empty list", () => {
  assert.deepEqual(parseReceiptLines(null), []);
  assert.deepEqual(parseReceiptLines(undefined), []);
  assert.deepEqual(parseReceiptLines([]), []);
});

test("a non-array payload and malformed rows throw", () => {
  assert.throws(() => parseReceiptLines({}), /must be an array/);
  assert.throws(() => parseReceiptLines([{ ...FULL_ROW, quantity: "abc" }]), /finite number/);
  assert.throws(() => parseReceiptLines([{ ...FULL_ROW, goods_receipt_id: 5 }]), /must be a string/);
  assert.throws(
    () => parseReceiptLines([{ ...FULL_ROW, photo_paths: "nope" }]),
    /must be an array/,
  );
});
