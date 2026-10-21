// Offline tests for the shared Jev-only decisions adapter.
//
// Every provider call is an injected fetcher: no network, no paid request and no
// real key. No provider switch or environment key is read by the adapter.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DecisionsError,
  decisionsFailureCode,
  evaluateDecisions,
  type DecisionsEnvGetter,
} from "./decisions-provider.ts";
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  jevQuestions,
  validateJevResponse,
} from "../finance-jev-duplicate-scan/jev.ts";

const GATEWAY_BODY = {
  model: JEV_MODEL,
  state: { older: { number: "PC-1", amount: 1000 }, newer: { number: "PC-2", amount: 1000 } },
  questions: jevQuestions(),
  providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } },
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** The exact Gateway answer shape the finance validator accepts. */
function jevBody(): Record<string, unknown> {
  return {
    model: JEV_MODEL,
    answers: {
      same_purchase: { type: "boolean", probability: 0.93 },
      relation: {
        type: "choice",
        choice: "same_purchase",
        probabilities: { same_purchase: 0.88, repeat_order: 0.1, split_or_partial: 0.02, unrelated: 0.0 },
        confidence: 0.81,
      },
    },
    usage: { inputTokens: 100, outputTokens: 20 },
    providerMetadata: { gateway: { cost: "0.00012" } },
  };
}

function makeFetcher(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetcher, calls };
}

const options = (fetcher: typeof fetch, env?: DecisionsEnvGetter, overrides: Record<string, unknown> = {}) => ({
  fetcher,
  gatewayUrl: JEV_ENDPOINT,
  gatewayKey: "jev-server-key",
  timeoutMs: 200,
  env,
  ...overrides,
});

test("the exact original body is sent once to the Jev Gateway", async () => {
  const { fetcher, calls } = makeFetcher(async () => json(jevBody()));
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, () => undefined));

  assert.equal(outcome.provider, "typesafe");
  assert.equal(outcome.status, 200);
  assert.deepEqual(outcome.body, jevBody());
  assert.equal(outcome.images_used, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_ENDPOINT);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer jev-server-key");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), GATEWAY_BODY);

  const evaluation = validateJevResponse(outcome.body);
  assert.equal(evaluation.p_same, 0.93);
  assert.equal(evaluation.relation, "same_purchase");
});

test("an OPENAI_API_KEY in the injectable env is ignored", async () => {
  const { fetcher, calls } = makeFetcher(async () => json(jevBody()));
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, (name) =>
    name === "OPENAI_API_KEY" ? "sk-test-key" : undefined));

  assert.equal(outcome.provider, "typesafe");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_ENDPOINT);
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer jev-server-key");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), GATEWAY_BODY);
});

test("images are ignored and the gateway request stays text-only", async () => {
  const { fetcher, calls } = makeFetcher(async () => json(jevBody()));
  const images = [
    { mime: "image/jpeg", base64: "AAA111" },
    { mime: "image/png", base64: "BBB222" },
  ];
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, () => undefined, { images }));

  assert.equal(outcome.provider, "typesafe");
  assert.equal(outcome.images_used, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), GATEWAY_BODY);
});

test("a gateway HTTP error keeps its status, detail and typesafe provider", async () => {
  const { fetcher } = makeFetcher(async () => new Response("slow down", { status: 429 }));
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, () => undefined));
  assert.equal(outcome.provider, "typesafe");
  assert.equal(outcome.status, 429);
  assert.equal(outcome.body, "slow down");
  assert.equal(outcome.images_used, false);
});

test("a malformed 200 response is an invalid_response transport error", async () => {
  const { fetcher } = makeFetcher(async () => new Response("not json", { status: 200 }));
  await assert.rejects(
    () => evaluateDecisions(GATEWAY_BODY, options(fetcher, () => undefined)),
    (error: unknown) => error instanceof DecisionsError && error.code === "invalid_response" && decisionsFailureCode(error) === "jev_invalid_response",
  );
});

test("a stalled gateway call is a timeout, never a fallback", async () => {
  const { fetcher, calls } = makeFetcher((_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  await assert.rejects(
    () => evaluateDecisions(GATEWAY_BODY, options(fetcher, () => undefined, { timeoutMs: 30 })),
    (error: unknown) => error instanceof DecisionsError && error.code === "timeout" && decisionsFailureCode(error) === "jev_timeout",
  );
  assert.equal(calls.length, 1);
});

test("a gateway transport failure is unavailable", async () => {
  const { fetcher } = makeFetcher(async () => { throw new TypeError("network down"); });
  await assert.rejects(
    () => evaluateDecisions(GATEWAY_BODY, options(fetcher, () => undefined)),
    (error: unknown) => error instanceof DecisionsError && error.code === "unavailable" && decisionsFailureCode(error) === "jev_unavailable",
  );
});

test("a parent cancellation propagates and never becomes a provider error", async () => {
  const controller = new AbortController();
  const { fetcher, calls } = makeFetcher((_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  const pending = evaluateDecisions(GATEWAY_BODY, options(fetcher, () => undefined, { timeoutMs: 5000, signal: controller.signal }));
  setTimeout(() => controller.abort(), 5);

  await assert.rejects(() => pending, (error: unknown) => (error as Error)?.name === "AbortError");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_ENDPOINT);
});

test("a non-object gateway body is rejected before any call", async () => {
  const { fetcher, calls } = makeFetcher(async () => json(jevBody()));
  await assert.rejects(
    () => evaluateDecisions("not-an-object", options(fetcher, () => undefined)),
    (error: unknown) => error instanceof DecisionsError && error.code === "invalid_response",
  );
  assert.equal(calls.length, 0);
});
