import assert from "node:assert/strict";
import test from "node:test";

import {
  CASH_PR_METHOD_LOCKED_CODE,
  FINANCE_RECONCILIATION_ERROR_MESSAGES,
  FINANCE_RECONCILIATION_LABELS,
  FINANCE_RECONCILIATION_PRIORITY_ORDER,
  PR_REQUIRES_DELIVERY_IMAGE_CODE,
  cashPrMethodLockedRequestNumber,
  deliveryImageReceiptNumber,
  financeReconciliationErrorCode,
  financeReconciliationErrorFromRaw,
  financeReconciliationErrorMessage,
  financeReconciliationLabel,
  financeReconciliationPriority,
  groupFlags,
  purchasePatternEvidenceLines,
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
  assert.equal(financeReconciliationLabel("paid_without_receipt"), "Chi khi chưa nhập kho");
  assert.equal(
    financeReconciliationLabel("receipt_confirmed_delivery_pending"),
    "Đã nhập kho, phiếu ghi chưa giao",
  );
  assert.equal(financeReconciliationLabel("invoice_zero_amount"), "Hóa đơn 0 đ");
  assert.equal(financeReconciliationLabel("jev_possible_duplicate"), "Sushi nghi chi trùng");
  assert.equal(financeReconciliationLabel("price_above_usual"), "Giá cao hơn thường lệ");
  assert.equal(financeReconciliationLabel("quantity_above_usual"), "Số lượng cao bất thường");
  assert.equal(financeReconciliationLabel("ordered_before_cycle"), "Đặt sớm hơn chu kỳ");
  assert.equal(financeReconciliationLabel("new_supplier_for_item"), "NCC mới cho món này");
  assert.equal(Object.keys(FINANCE_RECONCILIATION_LABELS).length, 12);
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

test("maps the PO cancel receipt error code to a Vietnamese message", () => {
  const message = financeReconciliationErrorMessage("po_cancel_has_receipt");
  assert.ok(message, "missing message for po_cancel_has_receipt");
  assert.equal(message, FINANCE_RECONCILIATION_ERROR_MESSAGES.po_cancel_has_receipt);
  assert.ok(message!.includes("phiếu nhập"));
});

test("returns null for an unknown error code", () => {
  assert.equal(financeReconciliationErrorMessage("something_else"), null);
});

test("maps the Jev review RPC error codes to Vietnamese messages", () => {
  for (const code of ["not_owner", "invalid_decision", "check_not_found"]) {
    const message = financeReconciliationErrorMessage(code);
    assert.ok(message, `missing message for ${code}`);
    assert.equal(message, FINANCE_RECONCILIATION_ERROR_MESSAGES[code]);
  }
  assert.ok(financeReconciliationErrorMessage("check_not_found")!.includes("cặp phiếu"));
});

test("maps the delivery-image guard code and fills in the receipt number", () => {
  const code = PR_REQUIRES_DELIVERY_IMAGE_CODE;
  assert.equal(code, "pr_requires_delivery_image");
  assert.ok(FINANCE_RECONCILIATION_ERROR_MESSAGES[code].includes("ảnh phiếu giao hàng"));

  const message = financeReconciliationErrorMessage(code, "pr_requires_delivery_image: PN-000123");
  assert.ok(message, "missing message for the delivery-image code");
  assert.ok(message!.includes("PN-000123"));
  assert.ok(message!.includes("tải ảnh giao hàng rồi duyệt lại"));

  assert.equal(deliveryImageReceiptNumber("pr_requires_delivery_image: PN-000123"), "PN-000123");
  assert.equal(financeReconciliationErrorCode("pr_requires_delivery_image: PN-000123"), code);
  assert.equal(financeReconciliationErrorFromRaw("pr_requires_delivery_image: PN-000123"), message);
});

test("reads the delivery-image receipt number through a PostgREST prefix", () => {
  const raw = 'PostgrestError: pr_requires_delivery_image: "PN-000456"';
  assert.equal(deliveryImageReceiptNumber(raw), "PN-000456");
  assert.equal(financeReconciliationErrorCode(raw), PR_REQUIRES_DELIVERY_IMAGE_CODE);

  const message = financeReconciliationErrorFromRaw(raw);
  assert.ok(message, "missing message when PostgREST prefixes the error");
  assert.ok(message!.includes("PN-000456"));
  assert.ok(!message!.includes("PostgrestError"));
});

test("does not translate an unrecognised raw error", () => {
  assert.equal(financeReconciliationErrorFromRaw("some other failure"), null);
  assert.equal(financeReconciliationErrorFromRaw(""), null);
  assert.equal(deliveryImageReceiptNumber("some other failure"), null);
});

test("maps the cash-pr payment-method lock code and fills in the request number", () => {
  const code = CASH_PR_METHOD_LOCKED_CODE;
  assert.equal(code, "cash_pr_method_locked");
  assert.ok(FINANCE_RECONCILIATION_ERROR_MESSAGES[code].includes("Chi tiền mặt"));

  const message = financeReconciliationErrorMessage(code, "cash_pr_method_locked: PR-6C74C201");
  assert.ok(message, "missing message for the cash-pr payment-method code");
  assert.ok(message!.includes("PR-6C74C201"));
  assert.ok(message!.includes("không dùng UNC"));

  assert.equal(cashPrMethodLockedRequestNumber("cash_pr_method_locked: PR-6C74C201"), "PR-6C74C201");
  assert.equal(financeReconciliationErrorCode("cash_pr_method_locked: PR-6C74C201"), code);
  assert.equal(financeReconciliationErrorFromRaw("cash_pr_method_locked: PR-6C74C201"), message);
});

test("reads the cash-pr request number through a PostgREST prefix", () => {
  const raw = 'PostgrestError: cash_pr_method_locked: "PR-000789"';
  assert.equal(cashPrMethodLockedRequestNumber(raw), "PR-000789");
  assert.equal(financeReconciliationErrorCode(raw), CASH_PR_METHOD_LOCKED_CODE);

  const message = financeReconciliationErrorFromRaw(raw);
  assert.ok(message, "missing message when PostgREST prefixes the error");
  assert.ok(message!.includes("PR-000789"));
  assert.ok(!message!.includes("PostgrestError"));
});

test("formats price-pattern evidence with vi-VN numbers and a rounded percent", () => {
  const lines = purchasePatternEvidenceLines(
    flag({
      label: "price_above_usual",
      evidence: {
        request_number: "PR-0001",
        lines: [
          {
            product_name: "Dưa leo",
            unit: "kg",
            quantity: 20,
            unit_price: 20000,
            prior_count: 5,
            ratio: 1.33,
            usual_unit_price: 15000,
          },
        ],
      },
    }),
  );
  assert.deepEqual(lines, ["Dưa leo: 20.000/kg, thường 15.000 (+33%)"]);
});

test("rounds the price percentage to the nearest whole percent", () => {
  const lines = purchasePatternEvidenceLines(
    flag({
      label: "price_above_usual",
      evidence: {
        lines: [
          {
            product_name: "Dưa leo",
            unit: "kg",
            unit_price: 20000,
            usual_unit_price: 15000,
            ratio: 1.337,
          },
        ],
      },
    }),
  );
  assert.deepEqual(lines, ["Dưa leo: 20.000/kg, thường 15.000 (+34%)"]);
});

test("formats quantity-pattern evidence with a whole and a fractional ratio", () => {
  const whole = purchasePatternEvidenceLines(
    flag({
      label: "quantity_above_usual",
      evidence: {
        lines: [
          {
            product_name: "Trứng gà",
            unit: "quả",
            quantity: 900,
            usual_quantity: 300,
            ratio: 3,
          },
        ],
      },
    }),
  );
  assert.deepEqual(whole, ["Trứng gà: 900 quả, thường 300 (gấp 3)"]);

  const fractional = purchasePatternEvidenceLines(
    flag({
      label: "quantity_above_usual",
      evidence: {
        lines: [
          {
            product_name: "Trứng gà",
            unit: "quả",
            quantity: 750,
            usual_quantity: 300,
            ratio: 2.5,
          },
        ],
      },
    }),
  );
  assert.deepEqual(fractional, ["Trứng gà: 750 quả, thường 300 (gấp 2,5)"]);
});

test("formats cycle-pattern evidence in Vietnamese", () => {
  const lines = purchasePatternEvidenceLines(
    flag({
      label: "ordered_before_cycle",
      evidence: {
        lines: [
          {
            product_name: "Hành lá",
            days_since_last: 1,
            median_gap_days: 7,
          },
        ],
      },
    }),
  );
  assert.deepEqual(lines, ["Hành lá: đặt lại sau 1 ngày, thường 7 ngày/lần"]);
});

test("formats new-supplier evidence with the prior supplier names", () => {
  const lines = purchasePatternEvidenceLines(
    flag({
      label: "new_supplier_for_item",
      evidence: {
        lines: [
          {
            product_name: "Bánh mì que",
            usual_suppliers: ["Tuyết Anh", "Hasu Food"],
          },
        ],
      },
    }),
  );
  assert.deepEqual(lines, ["Bánh mì que: trước đây mua của Tuyết Anh, Hasu Food"]);
});

test("caps purchase-pattern evidence at three lines", () => {
  const entries = ["A", "B", "C", "D", "E"].map((name) => ({
    product_name: name,
    unit: "kg",
    unit_price: 20000,
    usual_unit_price: 15000,
    ratio: 1.33,
  }));
  const lines = purchasePatternEvidenceLines(
    flag({ label: "price_above_usual", evidence: { lines: entries } }),
  );
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((line) => line.split(":")[0]),
    ["A", "B", "C"],
  );
});

test("returns [] for malformed or missing purchase-pattern evidence", () => {
  const malformed: Array<Record<string, unknown> | null> = [
    null,
    {},
    { lines: "nope" },
    { lines: [] },
    { lines: [{ product_name: "Dưa leo" }] },
    { lines: [null, 42] },
  ];
  for (const evidence of malformed) {
    assert.deepEqual(
      purchasePatternEvidenceLines(flag({ label: "price_above_usual", evidence })),
      [],
    );
  }
  assert.deepEqual(
    purchasePatternEvidenceLines({ ...flag(), label: "price_above_usual", evidence: null }),
    [],
  );
  assert.deepEqual(
    purchasePatternEvidenceLines(null as unknown as FinanceReconciliationFlag),
    [],
  );
});

test("returns [] for a non purchase-pattern label", () => {
  const lines = purchasePatternEvidenceLines(
    flag({
      label: "po_overpaid",
      evidence: {
        lines: [
          {
            product_name: "Dưa leo",
            unit: "kg",
            unit_price: 20000,
            usual_unit_price: 15000,
          },
        ],
      },
    }),
  );
  assert.deepEqual(lines, []);
});
