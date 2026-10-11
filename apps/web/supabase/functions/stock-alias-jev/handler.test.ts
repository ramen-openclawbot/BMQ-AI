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
  type MaterialAliasUsage,
} from "./handler.ts";
import { JEV_PROMPT_VERSION, type JevMatchEvaluation } from "./jev.ts";

const CANDIDATE_A = { id: "11111111-1111-4111-8111-111111111111", name: "Tỏi bóc vỏ", unit: "kg" };
const CANDIDATE_B = { id: "22222222-2222-4222-8222-222222222222", name: "Tỏi phi", unit: "kg" };

const EVAL: JevMatchEvaluation = {
  choice: CANDIDATE_A.id,
  probability: 0.9,
  confidence: 0.8,
  usage: { input: 10, output: 5 },
  cost: 0.001,
};

const ANSWER: CachedJevAnswer = {
  choice: CANDIDATE_A.id,
  item_id: CANDIDATE_A.id,
  probability: 0.9,
  confidence: 0.8,
  pack: { label: "Tỏi ngày 10", base_qty: 10, base_unit: null, multiplier: 1 },
};

function keyOf(key: MaterialAliasCacheKey): string {
  return JSON.stringify(key);
}

function makeDeps(overrides: Partial<MaterialAliasHandlerDeps> = {}) {
  const cache = new Map<string, { answer: CachedJevAnswer; cost: number | null }>();
  const usageRecords: MaterialAliasUsage[] = [];
  const defaults: MaterialAliasHandlerDeps = {
    killSwitch: () => false,
    evaluator: () => async () => EVAL,
    authenticate: async () => ({ userId: "owner-1", q7Editor: true }),
    getCache: async (key) => cache.get(keyOf(key)) ?? null,
    putCache: async (key, answer, cost) => { cache.set(keyOf(key), { answer, cost }); },
    getUsage: async (usageDate) => ({ usage_date: usageDate, calls: 0, cost: 0, call_limit: 600 }),
    recordUsage: async (usage) => { usageRecords.push(usage); },
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
