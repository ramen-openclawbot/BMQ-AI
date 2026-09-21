// Offline handler tests for the VNAgent data-assets admin: owner gate, origin
// gate, idempotent contributions (scope-sensitive), optimistic concurrency, Gold
// validation, SQL-scoped export, daily timeseries and honest failure handling.
import test from "node:test";
import assert from "node:assert/strict";
import { createDataAdminHandler, vnToday, type DataAdminConfig, type DataAdminIdentity, type DataAdminStore } from "./handler.ts";
import { DataAdminError, type AssetFilterInput, type DataAsset, type ExportQuery } from "./data-assets.ts";
import {
  SUPPORTED_TOPICS,
  buildGenerationChunkRequest,
  estimateWorstCaseCostUsd,
  generationChunkPlan,
  generationInputTokenBound,
  generationOutputTokenBound,
  splitGenerationStyleMix,
  validateGenerationOutput,
  validateGenerationRequest,
  type GenerationRequest,
} from "./generation.ts";
import { GenerationProviderError } from "./generation-client.ts";

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
  jobs: Map<string, Record<string, unknown>>;
  progressSignals: AbortSignal[];
  progressInputs: { created: number; duplicate: number }[];
}

function harness(seed: DataAsset[] = []): Harness {
  const assets = new Map(seed.map((item) => [item.id, { ...item }]));
  const calls: string[] = [];
  const exportQueries: ExportQuery[] = [];
  const jobs = new Map<string, Record<string, unknown>>();
  const progressSignals: AbortSignal[] = [];
  const progressInputs: { created: number; duplicate: number }[] = [];
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
    async generationStart(input) {
      calls.push(`generationStart:${input.idempotencyKey}`);
      const existing = [...jobs.values()].find((job) => job.idempotency_key === input.idempotencyKey);
      if (existing) {
        // Same key with a different contract is a conflict, never a silent reuse.
        if (existing.request_fingerprint !== input.requestFingerprint) throw new DataAdminError("generation_idempotency_conflict", 409);
        return { job: existing, resumed: true, abandoned: false };
      }
      const running = [...jobs.values()].find((job) => job.status === "running");
      if (running) throw new DataAdminError("generation_busy", 409);
      const job: Record<string, unknown> = {
        id: `33333333-3333-3333-3333-${String(jobs.size).padStart(12, "0")}`,
        status: "running",
        version: 1,
        idempotency_key: input.idempotencyKey,
        request_fingerprint: input.requestFingerprint,
        request: input.request,
        model: input.model,
        prompt_version: input.promptVersion,
        seed_ids: input.seedIds,
        budget_usd: input.budgetUsd,
        worst_case_cost_usd: input.worstCaseCostUsd,
        actual_cost_usd: null,
        result_summary: {},
        error_code: null,
      };
      jobs.set(String(job.id), job);
      return { job, resumed: false, abandoned: false };
    },
    async generationFinish(input) {
      calls.push(`generationFinish:${input.status}`);
      const job = jobs.get(input.jobId);
      if (!job) throw new DataAdminError("generation_job_not_found", 404);
      if (job.version !== input.expectedVersion) throw new DataAdminError("generation_version_conflict", 409);
      const updated = { ...job, status: input.status, version: Number(job.version) + 1, result_summary: input.summary, actual_cost_usd: input.actualCostUsd, error_code: input.errorCode };
      jobs.set(input.jobId, updated);
      return updated;
    },
    async generationProgress(input, signal) {
      calls.push(`generationProgress:${input.created}/${input.duplicate}`);
      progressSignals.push(signal);
      progressInputs.push({ created: input.created, duplicate: input.duplicate });
      // Mirrors the RPC: merge partial counts, keep the job running and DO NOT bump
      // the version (the terminal write still uses the start version).
      const job = jobs.get(input.jobId);
      if (!job) throw new DataAdminError("generation_job_not_found", 404);
      if (job.version !== input.expectedVersion) throw new DataAdminError("generation_version_conflict", 409);
      const updated = { ...job, result_summary: { ...(job.result_summary as Record<string, unknown>), created: input.created, duplicate: input.duplicate } };
      jobs.set(input.jobId, updated);
      return updated;
    },
    async generationGet(jobId, idempotencyKey) {
      calls.push(`generationGet:${jobId ?? idempotencyKey ?? "recent"}`);
      if (idempotencyKey) return { job: [...jobs.values()].find((job) => job.idempotency_key === idempotencyKey) ?? null, jobs: [], abandoned: false };
      if (jobId) return { job: jobs.get(jobId) ?? null, jobs: [], abandoned: false };
      return { job: null, jobs: [...jobs.values()], abandoned: false };
    },
  };
  return { store, calls, assets, exportQueries, jobs, progressSignals, progressInputs };
}

/**
 * A harness whose generation writes honor the passed abort signal, like the real
 * Supabase client (`.abortSignal(signal)`). Without this, a terminal write could
 * silently "succeed" in an offline test even while bound to an aborted caller
 * signal, which is exactly the production bug these regressions pin down.
 */
function abortAwareHarness() {
  const base = harness();
  const finishSignals: AbortSignal[] = [];
  const store: DataAdminStore = {
    ...base.store,
    async createAsset(input, key, signal) {
      signal.throwIfAborted();
      return base.store.createAsset(input, key, signal);
    },
    async generationFinish(input, signal) {
      finishSignals.push(signal);
      signal.throwIfAborted();
      return base.store.generationFinish(input, signal);
    },
  };
  return { ...base, store, finishSignals };
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

function post(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request("https://example.test/vnagent-data-admin", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
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

test("CORS allows the exact admin hosts and rejects suffix/lookalike and foreign origins", async () => {
  const { store } = harness();
  const handler = createDataAdminHandler(configFor({}, store));

  for (const origin of ["https://admin.banhmique.vn", "https://admin.vnagent.ai", "https://ai.banhmique.vn"]) {
    const response = await handler(post({ action: "overview" }, { origin }));
    assert.equal(response.status, 200, `allowed origin rejected: ${origin}`);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
  }

  for (const origin of [
    "https://admin.banhmique.vn.evil.test",
    "https://admin.banhmique.vn:443",
    "https://sub.admin.banhmique.vn",
    "https://evil-admin.banhmique.vn",
    "https://admin.banhmique.com",
    "http://admin.banhmique.vn",
    "https://admin.vnagent.ai.evil.test",
    "https://evil.example",
  ]) {
    const response = await handler(post({ action: "overview" }, { origin }));
    assert.equal(response.status, 403, `origin should be forbidden: ${origin}`);
    assert.equal((await response.json()).code, "origin_forbidden");
    assert.equal(response.headers.get("access-control-allow-origin"), null, `no CORS echo for: ${origin}`);
  }
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

// ── Owner-only Generate Data (durable job, hard budget, strict provenance) ─────

function generationItems(request: GenerationRequest) {
  const styles = ["variant", "typo", "ambiguous", "out_of_scope"] as const;
  const response: Record<string, string> = { variant: "answer", typo: "answer", ambiguous: "clarify", out_of_scope: "abstain" };
  // The question text includes the chunk position so a multi-chunk batch produces
  // DISTINCT questions per chunk, like a real model would (otherwise the DB dedupe
  // key would legitimately count the later chunks as duplicates).
  const chunk = request.chunkIndex ?? 0;
  const value = {
    questions: Array.from({ length: request.count }, (_, index) => {
      const style = styles[index % styles.length];
      const topicId = request.topicId === "mixed" ? SUPPORTED_TOPICS[index % SUPPORTED_TOPICS.length].id : request.topicId;
      return { question: `Câu hỏi tổng hợp phần ${chunk} số ${index} về ${topicId}?`, style, topic_id: topicId, expected_response: response[style], expected_filters: {} };
    }),
  };
  return validateGenerationOutput(value, request);
}

const GENERATION_PRICES = { inputPer1kUsd: 0.0003, outputPer1kUsd: 0.0012, cachedInputPer1kUsd: 0.000006, provenance: { source: "deepseek-official-pricing", modelId: "deepseek-flash" } };
const generationBody = { action: "generate", topic: "controlled_revenue", count: 20, target_language: "vi", budget_usd: 1, idempotency_key: "batch-0001" };

test("generation is disabled without a server generator and never makes a call", async () => {
  const { store, calls } = harness();
  const handler = createDataAdminHandler(configFor({}, store, { generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post(generationBody));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "generation_disabled");
  assert.deepEqual(calls.filter((call) => call.startsWith("generation")), []);
});

test("an unbounded or insufficient budget fails closed before any model call", async () => {
  const { store, calls } = harness();
  let callsToModel = 0;
  const generate = async () => { callsToModel += 1; throw new Error("must not be called"); };
  const unbounded = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => null }));
  const unboundedResponse = await unbounded(post(generationBody));
  assert.equal(unboundedResponse.status, 503);
  assert.equal((await unboundedResponse.json()).code, "generation_cost_unbounded");

  // A valid budget that is below the measured worst case is refused before any call.
  const expensive = { inputPer1kUsd: 0.01, outputPer1kUsd: 0.05, provenance: { source: "test-catalog" } };
  const tooSmall = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => expensive }));
  const tooSmallResponse = await tooSmall(post({ ...generationBody, budget_usd: 0.05 }));
  assert.equal(tooSmallResponse.status, 400);
  assert.equal((await tooSmallResponse.json()).code, "generation_budget_exceeded");
  assert.equal(callsToModel, 0);
  assert.deepEqual(calls.filter((call) => call.startsWith("generationStart")), []);
});

test("a successful batch stores Raw synthetic/llm_generated assets with run provenance", async () => {
  const { store, calls, assets, jobs } = harness();
  const seen: GenerationRequest[] = [];
  const generate = async (request: GenerationRequest) => {
    seen.push(request);
    return { items: generationItems(request), usage: { input: 900, output: 600 }, cost: 0.02, model: "deepseek-flash" };
  };
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES, generationModel: () => "deepseek-flash" }));
  const response = await handler(post(generationBody));
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.status, "ok");
  assert.equal(body.results.created, 20);
  assert.equal(body.results.duplicate, 0);
  // A 20-question batch is generated as two 10-question chunks; the reported cost
  // and usage are the sums across both calls.
  assert.deepEqual(seen.map((entry) => entry.count), [10, 10]);
  assert.deepEqual(seen.map((entry) => entry.chunkIndex), [0, 1]);
  assert.ok(seen.every((entry) => entry.chunkTotal === 2 && entry.idempotencyKey === "batch-0001"));
  assert.equal(body.actualCostUsd, 0.04);
  const stored = [...assets.values()];
  assert.equal(stored.length, 20);
  for (const asset of stored) {
    assert.equal(asset.dataset_stage, "raw");
    assert.equal(asset.source_kind, "synthetic");
    assert.equal(asset.source_designation, "llm_generated");
    assert.equal(asset.evaluation_status, "not_evaluated");
    assert.equal(asset.provenance.model, "deepseek-flash");
    assert.equal(asset.provenance.source, "synthetic_builtin_example");
    assert.equal(asset.provenance.pricing.source, "deepseek-official-pricing");
    assert.ok(typeof asset.provenance.inputTokenBound === "number" && asset.provenance.inputTokenBound > 0);
    assert.ok(typeof asset.provenance.runId === "string");
    assert.ok(!("dataset_stage" in asset.provenance));
  }
  assert.equal(body.usage.input, 1800);
  assert.equal(body.usage.output, 1200);
  assert.equal([...jobs.values()][0].status, "completed");
  assert.ok(calls.some((call) => call === "generationFinish:completed"));
});

test("live progress heartbeats run during the loop with running counts and a detached signal", async () => {
  const harnessed = harness();
  const caller = new AbortController();
  const generate = async (request: GenerationRequest) => ({ items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0.02, model: "m" });
  const handler = createDataAdminHandler(configFor({}, harnessed.store, { generate, generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post(generationBody, {}, caller.signal));
  assert.equal(response.status, 201);

  // One heartbeat per stored question, carrying the RUNNING created/duplicate totals.
  assert.equal(harnessed.progressInputs.length, 20);
  assert.deepEqual(harnessed.progressInputs[0], { created: 1, duplicate: 0 });
  assert.deepEqual(harnessed.progressInputs[19], { created: 20, duplicate: 0 });
  // Every heartbeat runs under its OWN bounded signal, never the caller's.
  assert.equal(harnessed.progressSignals.length, 20);
  for (const signal of harnessed.progressSignals) {
    assert.notEqual(signal, caller.signal);
    assert.equal(signal.aborted, false);
  }
  // The terminal write still stores the full summary, not the last heartbeat.
  const job = [...harnessed.jobs.values()][0];
  assert.equal(job.status, "completed");
  const summary = job.result_summary as Record<string, unknown>;
  assert.equal(summary.created, 20);
  assert.equal(summary.duplicate, 0);
  assert.equal(summary.total, 20);
});

test("a failing progress write never fails the batch and still returns the accepted results", async () => {
  const harnessed = harness();
  let progressCalls = 0;
  const store: DataAdminStore = {
    ...harnessed.store,
    async generationProgress() {
      progressCalls += 1;
      throw new Error("progress unavailable");
    },
  };
  const generate = async (request: GenerationRequest) => ({ items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0.02, model: "m" });
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post(generationBody));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.status, "ok");
  assert.equal(body.results.created, 20);
  assert.equal(body.results.duplicate, 0);
  assert.equal(body.assets.length, 20);
  // The heartbeat was attempted for every item and every failure was swallowed.
  assert.equal(progressCalls, 20);
  assert.equal([...harnessed.jobs.values()][0].status, "completed");
});

test("progress heartbeats never change the terminal failed settle or its partial counts", async () => {
  const harnessed = abortAwareHarness();
  const controller = new AbortController();
  let inserts = 0;
  const store: DataAdminStore = {
    ...harnessed.store,
    async createAsset(input, key, signal) {
      const result = await harnessed.store.createAsset(input, key, signal);
      inserts += 1;
      if (inserts === 5) controller.abort();
      return result;
    },
  };
  const generate = async (request: GenerationRequest) => ({ items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0.02, model: "m" });
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));

  await handler(post(generationBody, {}, controller.signal));

  const job = [...harnessed.jobs.values()][0];
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "generation_request_aborted");
  // The terminal write still owns the final summary with the partial counts.
  assert.deepEqual(job.result_summary, { created: 5, duplicate: 0, rejected: 0 });
  assert.deepEqual(harnessed.progressInputs.at(-1), { created: 5, duplicate: 0 });
  assert.equal(harnessed.finishSignals.length, 1);
  assert.equal(harnessed.finishSignals[0].aborted, false);
});

test("unknown provider usage is returned as null, never a fabricated zero", async () => {
  const { store } = harness();
  const generate = async (request: GenerationRequest) => ({ items: generationItems(request), usage: { input: null, output: null }, cost: null, model: "m" });
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post(generationBody));
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.deepEqual(body.usage, { input: null, output: null });
  assert.equal(body.actualCostUsd, null);
});

test("a DeepSeek outcome keeps the billed cost unknown and stores the usage bound separately", async () => {
  const { store, jobs } = harness();
  // Exactly what the DeepSeek client returns: no provider dollar cost, plus a
  // conservative peak-rate usage upper bound.
  const generate = async (request: GenerationRequest) => ({
    items: generationItems(request),
    usage: { input: 900, output: 640 },
    cost: null,
    usageCostUpperBoundUsd: 0.000921,
    model: "deepseek-flash",
  });
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES, generationModel: () => "deepseek-flash" }));
  const response = await handler(post(generationBody));
  const body = await response.json();
  assert.equal(response.status, 201);
  // The billed cost is genuinely unknown, never replaced by the peak-rate bound.
  assert.equal(body.actualCostUsd, null);
  // The usage upper bound is the SUM across the two 10-question chunks.
  assert.equal(body.usageCostUpperBoundUsd, 0.001842);
  assert.equal(body.results.created, 20);
  const job = [...jobs.values()][0];
  assert.equal(job.status, "completed");
  assert.equal(job.actual_cost_usd, null);
  // The bound is durable and clearly separate from the actual cost column.
  assert.equal((job.result_summary as Record<string, unknown>).usageCostUpperBoundUsd, 0.001842);
});

test("the same key with a different payload is a 409 conflict, not a silent reuse", async () => {
  const { store } = harness();
  let modelCalls = 0;
  const generate = async (request: GenerationRequest) => { modelCalls += 1; return { items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0.02, model: "m" }; };
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  assert.equal((await handler(post(generationBody))).status, 201);
  const conflict = await handler(post({ ...generationBody, count: 30 }));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "generation_idempotency_conflict");
  // The first (20-question) batch made two chunk calls; the conflicting retry spent nothing.
  assert.equal(modelCalls, 2);
});

test("a repeated idempotency key reads the durable job back and never spends again", async () => {
  const { store } = harness();
  let modelCalls = 0;
  const generate = async (request: GenerationRequest) => {
    modelCalls += 1;
    return { items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0.02, model: "m" };
  };
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  const first = await handler(post(generationBody));
  assert.equal(first.status, 201);
  const second = await handler(post(generationBody));
  const body = await second.json();
  assert.equal(second.status, 200);
  assert.equal(body.resumed, true);
  assert.equal(body.status, "ok");
  assert.equal(body.results.created, 20);
  // Two chunks on the first run; the resumed read-back calls the model zero times.
  assert.equal(modelCalls, 2);
});

test("a reported cost above the owner budget stores nothing and fails the job", async () => {
  const { store, assets, jobs } = harness();
  const generate = async (request: GenerationRequest) => ({ items: generationItems(request), usage: { input: 1, output: 1 }, cost: 2, model: "m" });
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post(generationBody));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "generation_budget_exceeded");
  assert.equal(assets.size, 0);
  assert.equal([...jobs.values()][0].status, "budget_exceeded");
});

test("generate_status supports exact-key recovery and validates ids/keys", async () => {
  const { store } = harness();
  const generate = async (request: GenerationRequest) => ({ items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0.02, model: "m" });
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  await handler(post(generationBody));
  const list = await handler(post({ action: "generate_status" }));
  const listBody = await list.json();
  assert.equal(listBody.status, "ok");
  assert.equal(listBody.jobs.length, 1);
  const jobId = listBody.jobs[0].id;
  const single = await handler(post({ action: "generate_status", job_id: jobId }));
  assert.equal((await single.json()).job.status, "completed");
  // Exact-key recovery finds the job even though it is outside a bounded list.
  const byKey = await handler(post({ action: "generate_status", idempotency_key: "batch-0001" }));
  assert.equal((await byKey.json()).job.id, jobId);
  // An absent key is authoritative and must not enable a new paid batch.
  const absent = await handler(post({ action: "generate_status", idempotency_key: "batch-absent-0009" }));
  assert.equal((await absent.json()).job, null);
  const invalid = await handler(post({ action: "generate_status", job_id: "not-a-uuid" }));
  assert.equal(invalid.status, 400);
  const invalidKey = await handler(post({ action: "generate_status", idempotency_key: "bad key!" }));
  assert.equal(invalidKey.status, 400);
});

test("a resumed failed job keeps its terminal failure status, not a success", async () => {
  const { store } = harness();
  let modelCalls = 0;
  const generate = async () => { modelCalls += 1; throw new DataAdminError("generation_unavailable", 503); };
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  const first = await handler(post(generationBody));
  assert.equal(first.status, 503);
  const second = await handler(post(generationBody));
  const body = await second.json();
  assert.equal(second.status, 200);
  assert.equal(body.resumed, true);
  assert.equal(body.status, "failed");
  assert.equal(body.job.status, "failed");
  assert.equal(modelCalls, 1);
});

test("a deterministic provider failure returns the durable failed job envelope with a safe reason", async () => {
  const { store, jobs, calls } = harness();
  const auditEvents: Record<string, unknown>[] = [];
  // A real HTTP-error-shaped provider failure carrying a secret-bearing message.
  const generate = async () => {
    throw new GenerationProviderError("generation_http_error", 502, { status: 400, code: "invalid_request_error", param: "max_tokens" });
  };
  const handler = createDataAdminHandler(configFor({}, store, {
    generate,
    generationPricing: () => GENERATION_PRICES,
    audit: (event) => auditEvents.push(event),
  }));

  const response = await handler(post(generationBody));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "failed");
  assert.equal(body.resumed, false);
  assert.equal(body.job.status, "failed");
  assert.equal(body.job.error_code, "generation_http_error");
  assert.equal(body.results.created, 0);
  // Support diagnostics stay on the saved job only; they are not in the primary envelope.
  assert.equal("diagnostic" in body, false);
  assert.deepEqual(body.job.result_summary.diagnostic, { status: 400, code: "invalid_request_error", param: "max_tokens" });
  assert.equal([...jobs.values()][0].status, "failed");
  assert.ok(calls.includes("generationFinish:failed"));

  // Exact-key read-back resolves to the same durable failure (UI recovery path).
  const readBack = await (await handler(post({ action: "generate_status", idempotency_key: "batch-0001" }))).json();
  assert.equal(readBack.job.status, "failed");
  assert.equal(readBack.job.error_code, "generation_http_error");
  assert.deepEqual(readBack.job.result_summary.diagnostic, { status: 400, code: "invalid_request_error", param: "max_tokens" });

  // The audit record carries safe codes only, never a raw provider message.
  const audit = auditEvents.find((event) => event.event === "vnagent_data_admin_generate");
  assert.equal(audit?.outcome, "failed");
  assert.equal(audit?.errorCode, "generation_http_error");
  assert.deepEqual(audit?.diagnostic, { status: 400, code: "invalid_request_error", param: "max_tokens" });
  assert.ok(!JSON.stringify(audit).includes("message"));
});

test("the DeepSeek 402 insufficient-balance rejection is a durable, fixed-code failure", async () => {
  const { store, jobs } = harness();
  // The DeepSeek client maps its documented 402 rejection to this fixed code; the
  // handler must persist exactly that code and never a raw provider message.
  const generate = async () => {
    throw new GenerationProviderError("generation_insufficient_balance", 502, { status: 402, code: "insufficient_balance_error", param: null });
  };
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post(generationBody));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "failed");
  assert.equal(body.job.status, "failed");
  assert.equal(body.job.error_code, "generation_insufficient_balance");
  assert.deepEqual(body.job.result_summary.diagnostic, { status: 402, code: "insufficient_balance_error", param: null });
  assert.equal([...jobs.values()][0].status, "failed");
  assert.ok(!JSON.stringify(body).includes("Insufficient Balance"));
});

test("a historical Gateway paid-credits job stays a durable, fixed-code failure (no raw message)", async () => {
  const { store, jobs } = harness();
  // Old job rows created while generation ran on the Vercel AI Gateway still carry
  // this code; the new DeepSeek lane never emits it, but it must stay explainable.
  const generate = async () => {
    throw new GenerationProviderError("generation_paid_credits_required", 502, { status: 403, code: "invalid_request_error", param: null });
  };
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post(generationBody));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "failed");
  assert.equal(body.job.status, "failed");
  assert.equal(body.job.error_code, "generation_paid_credits_required");
  assert.deepEqual(body.job.result_summary.diagnostic, { status: 403, code: "invalid_request_error", param: null });
  assert.equal([...jobs.values()][0].status, "failed");
  // The durable record never contains the provider message or its billing URL.
  assert.ok(!JSON.stringify(body).includes("Free tier"));
  assert.ok(!JSON.stringify(body).includes("vercel.com"));
});

test("a resumed deterministic failure stays failed and never spends again", async () => {
  const { store } = harness();
  let modelCalls = 0;
  const generate = async () => { modelCalls += 1; throw new GenerationProviderError("generation_http_error", 502, { status: 400, code: "invalid_request_error", param: "max_tokens" }); };
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  assert.equal((await handler(post(generationBody))).status, 200);
  const second = await handler(post(generationBody));
  const body = await second.json();
  assert.equal(second.status, 200);
  assert.equal(body.resumed, true);
  assert.equal(body.status, "failed");
  assert.equal(body.job.status, "failed");
  assert.equal(modelCalls, 1);
});

test("generate_status surfaces a server-evaluated expired lease as abandoned", async () => {
  const { store } = harness();
  const expiredStore = {
    ...store,
    generationGet: async () => ({ job: { id: "j1", status: "running", version: 1 }, jobs: [], abandoned: true }),
  };
  const handler = createDataAdminHandler(configFor({}, expiredStore, {}));
  const response = await handler(post({ action: "generate_status", idempotency_key: "batch-0001" }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.abandoned, true);
  assert.equal(body.job.status, "running");
});

// ── Caller abort: a live batch must always settle, never stay `running` ────────

test("a caller abort during the model call settles the job failed with the abort code", async () => {
  const harnessed = abortAwareHarness();
  const controller = new AbortController();
  const generate = async (_request: GenerationRequest, signal: AbortSignal) => {
    // The owner's panel aborted in flight; the client surfaces an AbortError.
    controller.abort();
    signal.throwIfAborted();
    throw new Error("unreachable");
  };
  const handler = createDataAdminHandler(configFor({}, harnessed.store, { generate, generationPricing: () => GENERATION_PRICES }));

  await handler(post(generationBody, {}, controller.signal));

  const job = [...harnessed.jobs.values()][0];
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "generation_request_aborted");
  assert.deepEqual(job.result_summary, { created: 0, duplicate: 0, rejected: 0 });
});

test("a caller abort part-way through asset inserts still settles the job failed with partial counts", async () => {
  const harnessed = abortAwareHarness();
  const controller = new AbortController();
  let inserts = 0;
  const store: DataAdminStore = {
    ...harnessed.store,
    async createAsset(input, key, signal) {
      const result = await harnessed.store.createAsset(input, key, signal);
      inserts += 1;
      if (inserts === 5) controller.abort();
      return result;
    },
  };
  const generate = async (request: GenerationRequest) => ({ items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0.02, model: "m" });
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));

  const response = await handler(post(generationBody, {}, controller.signal));

  // The caller is gone, but the durable job is terminal and keeps the partial work.
  assert.equal(controller.signal.aborted, true);
  assert.ok(response.status >= 400);
  const job = [...harnessed.jobs.values()][0];
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "generation_request_aborted");
  assert.deepEqual(job.result_summary, { created: 5, duplicate: 0, rejected: 0 });
  assert.equal(harnessed.assets.size, 5);
});

test("an already-aborted caller signal never leaves the job running", async () => {
  const harnessed = abortAwareHarness();
  const controller = new AbortController();
  const generate = async (request: GenerationRequest) => {
    // The model call had already returned when the abort raced in; the batch must
    // still be settled instead of hanging `running`.
    controller.abort();
    return { items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0.02, model: "m" };
  };
  const handler = createDataAdminHandler(configFor({}, harnessed.store, { generate, generationPricing: () => GENERATION_PRICES }));

  await handler(post(generationBody, {}, controller.signal));

  const job = [...harnessed.jobs.values()][0];
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "generation_request_aborted");
  assert.deepEqual(job.result_summary, { created: 0, duplicate: 0, rejected: 0 });
  assert.equal(harnessed.assets.size, 0);
});

test("the terminal write uses a detached bounded signal, never the aborted caller signal", async () => {
  const harnessed = abortAwareHarness();
  const controller = new AbortController();
  let inserts = 0;
  const store: DataAdminStore = {
    ...harnessed.store,
    async createAsset(input, key, signal) {
      const result = await harnessed.store.createAsset(input, key, signal);
      inserts += 1;
      if (inserts === 5) controller.abort();
      return result;
    },
  };
  const generate = async (request: GenerationRequest) => ({ items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0.02, model: "m" });
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));

  await handler(post(generationBody, {}, controller.signal));

  assert.equal(controller.signal.aborted, true);
  assert.equal(harnessed.finishSignals.length, 1);
  const settle = harnessed.finishSignals[0];
  // This is the regression: the terminal write must NOT run under the caller's
  // aborted signal, and must still be backed by a bounded budget of its own.
  assert.equal(settle.aborted, false);
  assert.notEqual(settle, controller.signal);
  assert.equal([...harnessed.jobs.values()][0].status, "failed");
});

// ── Chunked generation: one small call per chunk, per-chunk retry ─────────────

test("a 50-question batch calls the generator once per chunk with that chunk's count and mix", async () => {
  const { store, assets, jobs } = harness();
  const seen: GenerationRequest[] = [];
  const generate = async (request: GenerationRequest) => {
    seen.push(request);
    return { items: generationItems(request), usage: { input: 500, output: 300 }, cost: 0.01, model: "m" };
  };
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post({ ...generationBody, count: 50, idempotency_key: "batch-50" }));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.results.created, 50);
  // Five 10-question chunks, in order, each documented with its position.
  assert.equal(seen.length, 5);
  assert.deepEqual(seen.map((entry) => entry.count), [10, 10, 10, 10, 10]);
  assert.deepEqual(seen.map((entry) => entry.chunkIndex), [0, 1, 2, 3, 4]);
  assert.ok(seen.every((entry) => entry.chunkTotal === 5));
  for (const entry of seen) {
    assert.equal(Object.values(entry.styleMix).reduce((sum, value) => sum + value, 0), entry.count);
  }
  assert.equal(assets.size, 50);
  assert.equal([...jobs.values()][0].status, "completed");
});

test("a chunk that fails once then succeeds is retried and the batch completes with all items", async () => {
  const { store, assets, jobs } = harness();
  let calls = 0;
  const generate = async (request: GenerationRequest) => {
    calls += 1;
    // The FIRST attempt at chunk 0 fails with a retryable invalid-output error.
    if (calls === 1) throw new DataAdminError("generation_invalid_output", 502);
    return { items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0.01, model: "m" };
  };
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post(generationBody));
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.status, "ok");
  assert.equal(body.results.created, 20);
  // chunk 0: failed once then succeeded (2 calls); chunk 1: succeeded (1 call).
  assert.equal(calls, 3);
  assert.equal(assets.size, 20);
  assert.equal([...jobs.values()][0].status, "completed");
});

test("a chunk that always fails settles failed with the partial counts from earlier chunks", async () => {
  const { store, assets, jobs } = harness();
  const callsPerChunk: number[] = [];
  const generate = async (request: GenerationRequest) => {
    const index = request.chunkIndex ?? 0;
    callsPerChunk[index] = (callsPerChunk[index] ?? 0) + 1;
    if (index === 1) throw new DataAdminError("generation_invalid_output", 502);
    return { items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0.01, model: "m" };
  };
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post(generationBody));
  const body = await response.json();

  // A definitive failure is a durable job envelope; the first chunk's 10 items stay.
  assert.equal(response.status, 200);
  assert.equal(body.status, "failed");
  assert.equal(body.results.created, 10);
  assert.equal(callsPerChunk[0], 1);
  assert.equal(callsPerChunk[1], 3);
  assert.equal(assets.size, 10);
  const job = [...jobs.values()][0];
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "generation_invalid_output");
  assert.deepEqual(job.result_summary, { created: 10, duplicate: 0, rejected: 0 });
});

test("the pre-call budget check uses the SUMMED worst case across every planned chunk", async () => {
  const { store, calls } = harness();
  let modelCalls = 0;
  const generate = async (request: GenerationRequest) => {
    modelCalls += 1;
    return { items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0, model: "m" };
  };
  // Expensive prices keep both the single-call and summed bounds inside the form's
  // allowed budget range, so the midpoint budget is a valid request.
  const expensive = { inputPer1kUsd: 0.01, outputPer1kUsd: 0.05 };
  const full = validateGenerationRequest({ topic: "controlled_revenue", count: 20, target_language: "vi", budget_usd: 1, idempotency_key: "batch-0001" });
  const plan = generationChunkPlan(full.count);
  const mixes = splitGenerationStyleMix(full.styleMix, plan);
  const chunks = plan.map((size, index) => buildGenerationChunkRequest(full, { count: size, styleMix: mixes[index], chunkIndex: index, chunkTotal: plan.length }));
  const single = estimateWorstCaseCostUsd({ inputTokens: generationInputTokenBound(full, "deepseek-flash"), outputTokens: generationOutputTokenBound(full.count) }, expensive)!;
  const summed = chunks.reduce((sum, chunk) => sum + estimateWorstCaseCostUsd(
    { inputTokens: generationInputTokenBound(chunk, "deepseek-flash"), outputTokens: generationOutputTokenBound(chunk.count) },
    expensive,
  )!, 0);
  assert.ok(summed > single, `summed ${summed} should exceed single ${single}`);
  const budget = Math.round(((single + summed) / 2) * 1000) / 1000;
  assert.ok(budget >= 0.01 && budget <= 5);

  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => expensive, generationModel: () => "deepseek-flash" }));
  const response = await handler(post({ ...generationBody, budget_usd: budget }));

  // The budget passes the old single-call bound but not the summed chunk bound, so
  // it must be refused BEFORE any paid call and before the job is even started.
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "generation_budget_exceeded");
  assert.equal(modelCalls, 0);
  assert.deepEqual(calls.filter((call) => call.startsWith("generationStart")), []);
});

test("a non-retryable chunk error stops the batch immediately without a retry", async () => {
  const { store, assets, jobs } = harness();
  const calls: number[] = [];
  const generate = async (request: GenerationRequest) => {
    calls.push(request.chunkIndex ?? 0);
    if ((request.chunkIndex ?? 0) === 1) {
      throw new GenerationProviderError("generation_insufficient_balance", 502, { status: 402, code: "insufficient_balance_error", param: null });
    }
    return { items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0, model: "m" };
  };
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post(generationBody));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "failed");
  assert.equal(body.results.created, 10);
  // Chunk 1 was attempted exactly once: an insufficient balance is definitive.
  assert.deepEqual(calls, [0, 1]);
  assert.equal(assets.size, 10);
  const job = [...jobs.values()][0];
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "generation_insufficient_balance");
  const summary = job.result_summary as Record<string, unknown>;
  assert.equal(summary.created, 10);
  assert.deepEqual(summary.diagnostic, { status: 402, code: "insufficient_balance_error", param: null });
});

test("a provider 5xx chunk is retried, but a provider 4xx stops immediately", async () => {
  const { store, assets, jobs } = harness();
  const calls: number[] = [];
  const generate = async (request: GenerationRequest) => {
    const index = request.chunkIndex ?? 0;
    calls.push(index);
    // Chunk 0: first attempt is a transient 503, then it succeeds.
    if (index === 0 && calls.filter((entry) => entry === 0).length === 1) {
      throw new GenerationProviderError("generation_http_error", 502, { status: 503, code: "service_unavailable", param: null });
    }
    // Chunk 1: a 400 bad-request is definitive and must not be retried.
    if (index === 1) {
      throw new GenerationProviderError("generation_http_error", 502, { status: 400, code: "invalid_request_error", param: "max_tokens" });
    }
    return { items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0, model: "m" };
  };
  const handler = createDataAdminHandler(configFor({}, store, { generate, generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post(generationBody));
  await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [0, 0, 1]);
  assert.equal(assets.size, 10);
  const job = [...jobs.values()][0];
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "generation_http_error");
  const summary = job.result_summary as Record<string, unknown>;
  assert.equal((summary.diagnostic as Record<string, unknown>).status, 400);
});

test("progress heartbeats carry the running totals across chunk boundaries", async () => {
  const harnessed = harness();
  const generate = async (request: GenerationRequest) => ({ items: generationItems(request), usage: { input: 1, output: 1 }, cost: 0.01, model: "m" });
  const handler = createDataAdminHandler(configFor({}, harnessed.store, { generate, generationPricing: () => GENERATION_PRICES }));
  const response = await handler(post({ ...generationBody, count: 50, idempotency_key: "batch-progress-50" }));
  assert.equal(response.status, 201);

  // One heartbeat per stored question, climbing continuously across each chunk.
  assert.equal(harnessed.progressInputs.length, 50);
  assert.deepEqual(harnessed.progressInputs[0], { created: 1, duplicate: 0 });
  assert.deepEqual(harnessed.progressInputs[9], { created: 10, duplicate: 0 });
  assert.deepEqual(harnessed.progressInputs[10], { created: 11, duplicate: 0 });
  assert.deepEqual(harnessed.progressInputs[49], { created: 50, duplicate: 0 });
});
