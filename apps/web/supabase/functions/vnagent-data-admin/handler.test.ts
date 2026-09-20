// Offline handler tests for the VNAgent data-assets admin: owner gate, origin
// gate, idempotent contributions (scope-sensitive), optimistic concurrency, Gold
// validation, SQL-scoped export, daily timeseries and honest failure handling.
import test from "node:test";
import assert from "node:assert/strict";
import { createDataAdminHandler, vnToday, type DataAdminConfig, type DataAdminIdentity, type DataAdminStore } from "./handler.ts";
import { DataAdminError, type AssetFilterInput, type DataAsset, type ExportQuery } from "./data-assets.ts";

const ORIGIN = "https://ai.banhmique.vn";
const ASSET_ID = "11111111-1111-1111-1111-111111111111";

function makeAsset(overrides: Partial<DataAsset> = {}): DataAsset {
  return {
    id: ASSET_ID,
    tenant: "bmq",
    dataset_stage: "raw",
    source_kind: "contributor",
    source_designation: "manual",
    interaction_id: null,
    question: "Giá bánh mì que?",
    source_answer: null,
    expected_intent: { intent: "tra cứu giá" },
    expected_filters: { product: "BMQ-001" },
    provenance: { note: "manual" },
    snapshot_at: "2026-09-20T01:00:00.000Z",
    effective_at: "2026-09-20T01:00:00.000Z",
    evaluation_status: "not_evaluated",
    verified_intent: null,
    verified_conditions: null,
    evidence: [],
    reviewer_id: null,
    version: 1,
    dedupe_key: "contributor:seed",
    created_by: "owner-1",
    created_at: "2026-09-20T01:00:00.000Z",
    updated_at: "2026-09-20T01:00:00.000Z",
    ...overrides,
  };
}

interface Harness {
  store: DataAdminStore;
  calls: string[];
  assets: Map<string, DataAsset>;
  exportQueries: ExportQuery[];
}

function harness(seed: DataAsset[] = []): Harness {
  const assets = new Map(seed.map((item) => [item.id, { ...item }]));
  const calls: string[] = [];
  const exportQueries: ExportQuery[] = [];
  const store: DataAdminStore = {
    async metrics() {
      calls.push("metrics");
      return {
        asOf: "2026-09-20",
        assets: { raw: 1, curated: 2, gold: 1, total: 4 },
        createdToday: 1,
        promotionsToday: { rawToCurated: 1, curatedToGold: 0, demotions: 0 },
        promotions7d: { rawToCurated: 3, curatedToGold: 1 },
        collected: { today: 5, last7d: 20, total: 60 },
        reviewed: { verified: 1, pending: 2, rejected: 0, notEvaluated: 1, denominator: 4 },
        unknown: { abstainedToday: 1, abstainedTotal: 4, errorsToday: 0, errorsTotal: 1 },
        sourceContributions: { operational_chat: 1, contributor: 2, synthetic: 1, total: 4 },
        scopeNote: "stages",
      };
    },
    async timeseries(days) {
      calls.push(`timeseries:${days}`);
      return {
        from: "2026-08-22", to: "2026-09-20", timezone: "Asia/Ho_Chi_Minh",
        days: [{ date: "2026-09-20", stock: { raw: 1, curated: 2, gold: 1, total: 4 }, inflow: { raw: 1, curated: 1, gold: 0 } }],
        sourceContributions: { operational_chat: 1, contributor: 2, synthetic: 1, total: 4 },
      };
    },
    async listAssets(filters: AssetFilterInput) {
      calls.push(`list:${filters.stage ?? "all"}`);
      const rows = [...assets.values()].filter((item) => !filters.stage || item.dataset_stage === filters.stage);
      return { rows: rows.slice(filters.offset, filters.offset + filters.limit), total: rows.length };
    },
    async listExportAssets(filters: ExportQuery) {
      calls.push("export");
      exportQueries.push(filters);
      const rows = [...assets.values()].filter((item) => {
        if (filters.stage && item.dataset_stage !== filters.stage) return false;
        if (filters.sourceKind && item.source_kind !== filters.sourceKind) return false;
        if (filters.evaluationStatus && item.evaluation_status !== filters.evaluationStatus) return false;
        if (filters.assetIds && !filters.assetIds.includes(item.id)) return false;
        if (filters.from && item.effective_at.slice(0, 10) < filters.from) return false;
        if (filters.to && item.effective_at.slice(0, 10) > filters.to) return false;
        return true;
      });
      return { rows: rows.slice(0, filters.limit), total: rows.length };
    },
    async getAsset(id) {
      calls.push(`get:${id}`);
      return assets.get(id) ?? null;
    },
    async createAsset(input, key) {
      calls.push("create");
      const existing = [...assets.values()].find((item) => item.dedupe_key === key);
      if (existing) return { status: "duplicate", asset: existing };
      const created = makeAsset({
        id: `22222222-2222-2222-2222-${String(assets.size).padStart(12, "0")}`,
        question: input.question,
        source_kind: input.sourceKind,
        source_designation: input.sourceDesignation,
        expected_intent: input.expectedIntent,
        expected_filters: input.expectedFilters,
        provenance: input.provenance,
        snapshot_at: input.snapshotAt,
        dedupe_key: key,
      });
      assets.set(created.id, created);
      return { status: "created", asset: created };
    },
    async transitionAsset(input) {
      calls.push(`transition:${input.toStage}`);
      const asset = assets.get(input.assetId);
      if (!asset) throw new DataAdminError("asset_not_found", 404);
      if (asset.version !== input.expectedVersion) throw new DataAdminError("version_conflict", 409);
      const updated = makeAsset({
        ...asset,
        dataset_stage: input.toStage,
        version: asset.version + 1,
        evaluation_status: input.toStage === "gold" ? "verified" : input.toStage === "curated" ? "pending_review" : "not_evaluated",
        verified_intent: input.verified?.intent ?? null,
        verified_conditions: input.verified?.conditions ?? null,
        evidence: input.verified?.evidence ?? [],
        reviewer_id: input.toStage === "gold" ? "owner-1" : null,
      });
      assets.set(updated.id, updated);
      return updated;
    },
    async listJev() {
      calls.push("jev");
      return [];
    },
  };
  return { store, calls, assets, exportQueries };
}

function configFor(identity: Partial<DataAdminIdentity>, store: DataAdminStore, overrides: Partial<DataAdminConfig> = {}): DataAdminConfig {
  return {
    enabled: () => true,
    authenticate: async () => ({ userId: "owner-1", role: "owner", store, ...identity }),
    now: () => new Date("2026-09-20T03:00:00.000Z"),
    audit: () => undefined,
    captureEnabled: () => true,
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/vnagent-data-admin", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

test("owner contribution is created, then a repeat is an honest duplicate", async () => {
  const { store, calls } = harness();
  const handler = createDataAdminHandler(configFor({}, store));
  const payload = { action: "contribute", question: "Giá bánh mì que?", source_kind: "contributor", source_designation: "manual", expected_intent: { intent: "tra cứu giá" } };

  const first = await handler(post(payload));
  assert.equal(first.status, 201);
  assert.equal((await first.json()).status, "created");

  const second = await handler(post(payload));
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.status, "duplicate");
  assert.equal(secondBody.duplicate, true);
  assert.equal(calls.filter((call) => call === "create").length, 2);
});

test("the same question with a different expected scope stays a distinct contribution", async () => {
  const { store } = harness();
  const handler = createDataAdminHandler(configFor({}, store));
  const base = { action: "contribute", question: "Doanh thu hôm nay?", source_kind: "contributor", source_designation: "manual" };

  const first = await (await handler(post({ ...base, expected_filters: { range: "today" } }))).json();
  const second = await (await handler(post({ ...base, expected_filters: { range: "this_week" } }))).json();
  const repeat = await (await handler(post({ ...base, expected_filters: { range: "today" } }))).json();

  assert.equal(first.status, "created");
  assert.equal(second.status, "created");
  assert.notEqual(first.asset.id, second.asset.id);
  assert.equal(repeat.status, "duplicate");
  assert.equal(repeat.asset.id, first.asset.id);
});

test("non-owner is denied before any dataset access", async () => {
  const { store, calls } = harness();
  const handler = createDataAdminHandler(configFor({ role: "viewer" }, store));
  const response = await handler(post({ action: "overview" }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "forbidden");
  assert.deepEqual(calls, []);
});

test("disabled feature and disallowed origin fail closed", async () => {
  const { store } = harness();
  const disabled = createDataAdminHandler(configFor({}, store, { enabled: () => false }));
  assert.equal((await disabled(post({ action: "overview" }))).status, 503);

  const handler = createDataAdminHandler(configFor({}, store));
  const badOrigin = await handler(post({ action: "overview" }, { origin: "https://evil.example" }));
  assert.equal(badOrigin.status, 403);
  assert.equal((await badOrigin.json()).code, "origin_forbidden");
});

test("stale optimistic version returns a conflict instead of overwriting", async () => {
  const { store } = harness([makeAsset({ version: 2 })]);
  const handler = createDataAdminHandler(configFor({}, store));
  const response = await handler(post({ action: "transition", asset_id: ASSET_ID, expected_version: 1, to_stage: "curated" }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "version_conflict");
});

test("Gold transition requires verified intent, conditions and evidence", async () => {
  const { store } = harness([makeAsset({ dataset_stage: "curated", version: 3, dedupe_key: "x" })]);
  const handler = createDataAdminHandler(configFor({}, store));

  const missing = await handler(post({ action: "transition", asset_id: ASSET_ID, expected_version: 3, to_stage: "gold" }));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "gold_verification_required");

  const empty = await handler(post({ action: "transition", asset_id: ASSET_ID, expected_version: 3, to_stage: "gold", verified: { intent: "x", conditions: { period: "today" }, evidence: [null] } }));
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, "gold_evidence_required");

  const valid = await handler(post({
    action: "transition",
    asset_id: ASSET_ID,
    expected_version: 3,
    to_stage: "gold",
    verified: { intent: "trả lời doanh thu có kiểm soát", conditions: { period: "today" }, evidence: [{ kind: "snapshot", ref: "snap-1" }] },
  }));
  assert.equal(valid.status, 200);
  const validBody = await valid.json();
  assert.equal(validBody.asset.dataset_stage, "gold");
  assert.equal(validBody.asset.evaluation_status, "verified");
  assert.equal(validBody.asset.reviewer_id, "owner-1");
  assert.equal(validBody.asset.version, 4);
});

test("export escapes injected markdown and reports the filter scope", async () => {
  const { store } = harness([makeAsset({ question: "Bánh | <img src=x onerror=alert(1)> `q`", snapshot_at: "2026-09-19T00:00:00.000Z" })]);
  const handler = createDataAdminHandler(configFor({}, store));
  const response = await handler(post({ action: "export", stage: "raw", limit: 10 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.count, 1);
  assert.equal(body.total, 1);
  assert.equal(body.truncated, false);
  assert.match(body.markdown, /stage=raw/);
  const [summaryTable, fullCases] = body.markdown.split("## Full cases");
  assert.ok(!summaryTable.includes("<img src=x"));
  assert.match(summaryTable, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(summaryTable, /\\\|/);
  // The raw value is preserved for verification inside the fenced full case.
  assert.ok(fullCases.includes("<img src=x onerror=alert(1)>"));
});

test("export applies date filters in the store before the limit and reports accurate truncation", async () => {
  const { store, exportQueries } = harness([
    makeAsset({ id: ASSET_ID, effective_at: "2026-09-19T00:00:00.000Z" }),
    makeAsset({ id: "33333333-3333-3333-3333-333333333333", effective_at: "2026-09-21T00:00:00.000Z", dedupe_key: "b" }),
    makeAsset({ id: "44444444-4444-4444-4444-444444444444", effective_at: "2026-09-20T00:00:00.000Z", dedupe_key: "c" }),
  ]);
  const handler = createDataAdminHandler(configFor({}, store));
  const body = await (await handler(post({ action: "export", from: "2026-09-20", to: "2026-09-20", limit: 1 }))).json();
  // The store received the date predicates (not a post-filter) and the limit.
  assert.equal(exportQueries.length, 1);
  assert.equal(exportQueries[0].from, "2026-09-20");
  assert.equal(exportQueries[0].to, "2026-09-20");
  assert.equal(exportQueries[0].limit, 1);
  // 1 matching row in range, truncated to the limit while the tool still sees 2 in the broader range.
  assert.equal(body.count, 1);
  assert.equal(body.total, 1);
  assert.equal(body.truncated, false);
});

test("export supports an explicit single selected asset", async () => {
  const { store, exportQueries } = harness([
    makeAsset({ id: ASSET_ID }),
    makeAsset({ id: "33333333-3333-3333-3333-333333333333", dedupe_key: "b" }),
  ]);
  const handler = createDataAdminHandler(configFor({}, store));
  const body = await (await handler(post({ action: "export", asset_ids: [ASSET_ID], limit: 1 }))).json();
  assert.deepEqual(exportQueries[0].assetIds, [ASSET_ID]);
  assert.equal(body.count, 1);
  assert.equal(body.filters.asset_ids.length, 1);
  assert.match(body.markdown, /Giá bánh mì que\?/);
});

test("store failures surface honestly instead of a fake success", async () => {
  const failing: DataAdminConfig = configFor({}, {
    metrics: async () => { throw new Error("boom"); },
    timeseries: async () => { throw new Error("boom"); },
    listAssets: async () => { throw new Error("boom"); },
    listExportAssets: async () => { throw new Error("boom"); },
    getAsset: async () => { throw new Error("boom"); },
    createAsset: async () => { throw new Error("boom"); },
    transitionAsset: async () => { throw new Error("boom"); },
    listJev: async () => { throw new Error("boom"); },
  });
  const handler = createDataAdminHandler(failing);
  const response = await handler(post({ action: "overview" }));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "store_unavailable");
  assert.ok(!("overview" in body));
});

test("overview returns real normalized counts, source contributions and capture status", async () => {
  const { store } = harness();
  const handler = createDataAdminHandler(configFor({}, store));
  const body = await (await handler(post({ action: "overview" }))).json();
  assert.equal(body.overview.assets.total, 4);
  assert.equal(body.overview.createdToday, 1);
  assert.equal(body.overview.reviewed.denominator, 4);
  assert.equal(body.overview.sourceContributions.contributor, 2);
  assert.equal(body.capture.enabled, true);

  const off = createDataAdminHandler(configFor({}, store, { captureEnabled: () => false }));
  assert.equal((await (await off(post({ action: "overview" }))).json()).capture.enabled, false);
});

test("timeseries returns the daily event-derived series and validates the day window", async () => {
  const { store, calls } = harness();
  const handler = createDataAdminHandler(configFor({}, store));
  const ok = await (await handler(post({ action: "timeseries", days: 90 }))).json();
  assert.equal(ok.timeseries.days.length, 1);
  assert.equal(ok.timeseries.days[0].stock.total, 4);
  assert.equal(ok.timeseries.days[0].inflow.curated, 1);
  assert.ok(calls.includes("timeseries:90"));

  const bad = await handler(post({ action: "timeseries", days: 5 }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "invalid_days");
});

test("invalid action and oversized export limit are rejected", async () => {
  const { store } = harness();
  const handler = createDataAdminHandler(configFor({}, store));
  assert.equal((await handler(post({ action: "delete_everything" }))).status, 400);
  assert.equal((await handler(post({ action: "export", limit: 5000 }))).status, 400);
});

test("vnToday uses the Vietnam calendar day", () => {
  assert.equal(vnToday(new Date("2026-09-19T18:00:00.000Z")), "2026-09-20");
  assert.equal(vnToday(new Date("2026-09-19T16:59:00.000Z")), "2026-09-19");
});

test("every action accepts the transport language envelope", async () => {
  const { store } = harness([makeAsset()]);
  const handler = createDataAdminHandler(configFor({}, store));
  const cases: Record<string, unknown>[] = [
    { action: "overview", language: "vi" },
    { action: "timeseries", language: "vi", days: 30 },
    { action: "assets", language: "vi", limit: 5 },
    { action: "asset", language: "vi", asset_id: ASSET_ID },
    { action: "contribute", language: "en", question: "Câu hỏi mới?", source_kind: "contributor", source_designation: "manual" },
    { action: "transition", language: "vi", asset_id: ASSET_ID, expected_version: 1, to_stage: "curated" },
    { action: "jev", language: "vi", limit: 5 },
    { action: "export", language: "vi", limit: 5 },
  ];
  for (const body of cases) {
    const response = await handler(post(body));
    assert.ok(response.status < 400, `${String(body.action)} should accept language but got ${response.status}`);
  }
});

test("error messages default to English and only switch to Vietnamese when requested", async () => {
  const { store } = harness();
  const handler = createDataAdminHandler(configFor({}, store));

  // No language signal at all: English is the admin default.
  const defaultBody = await (await handler(post({ action: "not_an_action" }))).json() as { error: string; code: string };
  assert.equal(defaultBody.code, "invalid_action");
  assert.equal(defaultBody.error, "Unsupported action.");

  // An explicit Vietnamese signal still selects the Vietnamese messages.
  const viBody = await (await handler(post({ action: "not_an_action" }, { "accept-language": "vi-VN" }))).json() as { error: string };
  assert.equal(viBody.error, "Thao tác không được hỗ trợ.");
});
