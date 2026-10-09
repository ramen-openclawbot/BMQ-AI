import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCandidatePairs,
  candidatePairKey,
  daysApart,
  isCandidatePair,
  selectCandidateBatch,
  type CandidateRequest,
  type CandidatePair,
} from "./candidates.ts";

function req(overrides: Partial<CandidateRequest> & { id: string }): CandidateRequest {
  return {
    request_number: `PR-${overrides.id}`,
    supplier_id: "sup-1",
    purchase_order_id: `po-${overrides.id}`,
    status: "pending",
    total_amount: 1_000_000,
    created_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

test("candidatePairKey is canonical regardless of argument order", () => {
  assert.equal(candidatePairKey("a", "b"), "a:b");
  assert.equal(candidatePairKey("b", "a"), "a:b");
  assert.equal(candidatePairKey("a", "a"), "a:a");
});

test("daysApart is whole days and NaN for an unparsable date", () => {
  assert.equal(daysApart("2026-10-01T00:00:00.000Z", "2026-10-06T00:00:00.000Z"), 5);
  assert.equal(daysApart("2026-10-06T12:00:00.000Z", "2026-10-01T00:00:00.000Z"), 5);
  assert.ok(Number.isNaN(daysApart("not-a-date", "2026-10-01T00:00:00.000Z")));
});

test("accepts the intended same-supplier different-PO near-duplicate pair", () => {
  const older = req({ id: "a", total_amount: 1_000_000, created_at: "2026-10-01T00:00:00.000Z" });
  const newer = req({ id: "b", total_amount: 1_040_000, created_at: "2026-10-10T00:00:00.000Z" });
  assert.equal(isCandidatePair(older, newer), true);
  const pair = buildCandidatePairs([older, newer])[0];
  assert.equal(pair.pair_key, "a:b");
  assert.equal(pair.pr_older, "a");
  assert.equal(pair.pr_newer, "b");
  assert.equal(pair.supplier_id, "sup-1");
  assert.equal(pair.days_apart, 9);
});

test("rejects pairs outside the candidate rules", () => {
  const base = req({ id: "a" });
  // same PO is not a duplicate across POs
  assert.equal(isCandidatePair(base, req({ id: "b", purchase_order_id: "po-a" })), false);
  // null supplier never pairs
  assert.equal(isCandidatePair(req({ id: "a", supplier_id: null }), req({ id: "b", supplier_id: null })), false);
  // a rejected phiếu is skipped
  assert.equal(isCandidatePair(base, req({ id: "b", status: "rejected" })), false);
  // non-positive totals are skipped
  assert.equal(isCandidatePair(req({ id: "a", total_amount: 0 }), req({ id: "b", total_amount: 0 })), false);
  // more than 5% of the larger amount apart
  assert.equal(isCandidatePair(base, req({ id: "b", total_amount: 1_060_000 })), false);
  // more than 45 days apart
  assert.equal(isCandidatePair(base, req({ id: "b", created_at: "2026-11-20T00:00:00.000Z" })), false);
  // a null PO on one side still counts as a different PO
  assert.equal(isCandidatePair(base, req({ id: "b", purchase_order_id: null })), true);
  // the same id is never a pair
  assert.equal(isCandidatePair(base, req({ id: "a" })), false);
});

test("orders same-amount pairs first, then closer dates, then the newer phiếu", () => {
  const requests = [
    req({ id: "a", total_amount: 1_000_000, created_at: "2026-10-01T00:00:00.000Z" }),
    req({ id: "b", total_amount: 1_000_000, created_at: "2026-10-20T00:00:00.000Z" }),
    req({ id: "c", total_amount: 1_050_000, created_at: "2026-10-02T00:00:00.000Z" }),
  ];
  const pairs = buildCandidatePairs(requests);
  // a:b (same amount, 19 days) sorts before a:c (5% apart, 1 day) because the
  // amount match wins over the closer date.
  assert.equal(pairs[0].pair_key, "a:b");
  assert.equal(pairs.find((pair) => pair.pair_key === "a:c")?.days_apart, 1);
});

test("selectCandidateBatch skips unchanged state hashes, filters pair_keys and cuts to the limit", async () => {
  const requests = [
    req({ id: "a", total_amount: 1_000_000, created_at: "2026-10-01T00:00:00.000Z" }),
    req({ id: "b", total_amount: 1_000_000, created_at: "2026-10-05T00:00:00.000Z" }),
    req({ id: "c", total_amount: 1_000_000, created_at: "2026-10-09T00:00:00.000Z" }),
  ];
  const hashOf = (_pair: CandidatePair) => "hash-unchanged";
  const selection = await selectCandidateBatch(requests, {
    limit: 1,
    existing: [{ pair_key: "a:b", state_hash: "hash-unchanged" }],
    stateHashOf: hashOf,
  });
  // a:b unchanged -> skipped; b:c and a:c remain, limit keeps one.
  assert.equal(selection.candidates, 3);
  assert.equal(selection.skipped_unchanged, 1);
  assert.equal(selection.pairs.length, 1);
  assert.notEqual(selection.pairs[0].pair_key, "a:b");

  const filtered = await selectCandidateBatch(requests, {
    limit: 50,
    existing: [],
    stateHashOf: hashOf,
    pairKeys: new Set(["b:c"]),
  });
  assert.deepEqual(filtered.pairs.map((pair) => pair.pair_key), ["b:c"]);
  assert.equal(filtered.candidates, 1);
});

test("a stale state hash re-checks the pair", async () => {
  const requests = [
    req({ id: "a", created_at: "2026-10-01T00:00:00.000Z" }),
    req({ id: "b", created_at: "2026-10-02T00:00:00.000Z" }),
  ];
  const selection = await selectCandidateBatch(requests, {
    limit: 50,
    existing: [{ pair_key: "a:b", state_hash: "old" }],
    stateHashOf: () => "new",
  });
  assert.equal(selection.skipped_unchanged, 0);
  assert.equal(selection.pairs.length, 1);
});
