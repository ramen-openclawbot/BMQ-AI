import { test } from "node:test";
import assert from "node:assert/strict";

import { formatPeriodLike, stripPeriod } from "./expense-period.ts";

test("stripPeriod bỏ các dạng kỳ TCT hay dùng trong ghi chú chi", () => {
  assert.equal(stripPeriod("Điện Kho Tân Tạo T092026"), "Điện Kho Tân Tạo");
  assert.equal(stripPeriod("Chi phí T09/2026"), "Chi phí");
  assert.equal(stripPeriod("Thuê nhà Q.7 T10/2026"), "Thuê nhà Q.7");
  assert.equal(stripPeriod("Tiền MB Q.7 T7/26"), "Tiền MB Q.7");
  assert.equal(stripPeriod("Điện Bếp Q.7 T3.2026"), "Điện Bếp Q.7");
  assert.equal(stripPeriod("Điện T01.2026"), "Điện");
  assert.equal(stripPeriod("Chi phí 12/2025"), "Chi phí");
});

test("stripPeriod giữ nguyên ghi chú không có kỳ và gộp khoảng trắng", () => {
  assert.equal(stripPeriod("Chi phí sửa máy lạnh Q.7"), "Chi phí sửa máy lạnh Q.7");
  assert.equal(stripPeriod("  Chi phí\n  T09/2026  "), "Chi phí");
  assert.equal(stripPeriod(null), "");
  assert.equal(stripPeriod(undefined), "");
  assert.equal(stripPeriod(""), "");
});

test("formatPeriodLike giữ dấu phân cách và độ dài tháng/năm của mẫu", () => {
  assert.equal(formatPeriodLike("Chi phí T09/2026", 2026, 10), "Chi phí T10/2026");
  assert.equal(formatPeriodLike("Điện Kho Tân Tạo T092026", 2026, 10), "Điện Kho Tân Tạo T102026");
  assert.equal(formatPeriodLike("Tiền MB Q.7 T7/26", 2026, 3), "Tiền MB Q.7 T3/26");
  assert.equal(formatPeriodLike("Thuê nhà Q.7 T10/2026", 2027, 1), "Thuê nhà Q.7 T01/2027");
  assert.equal(formatPeriodLike("Điện Bếp Q.7 T3.2026", 2026, 11), "Điện Bếp Q.7 T11.2026");
});

test("formatPeriodLike có fallback và từ chối tháng không hợp lệ", () => {
  assert.equal(formatPeriodLike("Chi phí", 2026, 10), "T10/2026");
  assert.equal(formatPeriodLike(null, 2026, 9), "T09/2026");
  assert.equal(formatPeriodLike("Chi phí T09/2026", 2026, 13), "");
  assert.equal(formatPeriodLike("Chi phí T09/2026", 2026, 0), "");
});
