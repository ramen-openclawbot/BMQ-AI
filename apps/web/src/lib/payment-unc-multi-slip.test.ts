import assert from "node:assert/strict";
import test from "node:test";

import { planUncSlipAllocations, type UncSlipInput } from "./payment-unc-multi-slip.ts";
import type { UncAllocationInput, UncPaymentRequestInput } from "./payment-unc-matching.ts";

const request = (overrides: Partial<UncPaymentRequestInput> = {}): UncPaymentRequestInput => ({
  id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
  supplierId: overrides.supplierId ?? "supplier-1",
  totalAmount: overrides.totalAmount ?? 1_000_000,
  allocatedAmount: overrides.allocatedAmount ?? 0,
  status: overrides.status ?? "pending",
  paymentStatus: overrides.paymentStatus ?? "unpaid",
  ...overrides,
});

const target = (paymentRequestId: string, amount: number): UncAllocationInput => ({
  paymentRequestId,
  amount,
});

const slip = (fileSha256: string, amount: number | null): UncSlipInput => ({ fileSha256, amount });

const sum = (allocations: UncAllocationInput[]) =>
  allocations.reduce((total, allocation) => total + allocation.amount, 0);

test("splits one request total across two slips", () => {
  const result = planUncSlipAllocations({
    requests: [request({ id: "a", totalAmount: 3_016_000 })],
    targets: [target("a", 3_016_000)],
    slips: [slip("sha-1", 2_000_000), slip("sha-2", 1_016_000)],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.slips.length, 2);
  assert.deepEqual(result.slips[0], {
    fileSha256: "sha-1",
    amount: 2_000_000,
    allocations: [{ paymentRequestId: "a", amount: 2_000_000 }],
  });
  assert.deepEqual(result.slips[1], {
    fileSha256: "sha-2",
    amount: 1_016_000,
    allocations: [{ paymentRequestId: "a", amount: 1_016_000 }],
  });
});

test("one slip can span two requests, oldest request first, and a request can take several slips", () => {
  const result = planUncSlipAllocations({
    // Targets are deliberately listed in the opposite order: the split must
    // follow the request order (oldest first), not the target array order.
    requests: [request({ id: "a", totalAmount: 1_000_000 }), request({ id: "b", totalAmount: 1_500_000 })],
    targets: [target("b", 1_500_000), target("a", 1_000_000)],
    slips: [slip("sha-1", 1_200_000), slip("sha-2", 1_300_000)],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.slips[0].allocations, [
    { paymentRequestId: "a", amount: 1_000_000 },
    { paymentRequestId: "b", amount: 200_000 },
  ]);
  assert.deepEqual(result.slips[1].allocations, [
    { paymentRequestId: "b", amount: 1_300_000 },
  ]);

  const byRequest = new Map<string, number>();
  for (const planned of result.slips) {
    for (const allocation of planned.allocations) {
      byRequest.set(
        allocation.paymentRequestId,
        (byRequest.get(allocation.paymentRequestId) ?? 0) + allocation.amount,
      );
    }
  }
  assert.equal(byRequest.get("a"), 1_000_000);
  assert.equal(byRequest.get("b"), 1_500_000);
});

test("rejects a slip total that does not match the target total", () => {
  const result = planUncSlipAllocations({
    requests: [request({ id: "a", totalAmount: 1_000_000 }), request({ id: "b", totalAmount: 1_500_000 })],
    targets: [target("a", 1_000_000), target("b", 1_500_000)],
    slips: [slip("sha-1", 1_000_000), slip("sha-2", 1_000_000)],
  });

  assert.deepEqual(result, { ok: false, code: "amount_mismatch" });
});

test("rejects two slips with the same file sha256", () => {
  const result = planUncSlipAllocations({
    requests: [request({ id: "a", totalAmount: 2_000_000 })],
    targets: [target("a", 2_000_000)],
    slips: [slip("sha-1", 1_000_000), slip("sha-1", 1_000_000)],
  });

  assert.deepEqual(result, { ok: false, code: "duplicate_slip" });
});

test("requires an amount on every slip", () => {
  const result = planUncSlipAllocations({
    requests: [request({ id: "a", totalAmount: 2_000_000 })],
    targets: [target("a", 2_000_000)],
    slips: [slip("sha-1", 1_000_000), slip("sha-2", null)],
  });

  assert.deepEqual(result, { ok: false, code: "slip_amount_required" });
});

test("rejects a target above the request remaining amount", () => {
  const result = planUncSlipAllocations({
    requests: [request({ id: "a", totalAmount: 1_000_000, allocatedAmount: 400_000 })],
    targets: [target("a", 700_000)],
    slips: [slip("sha-1", 700_000)],
  });

  assert.deepEqual(result, { ok: false, code: "allocation_exceeds_remaining" });
});

test("uses the remaining amount of a partially paid request", () => {
  const result = planUncSlipAllocations({
    requests: [request({ id: "a", totalAmount: 1_000_000, allocatedAmount: 400_000 })],
    targets: [target("a", 600_000)],
    slips: [slip("sha-1", 600_000)],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.slips[0].allocations, [{ paymentRequestId: "a", amount: 600_000 }]);
});

test("rounds lẻ xu to whole đồng while keeping each slip total exact", () => {
  const result = planUncSlipAllocations({
    requests: [
      request({ id: "a", totalAmount: 1_000_000.4 }),
      request({ id: "b", totalAmount: 500_000.4 }),
    ],
    targets: [target("a", 1_000_000.4), target("b", 500_000.4)],
    slips: [slip("sha-1", 999_999.6), slip("sha-2", 500_000.4)],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.slips.map((planned) => planned.amount), [1_000_000, 500_000]);
  for (const planned of result.slips) {
    assert.equal(sum(planned.allocations), planned.amount);
    assert.ok(planned.allocations.every((allocation) => Number.isInteger(allocation.amount) && allocation.amount > 0));
  }
});

test("rejects an empty slip list and non-positive targets", () => {
  assert.deepEqual(
    planUncSlipAllocations({ requests: [request()], targets: [target("a", 1_000_000)], slips: [] }),
    { ok: false, code: "no_slips" },
  );
  assert.deepEqual(
    planUncSlipAllocations({
      requests: [request({ id: "a" })],
      targets: [target("a", 0)],
      slips: [slip("sha-1", 1_000_000)],
    }),
    { ok: false, code: "invalid_allocation" },
  );
});

test("keeps the single-slip case as one allocation for the whole target", () => {
  const result = planUncSlipAllocations({
    requests: [request({ id: "a", totalAmount: 3_016_000 })],
    targets: [target("a", 3_016_000)],
    slips: [slip("sha-1", 3_016_000)],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.slips, [
    {
      fileSha256: "sha-1",
      amount: 3_016_000,
      allocations: [{ paymentRequestId: "a", amount: 3_016_000 }],
    },
  ]);
});
