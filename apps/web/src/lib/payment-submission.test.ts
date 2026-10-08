import assert from "node:assert/strict";
import test from "node:test";

import {
  clampPaymentSubmissionPageSize,
  foldVietnamese,
  formatPaymentSubmissionPreview,
  matchSupplierIdsByName,
  paymentSubmissionPageToRange,
  paymentSubmissionTotalPages,
  vietnamDateCutoff,
  type PaymentSubmissionPreviewItem,
} from "./payment-submission.ts";

test("clamps the page size to 1..50 with a default of 10", () => {
  assert.equal(clampPaymentSubmissionPageSize(10), 10);
  assert.equal(clampPaymentSubmissionPageSize(0), 1);
  assert.equal(clampPaymentSubmissionPageSize(-5), 1);
  assert.equal(clampPaymentSubmissionPageSize(999), 50);
  assert.equal(clampPaymentSubmissionPageSize(10.9), 10);
  assert.equal(clampPaymentSubmissionPageSize(Number.NaN), 10);
});

test("converts a 1-based page to a Supabase range", () => {
  assert.deepEqual(paymentSubmissionPageToRange(1, 10), { page: 1, pageSize: 10, from: 0, to: 9 });
  assert.deepEqual(paymentSubmissionPageToRange(3, 10), { page: 3, pageSize: 10, from: 20, to: 29 });
  assert.deepEqual(paymentSubmissionPageToRange(0, 10), { page: 1, pageSize: 10, from: 0, to: 9 });
  assert.deepEqual(paymentSubmissionPageToRange(2, 7), { page: 2, pageSize: 7, from: 7, to: 13 });
});

test("computes the exact total page count", () => {
  assert.equal(paymentSubmissionTotalPages(0, 10), 1);
  assert.equal(paymentSubmissionTotalPages(1, 10), 1);
  assert.equal(paymentSubmissionTotalPages(10, 10), 1);
  assert.equal(paymentSubmissionTotalPages(11, 10), 2);
  assert.equal(paymentSubmissionTotalPages(25, 10), 3);
});

test("computes the Vietnam-day cutoff regardless of host timezone", () => {
  // 05:00Z is 12:00 on 2026-10-07 in Vietnam.
  assert.equal(
    vietnamDateCutoff(0, new Date("2026-10-07T05:00:00.000Z")),
    "2026-10-07T00:00:00+07:00",
  );
  // 18:00Z on 2026-10-06 is already 2026-10-07 in Vietnam.
  assert.equal(
    vietnamDateCutoff(0, new Date("2026-10-06T18:00:00.000Z")),
    "2026-10-07T00:00:00+07:00",
  );
  // 90 Vietnam days before 2026-10-07 is 2026-07-09.
  assert.equal(
    vietnamDateCutoff(90, new Date("2026-10-07T05:00:00.000Z")),
    "2026-07-09T00:00:00+07:00",
  );
});

test("previews the Trình chi gấp Zalo message", () => {
  const item = (overrides: Partial<PaymentSubmissionPreviewItem> = {}): PaymentSubmissionPreviewItem => ({
    supplierName: overrides.supplierName ?? "Công ty TNHH Bột Mì Sài Gòn",
    requestNumber: overrides.requestNumber ?? "PC-20261006-0001",
    remainingAmount: overrides.remainingAmount ?? 41_006_300,
    ...overrides,
  });

  const message = formatPaymentSubmissionPreview({
    submissionNumber: "TC-261007-01",
    totalAmount: 41_006_300,
    note: "Gấp trước 3h chiều",
    items: [item()],
  });

  assert.match(message, /📋 TRÌNH CHI GẤP TC-261007-01/);
  assert.match(message, /1 phiếu · Tổng 41\.006\.300 đ/);
  assert.match(message, /• Công ty TNHH Bột Mì Sài Gòn – PC-20261006-0001: 41\.006\.300 đ/);
  assert.match(message, /Gấp trước 3h chiều/);
});

test("caps the preview at five lines and appends the overflow count", () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    supplierName: `NCC ${index + 1}`,
    requestNumber: `PC-20261006-000${index + 1}`,
    remainingAmount: 1_000_000 * (index + 1),
  }));

  const message = formatPaymentSubmissionPreview({
    submissionNumber: "TC-261007-02",
    totalAmount: 36_000_000,
    items,
  });

  assert.match(message, /8 phiếu · Tổng 36\.000\.000 đ/);
  assert.match(message, /• NCC 5 – PC-20261006-0005/);
  assert.doesNotMatch(message, /• NCC 6 –/);
  assert.match(message, /… và 3 phiếu khác/);
  assert.doesNotMatch(message, /Gấp trước/);
});

test("never leaks a bank account number or image payload", () => {
  const item = {
    supplierName: "NCC",
    requestNumber: "PC-1",
    remainingAmount: 1_000_000,
    beneficiaryAccount: "1234567890123",
    bankAccountNumber: "9704229200000000",
  } as unknown as PaymentSubmissionPreviewItem;
  const message = formatPaymentSubmissionPreview({
    submissionNumber: "TC-261007-03",
    totalAmount: 1_000_000,
    items: [item],
  });
  assert.doesNotMatch(message, /1234567890123/);
  assert.doesNotMatch(message, /9704229200000000/);
  assert.doesNotMatch(message, /data:image|base64|số tài khoản/i);
});

test("supplier search ignores Vietnamese accents and case", () => {
  assert.equal(foldVietnamese("  Bao bì  Minh Tuấn "), "bao bi minh tuan");
  assert.equal(foldVietnamese("Đại Phát"), "dai phat");
  const suppliers = [
    { id: "a", name: "Bao bì Minh Tuấn" },
    { id: "b", name: "Tuyết Anh" },
    { id: "c", name: "Thiên An Sinh" },
    { id: "d", name: null },
  ];
  assert.deepEqual(matchSupplierIdsByName(suppliers, "minh tuan"), ["a"]);
  assert.deepEqual(matchSupplierIdsByName(suppliers, "Minh Tuấn"), ["a"]);
  assert.deepEqual(matchSupplierIdsByName(suppliers, "TUYET"), ["b"]);
  assert.deepEqual(matchSupplierIdsByName(suppliers, "an"), ["a", "b", "c"]);
  assert.deepEqual(matchSupplierIdsByName(suppliers, "PR-951F"), []);
  assert.deepEqual(matchSupplierIdsByName(suppliers, "  "), []);
});
