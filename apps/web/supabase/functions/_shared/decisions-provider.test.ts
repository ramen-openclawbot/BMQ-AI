// Offline tests for the shared Decisions provider adapter.
//
// Every provider call is an injected fetcher: no network, no paid request and no
// real key. The OpenAI path is selected only through the injectable env getter,
// so these tests never read or write global Deno / process environment.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateDecisions,
  OPENAI_DECISIONS_ENDPOINT,
  type DecisionsEnvGetter,
} from "./decisions-provider.ts";
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  jevQuestions,
  RELATION_CRITERIA,
  SAME_PURCHASE_CRITERIA,
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

/** The documented Decisions answer shape (array probabilities, no usage). */
function openaiBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    answers: [
      { type: "predicate", name: "same_purchase", probability: 0.93 },
      {
        type: "choice",
        name: "relation",
        choice: "same_purchase",
        probabilities: [
          { value: "same_purchase", probability: 0.88 },
          { value: "repeat_order", probability: 0.1 },
          { value: "split_or_partial", probability: 0.02 },
          { value: "unrelated", probability: 0.0 },
        ],
        confidence: 0.81,
      },
    ],
    ...overrides,
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

const openaiEnv = (extra: Record<string, string> = {}): DecisionsEnvGetter =>
  (name) => (name === "OPENAI_API_KEY" ? "sk-test-key" : extra[name]);

const options = (fetcher: typeof fetch, env?: DecisionsEnvGetter, overrides: Record<string, unknown> = {}) => ({
  fetcher,
  gatewayUrl: JEV_ENDPOINT,
  gatewayKey: "jev-server-key",
  timeoutMs: 200,
  env,
  ...overrides,
});

test("no OpenAI key sends the original body straight to the Jev Gateway", async () => {
  const { fetcher, calls } = makeFetcher(async () => json(jevBody()));
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, () => undefined));

  assert.equal(outcome.provider, "typesafe");
  assert.equal(outcome.status, 200);
  assert.deepEqual(outcome.body, jevBody());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_ENDPOINT);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer jev-server-key");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), GATEWAY_BODY);
});

test("an OpenAI key translates the questions and translates the answer back", async () => {
  const { fetcher, calls } = makeFetcher(async (url) => (url === OPENAI_DECISIONS_ENDPOINT ? json(openaiBody()) : json(jevBody())));
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, openaiEnv()));

  assert.equal(outcome.provider, "openai");
  assert.equal(outcome.openaiError, undefined);
  assert.equal(calls.length, 1, "a successful OpenAI answer must not call Jev");
  assert.equal(calls[0].url, "https://api.openai.com/v1/decisions");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer sk-test-key");

  const sent = JSON.parse(String(calls[0].init?.body)) as {
    model: string;
    input: string;
    questions: { type: string; name: string; instructions: string; choices?: { value: string; description: string }[] }[];
  };
  assert.equal(sent.model, "gpt-6-luna");
  assert.equal(sent.input, JSON.stringify(GATEWAY_BODY.state));

  const predicate = sent.questions.find((question) => question.name === "same_purchase")!;
  assert.equal(predicate.type, "predicate");
  assert.ok(predicate.instructions.includes(SAME_PURCHASE_CRITERIA.true));
  assert.ok(predicate.instructions.includes(SAME_PURCHASE_CRITERIA.false));

  const choice = sent.questions.find((question) => question.name === "relation")!;
  assert.equal(choice.type, "choice");
  assert.deepEqual(
    choice.choices?.map((entry) => entry.value),
    ["same_purchase", "repeat_order", "split_or_partial", "unrelated"],
  );
  assert.equal(choice.choices?.[0].description, RELATION_CRITERIA.same_purchase);

  // The translated body must satisfy the unmodified finance validator.
  const evaluation = validateJevResponse(outcome.body);
  assert.equal(evaluation.p_same, 0.93);
  assert.equal(evaluation.relation, "same_purchase");
  assert.equal(evaluation.relation_probability, 0.88);
  assert.equal(evaluation.relation_confidence, 0.81);
});

test("a string state is passed through as the Decisions input unchanged", async () => {
  const { fetcher, calls } = makeFetcher(async () => json(openaiBody()));
  const gatewayBody = { model: JEV_MODEL, state: "tuần này có bao nhiêu đơn đại lý?", questions: jevQuestions() };
  await evaluateDecisions(gatewayBody, options(fetcher, openaiEnv()));
  const sent = JSON.parse(String(calls[0].init?.body));
  assert.equal(sent.input, "tuần này có bao nhiêu đơn đại lý?");
});

test("an OpenAI HTTP 429 falls back to Jev with a short error code", async () => {
  const { fetcher, calls } = makeFetcher(async (url) => (url === OPENAI_DECISIONS_ENDPOINT ? new Response("slow down", { status: 429 }) : json(jevBody())));
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, openaiEnv()));

  assert.equal(outcome.provider, "fallback");
  assert.equal(outcome.openaiError, "openai_http_429");
  assert.equal(outcome.status, 200);
  assert.deepEqual(outcome.body, jevBody());
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.url), ["https://api.openai.com/v1/decisions", JEV_ENDPOINT]);
});

test("an OpenAI timeout falls back to Jev", async () => {
  const { fetcher, calls } = makeFetcher((url, init) => {
    if (url !== OPENAI_DECISIONS_ENDPOINT) return Promise.resolve(json(jevBody()));
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  });
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, openaiEnv(), { timeoutMs: 30 }));

  assert.equal(outcome.provider, "fallback");
  assert.equal(outcome.openaiError, "openai_timeout");
  assert.deepEqual(outcome.body, jevBody());
  assert.deepEqual(calls.map((call) => call.url), ["https://api.openai.com/v1/decisions", JEV_ENDPOINT]);
});

test("an OpenAI refusal falls back to Jev", async () => {
  const refused = { answers: [{ type: "refusal", name: "same_purchase" }, openaiBody().answers[1]] };
  const { fetcher, calls } = makeFetcher(async (url) => (url === OPENAI_DECISIONS_ENDPOINT ? json(refused) : json(jevBody())));
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, openaiEnv()));

  assert.equal(outcome.provider, "fallback");
  assert.equal(outcome.openaiError, "openai_refusal");
  assert.deepEqual(outcome.body, jevBody());
  assert.equal(calls.length, 2);
});

test("an OpenAI choice outside the offered options falls back to Jev", async () => {
  const outside = openaiBody({
    answers: [
      openaiBody().answers[0],
      {
        type: "choice",
        name: "relation",
        choice: "maybe",
        probabilities: [
          { value: "same_purchase", probability: 0.5 },
          { value: "repeat_order", probability: 0.5 },
        ],
      },
    ],
  });
  const { fetcher, calls } = makeFetcher(async (url) => (url === OPENAI_DECISIONS_ENDPOINT ? json(outside) : json(jevBody())));
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, openaiEnv()));

  assert.equal(outcome.provider, "fallback");
  assert.equal(outcome.openaiError, "openai_choice_out_of_list");
  assert.deepEqual(outcome.body, jevBody());
  assert.equal(calls.length, 2);
});

test("a malformed OpenAI body falls back to Jev", async () => {
  const { fetcher } = makeFetcher(async (url) => (url === OPENAI_DECISIONS_ENDPOINT ? new Response("not json", { status: 200 }) : json(jevBody())));
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, openaiEnv()));
  assert.equal(outcome.provider, "fallback");
  assert.equal(outcome.openaiError, "openai_invalid_response");
  assert.deepEqual(outcome.body, jevBody());
});

test("a missing OpenAI answer falls back to Jev", async () => {
  const missing = { answers: [openaiBody().answers[0]] };
  const { fetcher, calls } = makeFetcher(async (url) => (url === OPENAI_DECISIONS_ENDPOINT ? json(missing) : json(jevBody())));
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, openaiEnv()));
  assert.equal(outcome.provider, "fallback");
  assert.equal(outcome.openaiError, "openai_missing_answer");
  assert.deepEqual(outcome.body, jevBody());
  assert.equal(calls.length, 2);
});

test("OPENAI_DECISIONS_MODEL overrides the Decisions model", async () => {
  const { fetcher, calls } = makeFetcher(async () => json(openaiBody()));
  await evaluateDecisions(GATEWAY_BODY, options(fetcher, openaiEnv({ OPENAI_DECISIONS_MODEL: "gpt-6-luna-preview" })));
  assert.equal(JSON.parse(String(calls[0].init?.body)).model, "gpt-6-luna-preview");
});

test("DECISIONS_PROVIDER=typesafe forces the Jev Gateway even with an OpenAI key", async () => {
  const { fetcher, calls } = makeFetcher(async () => json(jevBody()));
  const outcome = await evaluateDecisions(GATEWAY_BODY, options(fetcher, openaiEnv({ DECISIONS_PROVIDER: "typesafe" })));

  assert.equal(outcome.provider, "typesafe");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_ENDPOINT);
});

test("a parent cancellation is never converted into a Jev fallback", async () => {
  const controller = new AbortController();
  const { fetcher, calls } = makeFetcher((_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  const pending = evaluateDecisions(GATEWAY_BODY, options(fetcher, openaiEnv(), { timeoutMs: 5000, signal: controller.signal }));
  setTimeout(() => controller.abort(), 5);

  await assert.rejects(() => pending, (error: unknown) => (error as Error)?.name === "AbortError");
  assert.equal(calls.length, 1, "a cancelled call must not fall back");
  assert.equal(calls[0].url, OPENAI_DECISIONS_ENDPOINT);
});
