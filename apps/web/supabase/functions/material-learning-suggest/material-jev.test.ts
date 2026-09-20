// Offline transport tests for the Material candidate evaluator.
// Every provider call is an injected fetcher: no network, no paid request and no
// real BMQ data. The verified Gateway endpoint/model and zero-data-retention
// provider options are asserted from the captured request body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JEV_ENDPOINT, createJevCircuit } from "../bmq-analytics/jev.ts";
import {
  MATERIAL_JEV_BODY_LIMIT,
  createMaterialJevEvaluator,
} from "./material-jev.ts";
import { MaterialSuggestError, type CandidateMaterial } from "./material-suggest.ts";

const CANDIDATES: CandidateMaterial[] = [
  { id: "mat_bo", material_code: "NVL-BO", canonical_name: "Bơ", normalized_name: "bo", default_unit: "kg", category: null, brand: null, specification: null, active: true },
  { id: "mat_peanut", material_code: "NVL-DAU", canonical_name: "Đậu phộng", normalized_name: "dau phong", default_unit: "kg", category: null, brand: "BMQ", specification: null, active: true },
];
const signal = () => new AbortController().signal;
const input = { raw_name: "Đậu phộng", raw_unit: "kg", supplier_name: "TV Food", candidates: CANDIDATES };

function bodyFor(refs: string[], choice: string) {
  const all = [...refs, "none", "ambiguous"];
  const other = all.length > 1 ? 0.1 / (all.length - 1) : 0;
  const probabilities = Object.fromEntries(all.map((key) => [key, key === choice ? 0.9 : other]));
  return { model: "typesafe-ai/jev", answers: { material: { type: "choice", choice, probabilities } }, usage: { inputTokens: 12, outputTokens: 4 }, providerMetadata: { gateway: { cost: "0.00001" } } };
}

function fetcherFor(body: unknown, capture?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    capture?.(String(url), init ?? {});
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("an unconfigured server key fails closed instead of calling the provider", () => {
  assert.throws(
    () => createMaterialJevEvaluator({ apiKey: "" }),
    (error: unknown) => error instanceof MaterialSuggestError && error.code === "material_jev_unconfigured",
  );
});

test("a valid choice maps back to the offered canonical id and keeps the ZDR gateway contract", async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const evaluator = createMaterialJevEvaluator({ apiKey: "server-key", fetcher: fetcherFor(bodyFor(["c0", "c1"], "c1"), (url, init) => { captured = { url, init }; }) });
  const evaluation = await evaluator(input, signal());
  assert.equal(evaluation.choice, "mat_peanut");
  assert.ok(evaluation.probability > 0.5);

  assert.ok(captured);
  const body = JSON.parse(String(captured.init.body));
  assert.equal(captured.url, JEV_ENDPOINT);
  assert.equal(body.model, "typesafe-ai/jev");
  assert.deepEqual(body.providerOptions, { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } });
  assert.equal((captured.init.headers as Record<string, string>).Authorization, "Bearer server-key");
  // Only minimum material descriptors and supplier context leave the server.
  assert.equal(body.state.request.raw_name, "Đậu phộng");
  assert.equal(body.state.supplier, "TV Food");
  for (const candidate of body.state.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ["brand", "category", "code", "name", "ref", "specification", "unit"]);
  }
});

test("none and ambiguous tokens pass through, but an id outside the offered set is refused", async () => {
  const none = createMaterialJevEvaluator({ apiKey: "k", fetcher: fetcherFor(bodyFor(["c0", "c1"], "none")) });
  assert.equal((await none(input, signal())).choice, "none");

  const ambiguous = createMaterialJevEvaluator({ apiKey: "k", fetcher: fetcherFor(bodyFor(["c0", "c1"], "ambiguous")) });
  assert.equal((await ambiguous(input, signal())).choice, "ambiguous");

  const outside = createMaterialJevEvaluator({ apiKey: "k", fetcher: fetcherFor(bodyFor(["c0", "c1"], "c9")) });
  await assert.rejects(() => outside(input, signal()), (error: unknown) => error instanceof MaterialSuggestError && error.code === "material_jev_invalid_response");
});

test("a tied or malformed answer, a rate limit and an oversized body are all refused", async () => {
  const tied = {
    model: "typesafe-ai/jev",
    answers: { material: { type: "choice", choice: "c0", probabilities: { c0: 0.5, c1: 0.5, none: 0, ambiguous: 0 } } },
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const tiedEvaluator = createMaterialJevEvaluator({ apiKey: "k", fetcher: fetcherFor(tied) });
  await assert.rejects(() => tiedEvaluator(input, signal()), (error: unknown) => error instanceof MaterialSuggestError && error.code === "material_jev_invalid_response");

  const limited = (async () => new Response("", { status: 429 })) as typeof fetch;
  const limitedEvaluator = createMaterialJevEvaluator({ apiKey: "k", fetcher: limited });
  await assert.rejects(() => limitedEvaluator(input, signal()), (error: unknown) => error instanceof MaterialSuggestError && error.code === "material_jev_rate_limited");

  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MATERIAL_JEV_BODY_LIMIT + 1)); controller.close(); } });
  const oversized = (async () => new Response(stream, { status: 200 })) as typeof fetch;
  const oversizedEvaluator = createMaterialJevEvaluator({ apiKey: "k", fetcher: oversized });
  await assert.rejects(() => oversizedEvaluator(input, signal()), (error: unknown) => error instanceof MaterialSuggestError && error.code === "material_jev_invalid_response");
});

test("a stalled provider is bounded by the timeout and never opens on an aborted parent", async () => {
  const hanging = (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const requestSignal = init?.signal as AbortSignal | undefined;
    requestSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  const timed = createMaterialJevEvaluator({ apiKey: "k", fetcher: hanging, timeoutMs: 20 });
  await assert.rejects(() => timed(input, signal()), (error: unknown) => error instanceof MaterialSuggestError && error.code === "material_jev_timeout");

  let called = false;
  const never = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
  const abortedEvaluator = createMaterialJevEvaluator({ apiKey: "k", fetcher: never });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => abortedEvaluator(input, controller.signal));
  assert.equal(called, false);
});

test("consecutive provider failures open the shared circuit and skip the provider", async () => {
  const circuit = createJevCircuit({ threshold: 2 });
  let calls = 0;
  const failing = (async () => { calls += 1; return new Response("", { status: 500 }); }) as typeof fetch;
  const evaluator = createMaterialJevEvaluator({ apiKey: "k", fetcher: failing, circuit });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(() => evaluator(input, signal()), (error: unknown) => error instanceof MaterialSuggestError && error.code === "material_jev_http_error");
  }
  await assert.rejects(() => evaluator(input, signal()), (error: unknown) => error instanceof MaterialSuggestError && error.code === "material_jev_circuit_open");
  assert.equal(calls, 2);
});
