// Offline handler tests: permission gate, kill switch, request grammar, cache
// reuse, candidate-hash sensitivity and the shared daily Jev quota.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMaterialAliasHandler,
  MaterialAliasError,
  type CachedJevAnswer,
  type MaterialAliasCacheKey,
  type MaterialAliasHandlerDeps,
} from "./handler.ts";
import { JEV_PROMPT_VERSION, type JevMatchEvaluation } from "./jev.ts";

const CANDIDATE_A = { id: "11111111-1111-4111-8111-111111111111", name: "Tỏi bóc vỏ", unit: "kg" };
const CANDIDATE_B = { id: "22222222-2222-4222-8222-222222222222", name: "Tỏi phi", unit: "kg" };

const EVAL: JevMatchEvaluation = {
  choice: CANDIDATE_A.id,
  probability: 0.9,
  lineType: "goods",
  lineTypeProbability: 0.95,
  confidence: 0.8,
  usage: { input: 10, output: 5 },
  cost: 0.001,
};

const ANSWER: CachedJevAnswer = {
  choice: CANDIDATE_A.id,
  item_id: CANDIDATE_A.id,
  probability: 0.9,
  line_type: "goods",
  line_type_probability: 0.95,
  confidence: 0.8,
  pack: { label: "Tỏi ngày 10", base_qty: 10, base_unit: null, multiplier: 1 },
  source: "jev",
};

function keyOf(key: MaterialAliasCacheKey): string {
  return JSON.stringify(key);
}

interface UsageRecord {
  date: string;
  calls: number;
  cost: number;
}

function makeDeps(overrides: Partial<MaterialAliasHandlerDeps> = {}) {
  const cache = new Map<string, { answer: CachedJevAnswer; cost: number | null }>();
  const usageRecords: UsageRecord[] = [];
  const defaults: MaterialAliasHandlerDeps = {
    killSwitch: () => false,
    evaluator: () => async () => EVAL,
    authenticate: async () => ({ userId: "owner-1", q7Editor: true }),
    getCache: async (key) => cache.get(keyOf(key)) ?? null,
    putCache: async (key, answer, cost) => { cache.set(keyOf(key), { answer, cost }); },
    getUsage: async (usageDate) => ({ usage_date: usageDate, calls: 0, cost: 0, call_limit: 600 }),
    incrementUsage: async (date, calls, cost) => { usageRecords.push({ date, calls, cost }); },
    listBacklog: async () => [],
    candidatesFor: async () => [],
    now: () => new Date("2026-10-16T00:00:00.000Z"),
    audit: () => {},
  };
  return { deps: { ...defaults, ...overrides }, cache, usageRecords };
}

function request(body: unknown, contentType = "application/json") {
  return new Request("https://edge.test/stock-alias-jev", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

function linesBody(candidates = [CANDIDATE_A, CANDIDATE_B]) {
  return {
    mode: "lines",
    supplier_id: "33333333-3333-4333-8333-333333333333",
    location: "q7",
    lines: [{ line_key: "l1", raw_name: "Tỏi ngày 10", raw_unit: "kg", candidates }],
  };
}

test("CORS preflight and method are bounded", async () => {
  const handler = createMaterialAliasHandler(makeDeps().deps);
  const preflight = await handler(new Request("https://edge.test/stock-alias-jev", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal((await handler(new Request("https://edge.test", { method: "GET" }))).status, 405);
});

test("a kill switch and an unauthorized session are refused before any work", async () => {
  const killed = createMaterialAliasHandler(makeDeps({ killSwitch: () => true }).deps);
  const killedResponse = await killed(request(linesBody()));
  assert.equal(killedResponse.status, 503);
  assert.equal((await killedResponse.json()).code, "disabled");

  const unauthorized = createMaterialAliasHandler(makeDeps({
    authenticate: async () => { throw new MaterialAliasError("unauthorized", 401); },
  }).deps);
  const unauthorizedResponse = await unauthorized(request(linesBody()));
  assert.equal(unauthorizedResponse.status, 401);
  assert.equal((await unauthorizedResponse.json()).code, "unauthorized");
});

test("backlog mode is Q7-editor only", async () => {
  const handler = createMaterialAliasHandler(makeDeps({
    authenticate: async () => ({ userId: "staff-1", q7Editor: false }),
  }).deps);
  const response = await handler(request({ mode: "backlog", location: "q7" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "forbidden");
});

test("the request grammar is validated", async () => {
  const handler = createMaterialAliasHandler(makeDeps().deps);
  assert.equal((await handler(request({ mode: "delete", location: "q7" }))).status, 400);
  assert.equal((await handler(request({ mode: "lines", location: "q7" }))).status, 400);
  assert.equal((await handler(request({ mode: "lines", location: "nowhere", lines: [] }))).status, 400);
  assert.equal((await handler(request(linesBody(), "text/plain"))).status, 415);
  assert.equal((await handler(request({
    mode: "lines",
    location: "q7",
    lines: [{ line_key: "l1", raw_name: "x", candidates: [{ id: "none", name: "x", unit: "kg" }] }],
  }))).status, 400);
});

test("a line already cached does not call Jev a second time", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    evaluator: () => async () => { calls += 1; return EVAL; },
  });
  const handler = createMaterialAliasHandler(deps);
  const first = await handler(request(linesBody()));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.calls, 1);
  assert.equal(firstBody.results[0].cached, false);
  assert.equal(firstBody.results[0].answer.choice, CANDIDATE_A.id);

  const second = await handler(request(linesBody()));
  const secondBody = await second.json();
  assert.equal(secondBody.calls, 0, "cached line must not call Jev again");
  assert.equal(secondBody.results[0].cached, true);
  assert.equal(calls, 1);
});

test("a changed candidates_hash asks Jev again", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    evaluator: () => async () => { calls += 1; return EVAL; },
  });
  const handler = createMaterialAliasHandler(deps);
  await handler(request(linesBody([CANDIDATE_A])));
  const changed = await handler(request(linesBody([CANDIDATE_B])));
  const body = await changed.json();
  assert.equal(body.calls, 1);
  assert.equal(body.results[0].answer.choice, CANDIDATE_A.id);
  assert.equal(calls, 2);
});

test("an exact normalized name is assigned in code, cached and never calls Jev", async () => {
  let calls = 0;
  const { deps, cache, usageRecords } = makeDeps({
    evaluator: () => async () => { calls += 1; return EVAL; },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({
    mode: "lines",
    supplier_id: "33333333-3333-4333-8333-333333333333",
    location: "q7",
    lines: [{
      line_key: "l1",
      raw_name: "Tỏi bóc vỏ",
      raw_unit: "kg",
      candidates: [
        { ...CANDIDATE_A, reason: "name_exact" },
        { ...CANDIDATE_B, reason: "token" },
      ],
    }],
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.calls, 0, "an exact name must not call Jev");
  assert.equal(calls, 0, "an exact name must not call Jev");
  assert.equal(usageRecords.length, 0, "an exact name must not count a Jev call");
  assert.equal(body.results[0].answer.choice, CANDIDATE_A.id);
  assert.equal(body.results[0].answer.probability, 1);
  assert.equal(body.results[0].answer.line_type, "goods");
  assert.equal(body.results[0].answer.source, "exact");
  assert.equal(cache.size, 1, "the deterministic answer must still be cached");
});

test("two exact candidates are ambiguous and fall back to Jev", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    evaluator: () => async () => { calls += 1; return EVAL; },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({
    mode: "lines",
    supplier_id: null,
    location: "q7",
    lines: [{
      line_key: "l1",
      raw_name: "Tỏi",
      raw_unit: "kg",
      candidates: [
        { ...CANDIDATE_A, reason: "name_exact" },
        { ...CANDIDATE_B, reason: "name_exact" },
      ],
    }],
  }));
  const body = await response.json();
  assert.equal(body.calls, 1);
  assert.equal(calls, 1);
});

test("the shared usage counter is incremented after every Jev call", async () => {
  const { deps, usageRecords } = makeDeps({
    evaluator: () => async () => EVAL,
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({
    mode: "lines",
    supplier_id: null,
    location: "q7",
    lines: [
      { line_key: "l1", raw_name: "Tỏi ngày 10", raw_unit: "kg", candidates: [CANDIDATE_A] },
      { line_key: "l2", raw_name: "Hành tím 5", raw_unit: "kg", candidates: [CANDIDATE_B] },
    ],
  }));
  const body = await response.json();
  assert.equal(body.calls, 2);
  assert.equal(usageRecords.length, 2, "one increment per Jev call, not one per request");
  for (const record of usageRecords) assert.equal(record.calls, 1);
});

test("a rule line (VAT / fee / service) is answered without calling Jev", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    evaluator: () => async () => { calls += 1; return EVAL; },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({
    mode: "lines",
    supplier_id: "33333333-3333-4333-8333-333333333333",
    location: "q7",
    lines: [{ line_key: "l1", raw_name: "Thuế VAT 8%", raw_unit: null, candidates: [CANDIDATE_A] }],
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.calls, 0, "a rule line must never call Jev");
  assert.equal(calls, 0, "a rule line must never call Jev");
  assert.equal(body.results[0].answer.line_type, "non_goods");
  assert.equal(body.results[0].answer.line_type_probability, 1);
  assert.equal(body.results[0].answer.choice, null);
});

test("the line_type answer is stored in the Jev cache without changing the key", async () => {
  const stored: CachedJevAnswer[] = [];
  const { deps } = makeDeps({
    putCache: async (_key, answer) => { stored.push(answer); },
  });
  const handler = createMaterialAliasHandler(deps);
  await handler(request(linesBody()));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].line_type, "goods");
  assert.equal(stored[0].line_type_probability, 0.95);
});

test("the shared daily quota stops a backlog run before any Jev call", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    getUsage: async (usageDate) => ({ usage_date: usageDate, calls: 600, cost: 1, call_limit: 600 }),
    listBacklog: async () => [{
      supplier_id: "44444444-4444-4444-8444-444444444444",
      normalized_name: "toi",
      raw_name: "Tỏi ngày 10",
      raw_unit: "kg",
      location: "q7",
    }],
    candidatesFor: async () => [CANDIDATE_A],
    evaluator: () => async () => { calls += 1; return EVAL; },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({ mode: "backlog", location: "q7" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.calls, 0);
  assert.equal(body.stopped, "daily_limit");
  assert.equal(calls, 0, "an exhausted quota must never call Jev");
});

test("lines mode keeps the prompt version in the cache key", async () => {
  const seen: MaterialAliasCacheKey[] = [];
  const { deps } = makeDeps({
    getCache: async (key) => { seen.push(key); return null; },
    putCache: async () => {},
  });
  const handler = createMaterialAliasHandler(deps);
  await handler(request(linesBody()));
  assert.equal(seen[0].promptVersion, JEV_PROMPT_VERSION);
  assert.equal(seen[0].normalizedName, "toi");
});

test("an empty backlog is not reported as a quota stop", async () => {
  const handler = createMaterialAliasHandler(makeDeps({ listBacklog: async () => [] }).deps);
  const response = await handler(request({ mode: "backlog", location: "q7" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.candidates, 0);
  assert.equal(body.stopped, null, "nothing to rank must not say 'dừng vì hết hạn mức'");
});

test("a backlog run processes one batch, increments per call and reports what is left", async () => {
  let calls = 0;
  const rows = [1, 2, 3].map((n) => ({
    supplier_id: null,
    normalized_name: `hang ${n}`,
    raw_name: `Hàng ${n}`,
    raw_unit: "kg",
    location: "q7",
  }));
  const { deps, usageRecords } = makeDeps({
    listBacklog: async () => rows,
    candidatesFor: async () => [CANDIDATE_A],
    evaluator: () => async () => { calls += 1; return EVAL; },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({ mode: "backlog", location: "q7", batch_size: 2 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.batch_size, 2);
  assert.equal(body.processed, 2);
  assert.equal(body.remaining, 1);
  assert.equal(body.calls, 2);
  assert.equal(body.stopped, null);
  assert.equal(usageRecords.length, 2, "one usage increment per Jev call");
  assert.equal(calls, 2);
});

test("the backlog batch size is capped and validated", async () => {
  const handler = createMaterialAliasHandler(makeDeps({ listBacklog: async () => [] }).deps);
  const capped = await handler(request({ mode: "backlog", location: "q7", batch_size: 99 }));
  assert.equal(capped.status, 200);
  assert.equal((await capped.json()).batch_size, 15);

  for (const bad of [0, -1, 1.5, "10"]) {
    const response = await handler(request({ mode: "backlog", location: "q7", batch_size: bad }));
    assert.equal(response.status, 400, `batch_size ${bad} must be refused`);
  }
});

test("a backlog run skips names already cached for the same candidate set", async () => {
  let calls = 0;
  const { deps, usageRecords, cache } = makeDeps({
    listBacklog: async () => [{
      supplier_id: null,
      normalized_name: "hang 1",
      raw_name: "Hàng 1",
      raw_unit: "kg",
      location: "q7",
    }],
    candidatesFor: async () => [CANDIDATE_A],
    evaluator: () => async () => { calls += 1; return EVAL; },
  });
  const handler = createMaterialAliasHandler(deps);
  const first = await handler(request({ mode: "backlog", location: "q7" }));
  assert.equal((await first.json()).evaluated, 1);
  assert.equal(cache.size, 1);
  const second = await handler(request({ mode: "backlog", location: "q7" }));
  const body = await second.json();
  assert.equal(body.evaluated, 0);
  assert.equal(body.skipped_existing, 1);
  assert.equal(body.remaining, 0);
  assert.equal(calls, 1, "a cached backlog name must not call Jev again");
  assert.equal(usageRecords.length, 1);
});
