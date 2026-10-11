// Offline handler tests: permission gate, kill switch, request grammar, the two
// routing thresholds, the rule_hint conflict guard, the manual-location skip and
// the shared daily Jev quota. Jev itself is a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStockRoutingHandler,
  StockRoutingError,
  type MaterialCategoryCandidate,
  type MaterialCategoryRow,
  type StockRoutingHandlerDeps,
  type StockRoutingUsage,
  type SupplierRoutingCandidate,
} from "./handler.ts";
import { createJevEvaluator, JEV_MODEL, MATERIAL_CATEGORY_CRITERIA } from "./jev.ts";

const CATEGORY_ROWS: MaterialCategoryRow[] = Object.keys(MATERIAL_CATEGORY_CRITERIA)
  .map((code, index) => ({ code, label_vi: code, sort_order: (index + 1) * 10 }));

const SUPPLIER: SupplierRoutingCandidate = {
  supplier_id: "11111111-1111-4111-8111-111111111111",
  receipt_count: 2,
  manual: false,
  evidence: {
    supplier_id: "11111111-1111-4111-8111-111111111111",
    supplier_name: "NCC A",
    category: "Flour",
    receipt_count: 2,
    top_items: [{ name: "Bột mì 888", line_count: 2 }],
    rule_hint: "q7",
  },
};

const MANUAL_SUPPLIER: SupplierRoutingCandidate = {
  ...SUPPLIER,
  manual: true,
  evidence: { ...SUPPLIER.evidence, supplier_id: "22222222-2222-4222-8222-222222222222", supplier_name: "NCC thủ công" },
};

const MATERIAL: MaterialCategoryCandidate = {
  material_id: "33333333-3333-4333-8333-333333333333",
  material_code: "NVL-BOT-MI",
  canonical_name: "Bột mì 888",
  default_unit: "kg",
  alias_names: ["Bột mì 888", "Bột mì đa dụng"],
};

function choiceAnswer(key: string, choice: string, probability: number, options: readonly string[]) {
  const probabilities: Record<string, number> = {};
  for (const option of options) probabilities[option] = 0;
  probabilities[choice] = probability;
  const rest = options.filter((option) => option !== choice);
  if (rest.length > 0) {
    const share = Number(((1 - probability) / rest.length).toFixed(4));
    for (const option of rest) probabilities[option] = share;
  }
  return {
    model: JEV_MODEL,
    answers: { [key]: { type: "choice", choice, probabilities, confidence: 0.9 } },
    usage: { inputTokens: 10, outputTokens: 5 },
    providerMetadata: { gateway: { cost: "0.0001" } },
  };
}

function fetchFake(handler: (init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) => handler(init)) as unknown as typeof fetch;
}

/** A real evaluator whose provider is a fake fetch returning `choice`. */
function evaluatorFor(choice: string, probability: number, onCall?: () => void) {
  return createJevEvaluator({
    apiKey: "test-key",
    fetcher: fetchFake(async (init) => {
      onCall?.();
      const body = JSON.parse(String(init?.body)) as {
        questions: Record<string, { criteria: Record<string, string> }>;
      };
      const key = body.questions.route ? "route" : "category";
      const options = Object.keys(body.questions[key].criteria);
      const chosen = options.includes(choice) ? choice : options[0];
      return new Response(JSON.stringify(choiceAnswer(key, chosen, probability, options)), { status: 200 });
    }),
  });
}

interface Recorder {
  applied: { supplierId: string; location: string; source: string; suggestionId: string }[];
  decided: { suggestionId: string; action: "approve" | "reject" }[];
  suggestions: number;
}

function makeDeps(overrides: Partial<StockRoutingHandlerDeps> = {}) {
  const recorder: Recorder = { applied: [], decided: [], suggestions: 0 };
  const usageRecords: StockRoutingUsage[] = [];
  const defaults: StockRoutingHandlerDeps = {
    killSwitch: () => false,
    evaluator: () => evaluatorFor("q7", 0.95),
    authenticate: async () => ({ userId: "owner-1", admin: true }),
    getUsage: async (usageDate) => ({ usage_date: usageDate, calls: 0, cost: 0, call_limit: 600 }),
    recordUsage: async (usage) => { usageRecords.push(usage); },
    listSupplierCandidates: async () => [SUPPLIER],
    putSupplierSuggestion: async () => { recorder.suggestions += 1; return { id: `s-${recorder.suggestions}` }; },
    applySupplierRouting: async (supplierId, location, source, suggestionId) => {
      recorder.applied.push({ supplierId, location, source, suggestionId });
      return {};
    },
    listMaterialCandidates: async () => [MATERIAL],
    listCategories: async () => CATEGORY_ROWS,
    putMaterialSuggestion: async () => { recorder.suggestions += 1; return { id: `m-${recorder.suggestions}` }; },
    decideMaterialCategory: async (suggestionId, action) => {
      recorder.decided.push({ suggestionId, action });
      return {};
    },
    now: () => new Date("2026-10-17T00:00:00.000Z"),
    audit: () => {},
  };
  return { deps: { ...defaults, ...overrides }, recorder, usageRecords };
}

function request(body: unknown, contentType = "application/json") {
  return new Request("https://edge.test/stock-routing-jev", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

test("CORS preflight and method are bounded", async () => {
  const handler = createStockRoutingHandler(makeDeps().deps);
  const preflight = await handler(new Request("https://edge.test/stock-routing-jev", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal((await handler(new Request("https://edge.test", { method: "GET" }))).status, 405);
});

test("a kill switch, an unauthorized session and a non-admin are refused", async () => {
  const killed = createStockRoutingHandler(makeDeps({ killSwitch: () => true }).deps);
  const killedResponse = await killed(request({ mode: "suppliers" }));
  assert.equal(killedResponse.status, 503);
  assert.equal((await killedResponse.json()).code, "disabled");

  const unauthorized = createStockRoutingHandler(makeDeps({
    authenticate: async () => { throw new StockRoutingError("unauthorized", 401); },
  }).deps);
  assert.equal((await unauthorized(request({ mode: "suppliers" }))).status, 401);

  const forbidden = createStockRoutingHandler(makeDeps({
    authenticate: async () => ({ userId: "staff-1", admin: false }),
  }).deps);
  const forbiddenResponse = await forbidden(request({ mode: "suppliers" }));
  assert.equal(forbiddenResponse.status, 403);
  assert.equal((await forbiddenResponse.json()).code, "forbidden");
});

test("the request grammar is validated", async () => {
  const handler = createStockRoutingHandler(makeDeps().deps);
  assert.equal((await handler(request({ mode: "delete" }))).status, 400);
  assert.equal((await handler(request({ mode: "suppliers", extra: 1 }))).status, 400);
  assert.equal((await handler(request({ mode: "suppliers", limit: 0 }))).status, 400);
  assert.equal((await handler(request({ mode: "suppliers" }, "text/plain"))).status, 415);
});

test("suppliers auto-apply at >= 0.9 when the rule_hint agrees", async () => {
  const { deps, recorder } = makeDeps();
  const handler = createStockRoutingHandler(deps);
  const response = await handler(request({ mode: "suppliers" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "suppliers");
  assert.equal(body.suggestions, 1);
  assert.equal(body.applied, 1);
  assert.equal(body.pending, 0);
  assert.equal(recorder.applied.length, 1);
  assert.equal(recorder.applied[0].location, "q7");
  assert.equal(recorder.applied[0].source, "jev");
});

test("a rule_hint conflict leaves the supplier pending", async () => {
  const { deps, recorder } = makeDeps({ evaluator: () => evaluatorFor("tan_tao", 0.95) });
  const handler = createStockRoutingHandler(deps);
  const body = await (await handler(request({ mode: "suppliers" }))).json();
  assert.equal(body.applied, 0);
  assert.equal(body.pending, 1);
  assert.equal(recorder.applied.length, 0);
});

test("a supplier with a manual warehouse is skipped", async () => {
  let calls = 0;
  const { deps, recorder } = makeDeps({
    listSupplierCandidates: async () => [MANUAL_SUPPLIER],
    evaluator: () => evaluatorFor("q7", 0.95, () => { calls += 1; }),
  });
  const handler = createStockRoutingHandler(deps);
  const body = await (await handler(request({ mode: "suppliers" }))).json();
  assert.equal(body.suggestions, 0);
  assert.equal(calls, 0);
  assert.equal(recorder.suggestions, 0);
});

test("materials auto-apply at >= 0.85 and stay pending below", async () => {
  const auto = makeDeps({ evaluator: () => evaluatorFor("flour", 0.9) });
  const autoBody = await (await createStockRoutingHandler(auto.deps)(request({ mode: "materials" }))).json();
  assert.equal(autoBody.mode, "materials");
  assert.equal(autoBody.applied, 1);
  assert.equal(autoBody.pending, 0);
  assert.equal(auto.recorder.decided.length, 1);
  assert.equal(auto.recorder.decided[0].action, "approve");

  const pending = makeDeps({ evaluator: () => evaluatorFor("flour", 0.8) });
  const pendingBody = await (await createStockRoutingHandler(pending.deps)(request({ mode: "materials" }))).json();
  assert.equal(pendingBody.applied, 0);
  assert.equal(pendingBody.pending, 1);
  assert.equal(pending.recorder.decided.length, 0);
});

test("an exhausted daily quota stops before any Jev call", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    getUsage: async (usageDate) => ({ usage_date: usageDate, calls: 600, cost: 1, call_limit: 600 }),
    evaluator: () => evaluatorFor("q7", 0.95, () => { calls += 1; }),
  });
  const handler = createStockRoutingHandler(deps);
  const body = await (await handler(request({ mode: "suppliers" }))).json();
  assert.equal(body.calls, 0);
  assert.equal(body.applied, 0);
  assert.equal(body.stopped, "daily_limit");
  assert.equal(calls, 0, "an exhausted quota must never call Jev");
});
