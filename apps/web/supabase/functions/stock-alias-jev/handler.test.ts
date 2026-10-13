// Offline handler tests: permission gate, kill switch, request grammar, cache
// reuse, candidate-hash sensitivity and the shared daily Jev quota.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMaterialAliasHandler,
  MATERIAL_ALIAS_MAX_CANDIDATES,
  MaterialAliasError,
  type CachedJevAnswer,
  type MaterialAliasCacheKey,
  type MaterialAliasHandlerDeps,
} from "./handler.ts";
import {
  JevError,
  candidatesHash,
  JEV_PROMPT_VERSION,
  type JevMatchEvaluation,
  type MaterialAliasCandidate,
} from "./jev.ts";

const CANDIDATE_A = { id: "11111111-1111-4111-8111-111111111111", name: "Tỏi bóc vỏ", unit: "kg" };
const CANDIDATE_B = { id: "22222222-2222-4222-8222-222222222222", name: "Tỏi phi", unit: "kg" };
const CATALOG_ITEM = { id: "55555555-5555-4555-8555-555555555555", name: "Phô mai Dairymont", unit: "kg", reason: "catalog" };
const CATALOG_OTHER = { id: "66666666-6666-4666-8666-666666666666", name: "Bột mì", unit: "kg", reason: "catalog" };
// A finished-goods SKU option and the shared NVL item a label line may still get.
const SKU_CANDIDATE = {
  id: "77777777-7777-4777-8777-777777777777",
  name: "Pate 200g",
  unit: "cái",
  reason: "name_contains+sku",
  sku_id: "88888888-8888-4888-8888-888888888888",
};
const LABEL_NVL_CANDIDATE = {
  id: "99999999-9999-4999-8999-999999999999",
  name: "Nhãn giấy",
  unit: "cái",
  reason: "token",
};

function backlogRow(normalized: string, raw: string) {
  return {
    supplier_id: null,
    normalized_name: normalized,
    raw_name: raw,
    raw_unit: "kg",
    location: "q7",
  };
}

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
    catalogOptions: async () => [],
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

test("new_items mode is Q7-editor only", async () => {
  const handler = createMaterialAliasHandler(makeDeps({
    authenticate: async () => ({ userId: "staff-1", q7Editor: false }),
  }).deps);
  const response = await handler(request({ mode: "new_items", location: "q7" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "forbidden");
});

test("the new_items request grammar is validated", async () => {
  const handler = createMaterialAliasHandler(makeDeps().deps);
  assert.equal((await handler(request({ mode: "new_items", location: "q7", days: 0 }))).status, 400);
  assert.equal((await handler(request({ mode: "new_items", location: "q7", days: 1.5 }))).status, 400);
  assert.equal((await handler(request({ mode: "new_items", location: "q7", days: 366 }))).status, 400);
  assert.equal((await handler(request({ mode: "new_items", location: "q7", lines: [] }))).status, 400);
  assert.equal((await handler(request({ mode: "new_items", location: "q7", batch_size: 0 }))).status, 400);
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

test("a backlog row with zero token candidates is evaluated with the catalog options", async () => {
  const seen: MaterialAliasCandidate[][] = [];
  const { deps, cache } = makeDeps({
    listBacklog: async () => [backlogRow("pho mai", "Phô mai Dairymont")],
    candidatesFor: async () => [],
    catalogOptions: async () => [CATALOG_ITEM],
    evaluator: () => async ({ state }) => {
      seen.push(state.candidates);
      return { ...EVAL, choice: CATALOG_ITEM.id };
    },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({ mode: "backlog", location: "q7" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.candidates, 1, "the row must not be skipped for having no token match");
  assert.equal(body.evaluated, 1);
  assert.equal(body.processed, 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].map((candidate) => candidate.id), [CATALOG_ITEM.id]);
  assert.equal(cache.size, 1, "a returned catalog choice must be stored");
  assert.equal([...cache.values()][0].answer.choice, CATALOG_ITEM.id);
});

test("token candidates come first and are not duplicated by the catalog", async () => {
  const token = { ...CANDIDATE_A, reason: "token" };
  const duplicate = { ...CANDIDATE_A, reason: "catalog" };
  let offered: MaterialAliasCandidate[] = [];
  let tokenLimit: number | null = null;
  const { deps } = makeDeps({
    listBacklog: async () => [backlogRow("toi boc vo", "Tỏi bóc vỏ")],
    candidatesFor: async (_name, _location, limit) => { tokenLimit = limit; return [token]; },
    catalogOptions: async () => [duplicate, CATALOG_OTHER],
    evaluator: () => async ({ state }) => {
      offered = state.candidates;
      return { ...EVAL, choice: token.id };
    },
  });
  const handler = createMaterialAliasHandler(deps);
  await handler(request({ mode: "backlog", location: "q7" }));
  assert.equal(tokenLimit, 5, "token candidates still ask for the top five");
  assert.deepEqual(offered.map((candidate) => candidate.id), [CANDIDATE_A.id, CATALOG_OTHER.id]);
  assert.equal(offered[0].reason, "token", "the token candidate keeps its reason");
});

test("the offered list is capped at MATERIAL_ALIAS_MAX_CANDIDATES", async () => {
  const token = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Token", unit: "kg", reason: "token" };
  const catalog: MaterialAliasCandidate[] = Array.from({ length: 200 }, (_, index) => ({
    id: `catalog-${index}`,
    name: `Catalog ${index}`,
    unit: "kg",
    reason: "catalog",
  }));
  let offered: MaterialAliasCandidate[] = [];
  const { deps } = makeDeps({
    listBacklog: async () => [backlogRow("token", "Token")],
    candidatesFor: async () => [token],
    catalogOptions: async () => catalog,
    evaluator: () => async ({ state }) => {
      offered = state.candidates;
      return { ...EVAL, choice: token.id };
    },
  });
  const handler = createMaterialAliasHandler(deps);
  await handler(request({ mode: "backlog", location: "q7" }));
  assert.equal(MATERIAL_ALIAS_MAX_CANDIDATES, 150);
  assert.equal(offered.length, MATERIAL_ALIAS_MAX_CANDIDATES);
  assert.equal(offered[0].id, token.id);
  assert.equal(offered[offered.length - 1].id, "catalog-148");
});

test("the cache key changes when the catalog changes", async () => {
  const token = { ...CANDIDATE_A, reason: "token" };
  const seen: MaterialAliasCacheKey[] = [];
  const depsFor = (catalog: MaterialAliasCandidate[]): MaterialAliasHandlerDeps => makeDeps({
    listBacklog: async () => [backlogRow("toi", "Tỏi ngày 10")],
    candidatesFor: async () => [token],
    catalogOptions: async () => catalog,
    getCache: async (key) => { seen.push(key); return null; },
    putCache: async () => {},
  }).deps;
  await createMaterialAliasHandler(depsFor([CATALOG_ITEM]))(request({ mode: "backlog", location: "q7" }));
  await createMaterialAliasHandler(depsFor([CATALOG_OTHER]))(request({ mode: "backlog", location: "q7" }));
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].candidatesHash, seen[1].candidatesHash);
  assert.equal(seen[0].promptVersion, JEV_PROMPT_VERSION);
  assert.equal(seen[0].candidatesHash, candidatesHash([token.id, CATALOG_ITEM.id]));
});

test("a cache row from the old prompt version is not reused", async () => {
  const token = { ...CANDIDATE_A, reason: "token" };
  const { deps, cache } = makeDeps({
    listBacklog: async () => [backlogRow("pho mai", "Phô mai Dairymont")],
    candidatesFor: async () => [token],
    catalogOptions: async () => [CATALOG_ITEM],
    evaluator: () => async () => ({ ...EVAL, choice: token.id }),
  });
  const oldAnswer: CachedJevAnswer = { ...ANSWER, choice: null, item_id: null, source: "none" };
  cache.set(JSON.stringify({
    supplierId: null,
    normalizedName: "pho mai",
    location: "q7",
    promptVersion: "jev-material-alias-2026-10-13.1",
    candidatesHash: candidatesHash([token.id, CATALOG_ITEM.id]),
  }), { answer: oldAnswer, cost: null });
  const handler = createMaterialAliasHandler(deps);
  const body = await (await handler(request({ mode: "backlog", location: "q7" }))).json();
  assert.equal(body.skipped_existing, 0, "an old prompt-version row must not count as cached");
  assert.equal(body.evaluated, 1);
  assert.equal(body.calls, 1);
  assert.equal(cache.size, 2, "the new answer is stored under the new prompt version");
  assert.equal(JEV_PROMPT_VERSION, "jev-material-alias-2026-10-14.1");
});

test("a whole-catalog candidate hash is short enough for the btree cache index", () => {
  const ids = Array.from({ length: 103 }, (_, i) => `${String(i).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
  const hash = candidatesHash(ids);
  assert.ok(hash.length < 100, `hash length ${hash.length}`);
  assert.equal(hash, candidatesHash([...ids].reverse()), "order-insensitive");
  assert.equal(hash, candidatesHash([...ids, ids[0]]), "duplicates ignored");
  const changed = [...ids.slice(1), "ffffffff-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
  assert.notEqual(hash, candidatesHash(changed), "one id swapped changes the key");
  assert.equal(candidatesHash(["b", "a"]), "a|b", "short lists keep the readable form");
});

test("a completely empty catalog is skipped without crashing", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    listBacklog: async () => [backlogRow("hang 1", "Hàng 1")],
    candidatesFor: async () => [],
    catalogOptions: async () => [],
    evaluator: () => async () => { calls += 1; return EVAL; },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({ mode: "backlog", location: "q7" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.candidates, 0);
  assert.equal(body.evaluated, 0);
  assert.equal(body.stopped, null);
  assert.equal(calls, 0, "no option means no Jev call");
});

test("a corrected label name drops finished-product SKUs and saves no suggestion", async () => {
  const offered: MaterialAliasCandidate[][] = [];
  const seenNames: string[] = [];
  const correctionsCalls: string[][] = [];
  const { deps, cache } = makeDeps({
    listBacklog: async () => [backlogRow("nhan pate heo 200gr", "Nhân Patê Heo 200gr")],
    candidatesFor: async () => [LABEL_NVL_CANDIDATE],
    catalogOptions: async () => [SKU_CANDIDATE],
    getStockNameCorrections: async (names) => {
      correctionsCalls.push(names);
      return new Map([["nhan pate heo 200gr", "Nhãn Patê Heo 200gr"]]);
    },
    evaluator: () => async ({ state }) => {
      offered.push(state.candidates);
      seenNames.push(state.line.name);
      return { ...EVAL, choice: null };
    },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({ mode: "backlog", location: "q7" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(correctionsCalls.length, 1, "one grouped correction read per batch, not per row");
  assert.deepEqual(correctionsCalls[0], ["nhan pate heo 200gr"]);
  assert.equal(offered.length, 1);
  assert.deepEqual(offered[0].map((candidate) => candidate.id), [LABEL_NVL_CANDIDATE.id]);
  assert.equal(seenNames[0], "Nhãn Patê Heo 200gr", "Jev reads the corrected display name");
  assert.equal(body.evaluated, 1);
  assert.equal(cache.size, 1);
  assert.equal([...cache.values()][0].answer.choice, null, "the saved answer is 'không có gợi ý'");
});

test("a label name with only SKU candidates is skipped without a Jev call", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    listBacklog: async () => [backlogRow("nhan pate heo 200gr", "Nhân Patê Heo 200gr")],
    candidatesFor: async () => [],
    catalogOptions: async () => [SKU_CANDIDATE],
    getStockNameCorrections: async () => new Map([["nhan pate heo 200gr", "Nhãn Patê Heo 200gr"]]),
    evaluator: () => async () => { calls += 1; return EVAL; },
  });
  const handler = createMaterialAliasHandler(deps);
  const body = await (await handler(request({ mode: "backlog", location: "q7" }))).json();
  assert.equal(body.candidates, 0);
  assert.equal(body.evaluated, 0);
  assert.equal(calls, 0, "no option left means no Jev call and no suggestion");
});

test("a non-label name still offers the finished-product SKU to Jev", async () => {
  const offered: MaterialAliasCandidate[][] = [];
  const seenNames: string[] = [];
  const { deps } = makeDeps({
    listBacklog: async () => [backlogRow("pate 200g", "Pate 200g")],
    candidatesFor: async () => [],
    catalogOptions: async () => [SKU_CANDIDATE],
    getStockNameCorrections: async () => new Map(),
    evaluator: () => async ({ state }) => {
      offered.push(state.candidates);
      seenNames.push(state.line.name);
      return { ...EVAL, choice: SKU_CANDIDATE.id };
    },
  });
  const handler = createMaterialAliasHandler(deps);
  const body = await (await handler(request({ mode: "backlog", location: "q7" }))).json();
  assert.equal(body.evaluated, 1);
  assert.deepEqual(offered[0].map((candidate) => candidate.id), [SKU_CANDIDATE.id]);
  assert.equal(seenNames[0], "Pate 200g", "an uncorrected name stays the machine name");
});

test("a failed correction read still runs with the machine name", async () => {
  const seenNames: string[] = [];
  const { deps } = makeDeps({
    listBacklog: async () => [backlogRow("nhan pate heo 200gr", "Nhân Patê Heo 200gr")],
    candidatesFor: async () => [],
    catalogOptions: async () => [SKU_CANDIDATE, LABEL_NVL_CANDIDATE],
    getStockNameCorrections: async () => { throw new Error("corrections table unavailable"); },
    evaluator: () => async ({ state }) => {
      seenNames.push(state.line.name);
      return { ...EVAL, choice: null };
    },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({ mode: "backlog", location: "q7" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.evaluated, 1, "a failed correction read must not break the run");
  assert.equal(seenNames[0], "Nhân Patê Heo 200gr", "the machine name is used when the read fails");
});

test("a label line in lines mode drops SKU candidates before hashing and Jev", async () => {
  const offered: MaterialAliasCandidate[][] = [];
  const { deps } = makeDeps({
    evaluator: () => async ({ state }) => {
      offered.push(state.candidates);
      return { ...EVAL, choice: null };
    },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({
    mode: "lines",
    supplier_id: null,
    location: "q7",
    lines: [{
      line_key: "l1",
      raw_name: "Tem 17k",
      raw_unit: "cái",
      candidates: [SKU_CANDIDATE, LABEL_NVL_CANDIDATE],
    }],
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(offered[0].map((candidate) => candidate.id), [LABEL_NVL_CANDIDATE.id]);
  assert.equal(body.results[0].answer.choice, null);
});

test("a missing catalogOptions dependency does not break backlog", async () => {
  const { deps } = makeDeps({
    listBacklog: async () => [backlogRow("hang 1", "Hàng 1")],
    candidatesFor: async () => [CANDIDATE_A],
    catalogOptions: undefined,
  });
  const handler = createMaterialAliasHandler(deps);
  const body = await (await handler(request({ mode: "backlog", location: "q7" }))).json();
  assert.equal(body.evaluated, 1);
});

test("the backlog audit reports the catalog size", async () => {
  const audits: Record<string, unknown>[] = [];
  const { deps } = makeDeps({
    listBacklog: async () => [backlogRow("hang 1", "Hàng 1")],
    candidatesFor: async () => [],
    catalogOptions: async () => [CATALOG_ITEM, CATALOG_OTHER],
    evaluator: () => async () => EVAL,
    audit: (event) => { audits.push(event); },
  });
  const handler = createMaterialAliasHandler(deps);
  await handler(request({ mode: "backlog", location: "q7" }));
  assert.equal(audits[0].catalog_size, 2);
});

test("a lines request with more than five candidates passes the grammar", async () => {
  const many: MaterialAliasCandidate[] = Array.from({ length: 6 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `Mặt hàng ${index}`,
    unit: "kg",
  }));
  let offeredCount = 0;
  const { deps } = makeDeps({
    evaluator: () => async ({ state }) => {
      offeredCount = state.candidates.length;
      return EVAL;
    },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request(linesBody(many)));
  assert.equal(response.status, 200);
  assert.equal(offeredCount, 6);
});

test("the request grammar accepts MATERIAL_ALIAS_MAX_CANDIDATES and refuses more", async () => {
  const make = (count: number): MaterialAliasCandidate[] => Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `Item ${index}`,
    unit: "kg",
  }));
  const handler = createMaterialAliasHandler(makeDeps().deps);
  assert.equal((await handler(request(linesBody(make(MATERIAL_ALIAS_MAX_CANDIDATES))))).status, 200);
  assert.equal((await handler(request(linesBody(make(MATERIAL_ALIAS_MAX_CANDIDATES + 1))))).status, 400);
});

function unmatchedRow(normalized: string, raw: string, exact = false) {
  return {
    supplier_id: null,
    normalized_name: normalized,
    raw_name: raw,
    raw_unit: "kg",
    receipt_count: 1,
    receipt_days: 1,
    first_date: "2026-10-01",
    last_date: "2026-10-01",
    has_exact_candidate: exact,
    cached_match_item_id: null,
    cached_match_line_type: null,
  };
}

test("new_items background answers 202 with a run_id and finishes via waitUntil", async () => {
  let createdLocation: string | null = null;
  let createdBy: string | null = null;
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let captured: Promise<unknown> | null = null;
  const { deps } = makeDeps({
    listUnmatched: async () => [unmatchedRow("hang moi", "Hàng mới", true)],
    candidatesFor: async () => [],
    createNewItemRun: async (location, startedBy) => {
      createdLocation = location;
      createdBy = startedBy;
      return {
        id: "run-1", location, status: "running" as const,
        processed: 0, remaining: 0, calls: 0, groups: 0, last_error: null,
      };
    },
    updateNewItemRun: async (id, patch) => { updates.push({ id, patch: patch as Record<string, unknown> }); },
    waitUntil: (promise) => { captured = promise; },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({ mode: "new_items", location: "tan_tao", background: true }));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.run_id, "run-1");
  assert.equal(body.background, true);
  assert.equal(createdLocation, "tan_tao");
  assert.equal(createdBy, "owner-1");
  assert.ok(captured, "the background task must be handed to waitUntil");
  await captured;
  assert.equal(updates[updates.length - 1].patch.status, "done");
});

test("a second new_items background call joins the live run for that location", async () => {
  let created = 0;
  let started = 0;
  const { deps } = makeDeps({
    getActiveNewItemRun: async () => ({
      id: "run-live", location: "q7", status: "running" as const,
      processed: 3, remaining: 7, calls: 2, groups: 1, last_error: null,
    }),
    createNewItemRun: async () => { created += 1; throw new Error("must not create a second run"); },
    waitUntil: () => { started += 1; },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({ mode: "new_items", location: "q7", background: true }));
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.run_id, "run-live");
  assert.equal(body.remaining, 7);
  assert.equal(created, 0);
  assert.equal(started, 0);
});

test("new_items reads the match cache in one batch, not per row", async () => {
  let manyCalls = 0;
  let perRowCalls = 0;
  const { deps } = makeDeps({
    listUnmatched: async () => [1, 2, 3].map((n) => unmatchedRow(`hang ${n}`, `Hàng ${n}`)),
    candidatesFor: async () => [CANDIDATE_A],
    getCacheMany: async (keys) => { manyCalls += 1; return keys.map(() => null); },
    getCache: async () => { perRowCalls += 1; return null; },
    evaluator: () => async () => EVAL,
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({ mode: "new_items", location: "q7" }));
  assert.equal(response.status, 200);
  assert.equal(manyCalls, 1, "one batched cache read for the whole match phase");
  assert.equal(perRowCalls, 0, "no per-row cache read when the batch read is available");
});

test("new_items reads the same-item and item-class caches in batches", async () => {
  let rawManyCalls = 0;
  let rawPerRowCalls = 0;
  const { deps } = makeDeps({
    listUnmatched: async () => [
      unmatchedRow("toi boc vo", "Tỏi bóc vỏ"),
      unmatchedRow("toi phi", "Tỏi phi"),
    ],
    candidatesFor: async () => [],
    getCacheMany: async (keys) => keys.map(() => null),
    getRawCacheMany: async (keys) => { rawManyCalls += 1; return keys.map(() => null); },
    getRawCache: async () => { rawPerRowCalls += 1; return null; },
    newItemEvaluator: () => async ({ mode }) => mode === "same_item"
      ? { mode, same_item: 0.1, item_class: null, class_probability: null, usage: { input: 1, output: 1 }, cost: 0 }
      : { mode, same_item: null, item_class: "raw_material", class_probability: 0.9, usage: { input: 1, output: 1 }, cost: 0 },
    upsertNewItemSuggestions: async () => {},
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({ mode: "new_items", location: "q7" }));
  assert.equal(response.status, 200);
  assert.equal(rawManyCalls, 2, "one batch per phase (same_item, item_class)");
  assert.equal(rawPerRowCalls, 0);
});

test("one invalid Jev answer is skipped and the rest of the batch still runs", async () => {
  let calls = 0;
  const { deps, cache } = makeDeps({
    listBacklog: async () => [backlogRow("hang a", "Hàng A"), backlogRow("hang b", "Hàng B"), backlogRow("hang c", "Hàng C")],
    candidatesFor: async () => [CANDIDATE_A],
    evaluator: () => async () => {
      calls += 1;
      if (calls === 2) throw new JevError("jev_invalid_response", 502);
      return { ...EVAL, choice: null };
    },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({ mode: "backlog", location: "q7" }));
  assert.equal(response.status, 200, "an invalid answer does not fail the request");
  const body = await response.json();
  assert.equal(body.failed, 1);
  assert.equal(body.evaluated, 2, "the other two names are still ranked");
  assert.equal(cache.size, 2, "only the valid answers are cached");
});

test("a quota or auth style Jev failure still stops the batch", async () => {
  const { deps } = makeDeps({
    listBacklog: async () => [backlogRow("hang a", "Hàng A"), backlogRow("hang b", "Hàng B")],
    candidatesFor: async () => [CANDIDATE_A],
    evaluator: () => async () => { throw new JevError("jev_unavailable", 503); },
  });
  const handler = createMaterialAliasHandler(deps);
  const response = await handler(request({ mode: "backlog", location: "q7" }));
  const text = await response.text();
  assert.equal(response.status, 503, text);
});
