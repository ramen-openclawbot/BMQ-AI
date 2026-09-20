// Offline handler tests: owner gate, feature flag, request grammar, rate limit,
// concurrent double-click protection and the read-only success path.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMaterialLearningSuggestHandler,
  type MaterialSuggestConfig,
  type MaterialSuggestIdentity,
} from "./handler.ts";
import {
  MaterialSuggestError,
  type CandidateMaterial,
  type MaterialMatchInput,
} from "./material-suggest.ts";

const REQUEST_ID = "11111111-1111-1111-1111-111111111111";
const MATERIALS: CandidateMaterial[] = [
  { id: "mat_bo", material_code: "NVL-BO", canonical_name: "Bơ", normalized_name: "bo", default_unit: "kg", category: null, brand: null, specification: null, active: true },
];

function matchInput(overrides: Partial<MaterialMatchInput> = {}): MaterialMatchInput {
  return {
    request_id: REQUEST_ID, raw_name: "Bơ", raw_code: null, raw_unit: null,
    supplier_id: null, supplier_name: null, source_type: "payment_request",
    materials: MATERIALS, scoped_aliases: [], supplier_products: [], ...overrides,
  };
}

function identity(overrides: Partial<MaterialSuggestIdentity> = {}): MaterialSuggestIdentity {
  return { userId: "owner-1", dataSource: { loadMatchInput: async () => matchInput() }, ...overrides };
}

function config(overrides: Partial<MaterialSuggestConfig> = {}): MaterialSuggestConfig {
  return { enabled: () => true, evaluator: () => null, authenticate: async () => identity(), audit: () => {}, ...overrides };
}

function request(body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  return new Request("https://edge.test/material-learning-suggest", { method: "POST", headers, body: JSON.stringify(body) });
}

test("CORS preflight, method and origin are bounded", async () => {
  const handler = createMaterialLearningSuggestHandler(config());
  const preflight = await handler(new Request("https://edge.test", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal((await handler(new Request("https://edge.test", { method: "GET" }))).status, 405);
  const denied = await handler(request({ request_id: REQUEST_ID }, { origin: "https://evil.test", "content-type": "application/json" }));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "origin_forbidden");
});

test("a disabled feature and a non-owner session are visible and never reach the provider", async () => {
  const disabled = createMaterialLearningSuggestHandler(config({ enabled: () => false }));
  const disabledResponse = await disabled(request({ request_id: REQUEST_ID }));
  assert.equal(disabledResponse.status, 503);
  assert.equal((await disabledResponse.json()).code, "disabled");

  const forbidden = createMaterialLearningSuggestHandler(config({ authenticate: async () => { throw new MaterialSuggestError("forbidden", 403); } }));
  const forbiddenResponse = await forbidden(request({ request_id: REQUEST_ID }));
  assert.equal(forbiddenResponse.status, 403);
  assert.equal((await forbiddenResponse.json()).code, "forbidden");
});

test("the request grammar rejects a missing id, an extra field and a wrong content type", async () => {
  const handler = createMaterialLearningSuggestHandler(config());
  assert.equal((await handler(request({ request_id: 42 }))).status, 400);
  assert.equal((await handler(request({ request_id: "x", sql: "select 1" }))).status, 400);
  assert.equal((await handler(request({ request_id: REQUEST_ID }, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await handler(request({ request_id: "not-a-uuid" }))).status, 400);
});

test("the success path is read-only, reviewable and audited without raw business text", async () => {
  const audited: string[] = [];
  const handler = createMaterialLearningSuggestHandler(config({ audit: (event) => audited.push(JSON.stringify(event)) }));
  const response = await handler(request({ request_id: REQUEST_ID }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome, "exact");
  assert.equal(body.requires_review, true);
  assert.equal(body.used_jev, false);
  assert.ok(audited.some((line) => line.includes("material_learning_suggest") && line.includes("exact")));
  assert.equal(audited.some((line) => line.includes("Bơ")), false, "audit must not carry the raw request name");
});

test("a per-user rate limit and concurrent double-click protection return explicit codes", async () => {
  const handler = createMaterialLearningSuggestHandler(config());
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal((await handler(request({ request_id: REQUEST_ID }))).status, 200);
  }
  const limited = await handler(request({ request_id: REQUEST_ID }));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "rate_limited");

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = createMaterialLearningSuggestHandler(config({
    authenticate: async () => identity({ dataSource: { loadMatchInput: async () => { await gate; return matchInput(); } } }),
  }));
  const first = slow(request({ request_id: REQUEST_ID }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await slow(request({ request_id: REQUEST_ID }));
  assert.equal(second.status, 429);
  assert.equal((await second.json()).code, "busy");
  release();
  assert.equal((await first).status, 200);
});
