// Offline tests for the kho review Jev handler and pair selection.
// The Jev provider is a fake evaluator: no network, no paid request and no real
// BMQ data. The handler is exercised over a real Request/Response pair.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KHO_REVIEW_JEV_DEFAULT_LIMIT,
  KHO_REVIEW_JEV_MAX_LIMIT,
  collectKhoReviewJevPairs,
  createKhoReviewJevHandler,
  pairKey,
  parseKhoReviewJevInput,
  type KhoReviewJevMarkRow,
  type KhoReviewJevReview,
} from "./handler.ts";
import {
  KHO_REVIEW_JEV_PROMPT_VERSION,
  verdictFromProbability,
  type KhoReviewJevEvaluation,
  type KhoReviewJevEvaluator,
  type KhoReviewJevEvaluatorParams,
} from "./jev.ts";

function reviewFixture(): KhoReviewJevReview {
  return {
    items: [
      {
        target_key: "i:item-1:q7",
        item_id: "item-1",
        item_code: "NVL-BOT",
        name: "Bột mì",
        unit: "kg",
        item_class: "raw_material",
        location: "q7",
        candidates: [
          {
            receipt_item_id: "ri-1",
            product_name: "Bột mì 888",
            unit: "kg",
            supplier_name: "NCC A",
            receipt_date: "2026-10-01",
            location: "q7",
          },
          {
            receipt_item_id: "ri-2",
            product_name: "Bột mì 999",
            unit: "kg",
            supplier_name: "NCC B",
            receipt_date: "2026-10-02",
            location: "q7",
          },
        ],
      },
    ],
    materials: [
      {
        target_key: "m:mat-1:kg",
        canonical_material_id: "mat-1",
        name: "Bơ",
        recipe_unit: "kg",
        sku_codes: ["BANH"],
        candidates: [
          {
            receipt_item_id: "ri-3",
            product_name: "Bơ Pháp",
            unit: "kg",
            supplier_name: "NCC C",
            receipt_date: "2026-10-03",
            location: "tan_tao",
          },
        ],
      },
    ],
  };
}

function fakeEvaluator(
  calls: KhoReviewJevEvaluatorParams[],
  overrides: Partial<Record<string, KhoReviewJevEvaluation | Error>> = {},
): KhoReviewJevEvaluator {
  return async (params) => {
    calls.push(params);
    const forced = overrides[params.state.line.name];
    if (forced instanceof Error) throw forced;
    if (forced) return forced;
    const name = params.state.line.name;
    const pSame = name.includes("888") ? 0.92 : name.includes("999") ? 0.1 : 0.5;
    return {
      p_same: pSame,
      suggested_class: params.kind === "material" ? "raw_material" : null,
      class_probability: params.kind === "material" ? 0.87 : null,
      usage: { input: 10, output: 2 },
      cost: 0,
      provider: "typesafe",
    };
  };
}

function request(body: unknown): Request {
  return new Request("https://example.test/functions/v1/kho-review-jev", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://ai.banhmique.vn" },
    body: JSON.stringify(body),
  });
}

test("verdict thresholds are same_item >= 0.8, different <= 0.2, otherwise unsure", () => {
  assert.equal(verdictFromProbability(1), "same_item");
  assert.equal(verdictFromProbability(0.8), "same_item");
  assert.equal(verdictFromProbability(0.79), "unsure");
  assert.equal(verdictFromProbability(0.21), "unsure");
  assert.equal(verdictFromProbability(0.2), "different");
  assert.equal(verdictFromProbability(0), "different");
});

test("pair collection keeps item and material targets, filters target_keys and dedupes", () => {
  const all = collectKhoReviewJevPairs(reviewFixture());
  assert.deepEqual(
    all.map((pair) => [pair.target_key, pair.receipt_item_id, pair.target_kind]),
    [
      ["i:item-1:q7", "ri-1", "item"],
      ["i:item-1:q7", "ri-2", "item"],
      ["m:mat-1:kg", "ri-3", "material"],
    ],
  );
  assert.deepEqual(all[2].state.target, {
    kind: "material",
    name: "Bơ",
    recipe_unit: "kg",
    sku_codes: ["BANH"],
  });
  assert.deepEqual(all[2].state.line, {
    name: "Bơ Pháp",
    unit: "kg",
    supplier: "NCC C",
    receipt_date: "2026-10-03",
    location: "tan_tao",
  });

  const onlyItems = collectKhoReviewJevPairs(reviewFixture(), ["i:item-1:q7"]);
  assert.equal(onlyItems.length, 2);
  assert.ok(onlyItems.every((pair) => pair.target_key === "i:item-1:q7"));

  const duplicate: KhoReviewJevReview = {
    items: [{
      ...reviewFixture().items![0],
      candidates: [
        { receipt_item_id: "ri-1", product_name: "Bột mì 888" },
        { receipt_item_id: "ri-1", product_name: "Bột mì 888 lặp" },
      ],
    }],
  };
  assert.equal(collectKhoReviewJevPairs(duplicate).length, 1);
});

test("input defaults to 20 pairs and hard-caps limit at 40", () => {
  assert.deepEqual(parseKhoReviewJevInput({}), { targetKeys: null, limit: KHO_REVIEW_JEV_DEFAULT_LIMIT });
  assert.equal(parseKhoReviewJevInput({ limit: 40 }).limit, 40);
  assert.equal(parseKhoReviewJevInput({ limit: 100 }).limit, KHO_REVIEW_JEV_MAX_LIMIT);
  assert.deepEqual(parseKhoReviewJevInput({ target_keys: ["a", "a", "b"] }).targetKeys, ["a", "b"]);
  assert.throws(() => parseKhoReviewJevInput({ limit: 0 }));
  assert.throws(() => parseKhoReviewJevInput({ target_keys: "nope" }));
  assert.throws(() => parseKhoReviewJevInput({ extra: true }));
});

test("the handler skips marks for the current prompt version, asks Jev and stores suggestions only", async () => {
  const calls: KhoReviewJevEvaluatorParams[] = [];
  const rows: KhoReviewJevMarkRow[] = [];
  const marked = new Set([pairKey("m:mat-1:kg", "ri-3")]);
  const handler = createKhoReviewJevHandler({
    authenticate: async () => ({ userId: "user-1", review: reviewFixture() }),
    evaluator: () => fakeEvaluator(calls),
    listMarkedPairs: async (promptVersion, targetKeys) => {
      assert.equal(promptVersion, KHO_REVIEW_JEV_PROMPT_VERSION);
      assert.ok(targetKeys.includes("i:item-1:q7"));
      assert.ok(targetKeys.includes("m:mat-1:kg"));
      return marked;
    },
    upsertMarks: async (inserted) => { rows.push(...inserted); },
  });

  const response = await handler(request({ limit: 10 }));
  assert.equal(response.status, 200);
  const body = await response.json() as {
    asked: number;
    cached: number;
    skipped: number;
    marks: { target_key: string; receipt_item_id: string; verdict: string; probability: number }[];
  };
  assert.equal(body.asked, 2);
  assert.equal(body.cached, 1);
  assert.equal(body.skipped, 0);
  assert.equal(body.marks.length, 2);
  assert.deepEqual(
    body.marks.map((mark) => [mark.receipt_item_id, mark.verdict, mark.probability]),
    [
      ["ri-1", "same_item", 0.92],
      ["ri-2", "different", 0.1],
    ],
  );
  assert.equal(calls.length, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].prompt_version, KHO_REVIEW_JEV_PROMPT_VERSION);
  assert.equal(rows[0].model, "typesafe-ai/jev");
  assert.equal(rows[0].provider, "typesafe");
  assert.equal(rows[0].created_by, "user-1");
  assert.equal(rows[0].suggested_class, null);
});

test("the handler applies the 40-pair cap and reports the over-limit pairs as skipped", async () => {
  const candidates = Array.from({ length: 45 }, (_value, index) => ({
    receipt_item_id: `ri-${index}`,
    product_name: `Bột mì ${index}`,
    unit: "kg",
  }));
  const review: KhoReviewJevReview = {
    items: [{
      target_key: "i:item-1:q7",
      item_id: "item-1",
      item_code: "NVL-BOT",
      name: "Bột mì",
      unit: "kg",
      location: "q7",
      candidates,
    }],
    materials: [],
  };
  const calls: KhoReviewJevEvaluatorParams[] = [];
  const rows: KhoReviewJevMarkRow[] = [];
  const handler = createKhoReviewJevHandler({
    authenticate: async () => ({ userId: "user-1", review }),
    evaluator: () => fakeEvaluator(calls),
    listMarkedPairs: async () => new Set(),
    upsertMarks: async (inserted) => { rows.push(...inserted); },
  });

  const response = await handler(request({ limit: 100 }));
  assert.equal(response.status, 200);
  const body = await response.json() as { asked: number; cached: number; skipped: number };
  assert.equal(body.asked, KHO_REVIEW_JEV_MAX_LIMIT);
  assert.equal(body.cached, 0);
  assert.equal(body.skipped, 5);
  assert.equal(calls.length, KHO_REVIEW_JEV_MAX_LIMIT);
  assert.equal(rows.length, KHO_REVIEW_JEV_MAX_LIMIT);
});

test("a provider failure skips only that pair and never links or creates", async () => {
  const calls: KhoReviewJevEvaluatorParams[] = [];
  const rows: KhoReviewJevMarkRow[] = [];
  const handler = createKhoReviewJevHandler({
    authenticate: async () => ({ userId: "user-1", review: reviewFixture() }),
    evaluator: () => fakeEvaluator(calls, {
      "Bột mì 888": new Error("provider down"),
      "Bơ Pháp": { p_same: 0.5, suggested_class: "packaging_supply", class_probability: 0.9, usage: { input: 1, output: 1 }, cost: null },
    }),
    listMarkedPairs: async () => new Set(),
    upsertMarks: async (inserted) => { rows.push(...inserted); },
  });

  const response = await handler(request({}));
  assert.equal(response.status, 200);
  const body = await response.json() as {
    asked: number;
    skipped: number;
    marks: { receipt_item_id: string; verdict: string; suggested_class: string | null }[];
  };
  assert.equal(body.asked, 3);
  assert.equal(body.skipped, 1);
  assert.equal(body.marks.length, 2);
  const materialMark = body.marks.find((mark) => mark.receipt_item_id === "ri-3");
  assert.equal(materialMark?.verdict, "unsure");
  assert.equal(materialMark?.suggested_class, "packaging_supply");
  assert.equal(rows.length, 2);
});

test("the handler rejects a malformed request and refuses a missing evaluator", async () => {
  const handler = createKhoReviewJevHandler({
    authenticate: async () => ({ userId: "user-1", review: reviewFixture() }),
    evaluator: () => null,
    listMarkedPairs: async () => new Set(),
    upsertMarks: async () => undefined,
  });

  const bad = await handler(new Request("https://example.test/functions/v1/kho-review-jev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit: 0 }),
  }));
  assert.equal(bad.status, 400);

  const unconfigured = await handler(request({}));
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json() as { code: string }).code, "unconfigured");
});
