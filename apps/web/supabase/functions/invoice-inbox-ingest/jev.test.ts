import test from "node:test";
import assert from "node:assert/strict";

import {
  createInvoiceJevEvaluator,
  InvoiceJevError,
  JEV_MODEL,
  validateInvoiceJevAnswer,
} from "./jev.ts";

function gatewayAnswer(choice: string, probability: number) {
  const other = choice === "none" ? "t1" : "none";
  return {
    model: JEV_MODEL,
    answers: {
      template_id: {
        type: "choice",
        choice,
        probabilities: { [choice]: probability, [other]: 1 - probability },
      },
    },
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

const STATE = {
  invoice: {
    id: "inv-1",
    seller_name: "GREEN SM",
    invoice_number: "SMOKE-123",
    invoice_date: "2026-10-19",
    total_amount: 1100,
    lines: [],
  },
  templates: [{ id: "t1", label: "Chi phí", cadence: "irregular", amount_median: 1100 }],
};

test("validate: id ứng viên hợp lệ trả template_id và confidence", () => {
  const evaluation = validateInvoiceJevAnswer(["t1"], gatewayAnswer("t1", 0.93));
  assert.equal(evaluation.template_id, "t1");
  assert.equal(evaluation.confidence, 0.93);
  assert.match(evaluation.reason, /t1/);
});

test("validate: none trả template_id null", () => {
  const evaluation = validateInvoiceJevAnswer(["t1"], gatewayAnswer("none", 0.8));
  assert.equal(evaluation.template_id, null);
  assert.equal(evaluation.confidence, 0.8);
});

test("validate: id ngoài danh sách ứng viên bị từ chối", () => {
  assert.throws(
    () => validateInvoiceJevAnswer(["t1"], gatewayAnswer("t2", 0.99)),
    (error: unknown) => error instanceof InvoiceJevError
      && error.code === "jev_invalid_response",
  );
});

test("evaluator: trả confidence thấp nguyên vẹn để handler tự chặn", async () => {
  const evaluator = createInvoiceJevEvaluator({
    apiKey: "test-key",
    fetcher: async () => new Response(JSON.stringify(gatewayAnswer("t1", 0.5)), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  const evaluation = await evaluator({
    state: STATE,
    allowedTemplateIds: ["t1"],
    signal: new AbortController().signal,
  });
  assert.equal(evaluation?.template_id, "t1");
  assert.equal(evaluation?.confidence, 0.5);
});

test("evaluator: timeout ném jev_timeout", async () => {
  const evaluator = createInvoiceJevEvaluator({
    apiKey: "test-key",
    timeoutMs: 20,
    fetcher: (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    }),
  });
  await assert.rejects(
    () => evaluator({
      state: STATE,
      allowedTemplateIds: ["t1"],
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof InvoiceJevError && error.code === "jev_timeout",
  );
});

test("evaluator: id lạ trong response ném jev_invalid_response", async () => {
  const evaluator = createInvoiceJevEvaluator({
    apiKey: "test-key",
    fetcher: async () => new Response(JSON.stringify(gatewayAnswer("t-other", 0.99)), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    () => evaluator({
      state: STATE,
      allowedTemplateIds: ["t1"],
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof InvoiceJevError
      && error.code === "jev_invalid_response",
  );
});
