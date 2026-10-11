import { test } from "node:test";
import assert from "node:assert/strict";

import {
  candidatesHash,
  createJevCircuit,
  createJevEvaluator,
  JEV_ENDPOINT,
  JEV_MODEL,
  JevError,
  matchCriteria,
  matchInstructions,
  matchOptions,
  NONE_OPTION,
  normalizeItemName,
  PACK_PARSE_TEST_CASES,
  parsePackFromName,
  validateJevResponse,
  type MaterialAliasCandidate,
} from "./jev.ts";
import { createMaterialAliasHandler } from "./handler.ts";

const CANDIDATES: MaterialAliasCandidate[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Tỏi bóc vỏ", unit: "kg" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Tỏi phi", unit: "kg" },
];
const ALLOWED = matchOptions(CANDIDATES);

function validMatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: JEV_MODEL,
    answers: {
      match: {
        type: "choice",
        choice: CANDIDATES[0].id,
        probabilities: { [CANDIDATES[0].id]: 0.86, [CANDIDATES[1].id]: 0.1, [NONE_OPTION]: 0.04 },
        confidence: 0.8,
      },
    },
    usage: { inputTokens: 100, outputTokens: 20 },
    providerMetadata: { gateway: { cost: "0.00012" } },
    ...overrides,
  };
}

function fetchFake(handler: (init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) => handler(init)) as unknown as typeof fetch;
}

test("validates the match choice and maps none to null", () => {
  const evaluation = validateJevResponse(ALLOWED, validMatch());
  assert.equal(evaluation.choice, CANDIDATES[0].id);
  assert.equal(evaluation.probability, 0.86);
  assert.equal(evaluation.confidence, 0.8);
  assert.equal(evaluation.cost, 0.00012);

  const none = validMatch({
    answers: {
      match: {
        type: "choice",
        choice: NONE_OPTION,
        probabilities: { [CANDIDATES[0].id]: 0.05, [CANDIDATES[1].id]: 0.05, [NONE_OPTION]: 0.9 },
      },
    },
  });
  assert.equal(validateJevResponse(ALLOWED, none).choice, null);
});

test("the match prompt is Vietnamese, describes every candidate and always offers none", () => {
  assert.ok(matchInstructions().includes("candidates"));
  const criteria = matchCriteria(CANDIDATES);
  assert.deepEqual(Object.keys(criteria).sort(), [...ALLOWED].sort());
  assert.ok(criteria[NONE_OPTION].length > 5);
  for (const candidate of CANDIDATES) {
    assert.ok(criteria[candidate.id].includes(candidate.name));
    assert.ok(criteria[candidate.id].includes(candidate.unit));
  }
});

test("refuses an unknown or tied option, a bad distribution and a missing none option", () => {
  const unknown = validMatch({
    answers: {
      match: {
        type: "choice",
        choice: "33333333-3333-4333-8333-333333333333",
        probabilities: { [CANDIDATES[0].id]: 0.5, [CANDIDATES[1].id]: 0.3, [NONE_OPTION]: 0.2 },
      },
    },
  });
  assert.throws(() => validateJevResponse(ALLOWED, unknown), JevError);

  const tied = validMatch({
    answers: {
      match: {
        type: "choice",
        choice: CANDIDATES[0].id,
        probabilities: { [CANDIDATES[0].id]: 0.5, [CANDIDATES[1].id]: 0.5, [NONE_OPTION]: 0.0 },
      },
    },
  });
  assert.throws(() => validateJevResponse(ALLOWED, tied), JevError);

  const badSum = validMatch({
    answers: {
      match: {
        type: "choice",
        choice: CANDIDATES[0].id,
        probabilities: { [CANDIDATES[0].id]: 0.8, [CANDIDATES[1].id]: 0.7, [NONE_OPTION]: 0.1 },
      },
    },
  });
  assert.throws(() => validateJevResponse(ALLOWED, badSum), JevError);

  assert.throws(() => validateJevResponse([CANDIDATES[0].id, CANDIDATES[1].id], validMatch()), JevError);
});

test("pack reading mirrors q7_pack_from_name cases", () => {
  for (const [name, baseQty, baseUnit, multiplier] of PACK_PARSE_TEST_CASES) {
    const parsed = parsePackFromName(name);
    assert.ok(parsed, `parse ${name}`);
    assert.equal(parsed?.baseQty, baseQty);
    assert.equal(parsed?.baseUnit, baseUnit);
    assert.equal(parsed?.multiplier, multiplier);
  }
  assert.equal(parsePackFromName(""), null);
});

test("normalizes names and hashes candidate sets like the SQL", () => {
  assert.equal(normalizeItemName("Tỏi ngày 10"), "toi");
  assert.equal(normalizeItemName("Chả lụa lá TVP XL (kg)"), "cha lua la tvp xl");
  assert.equal(candidatesHash(["b", "a", "a"]), "a|b");
  assert.equal(candidatesHash([]), "");
});

test("an empty api key fails closed and the request shape is pinned", async () => {
  assert.throws(() => createJevEvaluator({ apiKey: "" }), JevError);

  let seenBody: Record<string, unknown> = {};
  const evaluator = createJevEvaluator({
    apiKey: "server-key",
    fetcher: fetchFake(async (init) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(validMatch()), { status: 200 });
    }),
  });
  const evaluation = await evaluator({
    state: { line: { name: "Tỏi ngày 10", unit: "kg", supplier: "NCC A" }, candidates: CANDIDATES },
    signal: new AbortController().signal,
  });
  assert.equal(evaluation.choice, CANDIDATES[0].id);
  assert.equal(seenBody.model, JEV_MODEL);
  const gateway = (seenBody.providerOptions as Record<string, Record<string, unknown>>).gateway;
  assert.equal(gateway.zeroDataRetention, true);
  assert.deepEqual(gateway.only, ["typesafe-ai"]);
  assert.equal(JEV_ENDPOINT, "https://ai-gateway.vercel.sh/v1/evaluate");
});

test("maps a 429 and a malformed body without retrying", async () => {
  let calls = 0;
  const rateLimited = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => {
      calls += 1;
      return new Response("slow down", { status: 429 });
    }),
  });
  await assert.rejects(
    () => rateLimited({ state: { line: { name: "x", unit: null, supplier: null }, candidates: CANDIDATES }, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_rate_limited" && error.status === 429,
  );
  assert.equal(calls, 1, "a 429 must not be retried");

  const malformed = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => new Response("not json", { status: 200 })),
  });
  await assert.rejects(
    () => malformed({ state: { line: { name: "x", unit: null, supplier: null }, candidates: CANDIDATES }, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_invalid_response",
  );
});

test("a stalled provider is a timeout and an expired deadline never calls it", async () => {
  const hanging = createJevEvaluator({
    apiKey: "k",
    timeoutMs: 20,
    fetcher: fetchFake((init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })),
  });
  await assert.rejects(
    () => hanging({ state: { line: { name: "x", unit: null, supplier: null }, candidates: CANDIDATES }, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_timeout",
  );

  let calls = 0;
  const evaluator = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => { calls += 1; return new Response(JSON.stringify(validMatch()), { status: 200 }); }),
  });
  await assert.rejects(
    () => evaluator({ state: { line: { name: "x", unit: null, supplier: null }, candidates: CANDIDATES }, signal: new AbortController().signal, deadlineAt: Date.now() - 1 }),
    (error: unknown) => error instanceof JevError && error.code === "jev_deadline_exceeded",
  );
  assert.equal(calls, 0);
});

test("the circuit opens after three consecutive provider failures", async () => {
  const circuit = createJevCircuit();
  let calls = 0;
  const evaluator = createJevEvaluator({
    apiKey: "k",
    circuit,
    fetcher: fetchFake(async () => { calls += 1; return new Response("boom", { status: 500 }); }),
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      () => evaluator({ state: { line: { name: "x", unit: null, supplier: null }, candidates: CANDIDATES }, signal: new AbortController().signal }),
      (error: unknown) => error instanceof JevError && error.code === "jev_http_error",
    );
  }
  assert.equal(circuit.isOpen(), true);
  await assert.rejects(
    () => evaluator({ state: { line: { name: "x", unit: null, supplier: null }, candidates: CANDIDATES }, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_circuit_open",
  );
  assert.equal(calls, 3, "the open circuit must not call the provider again");
});

test("the kill switch refuses the ranking before any provider call", async () => {
  let calls = 0;
  const handler = createMaterialAliasHandler({
    killSwitch: () => true,
    evaluator: () => async () => { calls += 1; return { choice: null, probability: 0, confidence: null, usage: { input: 0, output: 0 }, cost: null }; },
    authenticate: async () => ({ userId: "owner-1", q7Editor: true }),
    getCache: async () => null,
    putCache: async () => {},
    getUsage: async (usageDate) => ({ usage_date: usageDate, calls: 0, cost: 0, call_limit: 600 }),
    recordUsage: async () => {},
    listBacklog: async () => [],
    candidatesFor: async () => [],
    audit: () => {},
  });
  const response = await handler(new Request("https://edge.test/stock-alias-jev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "lines", supplier_id: null, location: "q7", lines: [{ line_key: "l1", raw_name: "Tỏi ngày 10", candidates: CANDIDATES }] }),
  }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "disabled");
  assert.equal(calls, 0);
});
