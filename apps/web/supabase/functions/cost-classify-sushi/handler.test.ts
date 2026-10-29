// Offline handler tests: auth paths, the cost switch, active category options,
// feedback corrections, the confidence threshold, manual_override / approved
// skips, the daily cap, dry_run and provider failures. The provider is fake.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createCostClassifyHandler,
  CostClassifyError,
  type ApplyCostInput,
  type ApplyCostResult,
  type CostCategoryRow,
  type CostClassifyHandlerDeps,
  type CostSettings,
} from "./handler.ts";
import {
  JEV_MODEL,
  JevError,
  type CostCategoryOption,
  type CostClassificationCandidate,
  type CostEvaluator,
  type CostFeedbackRow,
  type ProductLineCode,
} from "./jev.ts";

const CATEGORY_ROWS: CostCategoryRow[] = [
  {
    code: "A_COGS",
    label: "Giá vốn hàng bán",
    parent_code: null,
    sushi_hint: null,
    is_active: true,
    sort_order: 100,
  },
  {
    code: "A1_BREAD_BOUGHT",
    label: "Bánh mì thành phẩm mua ngoài",
    parent_code: "A_COGS",
    sushi_hint: "bánh mì que, bánh mì lớn mua của HKD Tuyết Anh",
    is_active: true,
    sort_order: 101,
  },
  {
    code: "A2_MEAT_OFFAL",
    label: "Thịt và nội tạng",
    parent_code: "A_COGS",
    sushi_hint: "mỡ heo, nạc đùi, gan heo làm pate",
    is_active: true,
    sort_order: 102,
  },
  {
    code: "PACKAGING_SALES",
    label: "Bao bì đã ngừng dùng",
    parent_code: null,
    sushi_hint: "hộp, khay",
    is_active: false,
    sort_order: 30,
  },
  {
    code: "UNMAPPED_REVIEW",
    label: "Chưa phân loại / cần review",
    parent_code: null,
    sushi_hint: null,
    is_active: true,
    sort_order: 70,
  },
];

const CANDIDATE_A: CostClassificationCandidate = {
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

const CANDIDATE_B: CostClassificationCandidate = {
  ...CANDIDATE_A,
  source_line_id: "33333333-3333-4333-8333-333333333333",
  product_name: "Hộp kraft",
  product_code: "HOP-KRAFT",
  subject_key: "22222222-2222-4222-8222-222222222222|hop kraft",
};

const FEEDBACK: CostFeedbackRow = {
  id: "44444444-4444-4444-8444-444444444444",
  kind: "cost_category",
  subject_key: CANDIDATE_A.subject_key!,
  robot_choice: "A2_MEAT_OFFAL",
  human_choice: "A1_BREAD_BOUGHT",
  robot_probability: 0.88,
  note: "Bột mì 888",
  created_at: "2026-10-19T00:00:00.000Z",
};

const SETTINGS: CostSettings = {
  cost_threshold: 0.95,
  cost_daily_cap: 200,
  cost_auto_enabled: true,
};

interface Recorder {
  applies: ApplyCostInput[];
  evaluations: { state: unknown; options: CostCategoryOption[] }[];
}

function evaluatorFor(
  category: string,
  probability: number,
  recorder?: Recorder,
  productLine: ProductLineCode = "shared",
  productLineProbability = 0.9,
): () => CostEvaluator {
  return () => async ({ state, options }) => {
    recorder?.evaluations.push({ state, options });
    return {
      category_code: category,
      probability,
      product_line: productLine,
      product_line_probability: productLineProbability,
      confidence: 0.9,
      usage: { input: 10, output: 5 },
      cost: 0.0001,
    };
  };
}

function makeDeps(overrides: Partial<CostClassifyHandlerDeps> = {}) {
  const recorder: Recorder = { applies: [], evaluations: [] };
  const defaults: CostClassifyHandlerDeps = {
    evaluator: evaluatorFor("A1_BREAD_BOUGHT", 0.96, recorder),
    authenticate: async () => ({ userId: "owner-1", owner: true }),
    getWorkerSecret: async () => "worker-secret",
    getSettings: async () => SETTINGS,
    listCategories: async () => CATEGORY_ROWS,
    listCandidates: async () => [CANDIDATE_A],
    getFeedback: async () => [],
    apply: async (input) => {
      recorder.applies.push(input);
      return {
        status: "applied",
        classification_id: "c1",
        action_id: "a1",
        category_code: input.category_code,
        product_line: input.product_line,
        review_status: input.category_code === "UNMAPPED_REVIEW" ? "needs_review" : "suggested",
      } satisfies ApplyCostResult;
    },
    audit: () => {},
  };
  return { deps: { ...defaults, ...overrides }, recorder };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://edge.test/cost-classify-sushi", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("CORS preflight and method are bounded", async () => {
  const handler = createCostClassifyHandler(makeDeps().deps);
  const preflight = await handler(new Request("https://edge.test/cost-classify-sushi", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal((await handler(new Request("https://edge.test", { method: "GET" }))).status, 405);
});

test("a bad worker secret is 401 and never falls back to user auth", async () => {
  let authenticated = 0;
  const handler = createCostClassifyHandler(makeDeps({
    authenticate: async () => { authenticated += 1; return { userId: "owner-1", owner: true }; },
  }).deps);
  const response = await handler(request({ limit: 10 }, { "x-worker-secret": "wrong" }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "unauthorized");
  assert.equal(authenticated, 0);
});

test("a valid worker secret runs the batch", async () => {
  const handler = createCostClassifyHandler(makeDeps({
    authenticate: async () => { throw new Error("must not authenticate a worker"); },
  }).deps);
  const response = await handler(request({ limit: 10 }, { "x-worker-secret": "worker-secret" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).applied, 1);
});

test("the cost switch refuses before any provider call", async () => {
  let called = 0;
  const handler = createCostClassifyHandler(makeDeps({
    getSettings: async () => ({ ...SETTINGS, cost_auto_enabled: false }),
    evaluator: () => async () => {
      called += 1;
      throw new Error("must not be called");
    },
  }).deps);
  const response = await handler(request({}));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "disabled");
  assert.equal(called, 0);
});

test("options exclude UNMAPPED_REVIEW, inactive codes and parent nodes", async () => {
  const { deps, recorder } = makeDeps();
  const body = await (await createCostClassifyHandler(deps)(request({}))).json();
  assert.equal(body.applied, 1);
  assert.equal(recorder.evaluations.length, 1);
  const options = recorder.evaluations[0].options;
  const codes = options.map((option) => option.code);
  assert.deepEqual(codes, ["A1_BREAD_BOUGHT", "A2_MEAT_OFFAL"]);
  assert.equal(codes.includes("UNMAPPED_REVIEW"), false);
  assert.equal(codes.includes("PACKAGING_SALES"), false);
  assert.equal(codes.includes("A_COGS"), false, "a parent is never offered");
  assert.equal(
    options[0].label,
    "Bánh mì thành phẩm mua ngoài — ví dụ: bánh mì que, bánh mì lớn mua của HKD Tuyết Anh",
  );
});

test("recent human corrections for the same supplier/item reach the state", async () => {
  const { deps, recorder } = makeDeps({ getFeedback: async () => [FEEDBACK] });
  await createCostClassifyHandler(deps)(request({}));
  const state = recorder.evaluations[0].state as { corrections: string[] };
  assert.equal(state.corrections.length, 1);
  assert.ok(state.corrections[0].includes("A2_MEAT_OFFAL"));
  assert.ok(state.corrections[0].includes("A1_BREAD_BOUGHT"));
});

test("at or above the threshold writes the category as sushi", async () => {
  const { deps, recorder } = makeDeps({ evaluator: evaluatorFor("A1_BREAD_BOUGHT", 0.95, undefined) });
  const body = await (await createCostClassifyHandler(deps)(request({}))).json();
  assert.equal(body.applied, 1);
  assert.equal(body.needs_review, 0);
  assert.equal(recorder.applies.length, 1);
  assert.equal(recorder.applies[0].category_code, "A1_BREAD_BOUGHT");
  assert.equal(recorder.applies[0].probability, 0.95);
  assert.equal(recorder.applies[0].product_line, "shared");
});

test("a product-line answer at 0.80 is written, below it falls back to shared", async () => {
  const atThreshold = makeDeps({
    evaluator: evaluatorFor("A1_BREAD_BOUGHT", 0.96, undefined, "bmq_bread", 0.8),
  });
  await createCostClassifyHandler(atThreshold.deps)(request({}));
  assert.equal(atThreshold.recorder.applies[0].product_line, "bmq_bread");

  const below = makeDeps({
    evaluator: evaluatorFor("A1_BREAD_BOUGHT", 0.96, undefined, "sweet_kitchen", 0.79),
  });
  await createCostClassifyHandler(below.deps)(request({}));
  assert.equal(below.recorder.applies[0].product_line, "shared");
});

test("below the threshold writes UNMAPPED_REVIEW with the top choice and probability in the note", async () => {
  const { deps, recorder } = makeDeps({ evaluator: evaluatorFor("A1_BREAD_BOUGHT", 0.7, undefined) });
  const body = await (await createCostClassifyHandler(deps)(request({}))).json();
  assert.equal(body.applied, 0);
  assert.equal(body.needs_review, 1);
  assert.equal(recorder.applies.length, 1);
  assert.equal(recorder.applies[0].category_code, "UNMAPPED_REVIEW");
  assert.ok(recorder.applies[0].note.includes("A1_BREAD_BOUGHT"));
  assert.ok(recorder.applies[0].note.includes("70.0%"));
  assert.equal(body.results[0].review_status, "needs_review");
});

test("a manual_override or approved row is skipped", async () => {
  const { deps, recorder } = makeDeps({
    apply: async (input) => {
      recorder.applies.push(input);
      return { status: "skipped", reason: "manual_override_or_approved" };
    },
  });
  const body = await (await createCostClassifyHandler(deps)(request({}))).json();
  assert.equal(body.skipped, 1);
  assert.equal(body.applied, 0);
  assert.equal(body.errors, 0);
  assert.equal(body.results[0].status, "skipped");
  assert.equal(recorder.applies.length, 1);
});

test("cap_reached stops the loop without touching later candidates", async () => {
  const { deps, recorder } = makeDeps({
    listCandidates: async () => [CANDIDATE_A, CANDIDATE_B],
    apply: async (input) => {
      recorder.applies.push(input);
      return { status: "cap_reached" };
    },
  });
  const body = await (await createCostClassifyHandler(deps)(request({}))).json();
  assert.equal(body.cap_reached, 1);
  assert.equal(body.stopped, "cap_reached");
  assert.equal(recorder.applies.length, 1, "the loop must stop at the cap");
  assert.equal(body.results.length, 1);
});

test("dry_run returns the decisions, including product_line, and writes nothing", async () => {
  const { deps, recorder } = makeDeps({
    evaluator: evaluatorFor("A1_BREAD_BOUGHT", 0.96, undefined, "sweet_kitchen", 0.91),
  });
  const body = await (await createCostClassifyHandler(deps)(request({ dry_run: true }))).json();
  assert.equal(body.dry_run, true);
  assert.equal(body.applied, 1);
  assert.equal(body.results[0].status, "dry_run");
  assert.equal(body.results[0].category_code, "A1_BREAD_BOUGHT");
  assert.equal(body.results[0].product_line, "sweet_kitchen");
  assert.equal(recorder.applies.length, 0, "dry_run must not call the writer");
});

test("a provider failure counts as an error and writes nothing", async () => {
  const { deps, recorder } = makeDeps({
    evaluator: () => async () => { throw new JevError("jev_unavailable", 503); },
  });
  const body = await (await createCostClassifyHandler(deps)(request({}))).json();
  assert.equal(body.errors, 1);
  assert.equal(body.applied, 0);
  assert.equal(body.needs_review, 0);
  assert.equal(recorder.applies.length, 0);
  assert.equal(body.results[0].reason, "jev_unavailable");
});

test("the request grammar and limit are validated", async () => {
  const handler = createCostClassifyHandler(makeDeps().deps);
  assert.equal((await handler(request({ limit: 0 }))).status, 400);
  assert.equal((await handler(request({ limit: 1.5 }))).status, 400);
  assert.equal((await handler(request({ dry_run: "yes" }))).status, 400);
  assert.equal((await handler(request({ extra: true }))).status, 400);
  assert.equal((await handler(request({}, { "content-type": "application/json" }))).status, 200);
  const notJson = await handler(new Request("https://edge.test", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "x",
  }));
  assert.equal(notJson.status, 415);
});

test("a non-owner user token is forbidden", async () => {
  const handler = createCostClassifyHandler(makeDeps({
    authenticate: async () => { throw new CostClassifyError("forbidden", 403); },
  }).deps);
  const response = await handler(new Request("https://edge.test/cost-classify-sushi", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer user-token" },
    body: JSON.stringify({}),
  }));
  assert.equal(response.status, 403);
});

test("suggest returns one read-only category and never lists candidates or calls the writer", async () => {
  let candidateCalls = 0;
  const { deps, recorder } = makeDeps({
    listCandidates: async () => {
      candidateCalls += 1;
      return [CANDIDATE_A];
    },
  });
  const response = await createCostClassifyHandler(deps)(request({
    mode: "suggest",
    supplier_name: "Lại Đình Tuấn",
    description: "Thuê kho Bình Tân tháng 10",
    amount: 20000000,
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.category_code, "A1_BREAD_BOUGHT");
  assert.equal(body.label, "Bánh mì thành phẩm mua ngoài");
  assert.equal(body.probability, 0.96);
  assert.equal(body.product_line, "shared");
  assert.equal(candidateCalls, 0, "suggest must not list DB candidates");
  assert.equal(recorder.applies.length, 0, "suggest must never call the writer");
  const state = recorder.evaluations[0].state as {
    line: { supplier: string; product_name: string; amount: number };
  };
  assert.equal(state.line.supplier, "Lại Đình Tuấn");
  assert.equal(state.line.product_name, "Thuê kho Bình Tân tháng 10");
  assert.equal(state.line.amount, 20000000);
});

test("suggest rejects non-owner callers and worker-secret-only callers", async () => {
  const nonOwner = createCostClassifyHandler(makeDeps({
    authenticate: async () => { throw new CostClassifyError("forbidden", 403); },
  }).deps);
  const forbidden = await nonOwner(request({ mode: "suggest", description: "Thuê kho" }));
  assert.equal(forbidden.status, 403);

  let authenticated = 0;
  const worker = createCostClassifyHandler(makeDeps({
    authenticate: async () => { authenticated += 1; return { userId: "owner-1", owner: true }; },
  }).deps);
  const workerResponse = await worker(request(
    { mode: "suggest", description: "Thuê kho" },
    { "x-worker-secret": "worker-secret" },
  ));
  assert.equal(workerResponse.status, 403);
  assert.equal(authenticated, 0);
});

test("suggest returns category_code null when the evaluator fails or is unconfigured", async () => {
  const failed = createCostClassifyHandler(makeDeps({
    evaluator: () => async () => { throw new JevError("jev_unavailable", 503); },
  }).deps);
  const failedBody = await (await failed(request({ mode: "suggest", description: "Thuê kho" }))).json();
  assert.equal(failedBody.category_code, null);
  assert.equal(failedBody.reason, "jev_unavailable");

  const unconfigured = createCostClassifyHandler(makeDeps({
    evaluator: () => null,
  }).deps);
  const unconfiguredBody = await (await unconfigured(request({ mode: "suggest", description: "Thuê kho" }))).json();
  assert.equal(unconfiguredBody.category_code, null);
  assert.equal(unconfiguredBody.reason, "unconfigured");
});

test("suggest still respects the cost kill switch", async () => {
  let called = 0;
  const handler = createCostClassifyHandler(makeDeps({
    getSettings: async () => ({ ...SETTINGS, cost_auto_enabled: false }),
    evaluator: () => async () => {
      called += 1;
      throw new Error("must not be called");
    },
  }).deps);
  const response = await handler(request({ mode: "suggest", description: "Thuê kho" }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "disabled");
  assert.equal(called, 0);
});

test("the provider body model is pinned", () => {
  assert.equal(JEV_MODEL, "typesafe-ai/jev");
});
