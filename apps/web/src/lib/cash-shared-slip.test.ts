import assert from "node:assert/strict";
import test from "node:test";

import {
  planSharedSlipAllocations,
  suggestSharedSlipRequests,
  type SharedSlipCandidate,
} from "./cash-shared-slip.ts";

const candidate = (overrides: Partial<SharedSlipCandidate> = {}): SharedSlipCandidate => ({
  requestId: overrides.requestId ?? "request-1",
  requestNumber: overrides.requestNumber ?? "PR-1",
  isCurrent: overrides.isCurrent ?? false,
  remainingTotal: overrides.remainingTotal ?? 0,
  items: overrides.items ?? [],
});

/** The 3-phiếu acceptance example: 2.560.000 + 4.373.000 + 4.200.000. */
const threeRequests = (): SharedSlipCandidate[] => [
  candidate({
    requestId: "pr-1",
    requestNumber: "PR-A",
    isCurrent: true,
    remainingTotal: 2_560_000,
    items: [{ id: "item-1", remaining: 2_560_000 }],
  }),
  candidate({
    requestId: "pr-2",
    requestNumber: "PR-B",
    remainingTotal: 4_373_000,
    items: [
      { id: "item-2a", remaining: 3_000_000 },
      { id: "item-2b", remaining: 1_373_000 },
    ],
  }),
  candidate({
    requestId: "pr-3",
    requestNumber: "PR-C",
    remainingTotal: 4_200_000,
    items: [{ id: "item-3", remaining: 4_200_000 }],
  }),
];

const allocationTotal = (allocations: { amount: number }[]): number =>
  allocations.reduce((sum, allocation) => sum + allocation.amount, 0);

test("11.133.000 slip selects all 3 phiếu and splits every item", () => {
  const candidates = threeRequests();
  const suggestion = suggestSharedSlipRequests(11_133_000, candidates);

  assert.deepEqual(suggestion, {
    requestIds: ["pr-1", "pr-2", "pr-3"],
    exact: true,
  });

  const plan = planSharedSlipAllocations(11_133_000, candidates, suggestion.requestIds);
  if (!plan.ok) throw new Error("expected an exact plan, but it was rejected");
  assert.deepEqual(plan.allocations, [
    { request_id: "pr-1", item_id: "item-1", amount: 2_560_000 },
    { request_id: "pr-2", item_id: "item-2a", amount: 3_000_000 },
    { request_id: "pr-2", item_id: "item-2b", amount: 1_373_000 },
    { request_id: "pr-3", item_id: "item-3", amount: 4_200_000 },
  ]);
  assert.equal(allocationTotal(plan.allocations), 11_133_000);
});

test("a slip equal to 2 phiếu selects the fewest phiếu, oldest first", () => {
  const suggestion = suggestSharedSlipRequests(6_933_000, threeRequests());
  assert.deepEqual(suggestion, { requestIds: ["pr-1", "pr-2"], exact: true });

  const plan = planSharedSlipAllocations(6_933_000, threeRequests(), suggestion.requestIds);
  if (!plan.ok) throw new Error("expected an exact plan, but it was rejected");
  assert.equal(allocationTotal(plan.allocations), 6_933_000);
  assert.equal(plan.allocations.some((allocation) => allocation.request_id === "pr-3"), false);
});

test("no combination matches the slip: current only, exact false, plan diff", () => {
  const suggestion = suggestSharedSlipRequests(9_999_999, threeRequests());
  assert.deepEqual(suggestion, { requestIds: ["pr-1"], exact: false });

  const plan = planSharedSlipAllocations(9_999_999, threeRequests(), suggestion.requestIds);
  assert.equal(plan.ok, false);
  if (!plan.ok && plan.code === "total_mismatch") {
    assert.equal(plan.diff, 9_999_999 - 2_560_000);
  } else {
    throw new Error(`expected total_mismatch, got ${plan.ok ? "ok" : plan.code}`);
  }
});

test("a partially covered item only proposes its remaining", () => {
  const candidates: SharedSlipCandidate[] = [
    candidate({
      requestId: "pr-1",
      isCurrent: true,
      remainingTotal: 560_000,
      items: [{ id: "item-1", remaining: 560_000 }],
    }),
    candidate({
      requestId: "pr-2",
      remainingTotal: 4_373_000,
      items: [{ id: "item-2", remaining: 4_373_000 }],
    }),
  ];

  const suggestion = suggestSharedSlipRequests(4_933_000, candidates);
  assert.deepEqual(suggestion, { requestIds: ["pr-1", "pr-2"], exact: true });

  const plan = planSharedSlipAllocations(4_933_000, candidates, suggestion.requestIds);
  if (!plan.ok) throw new Error("expected an exact plan, but it was rejected");
  assert.deepEqual(plan.allocations[0], { request_id: "pr-1", item_id: "item-1", amount: 560_000 });
  assert.equal(allocationTotal(plan.allocations), 4_933_000);
});

test("rounds to whole đồng like the server", () => {
  const candidates: SharedSlipCandidate[] = [
    candidate({
      requestId: "pr-1",
      isCurrent: true,
      remainingTotal: 2_560_000.4,
      items: [{ id: "item-1", remaining: 2_560_000.4 }],
    }),
    candidate({
      requestId: "pr-2",
      remainingTotal: 4_373_000.4,
      items: [{ id: "item-2", remaining: 4_373_000.4 }],
    }),
  ];

  // 2.560.000,4 + 4.373.000,4 = 6.933.000,8 -> whole đồng 6.933.001.
  const suggestion = suggestSharedSlipRequests(6_933_001, candidates);
  assert.deepEqual(suggestion, { requestIds: ["pr-1", "pr-2"], exact: true });

  const plan = planSharedSlipAllocations(6_933_001, candidates, suggestion.requestIds);
  if (!plan.ok) throw new Error("expected an exact plan, but it was rejected");
  assert.deepEqual(plan.allocations, [
    { request_id: "pr-1", item_id: "item-1", amount: 2_560_000.4 },
    { request_id: "pr-2", item_id: "item-2", amount: 4_373_000.4 },
  ]);
  assert.equal(Math.round(allocationTotal(plan.allocations)), 6_933_001);
});

test("uses at most 10 phiếu even when more candidates exist", () => {
  const candidates: SharedSlipCandidate[] = [
    candidate({
      requestId: "current",
      isCurrent: true,
      remainingTotal: 1_000_000,
      items: [{ id: "item-current", remaining: 1_000_000 }],
    }),
    ...Array.from({ length: 10 }, (_, index) =>
      candidate({
        requestId: `extra-${index + 1}`,
        remainingTotal: 1_000_000,
        items: [{ id: `item-extra-${index + 1}`, remaining: 1_000_000 }],
      }),
    ),
  ];

  const exact = suggestSharedSlipRequests(10_000_000, candidates);
  assert.equal(exact.exact, true);
  assert.equal(exact.requestIds.length, 10);
  assert.ok(exact.requestIds.includes("current"));

  // 11.000.000 would need all 11 phiếu, above the 10-phiếu cap.
  const overCap = suggestSharedSlipRequests(11_000_000, candidates);
  assert.deepEqual(overCap, { requestIds: ["current"], exact: false });
});

test("requires the current phiếu in the selected set", () => {
  const plan = planSharedSlipAllocations(4_373_000, threeRequests(), ["pr-2"]);
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.equal(plan.code, "current_required");
});

test("finds an 8-extra combination among 29 candidates without a node cap", () => {
  const extras: SharedSlipCandidate[] = Array.from({ length: 29 }, (_, index) =>
    candidate({
      requestId: `extra-${index + 1}`,
      remainingTotal: 100_000 + index * 1_000,
      items: [{ id: `item-extra-${index + 1}`, remaining: 100_000 + index * 1_000 }],
    }),
  );
  const candidates: SharedSlipCandidate[] = [
    candidate({
      requestId: "current",
      isCurrent: true,
      remainingTotal: 1_000_000,
      items: [{ id: "item-current", remaining: 1_000_000 }],
    }),
    ...extras,
  ];

  // Current + the largest 8 extras: 1.000.000 + (121.000..128.000) = 1.996.000.
  // Any 7 extras top out at 1.875.000, so the minimal answer needs 8 extras.
  const suggestion = suggestSharedSlipRequests(1_996_000, candidates);
  assert.equal(suggestion.exact, true);
  assert.equal(suggestion.requestIds.length, 9);
  assert.ok(suggestion.requestIds.includes("current"));
  const selectedTotal = candidates
    .filter((entry) => suggestion.requestIds.includes(entry.requestId))
    .reduce((sum, entry) => sum + Math.round(entry.remainingTotal), 0);
  assert.equal(selectedTotal, 1_996_000);
});

test("planner rejects more than 10 phiếu", () => {
  const candidates: SharedSlipCandidate[] = Array.from({ length: 11 }, (_, index) =>
    candidate({
      requestId: `pr-${index}`,
      isCurrent: index === 0,
      remainingTotal: 1_000_000,
      items: [{ id: `item-${index}`, remaining: 1_000_000 }],
    }),
  );

  const plan = planSharedSlipAllocations(
    11_000_000,
    candidates,
    candidates.map((entry) => entry.requestId),
  );
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.equal(plan.code, "too_many_requests");
});

test("planner rejects more than 100 allocations", () => {
  const items = Array.from({ length: 101 }, (_, index) => ({
    id: `item-${index}`,
    remaining: 1_000,
  }));
  const candidates: SharedSlipCandidate[] = [
    candidate({ requestId: "pr-1", isCurrent: true, remainingTotal: 101_000, items }),
  ];

  const plan = planSharedSlipAllocations(101_000, candidates, ["pr-1"]);
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.equal(plan.code, "too_many_allocations");
});

test("suggestion never proposes more than 100 open items", () => {
  const candidates: SharedSlipCandidate[] = [
    candidate({
      requestId: "pr-1",
      isCurrent: true,
      remainingTotal: 100_000,
      items: [{ id: "item-current", remaining: 100_000 }],
    }),
    candidate({
      requestId: "pr-2",
      remainingTotal: 100_000,
      items: Array.from({ length: 100 }, (_, index) => ({
        id: `item-extra-${index}`,
        remaining: 1_000,
      })),
    }),
  ];

  // 1 + 100 open items > 100, so the otherwise exact 200.000 slip is not proposed.
  const suggestion = suggestSharedSlipRequests(200_000, candidates);
  assert.deepEqual(suggestion, { requestIds: ["pr-1"], exact: false });

  const plan = planSharedSlipAllocations(200_000, candidates, ["pr-1", "pr-2"]);
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.equal(plan.code, "too_many_allocations");
});
