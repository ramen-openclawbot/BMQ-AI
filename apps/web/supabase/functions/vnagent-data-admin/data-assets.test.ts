// Offline tests for the VNAgent data-assets pure domain logic.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DataAdminError,
  EXPORT_BYTES_MAX,
  SUMMARY_TRUNCATION_MARKER,
  canonicalJson,
  dedupeKey,
  escapeMarkdownCell,
  evidenceIsMeaningful,
  exportFiltersWire,
  fencedJson,
  normalizeQuestion,
  renderAssetsMarkdown,
  sanitizeJson,
  summarizeOverview,
  summarizeTimeseries,
  validateAssetFilters,
  validateContribution,
  validateExportFilters,
  validateTransition,
  assetFiltersWire,
  type DataAsset,
} from "./data-assets.ts";

function asset(overrides: Partial<DataAsset> = {}): DataAsset {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    tenant: "bmq",
    dataset_stage: "curated",
    source_kind: "operational_chat",
    source_designation: null,
    interaction_id: null,
    question: "Doanh thu hôm nay?",
    source_answer: "Doanh thu hôm nay là 1.000.000đ",
    expected_intent: { lane: "fast" },
    expected_filters: { range: "today" },
    provenance: { source: "bmq-analytics", executedFilters: { metrics: ["controlled_revenue"] } },
    snapshot_at: "2026-09-20T02:00:00.000Z",
    effective_at: "2026-09-20T02:00:00.000Z",
    evaluation_status: "pending_review",
    verified_intent: null,
    verified_conditions: null,
    evidence: [],
    reviewer_id: null,
    version: 2,
    dedupe_key: "operational_chat:abc",
    created_by: "owner-1",
    created_at: "2026-09-20T02:00:00.000Z",
    updated_at: "2026-09-20T02:00:00.000Z",
    ...overrides,
  };
}

test("normalizeQuestion collapses whitespace and control characters but keeps semantics", () => {
  assert.equal(normalizeQuestion("  Doanh\u0000thu   hôm\nnay?  "), "Doanh thu hôm nay?");
  assert.throws(() => normalizeQuestion("   "), (error: unknown) => error instanceof DataAdminError && error.code === "question_required");
  assert.throws(() => normalizeQuestion("x".repeat(4001)), /question_too_long/);
});

test("dedupeKey is deterministic, source-kind specific and scope sensitive", async () => {
  const a = await dedupeKey("Doanh thu hôm nay?", "contributor", { intent: "x" }, { range: "today" });
  const b = await dedupeKey("Doanh thu hôm nay?", "contributor", { intent: "x" }, { range: "today" });
  const c = await dedupeKey("Doanh thu hôm nay?", "synthetic", { intent: "x" }, { range: "today" });
  const d = await dedupeKey("Doanh thu hôm nay?", "contributor", { intent: "x" }, { range: "this_week" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  // The same question with a different expected scope must not collapse.
  assert.notEqual(a, d);
  assert.match(a, /^contributor:[0-9a-f]{40}$/);
});

test("canonicalJson is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ y: 2, x: 1 }] }), canonicalJson({ a: [{ x: 1, y: 2 }], b: 1 }));
});

test("contribution form rejects operational_chat and missing designation", () => {
  assert.throws(
    () => validateContribution({ question: "Hỏi", source_kind: "operational_chat", source_designation: "manual" }),
    (error: unknown) => error instanceof DataAdminError && error.code === "invalid_source_kind",
  );
  assert.throws(
    () => validateContribution({ question: "Hỏi", source_kind: "contributor" }),
    (error: unknown) => error instanceof DataAdminError && error.code === "invalid_source_designation",
  );
});

test("contribution form accepts manual and LLM-generated designations and bounds filters", () => {
  const manual = validateContribution({
    question: "  Giá bánh mì que? ",
    source_kind: "contributor",
    source_designation: "manual",
    expected_intent: { intent: "tra cứu giá bán" },
    expected_filters: { product: "BMQ-001" },
    provenance: { note: "pasted by owner", secret: "Bearer abcdefgh12345678" },
  });
  assert.equal(manual.question, "Giá bánh mì que?");
  assert.deepEqual(manual.expectedFilters, { product: "BMQ-001" });
  assert.equal(manual.sourceDesignation, "manual");

  const generated = validateContribution({ question: "Hỏi", source_kind: "synthetic", source_designation: "llm_generated" });
  assert.equal(generated.sourceDesignation, "llm_generated");

  assert.throws(
    () => validateContribution({ question: "Hỏi", source_kind: "contributor", source_designation: "manual", expected_filters: { blank: "   " } }),
    /invalid_expected_filters/,
  );
  const tooMany = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`k${index}`, "v"]));
  assert.throws(() => validateContribution({ question: "Hỏi", source_kind: "contributor", source_designation: "manual", expected_filters: tooMany }), /invalid_expected_filters/);
});

test("sanitizeJson drops unsupported values and keeps bounded scalars", () => {
  assert.deepEqual(sanitizeJson({ a: 1, b: true, c: null, d: () => 1, e: [{ f: "x" }] }), { a: 1, b: true, c: null, d: null, e: [{ f: "x" }] });
});

test("Gold evidence must be meaningful: empty, null, numeric and boolean placeholders do not count", () => {
  assert.equal(evidenceIsMeaningful([]), false);
  assert.equal(evidenceIsMeaningful([null]), false);
  assert.equal(evidenceIsMeaningful([""]), false);
  assert.equal(evidenceIsMeaningful(["   "]), false);
  assert.equal(evidenceIsMeaningful([{}]), false);
  assert.equal(evidenceIsMeaningful([[]]), false);
  // A number or boolean is not evidence, even when non-zero/true.
  assert.equal(evidenceIsMeaningful([0]), false);
  assert.equal(evidenceIsMeaningful([1]), false);
  assert.equal(evidenceIsMeaningful([false]), false);
  assert.equal(evidenceIsMeaningful([true]), false);
  assert.equal(evidenceIsMeaningful(["snapshot:snap-1"]), true);
  assert.equal(evidenceIsMeaningful([{ kind: "snapshot", ref: "snap-1" }]), true);
  // A non-empty structured list is still meaningful.
  assert.equal(evidenceIsMeaningful([["snap-1"]]), true);

  assert.throws(
    () => validateTransition({ asset_id: "11111111-1111-1111-1111-111111111111", expected_version: 1, to_stage: "gold", verified: { intent: "x", conditions: { a: 1 }, evidence: [null] } }),
    /gold_evidence_required/,
  );
  assert.throws(
    () => validateTransition({ asset_id: "11111111-1111-1111-1111-111111111111", expected_version: 1, to_stage: "gold", verified: { intent: "x", conditions: { a: 1 }, evidence: ["   "] } }),
    /gold_evidence_required/,
  );
  for (const placeholder of [0, 1, false, true]) {
    assert.throws(
      () => validateTransition({ asset_id: "11111111-1111-1111-1111-111111111111", expected_version: 1, to_stage: "gold", verified: { intent: "x", conditions: { a: 1 }, evidence: [placeholder] } }),
      /gold_evidence_required/,
      `placeholder ${String(placeholder)} must be rejected`,
    );
  }
});

test("gold transition requires a verified intent, conditions and evidence", () => {
  assert.throws(
    () => validateTransition({ asset_id: "11111111-1111-1111-1111-111111111111", expected_version: 1, to_stage: "gold" }),
    (error: unknown) => error instanceof DataAdminError && error.code === "gold_verification_required",
  );
  assert.throws(
    () => validateTransition({ asset_id: "11111111-1111-1111-1111-111111111111", expected_version: 1, to_stage: "gold", verified: { intent: "x", conditions: { a: 1 }, evidence: [] } }),
    /gold_evidence_required/,
  );
  const ok = validateTransition({
    asset_id: "11111111-1111-1111-1111-111111111111",
    expected_version: 3,
    to_stage: "gold",
    verified: { intent: "trả lời doanh thu có kiểm soát", conditions: { period: "today" }, evidence: [{ kind: "snapshot", ref: "snap-1" }] },
  });
  assert.equal(ok.toStage, "gold");
  assert.equal(ok.expectedVersion, 3);
  assert.equal(ok.verified?.evidence.length, 1);
});

test("non-gold transitions do not require verification and invalid ids are rejected", () => {
  const curated = validateTransition({ asset_id: "11111111-1111-1111-1111-111111111111", expected_version: 1, to_stage: "curated" });
  assert.equal(curated.verified, null);
  assert.throws(() => validateTransition({ asset_id: "not-a-uuid", expected_version: 1, to_stage: "curated" }), /invalid_asset_id/);
  assert.throws(() => validateTransition({ asset_id: "11111111-1111-1111-1111-111111111111", expected_version: 0, to_stage: "curated" }), /invalid_expected_version/);
  assert.throws(() => validateTransition({ asset_id: "11111111-1111-1111-1111-111111111111", expected_version: 1, to_stage: "gold", verified: { intent: "x", conditions: {}, evidence: ["e"] }, role: "owner" }), /invalid_request/);
});

test("filters are validated and bounded", () => {
  assert.deepEqual(validateAssetFilters({ stage: "gold", limit: 10 }), { stage: "gold", sourceKind: null, evaluationStatus: null, search: null, limit: 10, offset: 0 });
  assert.throws(() => validateAssetFilters({ limit: 500 }), /invalid_limit/);
  assert.throws(() => validateAssetFilters({ stage: "silver" }), /invalid_stage/);
  assert.throws(() => validateExportFilters({ from: "2026-09-21", to: "2026-09-20" }), /invalid_range/);
  assert.deepEqual(validateExportFilters({}).limit, 50);
});

test("export filters accept a single selected asset and reject a bad id", () => {
  const filters = validateExportFilters({ asset_ids: ["11111111-1111-1111-1111-111111111111"], limit: 1 });
  assert.deepEqual(filters.assetIds, ["11111111-1111-1111-1111-111111111111"]);
  assert.equal(filters.limit, 1);
  assert.throws(() => validateExportFilters({ asset_ids: ["not-a-uuid"] }), /invalid_asset_id/);
  assert.throws(() => validateExportFilters({ asset_ids: [] }), /invalid_asset_id/);
});

test("wire echoes use snake_case so they match the frontend schemas exactly", () => {
  const assetWire = assetFiltersWire({ stage: "gold", sourceKind: "contributor", evaluationStatus: "verified", search: "x", limit: 5, offset: 0 });
  assert.deepEqual(Object.keys(assetWire).sort(), ["evaluation_status", "limit", "offset", "search", "source_kind", "stage"]);
  const exportWire = exportFiltersWire({ stage: null, sourceKind: null, evaluationStatus: null, from: null, to: null, assetIds: null, limit: 50 });
  assert.deepEqual(Object.keys(exportWire).sort(), ["asset_ids", "evaluation_status", "from", "limit", "source_kind", "stage", "to"]);
});

test("markdown export escapes injection and carries original + reviewed columns", () => {
  const filters = validateExportFilters({ stage: "gold", limit: 50 });
  const result = renderAssetsMarkdown([
    asset({
      question: "Doanh thu | <script>alert(1)</script> `tick`",
      source_answer: "Câu trả lời gốc",
      dataset_stage: "gold",
      evaluation_status: "verified",
      verified_intent: "doanh thu có kiểm soát",
      verified_conditions: { period: "today" },
      evidence: [{ kind: "snapshot", ref: "snap-1" }],
      reviewer_id: "owner-1",
      version: 4,
    }),
  ], filters, "2026-09-20T03:00:00.000Z", 1);
  assert.match(result.markdown, /# VNAgent dataset export/);
  assert.match(result.markdown, /Filter scope: stage=gold/);
  assert.match(result.markdown, /Original answer/);
  assert.match(result.markdown, /Executed filters/);
  assert.match(result.markdown, /Verified intent/);
  assert.match(result.markdown, /Evidence/);
  assert.match(result.markdown, /Reviewer \/ version/);
  assert.match(result.markdown, /owner-1 \/ v4/);
  // The compact summary neutralizes HTML; the full case preserves it verbatim in a fence.
  const [summaryTable, fullCases] = result.markdown.split("## Full cases");
  assert.match(summaryTable, /\\\|/);
  assert.ok(!summaryTable.includes("<script>"));
  assert.match(summaryTable, /&lt;script&gt;/);
  assert.ok(fullCases.includes("<script>alert(1)</script>"));
  assert.equal(result.count, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.total, 1);
});

test("markdown export handles an empty result honestly and truncates against the real total", () => {
  const empty = renderAssetsMarkdown([], validateExportFilters({ limit: 10 }), "2026-09-20T03:00:00.000Z", 0);
  assert.match(empty.markdown, /No assets matched/);
  const bounded = renderAssetsMarkdown([asset(), asset({ id: "22222222-2222-2222-2222-222222222222" })], validateExportFilters({ limit: 1 }), "2026-09-20T03:00:00.000Z", 9);
  assert.equal(bounded.count, 1);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.total, 9);
  assert.match(bounded.markdown, /Rows: 1 of 9/);
});

test("export preserves the complete end of a max-length question and long evidence", () => {
  const tail = "END-OF-QUESTION-QUALIFIER";
  const longQuestion = "a".repeat(4000 - tail.length) + tail;
  const longEvidence = `evidence-${"e".repeat(1991)}`;
  assert.equal(longQuestion.length, 4000);
  assert.equal(longEvidence.length, 2000);
  const result = renderAssetsMarkdown([
    asset({ question: longQuestion, source_answer: "y".repeat(2000), evidence: [longEvidence] }),
  ], validateExportFilters({ limit: 10 }), "2026-09-20T03:00:00.000Z", 1);

  // The compact summary cell is explicitly marked as shortened...
  assert.ok(result.markdown.includes(SUMMARY_TRUNCATION_MARKER));
  const summary = result.markdown.split("## Full cases")[0];
  assert.ok(!summary.includes(tail));
  // ...while the full case section keeps the exact stored value, unchanged.
  assert.ok(result.markdown.includes(longQuestion));
  assert.ok(result.markdown.includes(tail));
  assert.ok(result.markdown.includes(longEvidence));
});

test("export keeps adversarial backticks and markdown image/link syntax inert", () => {
  const payload = "``````\n![pwn](https://evil.example/x.png) [link](https://evil.example)";
  const result = renderAssetsMarkdown([
    asset({ question: payload, source_answer: "``` ![y](https://evil.example/y.png)" }),
  ], validateExportFilters({ limit: 10 }), "2026-09-20T03:00:00.000Z", 1);

  const [summary, full] = result.markdown.split("## Full cases");
  // The summary table must not contain an active image/link.
  assert.ok(!summary.includes("![pwn]("));
  assert.match(summary, /!\\\[pwn\\\]\(https:\/\/evil\.example\/x\.png\)/);
  // The fenced full case preserves the raw text verbatim (JSON-escaped newline is
  // lossless), inside a fence longer than the 6-backtick run so it cannot close early.
  assert.ok(full.includes("![pwn](https://evil.example/x.png)"));
  assert.ok(full.includes("``````"));
  assert.match(full, /^`{7,}json$/m);
  assert.match(full, /^`{7,}$/m);
});

test("export bounds the total response size with an explicit error, never silent loss", () => {
  const huge = Array.from({ length: 100 }, (_, index) => asset({
    id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    question: "q".repeat(4000),
    source_answer: "a".repeat(2000),
    evidence: Array.from({ length: 20 }, (_, item) => `e-${item}-${"x".repeat(1990)}`),
    dedupe_key: `huge-${index}`,
  }));
  const filters = validateExportFilters({ limit: 100 });
  const oversized = () => renderAssetsMarkdown(huge, filters, "2026-09-20T03:00:00.000Z", huge.length);
  assert.throws(oversized, (error: unknown) => error instanceof DataAdminError && error.code === "export_too_large" && error.status === 413);
  // A single bounded case stays well inside the cap but keeps the same fidelity.
  const single = renderAssetsMarkdown([huge[0]], validateExportFilters({ limit: 1 }), "2026-09-20T03:00:00.000Z", 1);
  assert.ok(new TextEncoder().encode(single.markdown).length < EXPORT_BYTES_MAX);
  assert.ok(single.markdown.includes("x".repeat(1990)));
});

test("fencedJson picks a fence longer than any backtick run in the payload", () => {
  const block = fencedJson({ note: "``` and ```` inside" });
  assert.match(block, /^`{5,}json/m);
  assert.ok(block.includes("``` and ```` inside"));
});

test("summary cells label truncation and neutralize brackets", () => {
  const short = escapeMarkdownCell("plain");
  assert.equal(short, "plain");
  const long = escapeMarkdownCell("z".repeat(500));
  assert.ok(long.startsWith("z".repeat(400)));
  assert.ok(long.endsWith(SUMMARY_TRUNCATION_MARKER));
  assert.equal(escapeMarkdownCell("[link](https://evil.example)"), "\\[link\\](https://evil.example)");
});

test("escapeMarkdownCell neutralizes pipes, newlines and HTML", () => {
  assert.equal(escapeMarkdownCell("a | b\nc <d>"), "a \\| b c &lt;d&gt;");
  assert.equal(escapeMarkdownCell(null), "—");
});

test("summarizeOverview keeps stage counts separate, reports created-today and sources", () => {
  const summary = summarizeOverview({
    asOf: "2026-09-20",
    assets: { raw: 5, curated: 2, gold: 1, total: 8 },
    createdToday: 3,
    promotionsToday: { rawToCurated: 1, curatedToGold: 0, demotions: 0 },
    promotions7d: { rawToCurated: 4, curatedToGold: 1 },
    collected: { today: 9, last7d: 40, total: 120 },
    reviewed: { verified: 1, pending: 2, rejected: 0, notEvaluated: 5, denominator: 8 },
    unknown: { abstainedToday: 2, abstainedTotal: 6, errorsToday: 1, errorsTotal: 3 },
    sourceContributions: { operational_chat: 5, contributor: 2, synthetic: 1, total: 8 },
    scopeNote: "stages",
  });
  assert.equal(summary.assets.raw + summary.assets.curated + summary.assets.gold, summary.assets.total);
  assert.equal(summary.reviewed.denominator, 8);
  assert.equal(summary.createdToday, 3);
  assert.equal(summary.sourceContributions.operational_chat, 5);
  assert.equal(summarizeOverview({ assets: { raw: -3 } }).assets.raw, 0);
  assert.throws(() => summarizeOverview(null), (error: unknown) => error instanceof DataAdminError && error.status === 503);
});

test("summarizeTimeseries normalizes the daily stock/inflow shape", () => {
  const series = summarizeTimeseries({
    from: "2026-08-22", to: "2026-09-20", timezone: "Asia/Ho_Chi_Minh",
    days: [{ date: "2026-09-20", stock: { raw: 1, curated: 2, gold: 3, total: 6 }, inflow: { raw: 1, curated: 1, gold: 1 } }],
    sourceContributions: { operational_chat: 3, contributor: 2, synthetic: 1, total: 6 },
  });
  assert.equal(series.days.length, 1);
  assert.equal(series.days[0].stock.total, 6);
  assert.equal(series.days[0].inflow.gold, 1);
  assert.equal(series.sourceContributions.total, 6);
  assert.throws(() => summarizeTimeseries({ days: "no" }), (error: unknown) => error instanceof DataAdminError);
});
