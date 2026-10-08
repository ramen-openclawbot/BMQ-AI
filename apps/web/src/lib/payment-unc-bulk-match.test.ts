import assert from "node:assert/strict";
import test from "node:test";

import {
  matchUncBulk,
  namesMatch,
  normalizeCompanyName,
  type UncBulkPaymentRequest,
  type UncBulkRead,
} from "./payment-unc-bulk-match.ts";

const read = (overrides: Partial<UncBulkRead> = {}): UncBulkRead => ({
  fileSha256: overrides.fileSha256 ?? "sha-1",
  amount: overrides.amount === undefined ? 1_000_000 : overrides.amount,
  beneficiaryName: overrides.beneficiaryName ?? null,
  transferContent: overrides.transferContent ?? null,
  reference: overrides.reference ?? null,
  transferDate: overrides.transferDate ?? "2026-10-10",
  ...overrides,
});

const req = (overrides: Partial<UncBulkPaymentRequest> = {}): UncBulkPaymentRequest => ({
  id: overrides.id ?? "pr-1",
  requestNumber: overrides.requestNumber ?? "PR-AAAABBBB",
  supplierId: overrides.supplierId ?? "sup-1",
  supplierName: overrides.supplierName ?? "Công ty TNHH Thực phẩm ABC",
  bankAccountName: overrides.bankAccountName ?? null,
  remaining: overrides.remaining === undefined ? 1_000_000 : overrides.remaining,
  createdAt: overrides.createdAt ?? "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const allocationSum = (result: { allocations: { amount: number }[] }) =>
  result.allocations.reduce((sum, allocation) => sum + allocation.amount, 0);

test("matches by PR code written in the transfer content", () => {
  const [result] = matchUncBulk(
    [read({ amount: 1_500_000, transferContent: "Thanh toan PR-AAAABBBB" })],
    [req({ id: "pr-1", requestNumber: "PR-AAAABBBB", remaining: 1_500_000 })],
  );
  assert.equal(result.status, "matched");
  assert.deepEqual(result.allocations, [{ paymentRequestId: "pr-1", amount: 1_500_000 }]);
  assert.equal(allocationSum(result), 1_500_000);
});

test("finds PR codes regardless of case and separators", () => {
  const [result] = matchUncBulk(
    [read({ amount: 700_000, transferContent: "ck pr.aaaabbbb cho ncc" })],
    [req({ id: "pr-1", requestNumber: "PR-AAAABBBB", remaining: 700_000 })],
  );
  assert.equal(result.status, "matched");
  assert.equal(result.allocations[0].paymentRequestId, "pr-1");
});

test("matches by beneficiary name with accents", () => {
  const [result] = matchUncBulk(
    [read({ amount: 800_000, beneficiaryName: "Công ty TNHH Thực phẩm ABC" })],
    [req({ id: "pr-1", supplierName: "Công ty TNHH Thực Phẩm ABC", remaining: 800_000 })],
  );
  assert.equal(result.status, "matched");
  assert.equal(result.allocations[0].paymentRequestId, "pr-1");
});

test("matches by beneficiary name without accents", () => {
  const [result] = matchUncBulk(
    [read({ amount: 800_000, beneficiaryName: "Cong ty TNHH Thuc pham ABC" })],
    [req({ id: "pr-1", supplierName: "Công ty TNHH Thực phẩm ABC", remaining: 800_000 })],
  );
  assert.equal(result.status, "matched");
  assert.equal(result.allocations[0].paymentRequestId, "pr-1");
});

test("matches by the supplier bank account name", () => {
  const [result] = matchUncBulk(
    [read({ amount: 1_200_000, beneficiaryName: "NGUYEN VAN A" })],
    [req({ id: "pr-1", supplierName: "Công ty XYZ", bankAccountName: "Nguyen Van A", remaining: 1_200_000 })],
  );
  assert.equal(result.status, "matched");
  assert.equal(result.allocations[0].paymentRequestId, "pr-1");
});

test("one UNC pays several phiếu via two PR codes", () => {
  const [result] = matchUncBulk(
    [read({ amount: 2_000_000, transferContent: "PR-AAAABBBB va PR-CCCCDDDD" })],
    [
      req({ id: "pr-1", requestNumber: "PR-AAAABBBB", remaining: 800_000 }),
      req({ id: "pr-2", requestNumber: "PR-CCCCDDDD", remaining: 1_200_000 }),
    ],
  );
  assert.equal(result.status, "matched");
  assert.equal(result.allocations.length, 2);
  assert.equal(allocationSum(result), 2_000_000);
});

test("one UNC pays several phiếu via a same-supplier subset sum", () => {
  const [result] = matchUncBulk(
    [read({ amount: 2_000_000, beneficiaryName: "Công ty TNHH ABC" })],
    [
      req({ id: "pr-1", supplierName: "Công ty TNHH ABC", remaining: 800_000 }),
      req({ id: "pr-2", supplierName: "Công ty TNHH ABC", remaining: 1_200_000 }),
    ],
  );
  assert.equal(result.status, "matched");
  assert.equal(result.allocations.length, 2);
  assert.equal(allocationSum(result), 2_000_000);
});

test("three UNCs match three different suppliers independently", () => {
  const results = matchUncBulk(
    [
      read({ fileSha256: "sha-a", amount: 1_000_000, beneficiaryName: "Cong ty A" }),
      read({ fileSha256: "sha-b", amount: 2_000_000, beneficiaryName: "Cong ty B" }),
      read({ fileSha256: "sha-c", amount: 3_000_000, beneficiaryName: "Cong ty C" }),
    ],
    [
      req({ id: "pr-a", supplierId: "sup-a", supplierName: "Cong ty A", remaining: 1_000_000 }),
      req({ id: "pr-b", supplierId: "sup-b", supplierName: "Cong ty B", remaining: 2_000_000 }),
      req({ id: "pr-c", supplierId: "sup-c", supplierName: "Cong ty C", remaining: 3_000_000 }),
    ],
  );
  assert.deepEqual(results.map((result) => result.status), ["matched", "matched", "matched"]);
  assert.deepEqual(results.map((result) => result.allocations[0].paymentRequestId), ["pr-a", "pr-b", "pr-c"]);
});

test("equal amounts across two suppliers with no name are ambiguous", () => {
  const [result] = matchUncBulk(
    [read({ amount: 1_000_000 })],
    [
      req({ id: "pr-a", supplierId: "sup-a", remaining: 1_000_000 }),
      req({ id: "pr-b", supplierId: "sup-b", remaining: 1_000_000 }),
    ],
  );
  assert.equal(result.status, "ambiguous");
  assert.equal(result.options.length, 2);
  assert.equal(result.allocations.length, 0);
});

test("a mismatched amount is unmatched", () => {
  const [result] = matchUncBulk(
    [read({ amount: 999_999 })],
    [req({ id: "pr-1", remaining: 1_000_000 })],
  );
  assert.equal(result.status, "unmatched");
  assert.deepEqual(result.allocations, []);
});

test("a UNC with no OCR amount is unmatched", () => {
  const [result] = matchUncBulk(
    [read({ amount: null })],
    [req({ id: "pr-1", remaining: 1_000_000 })],
  );
  assert.equal(result.status, "unmatched");
  assert.match(result.reason, /số tiền/);
});

test("the same image hash is a duplicate", () => {
  const results = matchUncBulk(
    [
      read({ fileSha256: "sha-same", amount: 1_000_000 }),
      read({ fileSha256: "sha-same", amount: 1_000_000 }),
    ],
    [req({ id: "pr-1", remaining: 1_000_000 })],
  );
  assert.deepEqual(results.map((result) => result.status), ["duplicate", "duplicate"]);
  assert.deepEqual(results[0].allocations, []);
});

test("the same transaction reference across different images is a duplicate", () => {
  const results = matchUncBulk(
    [
      read({ fileSha256: "sha-1", reference: "FT26 001234" }),
      read({ fileSha256: "sha-2", reference: "ft-26.001_234" }),
    ],
    [req({ id: "pr-1", remaining: 1_000_000 })],
  );
  assert.deepEqual(results.map((result) => result.status), ["duplicate", "duplicate"]);
});

test("two UNCs matching the same phiếu become ambiguous", () => {
  const results = matchUncBulk(
    [
      read({ fileSha256: "sha-1", amount: 1_000_000 }),
      read({ fileSha256: "sha-2", amount: 1_000_000 }),
    ],
    [req({ id: "pr-1", remaining: 1_000_000 })],
  );
  assert.deepEqual(results.map((result) => result.status), ["ambiguous", "ambiguous"]);
  assert.deepEqual(results[0].allocations, []);
  assert.equal(results[0].options.length, 1);
});

test("a fully paid phiếu is excluded from matching", () => {
  const [result] = matchUncBulk(
    [read({ amount: 1_000_000 })],
    [
      req({ id: "pr-paid", remaining: 0 }),
      req({ id: "pr-open", remaining: 1_000_000 }),
    ],
  );
  assert.equal(result.status, "matched");
  assert.deepEqual(result.allocations, [{ paymentRequestId: "pr-open", amount: 1_000_000 }]);
});

test("a batch with only a fully paid phiếu stays unmatched", () => {
  const [result] = matchUncBulk(
    [read({ amount: 1_000_000 })],
    [req({ id: "pr-paid", remaining: 0 })],
  );
  assert.equal(result.status, "unmatched");
});

test("several same-supplier subsets summing to the amount is ambiguous", () => {
  const [result] = matchUncBulk(
    [read({ amount: 300_000, beneficiaryName: "Cong ty TNHH ABC" })],
    [
      req({ id: "pr-1", supplierName: "Cong ty TNHH ABC", remaining: 100_000 }),
      req({ id: "pr-2", supplierName: "Cong ty TNHH ABC", remaining: 200_000 }),
      req({ id: "pr-3", supplierName: "Cong ty TNHH ABC", remaining: 300_000 }),
    ],
  );
  assert.equal(result.status, "ambiguous");
  assert.equal(result.options.length >= 2, true);
});

test("company-form prefixes are ignored when matching names", () => {
  assert.equal(normalizeCompanyName("Công ty Cổ phần ABC"), "abc");
  assert.equal(namesMatch("CTCP ABC", "Công ty Cổ phần ABC"), true);
  const [result] = matchUncBulk(
    [read({ amount: 500_000, beneficiaryName: "CTCP ABC" })],
    [req({ id: "pr-1", supplierName: "Công ty Cổ phần ABC", remaining: 500_000 })],
  );
  assert.equal(result.status, "matched");
});

test("a PR code that does not sum to the amount falls through to the name rule", () => {
  const [result] = matchUncBulk(
    [
      read({
        amount: 2_000_000,
        transferContent: "PR-AAAABBBB",
        beneficiaryName: "Cong ty TNHH ABC",
      }),
    ],
    [
      req({ id: "pr-1", requestNumber: "PR-AAAABBBB", supplierName: "Cong ty TNHH ABC", remaining: 500_000 }),
      req({ id: "pr-2", requestNumber: "PR-CCCCDDDD", supplierName: "Cong ty TNHH ABC", remaining: 2_000_000 }),
    ],
  );
  assert.equal(result.status, "matched");
  assert.deepEqual(result.allocations, [{ paymentRequestId: "pr-2", amount: 2_000_000 }]);
});

test("every matched allocation set sums exactly to the UNC amount", () => {
  const readings = [
    read({ fileSha256: "sha-1", amount: 1_000_000, beneficiaryName: "Cong ty A" }),
    read({ fileSha256: "sha-2", amount: 3_000_000, transferContent: "PR-BBBBBBBB PR-CCCCCCCC" }),
  ];
  const requests = [
    req({ id: "pr-a", requestNumber: "PR-AAAAAAA1", supplierId: "sup-a", supplierName: "Cong ty A", remaining: 1_000_000 }),
    req({ id: "pr-b", requestNumber: "PR-BBBBBBBB", remaining: 1_500_000 }),
    req({ id: "pr-c", requestNumber: "PR-CCCCCCCC", remaining: 1_500_000 }),
  ];
  const amountBySha = new Map(readings.map((reading) => [reading.fileSha256, reading.amount]));
  const results = matchUncBulk(readings, requests);
  assert.deepEqual(results.map((result) => result.status), ["matched", "matched"]);
  for (const result of results) {
    assert.equal(allocationSum(result), amountBySha.get(result.fileSha256));
    assert.equal(allocationSum(result), result.options[0].total);
  }
});

test("PR codes of two different suppliers are never matched together", () => {
  const [result] = matchUncBulk(
    [read({ amount: 2_000_000, transferContent: "PR-AAAABBBB PR-CCCCDDDD" })],
    [
      req({ id: "pr-1", requestNumber: "PR-AAAABBBB", supplierId: "sup-a", remaining: 800_000 }),
      req({ id: "pr-2", requestNumber: "PR-CCCCDDDD", supplierId: "sup-b", remaining: 1_200_000 }),
    ],
  );
  assert.notEqual(result.status, "matched");
  assert.deepEqual(result.allocations, []);
});
