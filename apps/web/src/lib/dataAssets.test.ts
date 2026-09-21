// Offline tests for the data-assets client helpers and response schemas.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_LANGUAGE,
  EMPTY_ASSET_FILTERS,
  EMPTY_EXPORT_FILTERS,
  REVIEW_PAGE_SIZE,
  REVIEWABLE_STAGES,
  assetSchema,
  chartPoints,
  contributionRows,
  designationLabel,
  evaluationLabel,
  exportFileName,
  exportResponseSchema,
  formatDateTime,
  formatNumber,
  isUncertainMutationStatus,
  jevEventSchema,
  overviewSchema,
  parseConditions,
  parseEvidenceLines,
  parseFilterRows,
  reviewPageRange,
  reviewQueueQuery,
  reviewedRate,
  sourceKindLabel,
  stageLabel,
  timeseriesResponseSchema,
  unknownTotal,
  defaultGenerationStyleMix,
  GENERATION_ABSENT_GRACE_MS,
  generationDiagnosticSchema,
  generationFailureReason,
  generationJobDiagnostic,
  generationProgress,
  generationRecoveryDecision,
  generationResponseSchema,
  generationStatusLabel,
  isDefinitiveGenerationDenial,
  parsePendingGeneration,
  pendingGenerationAgeMs,
  serializePendingGeneration,
  type DataAdminOverview,
  type DataAdminTimeseries,
} from "./dataAssets.ts";

function overview(overrides: Partial<DataAdminOverview> = {}): DataAdminOverview {
  return {
    asOf: "2026-09-20",
    assets: { raw: 5, curated: 2, gold: 1, total: 8 },
    createdToday: 2,
    promotionsToday: { rawToCurated: 1, curatedToGold: 0, demotions: 0 },
    promotions7d: { rawToCurated: 4, curatedToGold: 1 },
    collected: { today: 9, last7d: 40, total: 120 },
    reviewed: { verified: 1, pending: 2, rejected: 0, notEvaluated: 5, denominator: 8 },
    unknown: { abstainedToday: 2, abstainedTotal: 6, errorsToday: 1, errorsTotal: 3 },
    sourceContributions: { operational_chat: 5, contributor: 2, synthetic: 1, total: 8 },
    scopeNote: "stages",
    ...overrides,
  };
}

function timeseries(): DataAdminTimeseries {
  return {
    from: "2026-08-22",
    to: "2026-09-20",
    timezone: "Asia/Ho_Chi_Minh",
    days: [
      { date: "2026-09-19", stock: { raw: 4, curated: 2, gold: 1, total: 7 }, inflow: { raw: 2, curated: 1, gold: 0 } },
      { date: "2026-09-20", stock: { raw: 5, curated: 2, gold: 1, total: 8 }, inflow: { raw: 1, curated: 0, gold: 1 } },
    ],
    sourceContributions: { operational_chat: 5, contributor: 2, synthetic: 1, total: 8 },
  };
}

test("stage and source labels are bilingual and stable", () => {
  assert.equal(stageLabel("curated", "vi"), "Curated · đã biên tập");
  assert.equal(stageLabel("gold", "en"), "Gold · verified");
  assert.equal(sourceKindLabel("operational_chat", "en"), "Operational chat");
  assert.equal(designationLabel("llm_generated", "vi"), "Do LLM tạo");
  assert.equal(designationLabel(null, "vi"), "Không áp dụng");
  assert.equal(evaluationLabel("pending_review", "vi"), "Chờ duyệt");
});

test("reviewed rate, unknown total and contribution rows are derived honestly", () => {
  assert.equal(reviewedRate(overview()), 13);
  assert.equal(reviewedRate(overview({ reviewed: { verified: 0, pending: 0, rejected: 0, notEvaluated: 0, denominator: 0 } })), null);
  assert.equal(unknownTotal(overview()), 9);
  assert.deepEqual(contributionRows(overview().sourceContributions, "vi").map((row) => row.key), ["operational_chat", "contributor", "synthetic", "total"]);
  assert.equal(contributionRows(overview().sourceContributions, "vi")[0].count, 5);
});

test("chartPoints switches between reconstructed stock and daily inflow", () => {
  assert.deepEqual(chartPoints(timeseries(), "stock")[0], { date: "2026-09-19", raw: 4, curated: 2, gold: 1 });
  assert.deepEqual(chartPoints(timeseries(), "new")[1], { date: "2026-09-20", raw: 1, curated: 0, gold: 1 });
});

test("overview schema accepts the server shape and rejects a missing group", () => {
  assert.equal(overviewSchema.safeParse(overview()).success, true);
  assert.equal(overviewSchema.safeParse({ asOf: "x" }).success, false);
});

test("timeseries schema accepts the daily stock/inflow shape", () => {
  assert.equal(timeseriesResponseSchema.safeParse({ status: "ok", timeseries: timeseries() }).success, true);
  assert.equal(timeseriesResponseSchema.safeParse({ status: "ok", timeseries: { days: [] } }).success, false);
});

test("asset schema requires a known stage, source answer and effective date", () => {
  const valid = {
    id: "11111111-1111-1111-1111-111111111111", tenant: "bmq", dataset_stage: "raw", source_kind: "contributor",
    source_designation: "manual", interaction_id: null, question: "Hỏi?", source_answer: null,
    expected_intent: {}, expected_filters: {}, provenance: {}, snapshot_at: null, effective_at: "2026-09-20T00:00:00.000Z",
    evaluation_status: "not_evaluated", verified_intent: null, verified_conditions: null,
    evidence: [], reviewer_id: null, version: 1, dedupe_key: "k", created_by: null,
    created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z",
  };
  assert.equal(assetSchema.safeParse(valid).success, true);
  assert.equal(assetSchema.safeParse({ ...valid, dataset_stage: "silver" }).success, false);
  assert.equal(assetSchema.safeParse({ ...valid, effective_at: undefined }).success, false);
});

test("asset schema accepts captured non-string filter values but rejects a non-object", () => {
  const captured = {
    id: "22222222-2222-2222-2222-222222222222", tenant: "bmq", dataset_stage: "raw", source_kind: "operational_chat",
    source_designation: null, interaction_id: null, question: "Doanh thu hôm nay?", source_answer: "1.000.000đ",
    expected_intent: {}, expected_filters: { metrics: [], periods: [], dimensions: [], queryCount: 0 },
    provenance: {}, snapshot_at: null, effective_at: "2026-09-20T00:00:00.000Z",
    evaluation_status: "not_evaluated", verified_intent: null, verified_conditions: null,
    evidence: [], reviewer_id: null, version: 1, dedupe_key: "k2", created_by: null,
    created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z",
  };
  assert.equal(assetSchema.safeParse(captured).success, true);
  // The empty synthetic shape still parses.
  assert.equal(assetSchema.safeParse({ ...captured, source_kind: "synthetic", expected_filters: {} }).success, true);
  // A non-object expected_filters is still rejected.
  for (const bad of [[], ["metrics"], "metrics", 0, null]) {
    assert.equal(assetSchema.safeParse({ ...captured, expected_filters: bad }).success, false, JSON.stringify(bad));
  }
});

test("export response schema uses the snake_case server echo and reports the total", () => {
  const parsed = exportResponseSchema.safeParse({
    status: "ok", markdown: "# x", count: 1, truncated: false, total: 3,
    filters: { stage: "gold", source_kind: "contributor", evaluation_status: "verified", from: null, to: null, asset_ids: ["11111111-1111-1111-1111-111111111111"], limit: 50 },
  });
  assert.equal(parsed.success, true);
});

test("jev schema accepts PostgREST numeric-as-string probabilities and null cost", () => {
  const parsed = jevEventSchema.safeParse({
    id: "j", request_id: "r", model: "m", prompt_version: null, registry_version: null, attempted: true, decided: false,
    screen: null, circuit: null, metric: "m", metric_probability: "0.99", period: null, period_probability: "0.5",
    support: null, support_probability: null, threshold: "0.8", fallback: null, cost: null,
    token_counts: { input: 5, output: null }, stage_timings: {}, counts: {}, decision: "m", created_at: "2026-09-20T00:00:00.000Z",
  });
  assert.equal(parsed.success, true);
});

test("filter defaults are empty and bounded", () => {
  assert.deepEqual(EMPTY_ASSET_FILTERS, { stage: "", sourceKind: "", evaluationStatus: "", search: "", limit: 25, offset: 0 });
  assert.deepEqual(EMPTY_EXPORT_FILTERS, { stage: "", sourceKind: "", evaluationStatus: "", from: "", to: "", assetIds: null, limit: 50 });
});

test("review queue asks the server for one stage and paginates honestly", () => {
  assert.deepEqual(REVIEWABLE_STAGES, ["raw", "curated"]);
  assert.deepEqual(reviewQueueQuery("curated", 50), {
    action: "assets", stage: "curated", source_kind: null, evaluation_status: null, search: null, limit: REVIEW_PAGE_SIZE, offset: 50,
  });
  assert.deepEqual(reviewQueueQuery("raw", 0).stage, "raw");
  // The server filters the stage (never "all stages then hide Gold on the client").
  assert.equal(reviewQueueQuery("curated", 0).stage, "curated");
  assert.equal(reviewPageRange(0, 25, 60), "1–25 / 60");
  assert.equal(reviewPageRange(50, 10, 60), "51–60 / 60");
  assert.equal(reviewPageRange(0, 5, null), "1–5");
  assert.equal(reviewPageRange(0, 0, 0), "0 / 0");
  assert.equal(reviewPageRange(25, 0, null), "0");
});

test("parseFilterRows trims, drops blanks and rejects half-filled or oversized rows", () => {
  assert.deepEqual(parseFilterRows([{ key: " period ", value: " today " }, { key: "", value: "" }]), { period: "today" });
  assert.throws(() => parseFilterRows([{ key: "period", value: "" }]), /invalid/);
  const many = Array.from({ length: 13 }, (_, index) => ({ key: `k${index}`, value: "v" }));
  assert.throws(() => parseFilterRows(many), /invalid/);
});

test("Gold draft helpers parse evidence lines and JSON conditions", () => {
  assert.deepEqual(parseEvidenceLines(" a \n\n b \n"), ["a", "b"]);
  assert.equal(parseConditions("  "), null);
  assert.deepEqual(parseConditions('{"a":1}'), { a: 1 });
  assert.equal(parseConditions("{not json"), undefined);
});

test("export file name is date-stamped and markdown-safe", () => {
  assert.equal(exportFileName(new Date("2026-09-20T05:00:00.000Z")), "vnagent-dataset-2026-09-20.md");
});

test("uncertain mutation statuses require reconciliation before retry", () => {
  // Network failure and 5xx may already have applied.
  assert.equal(isUncertainMutationStatus(0), true);
  assert.equal(isUncertainMutationStatus(500), true);
  assert.equal(isUncertainMutationStatus(503), true);
  assert.equal(isUncertainMutationStatus(504), true);
  // Definitive client answers (validation, conflict, forbidden, rate limit) are not.
  assert.equal(isUncertainMutationStatus(400), false);
  assert.equal(isUncertainMutationStatus(409), false);
  assert.equal(isUncertainMutationStatus(403), false);
  assert.equal(isUncertainMutationStatus(429), false);
});

test("formatDateTime degrades honestly on bad input", () => {
  assert.equal(formatDateTime("not-a-date", "vi"), "—");
  assert.equal(formatDateTime(null, "en"), "—");
  assert.notEqual(formatDateTime("2026-09-20T05:00:00.000Z", "vi"), "—");
});

test("the admin language defaults to English and formats numbers in en-US", () => {
  // The admin constant is independent from the BMQ app language.
  assert.equal(ADMIN_LANGUAGE, "en");
  assert.equal(stageLabel("gold", ADMIN_LANGUAGE), "Gold · verified");
  assert.equal(evaluationLabel("pending_review", ADMIN_LANGUAGE), "Pending review");
  assert.equal(sourceKindLabel("operational_chat", ADMIN_LANGUAGE), "Operational chat");
  // Grouping: English uses commas, Vietnamese uses dots. The admin default is English.
  assert.equal(formatNumber(1234567), "1,234,567");
  assert.equal(formatNumber(1234567, ADMIN_LANGUAGE), "1,234,567");
  assert.equal(formatNumber(1234567, "vi"), "1.234.567");
  assert.match(formatDateTime("2026-09-20T05:00:00.000Z", ADMIN_LANGUAGE), /\d{1,2}\/\d{1,2}\/\d{2}/);
});

test("the generation style mix matches the server default and the response schema is strict", () => {
  for (const count of [20, 33, 50]) {
    const mix = defaultGenerationStyleMix(count);
    assert.equal(mix.variant + mix.typo + mix.ambiguous + mix.out_of_scope, count);
    assert.ok(mix.variant > 0 && mix.typo > 0 && mix.ambiguous > 0 && mix.out_of_scope > 0);
  }
  // Server default for count 20 (see generation.ts defaultStyleMix): variant 12, typo 3, ambiguous 3, out_of_scope 2.
  assert.deepEqual(defaultGenerationStyleMix(20), { variant: 12, typo: 3, ambiguous: 3, out_of_scope: 2 });
  assert.equal(generationStatusLabel("budget_exceeded", "en"), "Budget exceeded");
  assert.equal(generationStatusLabel("running", "vi"), "Đang chạy");
  const parsed = generationResponseSchema.safeParse({
    status: "ok",
    resumed: false,
    job: { id: "j1", status: "completed", version: 2, budget_usd: "1", worst_case_cost_usd: "0.02", actual_cost_usd: null, result_summary: { created: 20, duplicate: 0 } },
    results: { created: 20, duplicate: 0 },
  });
  assert.equal(parsed.success, true);
  // Unknown provider usage stays null; terminal statuses are part of the contract.
  assert.equal(generationResponseSchema.safeParse({
    status: "failed",
    resumed: true,
    job: { id: "j1", status: "failed", version: 2 },
    results: { created: 0, duplicate: 0 },
    usage: { input: null, output: null },
  }).success, true);
  assert.equal(generationResponseSchema.safeParse({ status: "ok", resumed: false, job: { id: "j1", status: "unknown", version: 1 }, results: { created: 0, duplicate: 0 } }).success, false);
  // A deterministic provider failure is a durable envelope with a safe diagnostic.
  assert.equal(generationResponseSchema.safeParse({
    status: "failed",
    resumed: false,
    job: { id: "j1", status: "failed", version: 2, error_code: "generation_http_error", result_summary: { created: 0, duplicate: 0, diagnostic: { status: 400, code: "invalid_request_error", param: "max_tokens" } } },
    results: { created: 0, duplicate: 0, rejected: 0, total: 0 },
    diagnostic: { status: 400, code: "invalid_request_error", param: "max_tokens" },
  }).success, true);
});

test("the durable generation diagnostic is allowlisted and never carries a raw provider message", () => {
  // Defensive parse strips unknown keys (for example a leaked provider `message`).
  const parsed = generationDiagnosticSchema.safeParse({ status: 400, code: "invalid_request_error", param: "max_tokens", message: "Unsupported parameter: sk-secret" });
  assert.deepEqual(parsed.success ? parsed.data : null, { status: 400, code: "invalid_request_error", param: "max_tokens" });
  assert.equal(generationDiagnosticSchema.safeParse({ status: "400", code: "x", param: null }).success, false);
  assert.equal(generationDiagnosticSchema.safeParse({ status: 400, code: 7, param: null }).success, false);

  const job = {
    status: "failed" as const,
    error_code: "generation_http_error",
    result_summary: { created: 0, duplicate: 0, rejected: 0, diagnostic: { status: 400, code: "invalid_request_error", param: "max_tokens", message: "Unsupported parameter: 'max_tokens'; sk-live-secret" } },
  };
  assert.deepEqual(generationJobDiagnostic(job), { status: 400, code: "invalid_request_error", param: "max_tokens" });
  const reason = generationFailureReason(job, "en");
  assert.ok(reason);
  // Primary copy is friendly and contains no code/HTTP/param internals.
  assert.match(reason, /model call returned an error/i);
  assert.match(reason, /nothing was stored/i);
  assert.ok(!reason.includes("generation_http_error"));
  assert.ok(!reason.includes("safe codes"));
  assert.ok(!reason.includes("HTTP"));
  assert.ok(!reason.includes("invalid_request_error"));
  assert.ok(!reason.includes("Unsupported parameter"));
  assert.ok(!reason.includes("sk-live-secret"));
  // A completed run never shows a failure reason, and junk diagnostics degrade to null.
  assert.equal(generationFailureReason({ status: "completed", error_code: null, result_summary: { diagnostic: { status: 500, code: "x", param: null } } }, "vi"), null);
  assert.equal(generationJobDiagnostic({ result_summary: { diagnostic: "not an object" } }), null);
  // Unknown codes keep support diagnostics on the saved job, not in the primary copy.
  assert.equal(generationFailureReason({ status: "failed", error_code: "generation_some_new_code" }, "en"), null);

  // The historical Gateway paid-credits classification stays explainable for old
  // job rows and explicitly tells the owner new runs use DeepSeek (no Gateway top-up).
  const creditsReason = generationFailureReason({ status: "failed", error_code: "generation_paid_credits_required", result_summary: { diagnostic: { status: 403, code: "invalid_request_error", param: null, message: "Free tier users... vercel.com" } } }, "en");
  assert.ok(creditsReason);
  assert.match(creditsReason, /previous Vercel AI Gateway provider/i);
  assert.match(creditsReason, /new runs use DeepSeek/i);
  assert.doesNotMatch(creditsReason, /top up/i);
  assert.ok(!creditsReason.includes("generation_paid_credits_required"));
  assert.ok(!creditsReason.includes("safe codes"));
  assert.ok(!creditsReason.includes("Free tier"));
  assert.ok(!creditsReason.includes("vercel.com"));
  const creditsVi = generationFailureReason({ status: "failed", error_code: "generation_paid_credits_required", result_summary: {} }, "vi");
  assert.ok(creditsVi);
  assert.match(creditsVi, /Gateway trước đây/);
  assert.match(creditsVi, /DeepSeek/);
  assert.doesNotMatch(creditsVi, /nạp credit/i);

  // The current DeepSeek lane reports insufficient balance with no Gateway,
  // ZDR or retention claim.
  const balanceReason = generationFailureReason({ status: "failed", error_code: "generation_insufficient_balance", result_summary: {} }, "en");
  assert.ok(balanceReason);
  assert.match(balanceReason, /DeepSeek account balance is insufficient/i);
  assert.ok(!/gateway/i.test(balanceReason));
  assert.ok(!/retention|zero data/i.test(balanceReason));
  const balanceVi = generationFailureReason({ status: "failed", error_code: "generation_insufficient_balance", result_summary: {} }, "vi");
  assert.ok(balanceVi);
  assert.match(balanceVi, /DeepSeek/);
  assert.ok(!/retention|zero data/i.test(balanceVi));

  // An aborted request is settled as failed but explicitly keeps the questions
  // already stored, so partial-success runs stay explainable.
  const abortedReason = generationFailureReason({ status: "failed", error_code: "generation_request_aborted", result_summary: { created: 12 } }, "en");
  assert.ok(abortedReason);
  assert.match(abortedReason, /aborted before the batch finished/i);
  assert.match(abortedReason, /questions already stored were kept/i);
  assert.ok(!abortedReason.includes("generation_request_aborted"));
  const abortedVi = generationFailureReason({ status: "failed", error_code: "generation_request_aborted", result_summary: { created: 12 } }, "vi");
  assert.ok(abortedVi);
  assert.match(abortedVi, /bị hủy trước khi lô chạy xong/);
  assert.match(abortedVi, /phần kết quả đã lưu vẫn được giữ/);
  assert.ok(!abortedVi.includes("generation_request_aborted"));
});

test("pending generation record round-trips the exact request and rejects junk", () => {
  const pending = { key: "batch-0001", request: { topic: "mixed", count: 33, target_language: "vi" as const, budget_usd: 0.5 } };
  assert.deepEqual(parsePendingGeneration(serializePendingGeneration(pending)), pending);
  // A dispatch timestamp round-trips too, and is used for the absent grace.
  const stamped = { ...pending, startedAt: "2026-09-21T06:05:33.000Z" };
  assert.deepEqual(parsePendingGeneration(serializePendingGeneration(stamped)), stamped);
  assert.equal(pendingGenerationAgeMs(stamped, Date.parse("2026-09-21T06:06:33.000Z")), 60_000);
  // A legacy record without a timestamp has an honestly unknown age, never 0.
  assert.equal(pendingGenerationAgeMs(pending, Date.parse("2026-09-21T06:06:33.000Z")), null);
  assert.equal(pendingGenerationAgeMs(null), null);
  // A future/skewed timestamp clamps to 0 (still inside the grace), never negative.
  assert.equal(pendingGenerationAgeMs({ ...pending, startedAt: "2026-09-21T07:00:00.000Z" }, Date.parse("2026-09-21T06:06:33.000Z")), 0);
  // A legacy bare key is accepted read-only (no request to replay).
  assert.deepEqual(parsePendingGeneration("legacy-key-0001"), { key: "legacy-key-0001", request: null });
  // A key with a malformed request keeps the key but drops the unsafe replay payload.
  assert.deepEqual(parsePendingGeneration(JSON.stringify({ key: "batch-0002", request: { topic: "mixed", count: "nope" } })), { key: "batch-0002", request: null });
  for (const bad of [null, "", "short", "bad key!", "{not json", JSON.stringify({ key: "x" })]) {
    assert.equal(parsePendingGeneration(bad as string | null), null, JSON.stringify(bad));
  }
});

test("recovery keeps the lock for running/absent and releases only verified terminal states", () => {
  assert.equal(generationRecoveryDecision({ jobStatus: "running", absent: false }), "keep");
  // An absent read without a known/old-enough age keeps the lock (backward compatible).
  assert.equal(generationRecoveryDecision({ absent: true }), "keep");
  assert.equal(generationRecoveryDecision({ absent: true, pendingAgeMs: null }), "keep");
  assert.equal(generationRecoveryDecision({ jobStatus: "completed" }), "clear");
  assert.equal(generationRecoveryDecision({ jobStatus: "failed" }), "clear");
  assert.equal(generationRecoveryDecision({ jobStatus: "budget_exceeded" }), "clear");
  // A server-evaluated expired lease is an explicit terminal release.
  assert.equal(generationRecoveryDecision({ jobStatus: "running", abandoned: true }), "clear");
  assert.equal(generationRecoveryDecision({}), "keep");
});

test("an absent lock is released only past the fixed grace", () => {
  const grace = GENERATION_ABSENT_GRACE_MS;
  assert.equal(grace, 5 * 60 * 1000);
  // One millisecond short of the grace still keeps the lock.
  assert.equal(generationRecoveryDecision({ absent: true, pendingAgeMs: grace - 1 }), "keep");
  assert.equal(generationRecoveryDecision({ absent: true, pendingAgeMs: grace }), "clear");
  assert.equal(generationRecoveryDecision({ absent: true, pendingAgeMs: grace + 1 }), "clear");
  // Unknown, non-finite or negative ages are uncertain, so they keep.
  assert.equal(generationRecoveryDecision({ absent: true, pendingAgeMs: null }), "keep");
  assert.equal(generationRecoveryDecision({ absent: true, pendingAgeMs: Number.NaN }), "keep");
  assert.equal(generationRecoveryDecision({ absent: true, pendingAgeMs: Number.POSITIVE_INFINITY }), "keep");
  assert.equal(generationRecoveryDecision({ absent: true, pendingAgeMs: -1 }), "keep");
  // A present (running) or abandoned job still wins over the absent branch.
  assert.equal(generationRecoveryDecision({ absent: false, jobStatus: "running", pendingAgeMs: grace * 2 }), "keep");
  assert.equal(generationRecoveryDecision({ absent: false, abandoned: true, pendingAgeMs: grace * 2 }), "clear");
});

test("generation progress reports honest phases, percentage and unknown values", () => {
  const job = (overrides: Partial<{ status: string; result_summary: Record<string, unknown>; request: Record<string, unknown> }>) => ({
    status: "running",
    result_summary: {},
    ...overrides,
  });

  // No job row read back yet: queued, with the requested total but unknown accepted.
  assert.deepEqual(generationProgress(null, 50), { phase: "queued", accepted: null, total: 50, percentage: null });
  // The single model call is in flight: nothing is written, so no fabricated 0.
  assert.deepEqual(generationProgress(job({}), 20), { phase: "model", accepted: null, total: 20, percentage: null });
  // A heartbeat reported running counts.
  assert.deepEqual(
    generationProgress(job({ result_summary: { created: 18, duplicate: 0 } }), 50),
    { phase: "writing", accepted: 18, total: 50, percentage: 36 },
  );
  assert.deepEqual(
    generationProgress(job({ result_summary: { created: 15, duplicate: 5 } }), 50),
    { phase: "writing", accepted: 20, total: 50, percentage: 40 },
  );
  // Terminal states.
  assert.deepEqual(
    generationProgress(job({ status: "completed", result_summary: { created: 20, duplicate: 0, rejected: 0 } }), 20),
    { phase: "done", accepted: 20, total: 20, percentage: 100 },
  );
  // A server-evaluated expired lease is reported as abandoned, not done/running.
  assert.equal(generationProgress(job({ result_summary: { created: 12, duplicate: 0 } }), 50, true).phase, "abandoned");
  assert.equal(generationProgress(job({ status: "failed", result_summary: { created: 3, duplicate: 0 } }), 50).phase, "failed");
  assert.equal(generationProgress(job({ status: "budget_exceeded", result_summary: { created: 0, duplicate: 0 } }), 50).phase, "failed");

  // Unknown values stay null, never a fabricated 0.
  assert.deepEqual(generationProgress(job({ result_summary: { created: 5 } }), 20), { phase: "model", accepted: null, total: 20, percentage: null });
  assert.deepEqual(generationProgress(job({ result_summary: { created: "x", duplicate: 0 } }), 20), { phase: "model", accepted: null, total: 20, percentage: null });
  // Total unknown: percentage is null even when accepted is known.
  assert.deepEqual(generationProgress(job({ result_summary: { created: 5, duplicate: 0 } }), null), { phase: "writing", accepted: 5, total: null, percentage: null });
  // The requested count may fall back to the durable job request.
  assert.deepEqual(
    generationProgress(job({ result_summary: { created: 5, duplicate: 0 }, request: { count: 20 } }), null),
    { phase: "writing", accepted: 5, total: 20, percentage: 25 },
  );
  // A count above the total clamps at 100 instead of overflowing.
  assert.equal(generationProgress(job({ result_summary: { created: 30, duplicate: 0 } }), 20).percentage, 100);
  // A zero/negative total is honestly unknown, not a divide-by-zero.
  assert.deepEqual(generationProgress(job({ result_summary: { created: 5, duplicate: 0 } }), 0), { phase: "writing", accepted: 5, total: null, percentage: null });
});

test("only definitive pre-dispatch denials release the pending lock", () => {
  assert.equal(isDefinitiveGenerationDenial("generation_budget_exceeded", false), true);
  assert.equal(isDefinitiveGenerationDenial("generation_busy", false), true);
  assert.equal(isDefinitiveGenerationDenial("generation_idempotency_conflict", false), true);
  assert.equal(isDefinitiveGenerationDenial("generation_invalid_request", false), true);
  // A possibly post-dispatch store failure must keep the durable pending record.
  assert.equal(isDefinitiveGenerationDenial("store_unavailable", false), false);
  assert.equal(isDefinitiveGenerationDenial("generation_version_conflict", false), false);
  assert.equal(isDefinitiveGenerationDenial("generation_unavailable", true), false);
  assert.equal(isDefinitiveGenerationDenial(undefined, false), false);
});
