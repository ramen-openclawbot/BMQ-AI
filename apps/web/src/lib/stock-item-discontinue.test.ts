// Node tests for the "Ngưng dùng" (discontinue) kitchen-item helpers.
import assert from "node:assert/strict";
import test from "node:test";

import {
  discontinueErrorCode,
  discontinueErrorText,
  parseDiscontinuedStockItems,
} from "./stock-item-discontinue.ts";

test("parseDiscontinuedStockItems maps a valid payload", () => {
  const items = parseDiscontinuedStockItems([
    {
      item_id: "245d214c-5f8d-4490-91aa-4d58192bf899",
      item_code: "NVL-BOT-CUSTARD",
      name: "Bột custard sư tử",
      unit: "g",
      item_class: "raw_material",
      pastry_q7: false,
      tan_tao_qty: 125.5,
      q7_qty: 0,
      in_q7: false,
      used_7d: true,
      tan_tao_qty_at_stop: 125.5,
      q7_qty_at_stop: 0,
      reason: "hết dùng",
      discontinued_by_name: "Chủ BMQ",
      discontinued_at: "2026-11-01T10:00:00+07:00",
    },
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    item_id: "245d214c-5f8d-4490-91aa-4d58192bf899",
    item_code: "NVL-BOT-CUSTARD",
    name: "Bột custard sư tử",
    unit: "g",
    item_class: "raw_material",
    pastry_q7: false,
    tan_tao_qty: 125.5,
    q7_qty: 0,
    in_q7: false,
    used_7d: true,
    tan_tao_qty_at_stop: 125.5,
    q7_qty_at_stop: 0,
    reason: "hết dùng",
    discontinued_by_name: "Chủ BMQ",
    discontinued_at: "2026-11-01T10:00:00+07:00",
  });
});

test("parseDiscontinuedStockItems defaults the ON/OFF fields for older payloads", () => {
  const items = parseDiscontinuedStockItems([
    {
      item_id: "old-q7",
      pastry_q7: true,
      reason: null,
      discontinued_at: "2026-10-15T10:00:00+07:00",
    },
    {
      item_id: "old-tt",
      pastry_q7: false,
    },
  ]);
  assert.deepEqual(items[0], {
    item_id: "old-q7",
    item_code: null,
    name: "",
    unit: "",
    item_class: null,
    pastry_q7: true,
    tan_tao_qty: 0,
    q7_qty: 0,
    in_q7: true,
    used_7d: false,
    tan_tao_qty_at_stop: null,
    q7_qty_at_stop: null,
    reason: null,
    discontinued_by_name: null,
    discontinued_at: "2026-10-15T10:00:00+07:00",
  });
  assert.equal(items[1].in_q7, false);
  assert.equal(items[1].used_7d, false);
  assert.equal(items[1].tan_tao_qty_at_stop, null);
  assert.equal(items[1].q7_qty_at_stop, null);
});

test("parseDiscontinuedStockItems keeps explicit in_q7/used_7d and numeric strings", () => {
  const items = parseDiscontinuedStockItems([
    {
      item_id: "new",
      item_class: null,
      pastry_q7: false,
      tan_tao_qty: "3.5",
      q7_qty: "7",
      in_q7: true,
      used_7d: true,
      tan_tao_qty_at_stop: "3.5",
      q7_qty_at_stop: null,
    },
  ]);
  assert.equal(items[0].item_class, null);
  assert.equal(items[0].tan_tao_qty, 3.5);
  assert.equal(items[0].q7_qty, 7);
  assert.equal(items[0].in_q7, true);
  assert.equal(items[0].used_7d, true);
  assert.equal(items[0].tan_tao_qty_at_stop, 3.5);
  assert.equal(items[0].q7_qty_at_stop, null);
});

test("parseDiscontinuedStockItems is tolerant of a non-array payload", () => {
  assert.deepEqual(parseDiscontinuedStockItems(null), []);
  assert.deepEqual(parseDiscontinuedStockItems(undefined), []);
  assert.deepEqual(parseDiscontinuedStockItems({}), []);
  assert.deepEqual(parseDiscontinuedStockItems("nope"), []);
});

test("parseDiscontinuedStockItems skips malformed entries and missing ids", () => {
  const items = parseDiscontinuedStockItems([
    null,
    "x",
    { name: "no id" },
    { item_id: "keep-me", name: 123, unit: null, pastry_q7: "yes", reason: 7 },
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    item_id: "keep-me",
    item_code: null,
    name: "",
    unit: "",
    item_class: null,
    pastry_q7: false,
    tan_tao_qty: 0,
    q7_qty: 0,
    in_q7: false,
    used_7d: false,
    tan_tao_qty_at_stop: null,
    q7_qty_at_stop: null,
    reason: null,
    discontinued_by_name: null,
    discontinued_at: "",
  });
});

test("parseDiscontinuedStockItems keeps pastry_q7 only when literally true", () => {
  const items = parseDiscontinuedStockItems([
    { item_id: "a", pastry_q7: true },
    { item_id: "b", pastry_q7: 1 },
  ]);
  assert.equal(items[0].pastry_q7, true);
  assert.equal(items[1].pastry_q7, false);
});

test("discontinueErrorCode extracts the known codes from error messages", () => {
  assert.equal(discontinueErrorCode(new Error("item_has_stock")), "item_has_stock");
  assert.equal(
    discontinueErrorCode({ message: "item_in_open_count", code: "22023" }),
    "item_in_open_count",
  );
  assert.equal(discontinueErrorCode("item_merged"), "item_merged");
  assert.equal(
    discontinueErrorCode({ message: "insufficient_privilege" }),
    "insufficient_privilege",
  );
  assert.equal(discontinueErrorCode(new Error("item_not_found")), "item_not_found");
});

test("discontinueErrorCode falls back to unknown", () => {
  assert.equal(discontinueErrorCode(new Error("boom")), "unknown");
  assert.equal(discontinueErrorCode(null), "unknown");
  assert.equal(discontinueErrorCode(undefined), "unknown");
  assert.equal(discontinueErrorCode({ message: 42 }), "unknown");
});

test("discontinueErrorCode reads a Supabase-like error object", () => {
  const error = {
    message: "item_has_stock",
    code: "22023",
    details: '{"tan_tao":3,"q7":0}',
    hint: null,
  };
  assert.equal(discontinueErrorCode(error), "item_has_stock");
});

test("discontinueErrorText maps every known code and a safe default", () => {
  assert.equal(
    discontinueErrorText("item_has_stock"),
    "Món còn tồn — kiểm kê hoặc xuất hết trước khi ngưng",
  );
  assert.equal(
    discontinueErrorText("item_in_open_count"),
    "Món đã được đếm trong phiếu kiểm kê chưa chốt — chốt phiếu trước",
  );
  assert.equal(discontinueErrorText("item_merged"), "Món đã được gộp vào món khác");
  assert.equal(
    discontinueErrorText("insufficient_privilege"),
    "Bạn không có quyền ngưng món này",
  );
  assert.equal(discontinueErrorText("unknown"), "Chưa ngưng được món này");
  assert.equal(discontinueErrorText("something_else"), "Chưa ngưng được món này");
});
