import assert from "node:assert/strict";
import test from "node:test";

import {
  areSameSupplier,
  evaluatePaymentUncMatch,
  evaluateUncAllocations,
  isExactAmountMatch,
  normalizeUncReference,
  remainingAmount,
  sumRemainingAmounts,
  type UncAllocationInput,
  type UncPaymentRequestInput,
} from "./payment-unc-matching.ts";

const request = (overrides: Partial<UncPaymentRequestInput> = {}): UncPaymentRequestInput => ({
  id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
  supplierId: overrides.supplierId ?? "supplier-1",
  totalAmount: overrides.totalAmount ?? 1_000_000,
  allocatedAmount: overrides.allocatedAmount ?? 0,
  status: overrides.status ?? "pending",
  paymentStatus: overrides.paymentStatus ?? "unpaid",
  ...overrides,
});

test("normalizes UNC references like the SQL unique index", () => {
  assert.equal(normalizeUncReference(" ft26 001234 "), "FT26001234");
  assert.equal(normalizeUncReference("ft-26.001_234"), "FT26001234");
  assert.equal(normalizeUncReference(""), null);
  assert.equal(normalizeUncReference(null), null);
  assert.equal(normalizeUncReference("---"), null);
});

test("sums remaining amounts across partial allocations", () => {
  assert.equal(remainingAmount(request({ totalAmount: 1_000_000, allocatedAmount: 250_000 })), 750_000);
  assert.equal(
    sumRemainingAmounts([
      request({ totalAmount: 1_000_000, allocatedAmount: 250_000 }),
      request({ id: "22222222-2222-2222-2222-222222222222", totalAmount: 500_000 }),
    ]),
    1_250_000,
  );
});

test("requires one shared supplier, treating nulls as their own supplier", () => {
  assert.equal(areSameSupplier([request(), request({ id: "b" })]), true);
  assert.equal(areSameSupplier([request(), request({ id: "b", supplierId: null })]), false);
  assert.equal(areSameSupplier([request({ supplierId: null }), request({ id: "b", supplierId: null })]), true);
  assert.equal(areSameSupplier([]), false);
});

test("exact amount compare rejects rounding and off-by-one", () => {
  assert.equal(isExactAmountMatch(1_250_000, 1_250_000), true);
  assert.equal(isExactAmountMatch(1_250_000, 1_250_001), false);
  assert.equal(isExactAmountMatch(1_250_000.4, 1_250_000.4), true);
  assert.equal(isExactAmountMatch(1_250_000, null), false);
});

test("evaluate accepts an exact same-supplier pending set", () => {
  const result = evaluatePaymentUncMatch({
    requests: [request({ totalAmount: 1_000_000 }), request({ id: "b", totalAmount: 500_000 })],
    evidenceAmount: 1_500_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "ok");
  assert.equal(result.remainingTotal, 1_500_000);
  assert.equal(result.supplierId, "supplier-1");
});

test("evaluate blocks non-pending, mixed-supplier and mismatched amounts", () => {
  assert.equal(
    evaluatePaymentUncMatch({ requests: [], evidenceAmount: 1 }).code,
    "no_requests",
  );
  assert.equal(
    evaluatePaymentUncMatch({
      requests: [request({ status: "approved" })],
      evidenceAmount: 1_000_000,
    }).code,
    "not_pending",
  );
  assert.equal(
    evaluatePaymentUncMatch({
      requests: [request(), request({ id: "b", supplierId: "supplier-2" })],
      evidenceAmount: 2_000_000,
    }).code,
    "supplier_mismatch",
  );
  assert.equal(
    evaluatePaymentUncMatch({
      requests: [request()],
      evidenceAmount: 999_999,
    }).code,
    "amount_mismatch",
  );
});

test("manual override requires a reason and skips the exact-amount guard", () => {
  assert.equal(
    evaluatePaymentUncMatch({
      requests: [request()],
      evidenceAmount: 900_000,
      manualOverride: true,
      overrideReason: "",
    }).code,
    "override_reason_required",
  );
  const overridden = evaluatePaymentUncMatch({
    requests: [request()],
    evidenceAmount: 900_000,
    manualOverride: true,
    overrideReason: "Ngân hàng trừ phí chuyển tiền",
  });
  assert.equal(overridden.ok, true);
  assert.equal(overridden.remainingTotal, 1_000_000);
});

// ---------------------------------------------------------------------------
// Phase 2: multi-request allocations.
// ---------------------------------------------------------------------------

const allocation = (
  paymentRequestId: string,
  amount: number,
): UncAllocationInput => ({ paymentRequestId, amount });

test("allocations accept pending and approved-partial requests of one supplier", () => {
  const pending = request({ id: "a", totalAmount: 1_000_000, allocatedAmount: 0, status: "pending" });
  const approvedPartial = request({
    id: "b",
    totalAmount: 1_000_000,
    allocatedAmount: 400_000,
    status: "approved",
    paymentStatus: "partial",
  });
  const result = evaluateUncAllocations({
    requests: [pending, approvedPartial],
    allocations: [allocation("a", 600_000), allocation("b", 600_000)],
    evidenceAmount: 1_200_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "ok");
  assert.equal(result.allocatedTotal, 1_200_000);
  assert.equal(result.supplierId, "supplier-1");
});

test("allocations reject duplicates, unknown ids and missing rows", () => {
  const requests = [request({ id: "a" }), request({ id: "b", supplierId: "supplier-1" })];
  assert.equal(
    evaluateUncAllocations({
      requests,
      allocations: [allocation("a", 1_000_000), allocation("a", 1_000_000)],
      evidenceAmount: 2_000_000,
    }).code,
    "invalid_allocation",
  );
  assert.equal(
    evaluateUncAllocations({
      requests,
      allocations: [allocation("a", 1_000_000), allocation("c", 1_000_000)],
      evidenceAmount: 2_000_000,
    }).code,
    "invalid_allocation",
  );
  assert.equal(
    evaluateUncAllocations({
      requests,
      allocations: [allocation("a", 1_000_000)],
      evidenceAmount: 1_000_000,
    }).code,
    "invalid_allocation",
  );
  assert.equal(
    evaluateUncAllocations({
      requests,
      allocations: [allocation("a", 0), allocation("b", 2_000_000)],
      evidenceAmount: 2_000_000,
    }).code,
    "invalid_allocation",
  );
});

test("allocations reject over-remaining, non-pending and mixed suppliers", () => {
  assert.equal(
    evaluateUncAllocations({
      requests: [request({ id: "a", totalAmount: 1_000_000, allocatedAmount: 400_000 })],
      allocations: [allocation("a", 700_000)],
      evidenceAmount: 700_000,
    }).code,
    "allocation_exceeds_remaining",
  );
  assert.equal(
    evaluateUncAllocations({
      requests: [
        request({ id: "a", status: "rejected", paymentStatus: "unpaid" }),
      ],
      allocations: [allocation("a", 1_000_000)],
      evidenceAmount: 1_000_000,
    }).code,
    "not_pending",
  );
  assert.equal(
    evaluateUncAllocations({
      requests: [request({ id: "a", status: "approved", paymentStatus: "paid", allocatedAmount: 1_000_000 })],
      allocations: [allocation("a", 1_000_000)],
      evidenceAmount: 1_000_000,
    }).code,
    "not_pending",
  );
  assert.equal(
    evaluateUncAllocations({
      requests: [request({ id: "a" }), request({ id: "b", supplierId: "supplier-2" })],
      allocations: [allocation("a", 1_000_000), allocation("b", 1_000_000)],
      evidenceAmount: 2_000_000,
    }).code,
    "supplier_mismatch",
  );
});

test("allocations require the exact evidence sum unless overridden with a reason", () => {
  const requests = [request({ id: "a", totalAmount: 1_000_000 }), request({ id: "b", totalAmount: 1_000_000 })];
  assert.equal(
    evaluateUncAllocations({
      requests,
      allocations: [allocation("a", 600_000), allocation("b", 600_000)],
      evidenceAmount: 1_000_000,
    }).code,
    "amount_mismatch",
  );
  assert.equal(
    evaluateUncAllocations({
      requests,
      allocations: [allocation("a", 600_000), allocation("b", 300_000)],
      evidenceAmount: 1_000_000,
      manualOverride: true,
      overrideReason: "",
    }).code,
    "override_reason_required",
  );
  const overridden = evaluateUncAllocations({
    requests,
    allocations: [allocation("a", 600_000), allocation("b", 300_000)],
    evidenceAmount: 1_000_000,
    manualOverride: true,
    overrideReason: "Ngân hàng trừ phí chuyển tiền",
  });
  assert.equal(overridden.ok, true);
  assert.equal(overridden.allocatedTotal, 900_000);
});
