// Offline handler tests: permission gate, kill switch, request grammar, daily
// Jev quota, same-prompt skip, probability threshold and classify writes.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createStockCatalogHandler,
  StockCatalogError,
  type StockCatalogHandlerDeps,
  type StockCatalogSuggestionRow,
  type StockCatalogUsage,
} from "./handler.ts";
import {
  candidatePairKey,
  type StockCatalogCandidate,
  type StockCatalogClassifyItem,
} from "./candidates.ts";
import { JEV_PROMPT_VERSION, type JevEvaluation } from "./jev.ts";

const SAME_EVAL: JevEvaluation = {
  mode: "same_item",
  p_same: 0.9,
  item_class: null,
  class_probability: null,
  class_confidence: null,
  usage: { input: 10, output: 5 },
  cost: 0.001,
};

const DIFF_EVAL: JevEvaluation = { ...SAME_EVAL, p_same: 0.2 };

const CLASS_EVAL: JevEvaluation = {
  mode: "item_class",
  p_same: null,
  item_class: "raw_material",
  class_probability: 0.82,
  class_confidence: 0.7,
  usage: { input: 8, output: 4 },
  cost: 0.002,
};

function candidate(overrides: Partial<StockCatalogCandidate> = {}): StockCatalogCandidate {
  return {
    left_id: "11111111-1111-4111-8111-111111111111",
    right_id: "22222222-2222-4222-8222-222222222222",
    left_name: "Bột mì 888",
    right_name: "Bột mì 999",
    left_unit: "kg",
    right_unit: "kg",
    left_item_type: "ingredient",
    right_item_type: "ingredient",
    left_issue_count_90d: 2,
    right_issue_count_90d: 1,
    left_movement_count_90d: 1,
    right_movement_count_90d: 1,
    left_canonical_material_id: null,
    right_canonical_material_id: null,
    left_canonical_material_code: null,
    right_canonical_material_code: null,
    left_to_right_factor: 1,
    right_to_left_factor: 1,
    ...overrides,
  };
}

function classifyItem(overrides: Partial<StockCatalogClassifyItem> = {}): StockCatalogClassifyItem {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Bơ",
    unit: "kg",
    item_type: "ingredient",
    issue_count_90d: 0,
    movement_count_90d: 0,
    canonical_material_id: null,
    canonical_material_code: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<StockCatalogHandlerDeps> = {}) {
  const inserted: StockCatalogSuggestionRow[][] = [];
  const usageRecords: StockCatalogUsage[] = [];
  const defaults: StockCatalogHandlerDeps = {
    killSwitch: () => false,
    evaluator: () => async () => SAME_EVAL,
    authenticate: async () => ({ userId: "owner-1" }),
    listCandidates: async () => [],
    listExistingMergePairKeys: async () => [],
    listUnclassifiedItems: async () => [],
    getUsage: async (usageDate) => ({ usage_date: usageDate, calls: 0, cost: 0, call_limit: 600 }),
    recordUsage: async (usage) => { usageRecords.push(usage); },
    insertSuggestions: async (rows) => {
      inserted.push(rows);
      return { inserted: rows.length, auto: { applied: 0, skipped: {} } };
    },
    now: () => new Date("2026-10-15T00:00:00.000Z"),
    audit: () => {},
  };
  return { deps: { ...defaults, ...overrides }, inserted, usageRecords };
}

function scanRequest(body: unknown, contentType = "application/json") {
  return new Request("https://edge.test/stock-catalog-jev", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

test("CORS preflight and method are bounded", async () => {
  const handler = createStockCatalogHandler(makeDeps().deps);
  const preflight = await handler(new Request("https://edge.test/stock-catalog-jev", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal((await handler(new Request("https://edge.test", { method: "GET" }))).status, 405);
});

test("a kill switch and a non-editor session are refused before any work", async () => {
  const killed = createStockCatalogHandler(makeDeps({ killSwitch: () => true }).deps);
  const killedResponse = await killed(scanRequest({ mode: "dedupe" }));
  assert.equal(killedResponse.status, 503);
  assert.equal((await killedResponse.json()).code, "disabled");

  const forbidden = createStockCatalogHandler(makeDeps({
    authenticate: async () => { throw new StockCatalogError("forbidden", 403); },
  }).deps);
  const forbiddenResponse = await forbidden(scanRequest({ mode: "dedupe" }));
  assert.equal(forbiddenResponse.status, 403);
  assert.equal((await forbiddenResponse.json()).code, "forbidden");
});

test("the request grammar is validated", async () => {
  const handler = createStockCatalogHandler(makeDeps().deps);
  assert.equal((await handler(scanRequest({ mode: "delete" }))).status, 400);
  assert.equal((await handler(scanRequest({}))).status, 400);
  assert.equal((await handler(scanRequest({ mode: "dedupe", limit: 0 }))).status, 400);
  assert.equal((await handler(scanRequest({ mode: "dedupe", limit: 201 }))).status, 400);
  assert.equal((await handler(scanRequest({ mode: "dedupe", sql: "select 1" }))).status, 400);
  assert.equal((await handler(scanRequest({ mode: "dedupe" }, "text/plain"))).status, 415);
});

test("the daily quota stops the run before any Jev call", async () => {
  let calls = 0;
  const { deps, inserted, usageRecords } = makeDeps({
    listCandidates: async () => [candidate()],
    getUsage: async (usageDate) => ({ usage_date: usageDate, calls: 600, cost: 1, call_limit: 600 }),
    evaluator: () => async () => { calls += 1; return SAME_EVAL; },
  });
  const response = await createStockCatalogHandler(deps)(scanRequest({ mode: "dedupe" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.calls, 0);
  assert.equal(body.stopped, "daily_limit");
  assert.equal(calls, 0, "an exhausted quota must never call Jev");
  assert.equal(inserted.length, 0);
  assert.equal(usageRecords.length, 0);
});

test("a pair already suggested for the same prompt version is skipped", async () => {
  const pair = candidate();
  let calls = 0;
  const { deps, inserted } = makeDeps({
    listCandidates: async () => [pair],
    listExistingMergePairKeys: async (promptVersion) => {
      assert.equal(promptVersion, JEV_PROMPT_VERSION);
      return [candidatePairKey(pair.left_id, pair.right_id)];
    },
    evaluator: () => async () => { calls += 1; return SAME_EVAL; },
  });
  const response = await createStockCatalogHandler(deps)(scanRequest({ mode: "dedupe" }));
  const body = await response.json();
  assert.equal(body.candidates, 1);
  assert.equal(body.skipped_existing, 1);
  assert.equal(body.calls, 0);
  assert.equal(calls, 0);
  assert.equal(inserted.length, 0);
});

test("only a Jev probability of at least 0.5 is written as a merge suggestion", async () => {
  const lowPair = candidate();
  const highPair = candidate({
    left_id: "55555555-5555-4555-8555-555555555555",
    right_id: "66666666-6666-4666-8666-666666666666",
    left_name: "Bơ",
    right_name: "Bơ lạt",
    right_issue_count_90d: 9,
  });
  const { deps, inserted, usageRecords } = makeDeps({
    listCandidates: async () => [lowPair, highPair],
    evaluator: () => async ({ state }) => {
      const name = (state as { a: { name: string } }).a.name;
      return name === "Bơ" ? SAME_EVAL : DIFF_EVAL;
    },
  });
  const response = await createStockCatalogHandler(deps)(scanRequest({ mode: "dedupe" }));
  const body = await response.json();
  assert.equal(body.calls, 2);
  assert.equal(body.suggestions, 1);
  assert.equal(inserted.length, 1);
  const row = inserted[0][0];
  assert.equal(row.kind, "merge");
  assert.equal(row.item_id, "55555555-5555-4555-8555-555555555555");
  assert.equal(row.other_item_id, "66666666-6666-4666-8666-666666666666");
  assert.equal(row.proposed_target_id, "66666666-6666-4666-8666-666666666666");
  assert.equal(row.proposed_factor, 1);
  assert.equal(row.factor_source, "unit_rule");
  assert.equal(row.probability, 0.9);
  assert.equal(row.prompt_version, JEV_PROMPT_VERSION);

  assert.equal(usageRecords.length, 1);
  assert.equal(usageRecords[0].calls, 2);
  assert.equal(usageRecords[0].cost, 0.002);
});

test("a missing conversion factor is recorded as factor_source none", async () => {
  const pair = candidate({ left_to_right_factor: null, right_to_left_factor: null });
  const { deps, inserted } = makeDeps({
    listCandidates: async () => [pair],
  });
  const response = await createStockCatalogHandler(deps)(scanRequest({ mode: "dedupe" }));
  assert.equal((await response.json()).suggestions, 1);
  assert.equal(inserted[0][0].proposed_factor, null);
  assert.equal(inserted[0][0].factor_source, "none");
});

test("classify mode asks for the item class and writes kind classify", async () => {
  const { deps, inserted } = makeDeps({
    listUnclassifiedItems: async (promptVersion) => {
      assert.equal(promptVersion, JEV_PROMPT_VERSION);
      return [classifyItem()];
    },
    evaluator: () => async () => CLASS_EVAL,
  });
  const response = await createStockCatalogHandler(deps)(scanRequest({ mode: "classify" }));
  const body = await response.json();
  assert.equal(body.suggestions, 1);
  assert.equal(inserted.length, 1);
  const row = inserted[0][0];
  assert.equal(row.kind, "classify");
  assert.equal(row.item_id, "44444444-4444-4444-8444-444444444444");
  assert.equal(row.proposed_class, "raw_material");
  assert.equal(row.probability, 0.82);
  assert.equal(row.proposed_target_id, null);
});

test("a Jev failure is counted without writing anything", async () => {
  const { deps, inserted } = makeDeps({
    listCandidates: async () => [candidate()],
    evaluator: () => async () => { throw new StockCatalogError("scan_failed", 503); },
  });
  const response = await createStockCatalogHandler(deps)(scanRequest({ mode: "dedupe" }));
  const body = await response.json();
  assert.equal(body.failed, 1);
  assert.equal(body.suggestions, 0);
  assert.equal(inserted.length, 0);
});

test("classify mode passes past corrections to Jev and reports auto-applied classes", async () => {
  const seenCorrections: unknown[] = [];
  const item = {
    ...classifyItem(),
    corrections: ["Người duyệt đã sửa trước đây: Bơ → rejected (Bé Mì đã chọn raw_material)"],
  };
  const { deps } = makeDeps({
    evaluator: () => async (params) => {
      seenCorrections.push(params.corrections);
      return CLASS_EVAL;
    },
    listUnclassifiedItems: async () => [item],
    insertSuggestions: async (rows) => ({
      inserted: rows.length,
      auto: { applied: rows.length, skipped: {} },
    }),
  });
  const handler = createStockCatalogHandler(deps);
  const body = await (await handler(scanRequest({ mode: "classify" }))).json();
  assert.deepEqual(seenCorrections[0], item.corrections);
  assert.equal(body.auto_applied, 1);
  assert.deepEqual(body.auto_skipped, {});
});

test("a merge suggestion is never auto-applied even when the store returns none", async () => {
  const { deps } = makeDeps({
    evaluator: () => async () => SAME_EVAL,
    listCandidates: async () => [candidate()],
    insertSuggestions: async (rows) => ({
      inserted: rows.length,
      auto: { applied: 0, skipped: {} },
    }),
  });
  const handler = createStockCatalogHandler(deps);
  const body = await (await handler(scanRequest({ mode: "dedupe" }))).json();
  assert.equal(body.auto_applied, 0);
  assert.equal(body.suggestions, 1);
});
