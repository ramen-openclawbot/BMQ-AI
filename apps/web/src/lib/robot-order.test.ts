// Offline tests for the robot-order client rules (node:test, no vitest, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  groupLinesBySupplier,
  MAX_DEBT_PICKS,
  packageSummary,
  priceInUnit,
  rankDebtRows,
  robotOrderErrorCode,
  robotOrderErrorText,
  sumDebtPicks,
  toggleDebtPick,
  type DebtPick,
  type RobotOrderLineInput,
  type SupplierDebtRow,
} from "./robot-order.ts";

function line(overrides: Partial<RobotOrderLineInput> & { supplier_id: string }): RobotOrderLineInput {
  return {
    product_name: "Bột mì",
    quantity: 1,
    unit: "kg",
    unit_price: 1000,
    ...overrides,
  };
}

function debt(overrides: Partial<SupplierDebtRow> & { id: string }): SupplierDebtRow {
  return {
    kind: "po",
    number: overrides.id,
    doc_date: "2026-01-01",
    amount: 1000,
    remaining: 1000,
    before_cutover: false,
    ...overrides,
  };
}

test("groupLinesBySupplier keeps the first-seen supplier order and the line order", () => {
  const groups = groupLinesBySupplier([
    line({ supplier_id: "s1", product_name: "A" }),
    line({ supplier_id: "s2", product_name: "B" }),
    line({ supplier_id: "s1", product_name: "C" }),
  ]);
  assert.deepEqual(groups.map((group) => group.supplier_id), ["s1", "s2"]);
  assert.deepEqual(groups[0].lines.map((entry) => entry.product_name), ["A", "C"]);
  assert.deepEqual(groups[1].lines.map((entry) => entry.product_name), ["B"]);
});

test("rankDebtRows moves before_cutover rows to the end and collapses them", () => {
  const rows = [
    debt({ id: "old", before_cutover: true, mark: "real_debt" }),
    debt({ id: "new1" }),
    debt({ id: "new2" }),
  ];
  const ranked = rankDebtRows(rows);
  assert.deepEqual(ranked.map((row) => row.id), ["new1", "new2", "old"]);
  assert.deepEqual(ranked.map((row) => row.collapsed), [false, false, true]);
});

test("rankDebtRows puts settled_outside after real_debt and unmarked in the same bucket", () => {
  const rows = [
    debt({ id: "settled-first", mark: "settled_outside" }),
    debt({ id: "unmarked" }),
    debt({ id: "real", mark: "real_debt" }),
    debt({ id: "settled-second", mark: "settled_outside", mark_source: "jev" }),
  ];
  const ranked = rankDebtRows(rows);
  assert.deepEqual(ranked.map((row) => row.id), [
    "unmarked",
    "real",
    "settled-first",
    "settled-second",
  ]);
});

test("rankDebtRows keeps the server farthest-first order inside a bucket", () => {
  const rows = [debt({ id: "a" }), debt({ id: "b" }), debt({ id: "c" })];
  assert.deepEqual(rankDebtRows(rows).map((row) => row.id), ["a", "b", "c"]);
});

test("rankDebtRows keeps the row's image fields", () => {
  const rows = [
    debt({ id: "with-photo", before_cutover: true, has_image: true, image_path: "pr/a.jpg", photo_count: 3 }),
    debt({ id: "plain", has_image: false, image_path: null, photo_count: 0 }),
  ];
  const ranked = rankDebtRows(rows);
  assert.deepEqual(ranked.map((row) => row.id), ["plain", "with-photo"]);
  assert.equal(ranked[0].has_image, false);
  assert.equal(ranked[0].image_path, null);
  assert.equal(ranked[0].photo_count, 0);
  assert.equal(ranked[1].has_image, true);
  assert.equal(ranked[1].image_path, "pr/a.jpg");
  assert.equal(ranked[1].photo_count, 3);
  assert.equal(ranked[1].collapsed, true);
});

test("packageSummary renders a short Vietnamese toast", () => {
  const summary = packageSummary({
    purchase_order_ids: ["po-1"],
    po_numbers: ["PO-0001"],
    debt: {
      kind: "po",
      id: "old-1",
      number: "PO-0000",
      submission_id: "sub-1",
      submission_number: "TC-261101-01",
    },
    marked_settled_outside_count: 2,
  });
  assert.match(summary, /Đã tạo 1 đơn nháp/);
  assert.match(summary, /PO-0001/);
  assert.match(summary, /PO-0000/);
  assert.match(summary, /TC-261101-01/);
  assert.match(summary, /2 khoản cũ/);
});

test("packageSummary stays readable without a debt", () => {
  const summary = packageSummary({
    purchase_order_ids: ["a", "b"],
    po_numbers: ["PO-1", "PO-2"],
    debt: null,
  });
  assert.equal(summary, "Đã tạo 2 đơn nháp (PO-1, PO-2)");
});

test("robotOrderErrorCode maps server error text to the known codes", () => {
  assert.equal(robotOrderErrorCode("debt_not_payable"), "debt_not_payable");
  assert.equal(
    robotOrderErrorCode({ message: 'Postgres error: one_supplier_per_package', code: "22023" }),
    "one_supplier_per_package",
  );
  assert.equal(robotOrderErrorCode({ message: "forbidden", code: "42501" }), "forbidden");
  assert.equal(robotOrderErrorCode("some other failure"), "unknown");
});

test("robotOrderErrorText returns a short Vietnamese message per code", () => {
  assert.match(robotOrderErrorText("debt_not_payable"), /không còn phù hợp/);
  assert.match(robotOrderErrorText("one_supplier_per_package"), /một nhà cung cấp/);
  assert.match(robotOrderErrorText("forbidden"), /không có quyền/);
  assert.match(robotOrderErrorText("nope"), /thử lại/);
});

test("priceInUnit restates the last price per the basket line's unit", () => {
  assert.equal(priceInUnit(90000, "kg", "g"), 90);
  assert.equal(priceInUnit(90, "g", "kg"), 90000);
  assert.equal(priceInUnit(30000, "lít", "ml"), 30);
  assert.equal(priceInUnit(12000, "Hộp", "hộp"), 12000);
  assert.equal(priceInUnit(12000, null, "g"), 12000);
  assert.equal(priceInUnit(500000, "thùng", "g"), null);
  assert.equal(priceInUnit(90000, "kg", "ml"), null);
  assert.equal(priceInUnit(null, "kg", "g"), null);
});

test("toggleDebtPick adds a new pick and keeps the pick order", () => {
  const first = toggleDebtPick([], { kind: "po", id: "a" });
  assert.deepEqual(first, [{ kind: "po", id: "a" }]);
  const second = toggleDebtPick(first, { kind: "pr", id: "b" });
  assert.deepEqual(second, [
    { kind: "po", id: "a" },
    { kind: "pr", id: "b" },
  ]);
  // The input array is not mutated.
  assert.deepEqual(first, [{ kind: "po", id: "a" }]);
});

test("toggleDebtPick removes an already-picked row by id", () => {
  const picks: DebtPick[] = [
    { kind: "po", id: "a" },
    { kind: "pr", id: "b" },
  ];
  assert.deepEqual(toggleDebtPick(picks, { kind: "po", id: "a" }), [
    { kind: "pr", id: "b" },
  ]);
  assert.deepEqual(toggleDebtPick(picks, { kind: "pr", id: "b" }), [
    { kind: "po", id: "a" },
  ]);
});

test("toggleDebtPick never exceeds MAX_DEBT_PICKS and never duplicates", () => {
  const full: DebtPick[] = Array.from(
    { length: MAX_DEBT_PICKS },
    (_, index): DebtPick => ({ kind: "po", id: `id-${index}` }),
  );
  assert.equal(full.length, 20);
  const capped = toggleDebtPick(full, { kind: "pr", id: "extra" });
  assert.equal(capped.length, MAX_DEBT_PICKS);
  assert.equal(capped.some((pick) => pick.id === "extra"), false);

  const withExisting = toggleDebtPick(full, { kind: "po", id: "id-3" });
  assert.equal(withExisting.length, MAX_DEBT_PICKS - 1);
  assert.equal(withExisting.some((pick) => pick.id === "id-3"), false);
});

test("sumDebtPicks sums the remaining of the picked rows only", () => {
  const rows = [
    debt({ id: "a", remaining: 1000 }),
    debt({ id: "b", remaining: 2500 }),
    debt({ id: "c", remaining: null }),
  ];
  assert.equal(sumDebtPicks(rows, [{ kind: "po", id: "a" }, { kind: "pr", id: "b" }]), 3500);
  assert.equal(sumDebtPicks(rows, [{ kind: "po", id: "a" }, { kind: "po", id: "c" }]), 1000);
  assert.equal(sumDebtPicks(rows, []), 0);
  assert.equal(sumDebtPicks([], [{ kind: "po", id: "a" }]), 0);
});
