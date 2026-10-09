import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createJevCircuit,
  createJevEvaluator,
  JEV_ENDPOINT,
  JEV_MODEL,
  JevError,
  validateJevResponse,
} from "./jev.ts";

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

function fetchFake(handler: (init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) => handler(init)) as unknown as typeof fetch;
}

test("validates the documented two-answer response", () => {
  const evaluation = validateJevResponse(validBody());
  assert.equal(evaluation.p_same, 0.93);
  assert.equal(evaluation.relation, "same_purchase");
  assert.equal(evaluation.relation_probability, 0.88);
  assert.equal(evaluation.relation_confidence, 0.81);
  assert.equal(evaluation.cost, 0.00012);
  assert.deepEqual(evaluation.usage, { input: 100, output: 20 });
});

test("refuses a wrong model, missing answer, unknown or tied choice", () => {
  assert.throws(() => validateJevResponse(validBody({ model: "gpt" })), JevError);
  const missing = validBody();
  delete ((missing.answers as Record<string, unknown>).relation);
  assert.throws(() => validateJevResponse(missing), JevError);

  const tied = validBody({
    answers: {
      same_purchase: { type: "boolean", probability: 0.5 },
      relation: {
        type: "choice",
        choice: "same_purchase",
        probabilities: { same_purchase: 0.5, repeat_order: 0.5, split_or_partial: 0.0, unrelated: 0.0 },
      },
    },
  });
  assert.throws(() => validateJevResponse(tied), JevError);

  const unknown = validBody({
    answers: {
      same_purchase: { type: "boolean", probability: 0.5 },
      relation: {
        type: "choice",
        choice: "maybe",
        probabilities: { same_purchase: 0.5, repeat_order: 0.5, split_or_partial: 0.0, unrelated: 0.0 },
      },
    },
  });
  assert.throws(() => validateJevResponse(unknown), JevError);
});

test("refuses out-of-range probabilities, a bad distribution and bad usage", () => {
  const outOfRange = validBody({
    answers: {
      same_purchase: { type: "boolean", probability: 1.4 },
      relation: {
        type: "choice",
        choice: "same_purchase",
        probabilities: { same_purchase: 0.88, repeat_order: 0.1, split_or_partial: 0.02, unrelated: 0.0 },
      },
    },
  });
  assert.throws(() => validateJevResponse(outOfRange), JevError);

  const badSum = validBody({
    answers: {
      same_purchase: { type: "boolean", probability: 0.5 },
      relation: {
        type: "choice",
        choice: "same_purchase",
        probabilities: { same_purchase: 0.88, repeat_order: 0.1, split_or_partial: 0.02, unrelated: 0.5 },
      },
    },
  });
  assert.throws(() => validateJevResponse(badSum), JevError);

  const badUsage = validBody({ usage: { inputTokens: -1, outputTokens: 20 } });
  assert.throws(() => validateJevResponse(badUsage), JevError);

  const extraAnswer = validBody();
  ((extraAnswer.answers as Record<string, unknown>).something_else = { type: "boolean", probability: 0.5 });
  assert.throws(() => validateJevResponse(extraAnswer), JevError);
});

test("an empty api key fails closed", () => {
  assert.throws(() => createJevEvaluator({ apiKey: "" }), JevError);
});

test("sends the verified Gateway body and reads the result", async () => {
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  let seenAuth = "";
  const evaluator = createJevEvaluator({
    apiKey: "server-key",
    fetcher: fetchFake(async (init) => {
      seenBody = JSON.parse(String(init?.body));
      seenAuth = String((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify(validBody()), { status: 200 });
    }),
  });
  seenUrl = JEV_ENDPOINT;
  const evaluation = await evaluator({ state: { older: 1, newer: 2 }, signal: new AbortController().signal });
  assert.equal(evaluation.relation, "same_purchase");
  assert.equal(seenUrl, "https://ai-gateway.vercel.sh/v1/evaluate");
  assert.equal(seenBody.model, JEV_MODEL);
  const questions = seenBody.questions as Record<string, Record<string, unknown>>;
  assert.equal(questions.same_purchase.type, "boolean");
  assert.equal(questions.relation.type, "choice");
  const gateway = (seenBody.providerOptions as Record<string, Record<string, unknown>>).gateway;
  assert.equal(gateway.zeroDataRetention, true);
  assert.deepEqual(gateway.only, ["typesafe-ai"]);
  assert.equal(seenAuth, "Bearer server-key");
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
    () => rateLimited({ state: {}, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_rate_limited" && error.status === 429,
  );
  assert.equal(calls, 1, "a 429 must not be retried");

  const malformed = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => new Response("not json", { status: 200 })),
  });
  await assert.rejects(
    () => malformed({ state: {}, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_invalid_response",
  );
});

test("a stalled provider is a timeout, and an expired deadline never calls it", async () => {
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
    () => hanging({ state: {}, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_timeout",
  );

  let calls = 0;
  const evaluator = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => { calls += 1; return new Response(JSON.stringify(validBody()), { status: 200 }); }),
  });
  await assert.rejects(
    () => evaluator({ state: {}, signal: new AbortController().signal, deadlineAt: Date.now() - 1 }),
    (error: unknown) => error instanceof JevError && error.code === "jev_deadline_exceeded",
  );
  assert.equal(calls, 0);
});

test("the circuit opens after consecutive provider failures", async () => {
  const circuit = createJevCircuit({ threshold: 2 });
  let calls = 0;
  const evaluator = createJevEvaluator({
    apiKey: "k",
    circuit,
    fetcher: fetchFake(async () => { calls += 1; return new Response("boom", { status: 500 }); }),
  });
  await assert.rejects(
    () => evaluator({ state: {}, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_http_error",
  );
  await assert.rejects(
    () => evaluator({ state: {}, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_http_error",
  );
  await assert.rejects(
    () => evaluator({ state: {}, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_circuit_open",
  );
  assert.equal(calls, 2, "the open circuit must not call the provider again");
});
