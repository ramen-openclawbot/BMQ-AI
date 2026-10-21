// Offline handler tests: owner gate, kill switch, request grammar, dry_run
// no-write, run upsert that never overwrites a CEO review, batch limit,
// unchanged-state skip and per-pair Jev failure counting.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createJevScanHandler,
  JevScanError,
  type ExistingCheck,
  type JevCheckRow,
  type JevDuplicateScanConfig,
  type JevDuplicateDataSource,
} from "./handler.ts";
import type { CandidateRequest } from "./candidates.ts";
import { buildPairState, stateHash, type RequestStateInput } from "./state.ts";
import { JEV_MODEL, JevError, type JevEvaluation } from "./jev.ts";

const FLAG_EVAL: JevEvaluation = {
  p_same: 0.95,
  relation: "same_purchase",
  relation_probability: 0.9,
  relation_confidence: 0.8,
  usage: { input: 10, output: 5 },
  cost: null,
};

function request(id: string, overrides: Partial<CandidateRequest> = {}): CandidateRequest {
  return {
    id,
    request_number: `PR-${id}`,
    supplier_id: "sup-1",
    purchase_order_id: `po-${id}`,
    status: "pending",
    total_amount: 1_000_000,
    created_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function detail(row: CandidateRequest): RequestStateInput {
  return {
    id: row.id,
    request_number: row.request_number,
    created_at: row.created_at,
    total_amount: row.total_amount,
    title: `Phiếu ${row.id}`,
    description: "Mô tả",
    po_number: row.purchase_order_id ? `PO-${row.id}` : null,
    goods_receipt_number: null,
    receipt_date: null,
    invoice_number: null,
    items: [],
  };
}

function sourceFor(requests: CandidateRequest[], existing: ExistingCheck[] = []): JevDuplicateDataSource {
  const details = Object.fromEntries(requests.map((row) => [row.id, detail(row)]));
  return {
    listRequests: async ({ ids }) => (ids && ids.length > 0 ? requests.filter((row) => ids.includes(row.id)) : requests),
    listExistingChecks: async (pairKeys) => (pairKeys ? existing.filter((row) => pairKeys.includes(row.pair_key)) : existing),
    loadContext: async ({ requestIds }) => ({
      supplierNames: { "sup-1": "NCC A" },
      requests: Object.fromEntries(requestIds.map((id) => [id, details[id]])),
    }),
  };
}

function makeConfig(overrides: Partial<JevDuplicateScanConfig> = {}) {
  const store = new Map<string, Record<string, unknown>>();
  const upserts: JevCheckRow[][] = [];
  const defaults: JevDuplicateScanConfig = {
    killSwitch: () => false,
    evaluator: () => async () => FLAG_EVAL,
    dataSource: () => sourceFor([]),
    sink: () => ({
      upsertChecks: async (rows) => {
        upserts.push(rows);
        for (const row of rows) {
          const previous = store.get(row.pair_key) ?? {};
          store.set(row.pair_key, { ...previous, ...row });
        }
      },
    }),
    authenticate: async () => ({ userId: "owner-1" }),
    now: () => new Date("2026-10-10T00:00:00.000Z"),
    audit: () => {},
  };
  return { config: { ...defaults, ...overrides }, upserts, store };
}

function scanRequest(body: unknown, contentType = "application/json") {
  return new Request("https://edge.test/finance-jev-duplicate-scan", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

test("CORS preflight and method are bounded", async () => {
  const handler = createJevScanHandler(makeConfig().config);
  const preflight = await handler(new Request("https://edge.test/finance-jev-duplicate-scan", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal((await handler(new Request("https://edge.test", { method: "GET" }))).status, 405);
});

test("a kill switch and a non-owner session are refused before any work", async () => {
  const killed = createJevScanHandler(makeConfig({ killSwitch: () => true }).config);
  const killedResponse = await killed(scanRequest({ mode: "dry_run" }));
  assert.equal(killedResponse.status, 503);
  assert.equal((await killedResponse.json()).code, "disabled");

  const forbidden = createJevScanHandler(makeConfig({
    authenticate: async () => { throw new JevScanError("forbidden", 403); },
  }).config);
  const forbiddenResponse = await forbidden(scanRequest({ mode: "dry_run" }));
  assert.equal(forbiddenResponse.status, 403);
  assert.equal((await forbiddenResponse.json()).code, "forbidden");
});

test("the request grammar is validated", async () => {
  const handler = createJevScanHandler(makeConfig().config);
  assert.equal((await handler(scanRequest({ mode: "delete" }))).status, 400);
  assert.equal((await handler(scanRequest({ limit: 0 }))).status, 400);
  assert.equal((await handler(scanRequest({ limit: 101 }))).status, 400);
  assert.equal((await handler(scanRequest({ days: 0 }))).status, 400);
  assert.equal((await handler(scanRequest({ days: 401 }))).status, 400);
  assert.equal((await handler(scanRequest({ pair_keys: "a:b" }))).status, 400);
  assert.equal((await handler(scanRequest({ sql: "select 1" }))).status, 400);
  assert.equal((await handler(scanRequest({}, "text/plain"))).status, 415);
});

test("dry_run returns items and never writes", async () => {
  const requests = [request("a"), request("b")];
  const { config, upserts } = makeConfig({ dataSource: () => sourceFor(requests) });
  const response = await createJevScanHandler(config)(scanRequest({ mode: "dry_run", limit: 50, days: 90 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "dry_run");
  assert.equal(body.candidates, 1);
  assert.equal(body.checked, 1);
  assert.equal(body.auto_flag, 1);
  assert.equal(body.failed, 0);
  assert.equal(body.skipped_unchanged, 0);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].status, "auto_flag");
  assert.equal(upserts.length, 0, "dry_run must not write");
});

test("run upserts the Jev result and never overwrites a CEO review", async () => {
  const requests = [request("a"), request("b")];
  const existing: ExistingCheck[] = [
    { pair_key: "a:b", pr_older: "a", pr_newer: "b", state_hash: "stale-hash" },
  ];
  const { config, upserts, store } = makeConfig({ dataSource: () => sourceFor(requests, existing) });
  store.set("a:b", { pair_key: "a:b", review_decision: "different_purchase", review_note: "CEO đã duyệt" });

  const response = await createJevScanHandler(config)(scanRequest({ mode: "run", limit: 50, days: 90 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "run");
  assert.equal(body.items, undefined, "run does not return items");
  assert.equal(body.auto_flag, 1);
  assert.equal(upserts.length, 1);
  const row = upserts[0][0];
  assert.equal(row.model, JEV_MODEL);
  for (const reviewKey of ["review_decision", "review_note", "reviewed_by", "reviewed_at"]) {
    assert.equal(reviewKey in row, false, `upsert must not carry ${reviewKey}`);
  }
  assert.equal(store.get("a:b")?.review_decision, "different_purchase");
  assert.equal(store.get("a:b")?.review_note, "CEO đã duyệt");
});

test("the batch limit caps how many pairs are checked", async () => {
  const requests = [request("a"), request("b"), request("c")];
  const { config } = makeConfig({ dataSource: () => sourceFor(requests) });
  const response = await createJevScanHandler(config)(scanRequest({ mode: "dry_run", limit: 1 }));
  const body = await response.json();
  assert.equal(body.candidates, 3);
  assert.equal(body.checked, 1);
  assert.equal(body.items.length, 1);
});

test("an unchanged state hash is skipped", async () => {
  const requests = [request("a"), request("b")];
  const state = buildPairState({ supplier_name: "NCC A", older: detail(requests[0]), newer: detail(requests[1]) });
  const existing: ExistingCheck[] = [
    { pair_key: "a:b", pr_older: "a", pr_newer: "b", state_hash: await stateHash(state) },
  ];
  const { config } = makeConfig({ dataSource: () => sourceFor(requests, existing) });
  const response = await createJevScanHandler(config)(scanRequest({ mode: "dry_run" }));
  const body = await response.json();
  assert.equal(body.candidates, 1);
  assert.equal(body.skipped_unchanged, 1);
  assert.equal(body.checked, 0);
});

test("pair_keys selects a rerun subset", async () => {
  const requests = [request("a"), request("b"), request("c")];
  const existing: ExistingCheck[] = [
    { pair_key: "a:b", pr_older: "a", pr_newer: "b", state_hash: "old" },
    { pair_key: "b:c", pr_older: "b", pr_newer: "c", state_hash: "old" },
  ];
  const { config } = makeConfig({ dataSource: () => sourceFor(requests, existing) });
  const response = await createJevScanHandler(config)(scanRequest({ mode: "dry_run", pair_keys: ["b:c"] }));
  const body = await response.json();
  assert.equal(body.candidates, 1);
  assert.equal(body.items[0].pair_key, "b:c");
});

test("a bad response, a timeout and a 429 are each counted as failed and never written", async () => {
  const requests = [request("a"), request("b")];
  const failures = [
    new JevError("jev_invalid_response", 502),
    new JevError("jev_timeout", 504),
    new JevError("jev_rate_limited", 429),
  ];
  for (const failure of failures) {
    const { config, upserts } = makeConfig({
      dataSource: () => sourceFor(requests),
      evaluator: () => async () => { throw failure; },
    });
    const response = await createJevScanHandler(config)(scanRequest({ mode: "run" }));
    const body = await response.json();
    assert.equal(body.checked, 0);
    assert.equal(body.failed, 1);
    assert.equal(body.items, undefined);
    assert.equal(upserts.length, 0, "a failed pair must not be written");
  }
});

test("a missing evaluator fails every pair closed instead of guessing", async () => {
  const requests = [request("a"), request("b")];
  const { config, upserts } = makeConfig({ dataSource: () => sourceFor(requests), evaluator: () => null });
  const response = await createJevScanHandler(config)(scanRequest({ mode: "dry_run" }));
  const body = await response.json();
  assert.equal(body.checked, 0);
  assert.equal(body.failed, 1);
  assert.equal(body.items[0].error, "unconfigured");
  assert.equal(upserts.length, 0);
});

const UNCERTAIN: JevEvaluation = {
  p_same: 0.4,
  relation: "unrelated",
  relation_probability: 0.6,
  relation_confidence: null,
  usage: { input: 3, output: 2 },
  cost: null,
};

const IMAGE_ANSWER: JevEvaluation = {
  p_same: 0.9,
  relation: "same_purchase",
  relation_probability: 0.9,
  relation_confidence: null,
  usage: { input: 4, output: 2 },
  cost: null,
  images_used: true,
};

test("an uncertain pair with both receipt photos keeps the text answer because Jev never uses images", async () => {
  const requests = [request("a"), request("b")];
  const image = { mime: "image/jpeg", base64: "AAA" };
  const base = sourceFor(requests);
  const source: JevDuplicateDataSource = {
    ...base,
    loadReceiptImages: async (ids) => Object.fromEntries(ids.map((id) => [id, [image]])),
  };
  const seen: Array<Record<string, unknown>> = [];
  const { config } = makeConfig({
    dataSource: () => source,
    evaluator: () => async (params) => {
      seen.push(params as unknown as Record<string, unknown>);
      return params.images && params.images.length ? { ...IMAGE_ANSWER, images_used: false } : UNCERTAIN;
    },
  });
  const body = await (await createJevScanHandler(config)(scanRequest({ mode: "dry_run" }))).json();
  assert.equal(seen.length, 2, "the pair is asked twice: text then a text-only image pass");
  assert.match(String(seen[1].imageInstructions), /hai phiếu giao hàng trong ảnh/);
  assert.equal(body.checked, 1);
  assert.equal(body.items[0].images_used, false);
  assert.equal(body.items[0].p_same_text, 0.4);
  assert.equal(body.items[0].p_same_image, null);
  assert.equal(body.items[0].p_same, 0.4);
  assert.equal(body.items[0].status, "needs_review");
});

test("a text-only fallback on the image pass keeps the text answer", async () => {
  const requests = [request("a"), request("b")];
  const image = { mime: "image/jpeg", base64: "AAA" };
  const base = sourceFor(requests);
  const source: JevDuplicateDataSource = {
    ...base,
    loadReceiptImages: async (ids) => Object.fromEntries(ids.map((id) => [id, [image]])),
  };
  const { config } = makeConfig({
    dataSource: () => source,
    evaluator: () => async (params) => (params.images && params.images.length
      ? { ...IMAGE_ANSWER, p_same: 0.95, images_used: false }
      : UNCERTAIN),
  });
  const body = await (await createJevScanHandler(config)(scanRequest({ mode: "dry_run" }))).json();
  assert.equal(body.items[0].images_used, false);
  assert.equal(body.items[0].p_same_text, 0.4);
  assert.equal(body.items[0].p_same_image, null);
  assert.equal(body.items[0].p_same, 0.4);
  assert.equal(body.items[0].status, "needs_review");
});

test("a confident text pair never spends an image call", async () => {
  const requests = [request("a"), request("b")];
  let imageReads = 0;
  const base = sourceFor(requests);
  const source: JevDuplicateDataSource = {
    ...base,
    loadReceiptImages: async (ids) => {
      imageReads += 1;
      return Object.fromEntries(ids.map((id) => [id, [{ mime: "image/jpeg", base64: "AAA" }]]));
    },
  };
  const { config } = makeConfig({ dataSource: () => source, evaluator: () => async () => FLAG_EVAL });
  await createJevScanHandler(config)(scanRequest({ mode: "dry_run" }));
  assert.equal(imageReads, 0);
});

test("past CEO decisions are appended to the duplicate question", async () => {
  const requests = [request("a"), request("b")];
  const seen: Array<Record<string, unknown>> = [];
  const { config } = makeConfig({
    dataSource: () => sourceFor(requests),
    evaluator: () => async (params) => {
      seen.push(params as unknown as Record<string, unknown>);
      return UNCERTAIN;
    },
    getRobotFeedback: async () => [{
      id: "f1",
      kind: "finance_duplicate",
      subject_key: "a:b",
      robot_choice: "needs_review",
      human_choice: "different_purchase",
      robot_probability: 0.4,
      note: null,
      created_at: null,
      robot_label: null,
      human_label: null,
    }],
  });
  await createJevScanHandler(config)(scanRequest({ mode: "dry_run" }));
  const corrections = seen[0].corrections as string[];
  assert.equal(corrections.length, 1);
  assert.match(corrections[0], /PR-a ↔ PR-b/);
  assert.match(corrections[0], /hai lần khác nhau/);
});
