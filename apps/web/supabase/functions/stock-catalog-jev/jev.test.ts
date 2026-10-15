import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createJevCircuit,
  createJevEvaluator,
  ITEM_CLASS_CRITERIA,
  JEV_ENDPOINT,
  JEV_MODEL,
  jevQuestions,
  JevError,
  STOCK_ITEM_CLASS_OPTIONS,
  validateJevResponse,
} from "./jev.ts";

function validSameItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: JEV_MODEL,
    answers: { same_item: { type: "boolean", probability: 0.93 } },
    usage: { inputTokens: 100, outputTokens: 20 },
    providerMetadata: { gateway: { cost: "0.00012" } },
    ...overrides,
  };
}

function validClassify(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: JEV_MODEL,
    answers: {
      item_class: {
        type: "choice",
        choice: "raw_material",
        probabilities: { raw_material: 0.82, packaging_supply: 0.1, finished_goods: 0.05, non_stock: 0.03 },
        confidence: 0.79,
      },
    },
    usage: { inputTokens: 80, outputTokens: 12 },
    providerMetadata: { gateway: { cost: "0.00010" } },
    ...overrides,
  };
}

function fetchFake(handler: (init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) => handler(init)) as unknown as typeof fetch;
}

test("validates the boolean same_item answer", () => {
  const evaluation = validateJevResponse("same_item", validSameItem());
  assert.equal(evaluation.mode, "same_item");
  assert.equal(evaluation.p_same, 0.93);
  assert.equal(evaluation.item_class, null);
  assert.equal(evaluation.cost, 0.00012);
  assert.deepEqual(evaluation.usage, { input: 100, output: 20 });
});

test("validates the choice item_class answer", () => {
  const evaluation = validateJevResponse("item_class", validClassify());
  assert.equal(evaluation.mode, "item_class");
  assert.equal(evaluation.item_class, "raw_material");
  assert.equal(evaluation.class_probability, 0.82);
  assert.equal(evaluation.class_confidence, 0.79);
  assert.equal(evaluation.p_same, null);
});

test("the item_class prompt defines all four classes with Vietnamese criteria", () => {
  assert.deepEqual(Object.keys(ITEM_CLASS_CRITERIA).sort(), [...STOCK_ITEM_CLASS_OPTIONS].sort());
  const questions = jevQuestions("item_class");
  const criteria = questions.item_class.criteria as Record<string, string>;
  assert.deepEqual(Object.keys(criteria).sort(), [...STOCK_ITEM_CLASS_OPTIONS].sort());
  for (const option of STOCK_ITEM_CLASS_OPTIONS) {
    assert.equal(typeof criteria[option], "string");
    assert.ok(criteria[option].length > 10, `${option} needs a Vietnamese description`);
  }
  const sameItem = jevQuestions("same_item");
  assert.equal(sameItem.same_item.type, "boolean");
  assert.ok(sameItem.same_item.criteria.false.includes("Bột mì 888"));
});

test("refuses a wrong model, missing answer and cross-mode answer", () => {
  assert.throws(() => validateJevResponse("same_item", validSameItem({ model: "gpt" })), JevError);
  assert.throws(() => validateJevResponse("same_item", validClassify()), JevError);
  assert.throws(() => validateJevResponse("item_class", validSameItem()), JevError);
  const missing = validSameItem();
  delete (missing.answers as Record<string, unknown>).same_item;
  assert.throws(() => validateJevResponse("same_item", missing), JevError);
});

test("refuses a tied or unknown item_class choice and a bad distribution", () => {
  const tied = validClassify({
    answers: {
      item_class: {
        type: "choice",
        choice: "raw_material",
        probabilities: { raw_material: 0.5, packaging_supply: 0.5, finished_goods: 0.0, non_stock: 0.0 },
      },
    },
  });
  assert.throws(() => validateJevResponse("item_class", tied), JevError);

  const unknown = validClassify({
    answers: {
      item_class: {
        type: "choice",
        choice: "maybe",
        probabilities: { raw_material: 0.5, packaging_supply: 0.5, finished_goods: 0.0, non_stock: 0.0 },
      },
    },
  });
  assert.throws(() => validateJevResponse("item_class", unknown), JevError);

  const badSum = validClassify({
    answers: {
      item_class: {
        type: "choice",
        choice: "raw_material",
        probabilities: { raw_material: 0.8, packaging_supply: 0.1, finished_goods: 0.05, non_stock: 0.4 },
      },
    },
  });
  assert.throws(() => validateJevResponse("item_class", badSum), JevError);
});

test("refuses out-of-range probabilities and bad usage", () => {
  const outOfRange = validSameItem({
    answers: { same_item: { type: "boolean", probability: 1.4 } },
  });
  assert.throws(() => validateJevResponse("same_item", outOfRange), JevError);
  const badUsage = validSameItem({ usage: { inputTokens: -1, outputTokens: 20 } });
  assert.throws(() => validateJevResponse("same_item", badUsage), JevError);

  const extraAnswer = validSameItem();
  ((extraAnswer.answers as Record<string, unknown>).item_class = { type: "boolean", probability: 0.5 });
  assert.throws(() => validateJevResponse("same_item", extraAnswer), JevError);
});

test("an empty api key fails closed", () => {
  assert.throws(() => createJevEvaluator({ apiKey: "" }), JevError);
});

test("sends one mode-specific question and reads the result", async () => {
  let seenBody: Record<string, unknown> = {};
  let seenAuth = "";
  const evaluator = createJevEvaluator({
    apiKey: "server-key",
    fetcher: fetchFake(async (init) => {
      seenBody = JSON.parse(String(init?.body));
      seenAuth = String((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify(validSameItem()), { status: 200 });
    }),
  });
  const evaluation = await evaluator({
    mode: "same_item",
    state: { a: { name: "Bột mì" }, b: { name: "Bột mì" } },
    signal: new AbortController().signal,
  });
  assert.equal(evaluation.p_same, 0.93);
  assert.equal(seenBody.model, JEV_MODEL);
  const questions = seenBody.questions as Record<string, unknown>;
  assert.deepEqual(Object.keys(questions), ["same_item"]);
  const gateway = (seenBody.providerOptions as Record<string, Record<string, unknown>>).gateway;
  assert.equal(gateway.zeroDataRetention, true);
  assert.deepEqual(gateway.only, ["typesafe-ai"]);
  assert.equal(seenAuth, "Bearer server-key");
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
    () => rateLimited({ mode: "same_item", state: {}, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_rate_limited" && error.status === 429,
  );
  assert.equal(calls, 1, "a 429 must not be retried");

  const malformed = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => new Response("not json", { status: 200 })),
  });
  await assert.rejects(
    () => malformed({ mode: "item_class", state: {}, signal: new AbortController().signal }),
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
    () => hanging({ mode: "same_item", state: {}, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_timeout",
  );

  let calls = 0;
  const evaluator = createJevEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () => { calls += 1; return new Response(JSON.stringify(validSameItem()), { status: 200 }); }),
  });
  await assert.rejects(
    () => evaluator({ mode: "same_item", state: {}, signal: new AbortController().signal, deadlineAt: Date.now() - 1 }),
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
      () => evaluator({ mode: "same_item", state: {}, signal: new AbortController().signal }),
      (error: unknown) => error instanceof JevError && error.code === "jev_http_error",
    );
  }
  assert.equal(circuit.isOpen(), true);
  await assert.rejects(
    () => evaluator({ mode: "same_item", state: {}, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_circuit_open",
  );
  assert.equal(calls, 3, "the open circuit must not call the provider again");
});

test("past human corrections are appended to the question text", () => {
  const corrections = ["Người duyệt đã sửa trước đây: Bơ → không dùng nhóm raw_material"];
  const sameItem = jevQuestions("same_item", corrections);
  assert.ok((sameItem.same_item.instructions as string).includes(corrections[0]));
  const itemClass = jevQuestions("item_class", corrections);
  assert.ok((itemClass.item_class.instructions as string).includes(corrections[0]));
  assert.ok(!(jevQuestions("same_item").same_item.instructions as string).includes(corrections[0]));
});
