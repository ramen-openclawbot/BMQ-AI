// Offline handler tests: the kill switch, auth paths, the enabled switch, the
// daily limit, provider failures, the confidence threshold, apply skips and the
// request grammar. The provider and the store are fake.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStockLabelHandler,
  StockLabelError,
  type ApplyStockLabelInput,
  type ApplyStockLabelResult,
  type StockLabelHandlerDeps,
  type StockLabelSettings,
} from "./handler.ts";
import {
  JEV_MODEL,
  JevError,
  reasonForClass,
  type StockLabelCandidate,
  type StockLabelClass,
  type StockLabelEvaluator,
} from "./jev.ts";

const CANDIDATE_A: StockLabelCandidate = {
  request_id: "11111111-1111-4111-8111-111111111111",
  supplier_id: "22222222-2222-4222-8222-222222222222",
  supplier_name: "NCC Bột",
  title: "Đề nghị chi - Bột mì 888",
  description: "Nhập bột cho bếp",
  total_amount: 250000,
  vat_amount: 0,
  item_names: ["Bột mì 888"],
  manual_examples: [],
};

const CANDIDATE_B: StockLabelCandidate = {
  ...CANDIDATE_A,
  request_id: "33333333-3333-4333-8333-333333333333",
  title: "Đề nghị chi - Tiền điện",
  item_names: ["Tiền điện"],
};

const SETTINGS: StockLabelSettings = {
  enabled: true,
  min_confidence: 0.9,
  daily_limit: 200,
};

interface Recorder {
  applies: ApplyStockLabelInput[];
  settingsCalls: number;
  countCalls: number;
  listCalls: number;
  listLimits: number[];
  evaluations: number;
}

function evaluatorFor(
  labelClass: StockLabelClass,
  confidence: number,
  recorder?: Recorder,
): () => StockLabelEvaluator {
  return () => async () => {
    if (recorder) recorder.evaluations += 1;
    return {
      class: labelClass,
      confidence,
      reason: reasonForClass(labelClass),
      usage: { input: 10, output: 5 },
      cost: 0.0001,
    };
  };
}

function makeDeps(overrides: Partial<StockLabelHandlerDeps> = {}) {
  const recorder: Recorder = {
    applies: [],
    settingsCalls: 0,
    countCalls: 0,
    listCalls: 0,
    listLimits: [],
    evaluations: 0,
  };
  const defaults: StockLabelHandlerDeps = {
    killSwitch: () => false,
    evaluator: evaluatorFor("non_stock", 0.96, recorder),
    authenticate: async () => ({ service: true }),
    getWorkerSecret: async () => "worker-secret",
    getSettings: async () => {
      recorder.settingsCalls += 1;
      return SETTINGS;
    },
    countToday: async () => {
      recorder.countCalls += 1;
      return 0;
    },
    listCandidates: async (limit) => {
      recorder.listCalls += 1;
      recorder.listLimits.push(limit);
      return [CANDIDATE_A];
    },
    apply: async (input) => {
      recorder.applies.push(input);
      return {
        status: "applied",
        applied: true,
        class: input.class,
        requires_receipt: input.class === "stock",
        no_receipt_reason: input.class === "non_stock" ? `Jev: ${input.reason}` : null,
      } satisfies ApplyStockLabelResult;
    },
    audit: () => {},
  };
  return { deps: { ...defaults, ...overrides }, recorder };
}

function request(body: unknown = {}, headers: Record<string, string> = {}) {
  return new Request("https://edge.test/payment-stock-label-jev", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("CORS preflight and method are bounded", async () => {
  const handler = createStockLabelHandler(makeDeps().deps);
  const preflight = await handler(
    new Request("https://edge.test/payment-stock-label-jev", { method: "OPTIONS" }),
  );
  assert.equal(preflight.status, 204);
  assert.equal((await handler(new Request("https://edge.test", { method: "GET" }))).status, 405);
});

test("the kill switch returns 503 before any setting or candidate read", async () => {
  const { deps, recorder } = makeDeps({ killSwitch: () => true });
  const response = await createStockLabelHandler(deps)(request({}));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "disabled");
  assert.equal(recorder.settingsCalls, 0);
  assert.equal(recorder.countCalls, 0);
  assert.equal(recorder.listCalls, 0);
  assert.equal(recorder.evaluations, 0);
  assert.equal(recorder.applies.length, 0);
});

test("a bad worker secret is 401 and never falls back to service auth", async () => {
  let authenticated = 0;
  const { deps } = makeDeps({
    authenticate: async () => {
      authenticated += 1;
      return { service: true };
    },
  });
  const response = await createStockLabelHandler(deps)(
    request({}, { "x-worker-secret": "wrong" }),
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "unauthorized");
  assert.equal(authenticated, 0);
});

test("a valid worker secret runs the batch", async () => {
  const { deps, recorder } = makeDeps({
    authenticate: async () => {
      throw new Error("must not authenticate a worker");
    },
  });
  const response = await createStockLabelHandler(deps)(
    request({}, { "x-worker-secret": "worker-secret" }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).applied, 1);
  assert.equal(recorder.applies.length, 1);
});

test("a non-service caller is forbidden", async () => {
  const { deps, recorder } = makeDeps({
    authenticate: async () => {
      throw new StockLabelError("forbidden", 403);
    },
  });
  const response = await createStockLabelHandler(deps)(request({}));
  assert.equal(response.status, 403);
  assert.equal(recorder.settingsCalls, 0);
});

test("enabled=false returns 200 skipped and reads no candidate", async () => {
  const { deps, recorder } = makeDeps({
    getSettings: async () => {
      recorder.settingsCalls += 1;
      return { ...SETTINGS, enabled: false };
    },
  });
  const response = await createStockLabelHandler(deps)(request({}));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.skipped, true);
  assert.equal(body.reason, "disabled");
  assert.equal(recorder.settingsCalls, 1);
  assert.equal(recorder.countCalls, 0);
  assert.equal(recorder.listCalls, 0);
  assert.equal(recorder.evaluations, 0);
  assert.equal(recorder.applies.length, 0);
});

test("reaching daily_limit stops before listing candidates", async () => {
  const { deps, recorder } = makeDeps({
    countToday: async () => {
      recorder.countCalls += 1;
      return 200;
    },
  });
  const response = await createStockLabelHandler(deps)(request({}));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.skipped, true);
  assert.equal(body.reason, "daily_limit");
  assert.equal(body.stopped, "daily_limit");
  assert.equal(recorder.listCalls, 0);
  assert.equal(recorder.evaluations, 0);
  assert.equal(recorder.applies.length, 0);
});

test("the candidate limit is the remaining daily quota", async () => {
  const { deps, recorder } = makeDeps({
    countToday: async () => 198,
    listCandidates: async (limit) => {
      recorder.listCalls += 1;
      recorder.listLimits.push(limit);
      return [CANDIDATE_A, CANDIDATE_B];
    },
  });
  const body = await (await createStockLabelHandler(deps)(request({ limit: 50 }))).json();
  assert.deepEqual(recorder.listLimits, [2]);
  assert.equal(body.candidates, 2);
  assert.equal(body.used_today, 200);
  assert.equal(body.stopped, "daily_limit");
});

test("a Jev error skips the request and never calls apply", async () => {
  const { deps, recorder } = makeDeps({
    evaluator: () => async () => {
      throw new JevError("jev_unavailable", 503);
    },
  });
  const body = await (await createStockLabelHandler(deps)(request({}))).json();
  assert.equal(body.errors, 1);
  assert.equal(body.applied, 0);
  assert.equal(recorder.applies.length, 0);
  assert.equal(body.results[0].status, "error");
  assert.equal(body.results[0].reason, "jev_unavailable");
});

test("a Jev timeout skips the request and never calls apply", async () => {
  const { deps, recorder } = makeDeps({
    evaluator: () => async () => {
      throw new JevError("jev_timeout", 504);
    },
  });
  const body = await (await createStockLabelHandler(deps)(request({}))).json();
  assert.equal(body.errors, 1);
  assert.equal(body.applied, 0);
  assert.equal(recorder.applies.length, 0);
  assert.equal(body.results[0].reason, "jev_timeout");
});

test("at or above the threshold applies the exact Jev payload", async () => {
  const { deps, recorder } = makeDeps({
    evaluator: evaluatorFor("non_stock", 0.95, undefined),
  });
  const body = await (await createStockLabelHandler(deps)(request({}))).json();
  assert.equal(body.applied, 1);
  assert.equal(body.suggested, 0);
  assert.equal(recorder.applies.length, 1);
  assert.deepEqual(recorder.applies[0], {
    request_id: CANDIDATE_A.request_id,
    class: "non_stock",
    confidence: 0.95,
    reason: reasonForClass("non_stock"),
    model: JEV_MODEL,
  });
  assert.equal(body.results[0].requires_receipt, false);
});

test("below the threshold still calls apply to store the suggestion", async () => {
  const { deps, recorder } = makeDeps({
    evaluator: evaluatorFor("non_stock", 0.5, undefined),
  });
  const body = await (await createStockLabelHandler(deps)(request({}))).json();
  assert.equal(recorder.applies.length, 1);
  assert.equal(recorder.applies[0].class, "non_stock");
  assert.equal(recorder.applies[0].confidence, 0.5);
  assert.equal(body.applied, 1);
});

test("an apply skip (manual label or linked PO) is not an error", async () => {
  const { deps, recorder } = makeDeps({
    apply: async (input) => {
      recorder.applies.push(input);
      return { status: "skipped", applied: false, reason: "already_labeled" };
    },
  });
  const body = await (await createStockLabelHandler(deps)(request({}))).json();
  assert.equal(body.skipped_count, 1);
  assert.equal(body.applied, 0);
  assert.equal(body.errors, 0);
  assert.equal(recorder.applies.length, 1);
  assert.equal(body.results[0].status, "skipped");
  assert.equal(body.results[0].reason, "already_labeled");
});

test("the request grammar is validated", async () => {
  const handler = createStockLabelHandler(makeDeps().deps);
  assert.equal((await handler(request({ limit: 0 }))).status, 400);
  assert.equal((await handler(request({ limit: 1.5 }))).status, 400);
  assert.equal((await handler(request({ extra: true }))).status, 400);
  assert.equal((await handler(request({}, { "content-type": "application/json" }))).status, 200);
  const notJson = await handler(new Request("https://edge.test", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "x",
  }));
  assert.equal(notJson.status, 415);
});

test("the provider body model is pinned", () => {
  assert.equal(JEV_MODEL, "typesafe-ai/jev");
});
