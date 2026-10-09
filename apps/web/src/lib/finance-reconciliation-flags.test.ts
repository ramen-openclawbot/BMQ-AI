import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCE_RECONCILIATION_ERROR_MESSAGES,
  FINANCE_RECONCILIATION_LABELS,
  FINANCE_RECONCILIATION_PRIORITY_ORDER,
  financeReconciliationErrorMessage,
  financeReconciliationLabel,
  financeReconciliationPriority,
  groupFlags,
  sortFlags,
  type FinanceReconciliationFlag,
} from "./finance-reconciliation-flags.ts";

const flag = (overrides: Partial<FinanceReconciliationFlag> = {}): FinanceReconciliationFlag => ({
  flag_key: overrides.flag_key ?? "po_overpaid:po-1",
  label: overrides.label ?? "po_overpaid",
  priority: overrides.priority ?? "critical",
  category: overrides.category ?? "finance",
  entity_type: overrides.entity_type ?? "purchase_order",
  entity_id: overrides.entity_id ?? "po-1",
  entity_ref: overrides.entity_ref ?? "PO-000340",
  supplier_id: overrides.supplier_id ?? "sup-1",
  supplier_name: overrides.supplier_name ?? "Nhà cung cấp A",
  group_key: overrides.group_key ?? "po:po-1",
  amount: overrides.amount === undefined ? 1000 : overrides.amount,
  evidence: overrides.evidence ?? {},
  detected_at: overrides.detected_at ?? "2026-10-10T00:00:00.000Z",
  review_status: overrides.review_status ?? null,
  review_note: overrides.review_note ?? null,
  ...overrides,
});

test("names every fixed label in short Vietnamese", () => {
  assert.equal(financeReconciliationLabel("po_overpaid"), "Chi vượt PO");
  assert.equal(financeReconciliationLabel("po_over_requested"), "Đề nghị vượt PO");
  assert.equal(financeReconciliationLabel("pr_twin_created"), "Phiếu tạo trùng");
  assert.equal(financeReconciliationLabel("paid_without_bank_evidence"), "Chi không có UNC");
  assert.equal(financeReconciliationLabel("paid_without_receipt"), "Chi chưa nhập kho");
  assert.equal(
    financeReconciliationLabel("receipt_confirmed_delivery_pending"),
    "Đã nhập kho, phiếu ghi chưa giao",
  );
  assert.equal(financeReconciliationLabel("invoice_zero_amount"), "Hóa đơn 0 đ");
  assert.equal(Object.keys(FINANCE_RECONCILIATION_LABELS).length, 7);
});

test("falls back to the raw label when there is no Vietnamese name", () => {
  assert.equal(financeReconciliationLabel("some_future_flag"), "some_future_flag");
});

test("sorts critical before high, medium and low", () => {
  const sorted = sortFlags([
    flag({ flag_key: "low", priority: "low" }),
    flag({ flag_key: "high", priority: "high" }),
    flag({ flag_key: "critical", priority: "critical" }),
    flag({ flag_key: "medium", priority: "medium" }),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.priority),
    ["critical", "high", "medium", "low"],
  );
  assert.equal(financeReconciliationPriority("critical"), 0);
  assert.ok(FINANCE_RECONCILIATION_PRIORITY_ORDER.high < FINANCE_RECONCILIATION_PRIORITY_ORDER.low);
});

test("sorts larger amounts first within the same priority", () => {
  const sorted = sortFlags([
    flag({ flag_key: "a", priority: "high", amount: 100 }),
    flag({ flag_key: "b", priority: "high", amount: 5_000_000 }),
    flag({ flag_key: "c", priority: "high", amount: 250_000 }),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.flag_key),
    ["b", "c", "a"],
  );
});

test("treats a missing amount as zero and orders ties by flag_key", () => {
  const sorted = sortFlags([
    flag({ flag_key: "z", priority: "medium", amount: null }),
    flag({ flag_key: "a", priority: "medium", amount: null }),
    flag({ flag_key: "m", priority: "medium", amount: 10 }),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.flag_key),
    ["m", "a", "z"],
  );
});

test("sortFlags never mutates the caller array", () => {
  const input = [flag({ flag_key: "late", priority: "low" }), flag({ flag_key: "early", priority: "critical" })];
  const before = input.map((item) => item.flag_key);
  sortFlags(input);
  assert.deepEqual(input.map((item) => item.flag_key), before);
});

test("groups flags by group_key", () => {
  const groups = groupFlags([
    flag({ flag_key: "a", group_key: "po:po-1" }),
    flag({ flag_key: "b", group_key: "po:po-1" }),
    flag({ flag_key: "c", group_key: "supplier:sup-2" }),
  ]);
  assert.deepEqual(Object.keys(groups).sort(), ["po:po-1", "supplier:sup-2"]);
  assert.equal(groups["po:po-1"].length, 2);
  assert.equal(groups["supplier:sup-2"][0].flag_key, "c");
});

test("groups an empty group_key under its entity", () => {
  const groups = groupFlags([flag({ flag_key: "a", group_key: "", entity_id: "pr-9" })]);
  assert.deepEqual(Object.keys(groups), ["entity:pr-9"]);
});

test("maps the three new blocking error codes to Vietnamese messages", () => {
  for (const code of ["po_overpaid", "po_over_requested", "goods_receipt_already_requested"]) {
    const message = financeReconciliationErrorMessage(code);
    assert.ok(message, `missing message for ${code}`);
    assert.equal(message, FINANCE_RECONCILIATION_ERROR_MESSAGES[code]);
    assert.equal(typeof message, "string");
  }
  assert.ok(financeReconciliationErrorMessage("po_overpaid")!.includes("vượt"));
  assert.ok(financeReconciliationErrorMessage("goods_receipt_already_requested")!.includes("phiếu đề nghị chi"));
});

test("returns null for an unknown error code", () => {
  assert.equal(financeReconciliationErrorMessage("something_else"), null);
});
