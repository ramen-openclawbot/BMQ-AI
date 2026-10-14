// Offline tests for the debt_review mode: skips learned / manual rows, writes
// Jev marks through the service RPC, stops cleanly when the shared daily Jev
// quota runs out, and validates the strict Jev answer shape.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDebtJevState,
  createDebtReviewStore,
  runDebtReview,
  validateDebtJevResponse,
  DEBT_MARK_OPTIONS,
  type DebtJevEvaluation,
  type DebtReviewDeps,
  type DebtReviewRpcClient,
  type SupplierDebtCandidateRow,
  type SupplierDebtCandidates,
} from "./debt-review.ts";

function row(overrides: Partial<SupplierDebtCandidateRow> & { id: string }): SupplierDebtCandidateRow {
  return {
    kind: "po",
    id: overrides.id,
    number: overrides.number ?? "PO-TEST",
    doc_date: overrides.doc_date ?? "2026-01-01",
    amount: overrides.amount ?? 1000,
    remaining: overrides.remaining ?? 1000,
    age_days: overrides.age_days ?? 30,
    has_receipt: overrides.has_receipt ?? false,
    mark: overrides.mark ?? null,
    mark_source: overrides.mark_source ?? null,
    probability: overrides.probability ?? null,
    before_cutover: overrides.before_cutover ?? false,
    last_submission_number: overrides.last_submission_number ?? null,
    ...overrides,
  };
}

function candidates(rows: SupplierDebtCandidateRow[]): SupplierDebtCandidates {
  return {
    supplier_id: "11111111-1111-1111-1111-111111111111",
    cutover: null,
    stats: { paid_90d: 2, median_lag_days: 5, last_paid_date: "2026-02-01" },
    rows,
  };
}

function fakeEvaluator(result: DebtJevEvaluation) {
  return () => async () => result;
}

function baseDeps(overrides: Partial<DebtReviewDeps> = {}): {
  deps: DebtReviewDeps;
  written: { supplierId: string; rows: { kind: string; id: string; mark: string; probability: number }[] }[];
  usage: { calls: number; cost: number };
} {
  const written: { supplierId: string; rows: { kind: string; id: string; mark: string; probability: number }[] }[] = [];
  const usage = { calls: 0, cost: 0 };
  const deps: DebtReviewDeps = {
    evaluator: fakeEvaluator({ mark: "settled_outside", probability: 0.9, usage: { input: 1, output: 1 }, cost: 0.01 }),
    getCandidates: async () => candidates([]),
    writeMarks: async (supplierId, rows) => { written.push({ supplierId, rows }); },
    incrementUsage: async (_date, calls, cost) => { usage.calls += calls; usage.cost += cost; },
    ...overrides,
  };
  return { deps, written, usage };
}

test("skips rows that already carry a learned or manual mark", async () => {
  const rows = [
    row({ id: "a", mark: "settled_outside", mark_source: "learned" }),
    row({ id: "b", mark: "real_debt", mark_source: "manual" }),
    row({ id: "c", kind: "pr", mark: "real_debt", mark_source: "jev" }),
    row({ id: "d" }),
  ];
  const { deps, written } = baseDeps({ getCandidates: async () => candidates(rows) });

  const result = await runDebtReview(deps, "sup-1", {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
    usageDate: "2026-11-01",
    remainingQuota: 100,
  });

  assert.equal(result.evaluated, 2);
  assert.equal(result.marked, 2);
  assert.equal(result.stopped, null);
  assert.equal(written.length, 1);
  assert.deepEqual(written[0].rows.map((r) => r.id).sort(), ["c", "d"]);
});

test("writes the Jev mark with its probability for each evaluated row", async () => {
  const rows = [row({ id: "a", kind: "pr" }), row({ id: "b", kind: "po" })];
  const { deps, written } = baseDeps({ getCandidates: async () => candidates(rows) });

  const result = await runDebtReview(deps, "sup-1", {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
    usageDate: "2026-11-01",
    remainingQuota: 100,
  });

  assert.equal(result.evaluated, 2);
  assert.equal(result.marked, 2);
  assert.deepEqual(
    written[0].rows.map((r) => ({ ...r })),
    [
      { kind: "pr", id: "a", mark: "settled_outside", probability: 0.9 },
      { kind: "po", id: "b", mark: "settled_outside", probability: 0.9 },
    ],
  );
});

test("stops on quota after the daily limit is reached", async () => {
  const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];
  const { deps, usage } = baseDeps({ getCandidates: async () => candidates(rows) });

  const result = await runDebtReview(deps, "sup-1", {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
    usageDate: "2026-11-01",
    remainingQuota: 1,
  });

  assert.equal(result.evaluated, 1);
  assert.equal(result.marked, 1);
  assert.equal(result.stopped, "quota");
  assert.equal(usage.calls, 1);
});

test("a wrong Jev answer does not write a mark and frees the quota slot", async () => {
  const rows = [row({ id: "a" }), row({ id: "b" })];
  let calls = 0;
  const { deps, written } = baseDeps({
    getCandidates: async () => candidates(rows),
    evaluator: () => async () => {
      calls += 1;
      if (calls === 1) throw new Error("bad answer");
      return { mark: "real_debt", probability: 0.7, usage: { input: 1, output: 1 }, cost: 0 };
    },
  });

  const result = await runDebtReview(deps, "sup-1", {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
    usageDate: "2026-11-01",
    remainingQuota: 100,
  });

  assert.equal(result.evaluated, 1);
  assert.equal(result.marked, 1);
  assert.equal(written[0].rows[0].mark, "real_debt");
});

test("builds the Jev facts including newer_paid_exists", () => {
  const state = buildDebtJevState(
    row({ id: "a", doc_date: "2025-12-31", amount: 5000, age_days: 100, has_receipt: true }),
    candidates([]),
  );
  assert.equal(state.debt.kind, "po");
  assert.equal(state.debt.amount, 5000);
  assert.equal(state.debt.age_days, 100);
  assert.equal(state.debt.has_receipt, true);
  assert.equal(state.debt.supplier_paid_90d, 2);
  assert.equal(state.debt.supplier_median_lag_days, 5);
  assert.equal(state.debt.newer_paid_exists, true);
});

test("the service-client store calls the two debt RPCs with the right args", async () => {
  const calls: { fn: string; args: Record<string, unknown> | undefined }[] = [];
  const client: DebtReviewRpcClient = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (fn === "get_supplier_debt_candidates") {
        return { data: candidates([row({ id: "a" })]), error: null };
      }
      return { data: null, error: null };
    },
  };
  const store = createDebtReviewStore(client);
  const result = await store.getCandidates("sup-9");
  assert.equal(result.supplier_id, "11111111-1111-1111-1111-111111111111");
  await store.writeMarks("sup-9", [{ kind: "po", id: "a", mark: "unsure", probability: 0.4 }]);
  assert.deepEqual(calls.map((c) => c.fn), ["get_supplier_debt_candidates", "set_supplier_debt_mark_ai"]);
  assert.deepEqual(calls[1].args, {
    p_supplier_id: "sup-9",
    p_rows: [{ kind: "po", id: "a", mark: "unsure", probability: 0.4 }],
  });
});

test("validates the strict debt-mark Jev response", () => {
  const valid = {
    model: "typesafe-ai/jev",
    usage: { inputTokens: 10, outputTokens: 2 },
    providerMetadata: { gateway: { cost: "0.001" } },
    answers: {
      debt_mark: {
        type: "choice",
        choice: "settled_outside",
        probabilities: { settled_outside: 0.8, real_debt: 0.15, unsure: 0.05 },
      },
    },
  };
  const evaluation = validateDebtJevResponse(valid);
  assert.equal(evaluation.mark, "settled_outside");
  assert.equal(evaluation.probability, 0.8);
  assert.equal(evaluation.usage.input, 10);

  const tied = {
    ...valid,
    answers: {
      debt_mark: {
        type: "choice",
        choice: "settled_outside",
        probabilities: { settled_outside: 0.5, real_debt: 0.5, unsure: 0 },
      },
    },
  };
  assert.throws(() => validateDebtJevResponse(tied));
  assert.equal(DEBT_MARK_OPTIONS.length, 3);
});
