import assert from "node:assert/strict";
import test from "node:test";

import { poCreateErrorText } from "./po-create-errors.ts";

const UNIT_DRIFT_MESSAGE = "Đơn vị trên dòng sản phẩm không hợp lệ, đã hủy PO nháp. Thử lại.";

test("unit drift error becomes the cancel + retry message", () => {
  assert.equal(poCreateErrorText(new Error("procurement source unit drift")), UNIT_DRIFT_MESSAGE);
  assert.equal(
    poCreateErrorText({ message: "ERROR: procurement source unit drift (SQLSTATE 23514)" }),
    UNIT_DRIFT_MESSAGE,
  );
  assert.equal(poCreateErrorText("Procurement Source Unit Drift"), UNIT_DRIFT_MESSAGE);
});

test("generic error keeps the generic message plus the server message", () => {
  assert.equal(
    poCreateErrorText(new Error("permission denied")),
    "Lỗi khi tạo đơn đặt hàng: permission denied",
  );
  assert.equal(
    poCreateErrorText({ message: "duplicate key value violates unique constraint" }),
    "Lỗi khi tạo đơn đặt hàng: duplicate key value violates unique constraint",
  );
  assert.equal(
    poCreateErrorText("plain server string"),
    "Lỗi khi tạo đơn đặt hàng: plain server string",
  );
});

test("null or empty error shows only the generic message", () => {
  assert.equal(poCreateErrorText(null), "Lỗi khi tạo đơn đặt hàng");
  assert.equal(poCreateErrorText(undefined), "Lỗi khi tạo đơn đặt hàng");
  assert.equal(poCreateErrorText(new Error("")), "Lỗi khi tạo đơn đặt hàng");
});
