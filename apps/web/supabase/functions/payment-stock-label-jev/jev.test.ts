import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildStockLabelState,
  createJevCircuit,
  createStockLabelEvaluator,
  isStockLabelClass,
  JEV_ENDPOINT,
  JEV_MODEL,
  JevError,
  PAYMENT_STOCK_LABEL_PROMPT_VERSION,
  reasonForClass,
  STOCK_LABEL_CRITERIA,
  STOCK_LABEL_INSTRUCTIONS,
  STOCK_LABEL_QUESTION_KEY,
  STOCK_LABEL_REASON_MAX,
  stockLabelQuestion,
  validateStockLabelAnswer,
  type StockLabelCandidate,
} from "./jev.ts";

const CANDIDATE: StockLabelCandidate = {
  request_id: "11111111-1111-4111-8111-111111111111",
  supplier_id: "22222222-2222-4222-8222-222222222222",
  supplier_name: "NCC Bột",
  title: "Đề nghị chi - Bột mì 888",
  description: "Nhập bột cho bếp",
  total_amount: 250000,
  vat_amount: 0,
  item_names: ["Bột mì 888", "Bột năng"],
  manual_examples: [
    {
      title: "Đề nghị chi - Bột mì",
      description: "Nhập kho",
      requires_receipt: true,
      item_names: ["Bột mì"],
    },
  ],
};

function choiceAnswer(
  choice: string,
  probability: number,
  extras: Record<string, unknown> = {},
) {
  const probabilities: Record<string, number> = { stock: 0, non_stock: 0 };
  probabilities[choice] = probability;
  return {
    model: JEV_MODEL,
    answers: {
      [STOCK_LABEL_QUESTION_KEY]: {
        type: "choice",
        choice,
        probabilities,
        ...extras,
      },
    },
    usage: { inputTokens: 100, outputTokens: 20 },
    providerMetadata: { gateway: { cost: "0.00012" } },
  };
}

function fetchFake(handler: (init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) => handler(init)) as unknown as typeof fetch;
}

test("the question offers exactly stock and non_stock in Vietnamese", () => {
  assert.equal(PAYMENT_STOCK_LABEL_PROMPT_VERSION, "payment-stock-label-2026-10-26.1");
  assert.ok(STOCK_LABEL_INSTRUCTIONS.includes("hàng hóa"));
  assert.ok(STOCK_LABEL_INSTRUCTIONS.includes("dịch vụ"));
  assert.ok(STOCK_LABEL_INSTRUCTIONS.includes("non_stock"));
  assert.deepEqual(Object.keys(STOCK_LABEL_CRITERIA), ["stock", "non_stock"]);
  assert.ok(STOCK_LABEL_CRITERIA.stock.includes("nhập kho"));
  assert.ok(STOCK_LABEL_CRITERIA.non_stock.includes("thuế"));
  assert.ok(isStockLabelClass("stock"));
  assert.equal(isStockLabelClass("other"), false);

  const questions = stockLabelQuestion() as Record<
    string,
    { type: string; criteria: Record<string, string> }
  >;
  assert.equal(questions[STOCK_LABEL_QUESTION_KEY].type, "choice");
  assert.deepEqual(Object.keys(questions[STOCK_LABEL_QUESTION_KEY].criteria), ["stock", "non_stock"]);
});

test("the state carries the request and up to five same-supplier manual examples", () => {
  const state = buildStockLabelState(CANDIDATE);
  assert.equal(state.request.supplier, "NCC Bột");
  assert.equal(state.request.title, "Đề nghị chi - Bột mì 888");
  assert.equal(state.request.total_amount, 250000);
  assert.deepEqual(state.request.items, ["Bột mì 888", "Bột năng"]);
  assert.equal(state.manual_examples.length, 1);
  assert.equal(state.manual_examples[0].requires_receipt, true);
  assert.deepEqual(state.manual_examples[0].items, ["Bột mì"]);

  const many = buildStockLabelState({
    ...CANDIDATE,
    manual_examples: Array.from({ length: 8 }, (_value, index) => ({
      title: `Phiếu ${index}`,
      description: null,
      requires_receipt: index % 2 === 0,
      item_names: [],
    })),
  });
  assert.equal(many.manual_examples.length, 5);
});

test("validates the choice into {class, confidence, reason}", () => {
  const valid = validateStockLabelAnswer(choiceAnswer("stock", 0.96, { confidence: 0.93 }));
  assert.ok(valid);
  assert.equal(valid.class, "stock");
  assert.equal(valid.confidence, 0.93);
  assert.equal(valid.reason, reasonForClass("stock"));
  assert.ok(valid.reason.length <= STOCK_LABEL_REASON_MAX);
  assert.equal(valid.cost, 0.00012);
  assert.deepEqual(valid.usage, { input: 100, output: 20 });

  const fallback = validateStockLabelAnswer(choiceAnswer("non_stock", 0.9));
  assert.ok(fallback);
  assert.equal(fallback.class, "non_stock");
  assert.equal(fallback.confidence, 0.9);
  assert.equal(fallback.reason, reasonForClass("non_stock"));

  const custom = validateStockLabelAnswer(
    choiceAnswer("non_stock", 0.9, { reason: "  Tiền điện tháng 10  " }),
  );
  assert.ok(custom);
  assert.equal(custom.reason, "Tiền điện tháng 10");

  const longReason = "x".repeat(200);
  const clamped = validateStockLabelAnswer(choiceAnswer("stock", 0.9, { reason: longReason }));
  assert.ok(clamped);
  assert.equal(clamped.reason.length, STOCK_LABEL_REASON_MAX);
});

test("rejects an unknown choice, a missing probability and an out-of-range confidence", () => {
  const unknown = choiceAnswer("stock", 0.96);
  unknown.answers[STOCK_LABEL_QUESTION_KEY].choice = "other";
  assert.equal(validateStockLabelAnswer(unknown), null);

  const missing = choiceAnswer("stock", 0.96);
  delete missing.answers[STOCK_LABEL_QUESTION_KEY].probabilities.stock;
  assert.equal(validateStockLabelAnswer(missing), null);

  const outOfRangeProbability = choiceAnswer("stock", 1.2);
  assert.equal(validateStockLabelAnswer(outOfRangeProbability), null);

  const high = choiceAnswer("stock", 0.96, { confidence: 1.2 });
  assert.equal(validateStockLabelAnswer(high), null);

  const negative = choiceAnswer("stock", 0.96, { confidence: -0.2 });
  assert.equal(validateStockLabelAnswer(negative), null);

  const malformed = { ...choiceAnswer("stock", 0.96), model: "other" };
  assert.throws(() => validateStockLabelAnswer(malformed), JevError);

  const noUsage = choiceAnswer("stock", 0.96);
  delete (noUsage as { usage?: unknown }).usage;
  assert.throws(() => validateStockLabelAnswer(noUsage), JevError);
});

test("the request carries the state and the two criteria, and parses the answer", async () => {
  let seenBody: Record<string, unknown> = {};
  const evaluator = createStockLabelEvaluator({
    apiKey: "server-key",
    fetcher: fetchFake(async (init) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(choiceAnswer("non_stock", 0.97, {
        confidence: 0.95,
        reason: "Tiền điện tháng 10",
      })), { status: 200 });
    }),
  });
  const evaluation = await evaluator({
    state: buildStockLabelState(CANDIDATE),
    signal: new AbortController().signal,
  });

  assert.ok(evaluation);
  assert.equal(evaluation.class, "non_stock");
  assert.equal(evaluation.confidence, 0.95);
  assert.equal(evaluation.reason, "Tiền điện tháng 10");
  assert.equal(seenBody.model, JEV_MODEL);
  const questions = seenBody.questions as Record<string, { type: string; criteria: Record<string, string> }>;
  assert.equal(questions[STOCK_LABEL_QUESTION_KEY].type, "choice");
  assert.deepEqual(Object.keys(questions[STOCK_LABEL_QUESTION_KEY].criteria), ["stock", "non_stock"]);
  const sentState = seenBody.state as { request: Record<string, unknown>; manual_examples: unknown[] };
  assert.equal(sentState.request.supplier, "NCC Bột");
  assert.equal(sentState.request.title, "Đề nghị chi - Bột mì 888");
  assert.equal(sentState.manual_examples.length, 1);
  const gateway = (seenBody.providerOptions as Record<string, Record<string, unknown>>).gateway;
  assert.equal(gateway.zeroDataRetention, true);
  assert.deepEqual(gateway.only, ["typesafe-ai"]);
  assert.equal(JEV_ENDPOINT, "https://ai-gateway.vercel.sh/v1/evaluate");
});

test("a provider failure is a Jev error and the circuit opens after three", async () => {
  const circuit = createJevCircuit();
  let calls = 0;
  const evaluator = createStockLabelEvaluator({
    apiKey: "k",
    circuit,
    fetcher: fetchFake(async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    }),
  });
  const state = buildStockLabelState(CANDIDATE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      () => evaluator({ state, signal: new AbortController().signal }),
      (error: unknown) => error instanceof JevError && error.code === "jev_http_error",
    );
  }
  assert.equal(circuit.isOpen(), true);
  await assert.rejects(
    () => evaluator({ state, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_circuit_open",
  );
  assert.equal(calls, 3);
});

test("an unknown option from the provider is a no-answer, not a write", async () => {
  const evaluator = createStockLabelEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () =>
      new Response(JSON.stringify(choiceAnswer("unexpected", 0.99)), { status: 200 })
    ),
  });
  const result = await evaluator({
    state: buildStockLabelState(CANDIDATE),
    signal: new AbortController().signal,
  });
  assert.equal(result, null);
});
