import { test } from "node:test";
import assert from "node:assert/strict";

import {
  allowedOptions,
  categoryCriteria,
  categoryInstructions,
  createJevCircuit,
  createJevEvaluator,
  JEV_ENDPOINT,
  JEV_MODEL,
  JevError,
  MATERIAL_CATEGORY_CRITERIA,
  ROUTE_OPTIONS,
  routeCriteria,
  routeInstructions,
  validateJevResponse,
  type MaterialCategoryOption,
  type MaterialRoutingState,
  type SupplierRoutingState,
} from "./jev.ts";
import { createStockRoutingHandler } from "./handler.ts";

const CATEGORIES: MaterialCategoryOption[] = Object.keys(MATERIAL_CATEGORY_CRITERIA)
  .map((code) => ({ code, label_vi: code }));

const SUPPLIER_STATE: SupplierRoutingState = {
  supplier: {
    name: "NCC Bánh mì",
    category: "Flour",
    top_items: [{ name: "Bánh mì tươi", line_count: 12 }],
    receipt_count: 4,
  },
};

const MATERIAL_STATE: MaterialRoutingState = {
  material: { name: "Bột mì 888", default_unit: "kg", aliases: ["Bột mì 888", "Bột mì đa dụng"] },
  categories: CATEGORIES,
};

function choiceAnswer(key: string, choice: string, probability: number, options: readonly string[]) {
  const probabilities: Record<string, number> = {};
  const rest = options.filter((option) => option !== choice);
  const remaining = Math.max(0, 1 - probability);
  for (const option of options) probabilities[option] = 0;
  probabilities[choice] = probability;
  if (rest.length > 0) {
    const share = remaining / rest.length;
    for (const option of rest) probabilities[option] = Number(share.toFixed(4));
  }
  return {
    model: JEV_MODEL,
    answers: {
      [key]: { type: "choice", choice, probabilities, confidence: 0.9 },
    },
    usage: { inputTokens: 100, outputTokens: 20 },
    providerMetadata: { gateway: { cost: "0.00012" } },
  };
}

function fetchFake(handler: (init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) => handler(init)) as unknown as typeof fetch;
}

test("validates the route choice", () => {
  const allowed = allowedOptions("route", SUPPLIER_STATE);
  assert.deepEqual(allowed, [...ROUTE_OPTIONS]);
  const evaluation = validateJevResponse("route", allowed, choiceAnswer("route", "tan_tao", 0.92, allowed));
  assert.equal(evaluation.choice, "tan_tao");
  assert.equal(evaluation.probability, 0.92);
  assert.equal(evaluation.cost, 0.00012);

  const unknown = choiceAnswer("route", "somewhere", 0.9, allowed);
  assert.throws(() => validateJevResponse("route", allowed, unknown), JevError);

  const tied = choiceAnswer("route", "q7", 0.4, allowed);
  (tied.answers as Record<string, { probabilities: Record<string, number> }>).route.probabilities.tan_tao = 0.4;
  assert.throws(() => validateJevResponse("route", allowed, tied), JevError);
});

test("validates the category choice against the offered codes", () => {
  const allowed = allowedOptions("category", MATERIAL_STATE);
  assert.equal(allowed.length, 11);
  const evaluation = validateJevResponse("category", allowed, choiceAnswer("category", "flour", 0.9, allowed));
  assert.equal(evaluation.choice, "flour");

  const wrongQuestion = choiceAnswer("route", "flour", 0.9, allowed);
  assert.throws(() => validateJevResponse("category", allowed, wrongQuestion), JevError);

  const badSum = choiceAnswer("category", "flour", 0.9, allowed);
  (badSum.answers as Record<string, { probabilities: Record<string, number> }>).category.probabilities.flour = 0.9;
  (badSum.answers as Record<string, { probabilities: Record<string, number> }>).category.probabilities.dairy_fat = 0.9;
  assert.throws(() => validateJevResponse("category", allowed, badSum), JevError);
});

test("the prompts name the three warehouses and every material group", () => {
  const instructions = routeInstructions();
  assert.ok(instructions.length > 5);
  const route = routeCriteria();
  assert.deepEqual(Object.keys(route).sort(), [...ROUTE_OPTIONS].sort());
  assert.ok(route.q7.includes("Q7"));
  assert.ok(route.tan_tao.includes("Tân Tạo"));
  assert.ok(route.non_stock.includes("Không nhập kho"));

  assert.ok(categoryInstructions().length > 5);
  const criteria = categoryCriteria(CATEGORIES);
  assert.equal(Object.keys(criteria).length, 11);
  for (const category of CATEGORIES) {
    assert.ok(criteria[category.code].length > 5, `criteria ${category.code}`);
  }
  for (const code of ["flour", "dairy_fat", "eggs", "sugar_additives", "meat_filling", "cheese", "vegetables", "packaging", "supplies", "service", "other"]) {
    assert.ok(MATERIAL_CATEGORY_CRITERIA[code], `missing criterion ${code}`);
  }
});

test("an empty api key fails closed and the request shape is pinned", async () => {
  assert.throws(() => createJevEvaluator({ apiKey: "" }), JevError);

  let seenBody: Record<string, unknown> = {};
  const allowed = allowedOptions("route", SUPPLIER_STATE);
  const evaluator = createJevEvaluator({
    apiKey: "server-key",
    fetcher: fetchFake(async (init) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(choiceAnswer("route", "q7", 0.9, allowed)), { status: 200 });
    }),
  });
  const evaluation = await evaluator({ mode: "route", state: SUPPLIER_STATE, signal: new AbortController().signal });
  assert.equal(evaluation.choice, "q7");
  assert.equal(seenBody.model, JEV_MODEL);
  const gateway = (seenBody.providerOptions as Record<string, Record<string, unknown>>).gateway;
  assert.equal(gateway.zeroDataRetention, true);
  assert.deepEqual(gateway.only, ["typesafe-ai"]);
  assert.equal(JEV_ENDPOINT, "https://ai-gateway.vercel.sh/v1/evaluate");
});

test("maps a 429 and a malformed body without retrying", async () => {
  const allowed = allowedOptions("route", SUPPLIER_STATE);
  let calls = 0;
  const rateLimited = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => {
      calls += 1;
      return new Response("slow down", { status: 429 });
    }),
  });
  await assert.rejects(
    () => rateLimited({ mode: "route", state: SUPPLIER_STATE, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_rate_limited" && error.status === 429,
  );
  assert.equal(calls, 1, "a 429 must not be retried");

  const malformed = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => new Response("not json", { status: 200 })),
  });
  await assert.rejects(
    () => malformed({ mode: "route", state: SUPPLIER_STATE, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_invalid_response",
  );
  assert.ok(allowed.length >= 2);
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
    () => hanging({ mode: "route", state: SUPPLIER_STATE, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_timeout",
  );

  let calls = 0;
  const allowed = allowedOptions("route", SUPPLIER_STATE);
  const evaluator = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => {
      calls += 1;
      return new Response(JSON.stringify(choiceAnswer("route", "q7", 0.9, allowed)), { status: 200 });
    }),
  });
  await assert.rejects(
    () => evaluator({ mode: "route", state: SUPPLIER_STATE, signal: new AbortController().signal, deadlineAt: Date.now() - 1 }),
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
    fetcher: fetchFake(async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    }),
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      () => evaluator({ mode: "route", state: SUPPLIER_STATE, signal: new AbortController().signal }),
      (error: unknown) => error instanceof JevError && error.code === "jev_http_error",
    );
  }
  assert.equal(circuit.isOpen(), true);
  await assert.rejects(
    () => evaluator({ mode: "route", state: SUPPLIER_STATE, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_circuit_open",
  );
  assert.equal(calls, 3, "the open circuit must not call the provider again");
});

test("the kill switch refuses the routing before any provider call", async () => {
  let calls = 0;
  const handler = createStockRoutingHandler({
    killSwitch: () => true,
    evaluator: () => async () => { calls += 1; throw new Error("must not be called"); },
    authenticate: async () => ({ userId: "owner-1", admin: true }),
    getUsage: async (usageDate) => ({ usage_date: usageDate, calls: 0, cost: 0, call_limit: 600 }),
    recordUsage: async () => {},
    listSupplierCandidates: async () => [],
    putSupplierSuggestion: async () => ({ id: "s1" }),
    applySupplierRouting: async () => ({}),
    listMaterialCandidates: async () => [],
    listCategories: async () => [],
    putMaterialSuggestion: async () => ({ id: "m1" }),
    decideMaterialCategory: async () => ({}),
    audit: () => {},
  });
  const response = await handler(new Request("https://edge.test/stock-routing-jev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "suppliers" }),
  }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "disabled");
  assert.equal(calls, 0);
});
