// Shared client/server contract test.
//
// It sends the EXACT payloads the frontend `invokeDataAdmin` builds (including
// the transport `language` field) through the real handler in both languages and
// validates every response with the REAL frontend Zod schemas. A shape drift
// (e.g. source_kind vs sourceKind) fails here, not only in a UI fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { createDataAdminHandler, type DataAdminConfig, type DataAdminStore } from "./handler.ts";
import { DataAdminError, type AssetFilterInput, type DataAsset, type ExportQuery } from "./data-assets.ts";
import {
  assetResponseSchema,
  assetsResponseSchema,
  contributionResponseSchema,
  exportResponseSchema,
  jevResponseSchema,
  overviewResponseSchema,
  timeseriesResponseSchema,
  transitionResponseSchema,
} from "../../../src/lib/dataAssets.ts";

const ORIGIN = "https://admin.vnagent.ai";
const ASSET_ID = "11111111-1111-1111-1111-111111111111";
const GOLD_ID = "22222222-2222-2222-2222-222222222222";

function asset(overrides: Partial<DataAsset> = {}): DataAsset {
  return {
    id: ASSET_ID,
    tenant: "bmq",
    dataset_stage: "raw",
    source_kind: "operational_chat",
    source_designation: null,
    interaction_id: null,
    question: "Doanh thu có kiểm soát hôm nay?",
    source_answer: "Doanh thu có kiểm soát hôm nay là 1.000.000đ",
    expected_intent: { lane: "fast", metrics: ["controlled_revenue"] },
    expected_filters: { metric: "controlled_revenue", time_range: "today" },
    provenance: { capture: "operational_chat", requestId: "req-1", executedFilters: { metrics: ["controlled_revenue"] }, sourceProvenance: { semanticVersion: "s-1", snapshot: "snap-0", citations: ["doc-1"] } },
    snapshot_at: "2026-09-20T01:00:00.000Z",
    effective_at: "2026-09-20T01:00:00.000Z",
    evaluation_status: "not_evaluated",
    verified_intent: null,
    verified_conditions: null,
    evidence: [],
    reviewer_id: null,
    version: 1,
    dedupe_key: "operational_chat:abc",
    created_by: "owner-1",
    created_at: "2026-09-20T01:00:00.000Z",
    updated_at: "2026-09-20T01:00:00.000Z",
    ...overrides,
  };
}

const GOLD = asset({
  id: GOLD_ID,
  dataset_stage: "gold",
  evaluation_status: "verified",
  verified_intent: "doanh thu có kiểm soát theo ngày",
  verified_conditions: { period: "today", metric: "controlled_revenue" },
  evidence: [{ kind: "snapshot", ref: "snap-1" }],
  reviewer_id: "owner-1",
  version: 3,
});

function makeStore(): DataAdminStore {
  const rows = [asset(), GOLD];
  const filter = (f: { stage: string | null; sourceKind: string | null; evaluationStatus: string | null; assetIds: string[] | null; from: string | null; to: string | null }) => rows.filter((row) => {
    if (f.stage && row.dataset_stage !== f.stage) return false;
    if (f.sourceKind && row.source_kind !== f.sourceKind) return false;
    if (f.evaluationStatus && row.evaluation_status !== f.evaluationStatus) return false;
    if (f.assetIds && !f.assetIds.includes(row.id)) return false;
    if (f.from && row.effective_at.slice(0, 10) < f.from) return false;
    if (f.to && row.effective_at.slice(0, 10) > f.to) return false;
    return true;
  });
  return {
    async metrics() {
      return {
        asOf: "2026-09-20",
        assets: { raw: 1, curated: 0, gold: 1, total: 2 },
        createdToday: 2,
        promotionsToday: { rawToCurated: 0, curatedToGold: 1, demotions: 0 },
        promotions7d: { rawToCurated: 2, curatedToGold: 1 },
        collected: { today: 2, last7d: 9, total: 40 },
        reviewed: { verified: 1, pending: 0, rejected: 0, notEvaluated: 1, denominator: 2 },
        unknown: { abstainedToday: 1, abstainedTotal: 3, errorsToday: 0, errorsTotal: 1 },
        sourceContributions: { operational_chat: 1, contributor: 1, synthetic: 0, total: 2 },
        scopeNote: "stages",
      };
    },
    async timeseries() {
      return {
        from: "2026-08-22", to: "2026-09-20", timezone: "Asia/Ho_Chi_Minh",
        days: [
          { date: "2026-08-22", stock: { raw: 0, curated: 0, gold: 0, total: 0 }, inflow: { raw: 0, curated: 0, gold: 0 } },
          { date: "2026-09-20", stock: { raw: 1, curated: 0, gold: 1, total: 2 }, inflow: { raw: 1, curated: 0, gold: 1 } },
        ],
        sourceContributions: { operational_chat: 1, contributor: 1, synthetic: 0, total: 2 },
      };
    },
    async listAssets(filters: AssetFilterInput) {
      const filtered = filter({ ...filters, assetIds: null, from: null, to: null });
      return { rows: filtered.slice(filters.offset, filters.offset + filters.limit), total: filtered.length };
    },
    async listExportAssets(filters: ExportQuery) {
      const filtered = filter(filters);
      return { rows: filtered.slice(0, filters.limit), total: filtered.length };
    },
    async getAsset(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
    async createAsset(input) {
      return { status: "created", asset: asset({ question: input.question, dedupe_key: "contributor:new" }) };
    },
    async transitionAsset(input) {
      if (input.toStage === "gold" && !input.verified) throw new DataAdminError("gold_verification_required", 400);
      return asset({ dataset_stage: input.toStage, version: input.expectedVersion + 1, evaluation_status: input.toStage === "gold" ? "verified" : "pending_review" });
    },
    async listJev() {
      return [{
        id: "jev-1",
        request_id: "req-1",
        model: "jev-1",
        prompt_version: "p3",
        registry_version: "r7",
        attempted: true,
        decided: true,
        screen: "pass",
        circuit: "closed",
        metric: "dealer_order_count",
        metric_probability: 0.99,
        period: "this_week",
        period_probability: 0.98,
        support: "supported_unqualified",
        support_probability: 0.97,
        threshold: 0.8,
        fallback: null,
        cost: null,
        token_counts: { input: 500, output: 20 },
        stage_timings: { totalMs: 200 },
        counts: { warehouseReads: 2, plannerCalls: 1 },
        decision: "dealer_order_count",
        created_at: "2026-09-20T03:00:00.000Z",
      }];
    },
    async generationStart() {
      return { job: { id: "job-1", status: "running", version: 1 }, resumed: false, abandoned: false };
    },
    async generationFinish(input) {
      return { id: input.jobId, status: input.status, version: input.expectedVersion + 1, result_summary: input.summary };
    },
    async generationGet() {
      return { job: null, jobs: [] };
    },
  };
}

const config: DataAdminConfig = {
  enabled: () => true,
  authenticate: async () => ({ userId: "owner-1", role: "owner", store: makeStore() }),
  now: () => new Date("2026-09-20T03:00:00.000Z"),
  audit: () => undefined,
  captureEnabled: () => true,
};
const handler = createDataAdminHandler(config);

function post(body: Record<string, unknown>, language: "vi" | "en"): Promise<Response> {
  return postTo(handler, body, language);
}

function postTo(target: ReturnType<typeof createDataAdminHandler>, body: Record<string, unknown>, language: "vi" | "en" = "vi"): Promise<Response> {
  return target(new Request("https://admin.vnagent.ai/vnagent-data-admin", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "accept-language": language, authorization: "Bearer fixture" },
    body: JSON.stringify({ ...body, language }),
  }));
}

test("real frontend payloads pass the real handler and the frontend schemas in both languages", async () => {
  const cases: { name: string; body: Record<string, unknown>; schema: { safeParse: (value: unknown) => { success: boolean } }; expect: (body: Record<string, unknown>) => void }[] = [
    { name: "overview", body: { action: "overview" }, schema: overviewResponseSchema, expect: (b) => assert.equal((b.overview as { assets: { total: number } }).assets.total, 2) },
    { name: "timeseries", body: { action: "timeseries", days: 30 }, schema: timeseriesResponseSchema, expect: (b) => assert.equal((b.timeseries as { days: unknown[] }).days.length, 2) },
    { name: "assets", body: { action: "assets", stage: null, source_kind: null, evaluation_status: null, search: null, limit: 25, offset: 0 }, schema: assetsResponseSchema, expect: (b) => assert.equal((b.filters as { source_kind: unknown }).source_kind, null) },
    { name: "asset", body: { action: "asset", asset_id: ASSET_ID }, schema: assetResponseSchema, expect: () => undefined },
    { name: "contribute", body: { action: "contribute", question: "Câu hỏi mới?", source_kind: "contributor", source_designation: "manual", expected_intent: { intent: "tra cứu" }, expected_filters: { range: "today" }, provenance: { note: "manual" } }, schema: contributionResponseSchema, expect: (b) => assert.equal(b.status, "created") },
    { name: "transition", body: { action: "transition", asset_id: ASSET_ID, expected_version: 1, to_stage: "curated" }, schema: transitionResponseSchema, expect: (b) => assert.equal((b.asset as { dataset_stage: string }).dataset_stage, "curated") },
    { name: "jev", body: { action: "jev", limit: 50 }, schema: jevResponseSchema, expect: (b) => assert.equal((b.events as { metric: string }[])[0].metric, "dealer_order_count") },
    { name: "export", body: { action: "export", stage: null, source_kind: null, evaluation_status: null, from: null, to: null, asset_ids: null, limit: 50 }, schema: exportResponseSchema, expect: (b) => assert.equal((b.filters as { asset_ids: unknown }).asset_ids, null) },
    { name: "export selected", body: { action: "export", asset_ids: [GOLD_ID], limit: 1 }, schema: exportResponseSchema, expect: (b) => assert.equal(b.count, 1) },
  ];

  for (const language of ["vi", "en"] as const) {
    for (const scenario of cases) {
      const response = await post(scenario.body, language);
      const body = await response.json() as Record<string, unknown>;
      assert.ok(response.status < 400, `${scenario.name} (${language}) returned ${response.status}: ${JSON.stringify(body)}`);
      const parsed = scenario.schema.safeParse(body);
      assert.ok(parsed.success, `${scenario.name} (${language}) failed the frontend schema: ${JSON.stringify(body)}`);
      scenario.expect(body);
    }
  }
});

test("the selected-case export contains reviewed semantics, evidence and the original observation", async () => {
  const response = await post({ action: "export", asset_ids: [GOLD_ID], limit: 1 }, "vi");
  const body = await response.json() as { markdown: string; filters: { source_kind: unknown; evaluation_status: unknown } };
  assert.match(body.markdown, /doanh thu có kiểm soát theo ngày/);
  assert.match(body.markdown, /snapshot/);
  assert.match(body.markdown, /Doanh thu có kiểm soát hôm nay là 1.000.000đ/);
  assert.match(body.markdown, /reviewer|owner-1/);
  // The full case section carries the original source provenance for verification.
  assert.match(body.markdown, /sourceProvenance/);
  assert.match(body.markdown, /semanticVersion/);
  assert.match(body.markdown, /doc-1/);
  // The wire echo is snake_case and null-valued where the request was null.
  assert.equal(body.filters.source_kind, null);
  assert.equal(body.filters.evaluation_status, null);
});

test("review queue stage filter + pagination reaches older pending assets beyond the first 50", async () => {
  const curatedId = (index: number) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const goldId = (index: number) => `${String(index).padStart(8, "0")}-2222-4222-8222-222222222222`;
  // 60 Gold rows precede 60 older pending curated rows in the all-stages order.
  const rows: DataAsset[] = [
    ...Array.from({ length: 60 }, (_, index) => asset({ id: goldId(index), dataset_stage: "gold", evaluation_status: "verified", dedupe_key: `gold-${index}` })),
    ...Array.from({ length: 60 }, (_, index) => asset({ id: curatedId(index), dataset_stage: "curated", evaluation_status: "pending_review", dedupe_key: `curated-${index}` })),
  ];
  const scopedStore: DataAdminStore = {
    async metrics() { throw new Error("unused"); },
    async timeseries() { throw new Error("unused"); },
    async listAssets(filters) {
      const filtered = rows.filter((row) => !filters.stage || row.dataset_stage === filters.stage);
      return { rows: filtered.slice(filters.offset, filters.offset + filters.limit), total: filtered.length };
    },
    async listExportAssets() { throw new Error("unused"); },
    async getAsset() { return null; },
    async createAsset() { throw new Error("unused"); },
    async transitionAsset() { throw new Error("unused"); },
    async listJev() { throw new Error("unused"); },
    async generationStart() { throw new Error("unused"); },
    async generationFinish() { throw new Error("unused"); },
    async generationGet() { return { job: null, jobs: [] }; },
  };
  const scoped = createDataAdminHandler({ ...config, authenticate: async () => ({ userId: "owner-1", role: "owner", store: scopedStore }) });

  // The old shape (latest N across ALL stages) is entirely Gold, so pending is invisible.
  const allStages = await (await postTo(scoped, { action: "assets", stage: null, limit: 25, offset: 0 })).json() as { assets: DataAsset[] };
  assert.ok(allStages.assets.length === 25 && allStages.assets.every((row) => row.dataset_stage === "gold"));

  // Server stage filter: first page and the honest total for curated.
  const first = await (await postTo(scoped, { action: "assets", stage: "curated", limit: 25, offset: 0 })).json() as { assets: DataAsset[]; total: number };
  assert.equal(first.assets.length, 25);
  assert.equal(first.total, 60);
  assert.ok(first.assets.every((row) => row.dataset_stage === "curated"));

  // A page beyond the first 50 still returns the older pending assets.
  const third = await (await postTo(scoped, { action: "assets", stage: "curated", limit: 25, offset: 50 })).json() as { assets: DataAsset[]; total: number; filters: { stage: string | null } };
  assert.equal(third.assets.length, 10);
  assert.equal(third.total, 60);
  assert.equal(third.filters.stage, "curated");
  assert.deepEqual(third.assets.map((row) => row.id), Array.from({ length: 10 }, (_, index) => curatedId(50 + index)));
});
