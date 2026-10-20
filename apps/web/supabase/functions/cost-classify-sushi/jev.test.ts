import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCostState,
  costCriteria,
  COST_INSTRUCTIONS,
  COST_QUESTION_KEY,
  createCostEvaluator,
  createJevCircuit,
  JEV_ENDPOINT,
  JEV_MODEL,
  JevError,
  SUSHI_COST_PROMPT_VERSION,
  validateCostAnswer,
  type CostCategoryOption,
  type CostClassificationCandidate,
} from "./jev.ts";

const OPTIONS: CostCategoryOption[] = [
  { code: "COGS_BMQ_BREAD", label: "Chi phí bánh mì que / bánh mì lớn" },
  { code: "COGS_SWEET_KITCHEN", label: "Chi phí bếp bánh ngọt" },
  { code: "OPEX_GENERAL", label: "Chi phí vận hành chung" },
];

const CANDIDATE: CostClassificationCandidate = {
  source_type: "payment_request_item",
  source_line_id: "11111111-1111-4111-8111-111111111111",
  supplier_id: "22222222-2222-4222-8222-222222222222",
  supplier_name: "NCC Bột",
  product_name: "Bột mì 888",
  product_code: "BOT-MI",
  unit: "kg",
  quantity: 10,
  unit_price: 25000,
  line_amount: 250000,
  document_date: "2026-10-20",
  note: "Nhập bột cho bếp",
  subject_key: "22222222-2222-4222-8222-222222222222|bot mi 888",
};

function choiceAnswer(choice: string, probability: number, options: readonly string[]) {
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
      [COST_QUESTION_KEY]: { type: "choice", choice, probabilities, confidence: 0.9 },
    },
    usage: { inputTokens: 100, outputTokens: 20 },
    providerMetadata: { gateway: { cost: "0.00012" } },
  };
}

function fetchFake(handler: (init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) => handler(init)) as unknown as typeof fetch;
}

test("the question offers only the supplied active categories, never UNMAPPED_REVIEW", () => {
  assert.equal(SUSHI_COST_PROMPT_VERSION, "sushi-cost-classify-2026-10-20.1");
  assert.ok(COST_INSTRUCTIONS.length > 10);
  const criteria = costCriteria(OPTIONS);
  assert.deepEqual(Object.keys(criteria), OPTIONS.map((option) => option.code));
  assert.equal(criteria.COGS_BMQ_BREAD, "Chi phí bánh mì que / bánh mì lớn");
  assert.equal(Object.hasOwn(criteria, "UNMAPPED_REVIEW"), false);
});

test("validates the cost choice and treats unknown or missing probability as no answer", () => {
  const allowed = OPTIONS.map((option) => option.code);
  const valid = validateCostAnswer(allowed, choiceAnswer("COGS_BMQ_BREAD", 0.96, allowed));
  assert.ok(valid);
  assert.equal(valid.category_code, "COGS_BMQ_BREAD");
  assert.equal(valid.probability, 0.96);
  assert.equal(valid.cost, 0.00012);

  const unknown = choiceAnswer("COGS_BMQ_BREAD", 0.96, allowed);
  unknown.answers[COST_QUESTION_KEY].choice = "UNMAPPED_REVIEW";
  assert.equal(validateCostAnswer(allowed, unknown), null);

  const missing = choiceAnswer("COGS_BMQ_BREAD", 0.96, allowed);
  delete missing.answers[COST_QUESTION_KEY].probabilities.COGS_BMQ_BREAD;
  assert.equal(validateCostAnswer(allowed, missing), null);

  const wrongQuestion = choiceAnswer("COGS_BMQ_BREAD", 0.96, allowed);
  wrongQuestion.answers.other = wrongQuestion.answers[COST_QUESTION_KEY];
  delete wrongQuestion.answers[COST_QUESTION_KEY];
  assert.equal(validateCostAnswer(allowed, wrongQuestion), null);

  const malformed = { ...choiceAnswer("COGS_BMQ_BREAD", 0.96, allowed), model: "other" };
  assert.throws(() => validateCostAnswer(allowed, malformed), JevError);
});

test("the request carries the line, the criteria and the recent corrections", async () => {
  const allowed = OPTIONS.map((option) => option.code);
  let seenBody: Record<string, unknown> = {};
  const evaluator = createCostEvaluator({
    apiKey: "server-key",
    fetcher: fetchFake(async (init) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(choiceAnswer("COGS_BMQ_BREAD", 0.96, allowed)), { status: 200 });
    }),
  });
  const state = buildCostState(CANDIDATE, [
    "Người duyệt đã sửa trước đây: OPEX_GENERAL → COGS_BMQ_BREAD (Sushi đã chọn OPEX_GENERAL)",
  ]);
  const evaluation = await evaluator({ state, options: OPTIONS, signal: new AbortController().signal });

  assert.ok(evaluation);
  assert.equal(evaluation.category_code, "COGS_BMQ_BREAD");
  assert.equal(seenBody.model, JEV_MODEL);
  const questions = seenBody.questions as Record<string, { type: string; criteria: Record<string, string> }>;
  assert.equal(questions[COST_QUESTION_KEY].type, "choice");
  assert.deepEqual(Object.keys(questions[COST_QUESTION_KEY].criteria), allowed);
  const sentState = seenBody.state as { line: Record<string, unknown>; corrections: string[] };
  assert.equal(sentState.line.supplier, "NCC Bột");
  assert.equal(sentState.line.product_name, "Bột mì 888");
  assert.equal(sentState.line.amount, 250000);
  assert.equal(sentState.corrections.length, 1);
  assert.ok(sentState.corrections[0].includes("OPEX_GENERAL"));
  assert.ok(sentState.corrections[0].includes("COGS_BMQ_BREAD"));
  const gateway = (seenBody.providerOptions as Record<string, Record<string, unknown>>).gateway;
  assert.equal(gateway.zeroDataRetention, true);
  assert.deepEqual(gateway.only, ["typesafe-ai"]);
  assert.equal(JEV_ENDPOINT, "https://ai-gateway.vercel.sh/v1/evaluate");
});

test("a provider failure is a Jev error and the circuit opens after three", async () => {
  const circuit = createJevCircuit();
  let calls = 0;
  const evaluator = createCostEvaluator({
    apiKey: "k",
    circuit,
    fetcher: fetchFake(async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    }),
  });
  const state = buildCostState(CANDIDATE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      () => evaluator({ state, options: OPTIONS, signal: new AbortController().signal }),
      (error: unknown) => error instanceof JevError && error.code === "jev_http_error",
    );
  }
  assert.equal(circuit.isOpen(), true);
  await assert.rejects(
    () => evaluator({ state, options: OPTIONS, signal: new AbortController().signal }),
    (error: unknown) => error instanceof JevError && error.code === "jev_circuit_open",
  );
  assert.equal(calls, 3);
});

test("an unknown option from the provider is a no-answer, not a write", async () => {
  const allowed = OPTIONS.map((option) => option.code);
  const evaluator = createCostEvaluator({
    apiKey: "k",
    fetcher: fetchFake(async () =>
      new Response(JSON.stringify(choiceAnswer("UNMAPPED_REVIEW", 0.99, [...allowed, "UNMAPPED_REVIEW"])), { status: 200 })
    ),
  });
  const result = await evaluator({
    state: buildCostState(CANDIDATE),
    options: OPTIONS,
    signal: new AbortController().signal,
  });
  assert.equal(result, null);
});
