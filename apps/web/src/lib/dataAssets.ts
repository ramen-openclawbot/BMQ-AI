// Shared types, response schemas and pure presentation helpers for the VNAgent
// data-assets admin. No Supabase import here so it stays unit-testable offline.

import { z } from "zod";

export const ASSET_STAGES = ["raw", "curated", "gold"] as const;
export const SOURCE_KINDS = ["operational_chat", "contributor", "synthetic"] as const;
export const SOURCE_DESIGNATIONS = ["manual", "llm_generated"] as const;
export const EVALUATION_STATUSES = ["not_evaluated", "pending_review", "verified", "rejected"] as const;
export const TIMESERIES_DAYS = [7, 30, 90] as const;

export type AssetStage = (typeof ASSET_STAGES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type SourceDesignation = (typeof SOURCE_DESIGNATIONS)[number];
export type Language = "vi" | "en";
export type TimeseriesDayCount = (typeof TIMESERIES_DAYS)[number];

/**
 * The VNAgent data admin is English by default and must never inherit the BMQ
 * app language (`LanguageContext` / the `app-language` localStorage key). Only
 * UI chrome is localized: raw captured questions, answers and evidence are
 * always shown verbatim in their original language.
 */
export const ADMIN_LANGUAGE: Language = "en";
export type ChartMode = "stock" | "new";

export const assetSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  dataset_stage: z.enum(ASSET_STAGES),
  source_kind: z.enum(SOURCE_KINDS),
  source_designation: z.enum(SOURCE_DESIGNATIONS).nullable(),
  interaction_id: z.string().nullable(),
  question: z.string(),
  source_answer: z.string().nullable(),
  expected_intent: z.record(z.unknown()),
  expected_filters: z.record(z.string()),
  provenance: z.record(z.unknown()),
  snapshot_at: z.string().nullable(),
  effective_at: z.string(),
  evaluation_status: z.string(),
  verified_intent: z.string().nullable(),
  verified_conditions: z.unknown(),
  evidence: z.array(z.unknown()),
  reviewer_id: z.string().nullable(),
  version: z.number(),
  dedupe_key: z.string(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type DataAsset = z.infer<typeof assetSchema>;

export const sourceContributionsSchema = z.object({
  operational_chat: z.number(),
  contributor: z.number(),
  synthetic: z.number(),
  total: z.number(),
});

export const overviewSchema = z.object({
  asOf: z.string(),
  assets: z.object({ raw: z.number(), curated: z.number(), gold: z.number(), total: z.number() }),
  createdToday: z.number(),
  promotionsToday: z.object({ rawToCurated: z.number(), curatedToGold: z.number(), demotions: z.number() }),
  promotions7d: z.object({ rawToCurated: z.number(), curatedToGold: z.number() }),
  collected: z.object({ today: z.number(), last7d: z.number(), total: z.number() }),
  reviewed: z.object({ verified: z.number(), pending: z.number(), rejected: z.number(), notEvaluated: z.number(), denominator: z.number() }),
  unknown: z.object({ abstainedToday: z.number(), abstainedTotal: z.number(), errorsToday: z.number(), errorsTotal: z.number() }),
  sourceContributions: sourceContributionsSchema,
  scopeNote: z.string(),
});
export type DataAdminOverview = z.infer<typeof overviewSchema>;

export const captureStatusSchema = z.object({ enabled: z.boolean() });
export type DataAdminCapture = z.infer<typeof captureStatusSchema>;

export const assetFiltersSchema = z.object({
  stage: z.enum(ASSET_STAGES).nullable(),
  source_kind: z.enum(SOURCE_KINDS).nullable(),
  evaluation_status: z.string().nullable(),
  search: z.string().nullable(),
  limit: z.number(),
  offset: z.number(),
});

export const exportFiltersSchema = z.object({
  stage: z.enum(ASSET_STAGES).nullable(),
  source_kind: z.enum(SOURCE_KINDS).nullable(),
  evaluation_status: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  asset_ids: z.array(z.string()).nullable(),
  limit: z.number(),
});

export const overviewResponseSchema = z.object({
  status: z.literal("ok"),
  overview: overviewSchema,
  capture: captureStatusSchema,
});
export const assetsResponseSchema = z.object({ status: z.literal("ok"), assets: z.array(assetSchema), total: z.number().nullable(), filters: assetFiltersSchema });
export const assetResponseSchema = z.object({ status: z.literal("ok"), asset: assetSchema });
export const contributionResponseSchema = z.object({ status: z.enum(["created", "duplicate"]), asset: assetSchema, duplicate: z.boolean() });
export const transitionResponseSchema = z.object({ status: z.literal("ok"), asset: assetSchema });

export const timeseriesDaySchema = z.object({
  date: z.string(),
  stock: z.object({ raw: z.number(), curated: z.number(), gold: z.number(), total: z.number() }),
  inflow: z.object({ raw: z.number(), curated: z.number(), gold: z.number() }),
});
export const timeseriesResponseSchema = z.object({
  status: z.literal("ok"),
  timeseries: z.object({
    from: z.string(),
    to: z.string(),
    timezone: z.string(),
    days: z.array(timeseriesDaySchema),
    sourceContributions: sourceContributionsSchema,
  }),
});
export type DataAdminTimeseries = z.infer<typeof timeseriesResponseSchema>["timeseries"];
export type TimeseriesDay = z.infer<typeof timeseriesDaySchema>;

export const jevEventSchema = z.object({
  id: z.string(),
  request_id: z.string(),
  model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  registry_version: z.string().nullable(),
  attempted: z.boolean(),
  decided: z.boolean(),
  screen: z.string().nullable(),
  circuit: z.string().nullable(),
  metric: z.string().nullable(),
  metric_probability: z.union([z.number(), z.string()]).nullable(),
  period: z.string().nullable(),
  period_probability: z.union([z.number(), z.string()]).nullable(),
  support: z.string().nullable(),
  support_probability: z.union([z.number(), z.string()]).nullable(),
  threshold: z.union([z.number(), z.string()]).nullable(),
  fallback: z.string().nullable(),
  cost: z.union([z.number(), z.string()]).nullable(),
  token_counts: z.record(z.unknown()),
  stage_timings: z.record(z.unknown()),
  counts: z.record(z.unknown()),
  decision: z.string().nullable(),
  created_at: z.string(),
});
export type JevEvent = z.infer<typeof jevEventSchema>;
export const jevResponseSchema = z.object({ status: z.literal("ok"), events: z.array(jevEventSchema) });

export const exportResponseSchema = z.object({
  status: z.literal("ok"),
  markdown: z.string(),
  count: z.number(),
  truncated: z.boolean(),
  total: z.number(),
  filters: exportFiltersSchema,
});
export type DataAdminExport = z.infer<typeof exportResponseSchema>;
export const errorResponseSchema = z.object({ error: z.string(), code: z.string() });

// ── Owner-only Generate Data (server-side synthetic question batches) ──
export const GENERATION_TOPICS = [
  { id: "mixed", label: "Mixed (all supported definitions)" },
  { id: "controlled_revenue", label: "Controlled revenue" },
  { id: "purchase_order_count", label: "Purchase order count" },
  { id: "low_stock_count", label: "Low stock" },
  { id: "supplier_debt", label: "Supplier payables" },
  { id: "dealer_order", label: "Dealer orders" },
  { id: "kiosk_report", label: "Kiosk reports" },
  { id: "supplier_payments", label: "Actual supplier payments" },
  { id: "cost_classification", label: "Cost classification" },
] as const;
export const GENERATION_COUNT_MIN = 20;
export const GENERATION_COUNT_MAX = 50;
export const GENERATION_BUDGET_MIN = 0.01;
export const GENERATION_BUDGET_MAX = 5;
export const GENERATION_LANGUAGES = ["vi", "en"] as const;
export type GenerationLanguage = (typeof GENERATION_LANGUAGES)[number];

const numericWire = z.union([z.number(), z.string()]);
export const generationJobSchema = z.object({
  id: z.string(),
  tenant: z.string().optional(),
  status: z.enum(["running", "completed", "failed", "budget_exceeded"]),
  version: z.number(),
  idempotency_key: z.string().optional(),
  request: z.record(z.unknown()).optional(),
  model: z.string().nullable().optional(),
  prompt_version: z.string().nullable().optional(),
  seed_ids: z.array(z.string()).optional(),
  budget_usd: numericWire.nullable().optional(),
  worst_case_cost_usd: numericWire.nullable().optional(),
  actual_cost_usd: numericWire.nullable().optional(),
  result_summary: z.record(z.unknown()).optional(),
  error_code: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  finished_at: z.string().nullable().optional(),
});
export type GenerationJob = z.infer<typeof generationJobSchema>;

export const generationResultsSchema = z.object({
  created: z.number(),
  duplicate: z.number(),
  rejected: z.number().optional(),
  total: z.number().optional(),
});

/**
 * Allowlisted provider diagnostic carried by the server: only the upstream HTTP
 * status, provider code and offending parameter name. The raw provider message is
 * never sent, so it can never be shown or stored here.
 */
export const generationDiagnosticSchema = z.object({
  status: z.number(),
  code: z.string().nullable(),
  param: z.string().nullable(),
});
export type GenerationDiagnostic = z.infer<typeof generationDiagnosticSchema>;

export const generationResponseSchema = z.object({
  status: z.enum(["ok", "in_progress", "abandoned", "failed", "budget_exceeded"]),
  resumed: z.boolean(),
  job: generationJobSchema,
  results: generationResultsSchema,
  assets: z.array(assetSchema).optional(),
  diagnostic: generationDiagnosticSchema.optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  inputTokenBound: z.number().nullable().optional(),
  outputTokenBound: z.number().nullable().optional(),
  worstCaseCostUsd: z.number().nullable().optional(),
  actualCostUsd: z.number().nullable().optional(),
  // The provider may omit usage; unknown is null, never a fabricated 0.
  usage: z.object({ input: z.number().nullable(), output: z.number().nullable() }).optional(),
});
export type GenerationResponse = z.infer<typeof generationResponseSchema>;

export const generationHistoryResponseSchema = z.object({
  status: z.literal("ok"),
  job: generationJobSchema.nullable().optional(),
  jobs: z.array(generationJobSchema).optional(),
  // Server-evaluated expired-lease outcome (never the browser clock).
  abandoned: z.boolean().optional(),
});
export type GenerationHistory = z.infer<typeof generationHistoryResponseSchema>;

// ── Owner-only Generate Data recovery state (pure, unit-testable) ──
export interface PendingGenerationRequest {
  topic: string;
  count: number;
  target_language: GenerationLanguage;
  budget_usd: number;
}
export interface PendingGeneration {
  key: string;
  /** The EXACT validated request of the pending run, restored so a safe retry is the same run. */
  request: PendingGenerationRequest | null;
}

const PENDING_KEY_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Parse the owner-scoped pending record; legacy bare keys are accepted read-only. */
export function parsePendingGeneration(raw: string | null): PendingGeneration | null {
  if (!raw) return null;
  const legacy = PENDING_KEY_PATTERN.test(raw) ? raw : null;
  try {
    const parsed = JSON.parse(raw) as { key?: unknown; request?: unknown } | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.key !== "string" || !PENDING_KEY_PATTERN.test(parsed.key)) return legacy ? { key: legacy, request: null } : null;
    const request = parsed.request as Record<string, unknown> | null | undefined;
    const valid = request
      && typeof request === "object"
      && typeof request.topic === "string"
      && Number.isInteger(request.count)
      && (request.target_language === "vi" || request.target_language === "en")
      && typeof request.budget_usd === "number" && Number.isFinite(request.budget_usd);
    return {
      key: parsed.key,
      request: valid
        ? { topic: request.topic as string, count: request.count as number, target_language: request.target_language as GenerationLanguage, budget_usd: request.budget_usd as number }
        : null,
    };
  } catch {
    return legacy ? { key: legacy, request: null } : null;
  }
}

export function serializePendingGeneration(pending: PendingGeneration): string {
  return JSON.stringify(pending);
}

/**
 * Whether a read-back releases the pending lock. An expired lease is an explicit
 * server-verified terminal outcome, so it releases. A still-running or absent job
 * keeps the lock (the owner must recover, not blindly start a new paid batch).
 */
export function generationRecoveryDecision(input: { jobStatus?: string | null; abandoned?: boolean; absent?: boolean }): "keep" | "clear" {
  if (input.absent) return "keep";
  if (input.abandoned) return "clear";
  if (input.jobStatus === "running") return "keep";
  return input.jobStatus ? "clear" : "keep";
}

/** Definitive pre-dispatch denials may clear the pending lock; everything else keeps it. */
export function isDefinitiveGenerationDenial(code: string | undefined, uncertain: boolean): boolean {
  if (uncertain || !code) return false;
  return new Set([
    "disabled", "unauthorized", "forbidden", "rate_limited", "invalid_action",
    "invalid_json", "invalid_content_type", "body_limit",
    "generation_disabled", "generation_cost_unbounded", "generation_budget_exceeded",
    "generation_busy", "generation_idempotency_conflict", "generation_input_too_large",
    "generation_invalid_request", "generation_invalid_topic", "generation_invalid_count",
    "generation_invalid_language", "generation_invalid_budget", "generation_invalid_style_mix",
    "generation_invalid_seeds", "generation_invalid_idempotency_key",
  ]).has(code);
}

/** Deterministic default style split shown in the UI (must match the server). */
export function defaultGenerationStyleMix(count: number): { variant: number; typo: number; ambiguous: number; out_of_scope: number } {
  const typo = Math.max(2, Math.round(count * 0.15));
  const ambiguous = Math.max(2, Math.round(count * 0.15));
  const outOfScope = Math.max(1, Math.round(count * 0.1));
  return { variant: count - typo - ambiguous - outOfScope, typo, ambiguous, out_of_scope: outOfScope };
}

export function generationStatusLabel(status: string, language: Language): string {
  return {
    running: pick(language, "Đang chạy", "Running"),
    completed: pick(language, "Hoàn tất", "Completed"),
    failed: pick(language, "Thất bại", "Failed"),
    budget_exceeded: pick(language, "Vượt ngân sách", "Budget exceeded"),
  }[status] ?? status;
}

/** Read the durable allowlisted diagnostic back from a job's result summary. */
export function generationJobDiagnostic(job: Pick<GenerationJob, "result_summary">): GenerationDiagnostic | null {
  const summary = (job.result_summary ?? {}) as Record<string, unknown>;
  const parsed = generationDiagnosticSchema.safeParse(summary.diagnostic);
  return parsed.success ? parsed.data : null;
}

/**
 * Operator-facing copy for known durable generation failure codes. These are
 * fixed strings keyed by a safe code, never a passthrough of provider text. The
 * code/HTTP/parameter diagnostics stay on the saved job for support only.
 */
const KNOWN_GENERATION_FAILURE_LABELS: Record<string, { vi: string; en: string }> = {
  generation_paid_credits_required: {
    vi: "Model tạo câu hỏi cần credit trả phí trên Gateway cho tài khoản này; anh nạp credit rồi chạy lại.",
    en: "The generation model needs paid Gateway credits on this account; top up the credits, then run again.",
  },
  generation_rate_limited: {
    vi: "Model tạo câu hỏi đang giới hạn lượt gọi; anh thử lại sau.",
    en: "The generation model is rate limited; please try again later.",
  },
  generation_http_error: {
    vi: "Lượt gọi model trả lỗi và không có câu nào được lưu; anh đọc lại trạng thái job trước khi chạy lại.",
    en: "The model call returned an error and nothing was stored; read the job state before running again.",
  },
  generation_invalid_response: {
    vi: "Phản hồi model không hợp lệ nên cả lô bị từ chối; không có câu nào được lưu.",
    en: "The model response was invalid, so the whole batch was rejected; nothing was stored.",
  },
  generation_invalid_output: {
    vi: "Model trả về bộ câu hỏi không đúng hợp đồng nên cả lô bị từ chối; không có câu nào được lưu.",
    en: "The model returned a batch that violates the contract, so the whole batch was rejected; nothing was stored.",
  },
  generation_duplicate_output: {
    vi: "Model trả về câu hỏi trùng nhau nên cả lô bị từ chối; không có câu nào được lưu.",
    en: "The model returned duplicate questions, so the whole batch was rejected; nothing was stored.",
  },
  generation_timeout: {
    vi: "Lượt tạo câu hỏi vượt thời gian cho phép; anh đọc lại trạng thái job trước khi chạy lại.",
    en: "The generation call timed out; read the job state before running it again.",
  },
  generation_unavailable: {
    vi: "Chưa gọi được model tạo câu hỏi; anh đọc lại trạng thái job trước khi chạy lại.",
    en: "The generation model could not be reached; read the job state before running it again.",
  },
  budget_exceeded: {
    vi: "Chi phí thực tế vượt ngân sách nên không có câu nào được lưu.",
    en: "The reported cost exceeded the budget, so nothing was stored.",
  },
};

/**
 * Human-safe failure reason: fixed friendly copy for a known durable failure
 * code, else null. No provider message, no HTTP/parameter internals and no
 * "safe code" jargon in the primary flow; those stay on the saved job for
 * support.
 */
export function generationFailureReason(
  job: Pick<GenerationJob, "status" | "error_code" | "result_summary">,
  language: Language,
): string | null {
  if (job.status === "completed" || !job.error_code) return null;
  const known = KNOWN_GENERATION_FAILURE_LABELS[job.error_code];
  return known ? pick(language, known.vi, known.en) : null;
}

export function generationTopicLabel(id: string): string {
  return GENERATION_TOPICS.find((topic) => topic.id === id)?.label ?? id;
}

export type AssetFilters = {
  stage: AssetStage | "";
  sourceKind: SourceKind | "";
  evaluationStatus: string;
  search: string;
  limit: number;
  offset: number;
};

export type ExportFilters = {
  stage: AssetStage | "";
  sourceKind: SourceKind | "";
  evaluationStatus: string;
  from: string;
  to: string;
  assetIds: string[] | null;
  limit: number;
};

export const EMPTY_ASSET_FILTERS: AssetFilters = { stage: "", sourceKind: "", evaluationStatus: "", search: "", limit: 25, offset: 0 };
export const EMPTY_EXPORT_FILTERS: ExportFilters = { stage: "", sourceKind: "", evaluationStatus: "", from: "", to: "", assetIds: null, limit: 50 };

// ── Review queue: server-side stage filter + pagination ──
// The queue must never page over "all stages then hide Gold on the client":
// with more than one page of Gold that hides older Raw/Curated pending assets.
// It asks the server for one reviewable stage at a time and uses the server total.
export const REVIEW_PAGE_SIZE = 25;
export const REVIEWABLE_STAGES = ["raw", "curated"] as const;
export type ReviewableStage = (typeof REVIEWABLE_STAGES)[number];

/** Exact `assets` payload for one review page; stage filtering happens in SQL before the limit. */
export function reviewQueueQuery(stage: ReviewableStage, offset: number): Record<string, unknown> {
  return { action: "assets", stage, source_kind: null, evaluation_status: null, search: null, limit: REVIEW_PAGE_SIZE, offset };
}

/** Honest 1-based range label for the current server page (total stays null when unknown). */
export function reviewPageRange(offset: number, count: number, total: number | null): string {
  if (count <= 0) return total === null ? "0" : `0 / ${total}`;
  const range = `${offset + 1}–${offset + count}`;
  return total === null ? range : `${range} / ${total}`;
}

function pick(language: Language, vi: string, en: string): string {
  return language === "en" ? en : vi;
}

export function stageLabel(stage: AssetStage | string, language: Language): string {
  return {
    raw: pick(language, "Raw · vừa thu thập", "Raw · just collected"),
    curated: pick(language, "Curated · đã biên tập", "Curated · edited"),
    gold: pick(language, "Gold · đã xác minh", "Gold · verified"),
  }[stage] ?? String(stage);
}

export function sourceKindLabel(kind: SourceKind | string, language: Language): string {
  return {
    operational_chat: pick(language, "Chat vận hành", "Operational chat"),
    contributor: pick(language, "Đóng góp thủ công", "Contributor"),
    synthetic: pick(language, "Tổng hợp (synthetic)", "Synthetic"),
  }[kind] ?? String(kind);
}

export function designationLabel(value: SourceDesignation | string | null, language: Language): string {
  if (!value) return pick(language, "Không áp dụng", "Not applicable");
  return value === "manual" ? pick(language, "Thủ công", "Manual") : pick(language, "Do LLM tạo", "LLM-generated");
}

export function evaluationLabel(status: string, language: Language): string {
  return {
    not_evaluated: pick(language, "Chưa đánh giá", "Not evaluated"),
    pending_review: pick(language, "Chờ duyệt", "Pending review"),
    verified: pick(language, "Đã xác minh", "Verified"),
    rejected: pick(language, "Từ chối", "Rejected"),
  }[status] ?? status;
}

export function formatDateTime(value: string | null | undefined, language: Language): string {
  if (!value) return pick(language, "—", "—");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(language === "en" ? "en-US" : "vi-VN", { dateStyle: "short", timeStyle: "short" });
}

export function formatDay(value: string | null | undefined): string {
  return value || "—";
}

/** Group a number for the admin UI; English grouping by default (en-US). */
export function formatNumber(value: number, language: Language = ADMIN_LANGUAGE): string {
  return new Intl.NumberFormat(language === "vi" ? "vi-VN" : "en-US").format(value);
}

/** Reviewed denominator excludes nothing; the rate is only shown when non-zero. */
export function reviewedRate(overview: DataAdminOverview): number | null {
  if (overview.reviewed.denominator <= 0) return null;
  return Math.round((overview.reviewed.verified / overview.reviewed.denominator) * 100);
}

export function unknownTotal(overview: DataAdminOverview): number {
  return overview.unknown.abstainedTotal + overview.unknown.errorsTotal;
}

export interface ChartPoint {
  date: string;
  raw: number;
  curated: number;
  gold: number;
}

/**
 * Turn the daily event-derived timeseries into chart points. `stock` is the
 * reconstructed inventory at the end of each day; `new` is the inflow recorded
 * on that day (created raw assets, real promotions). No smoothing or fake values.
 */
export function chartPoints(timeseries: DataAdminTimeseries, mode: ChartMode): ChartPoint[] {
  return timeseries.days.map((day) => mode === "stock"
    ? { date: day.date, raw: day.stock.raw, curated: day.stock.curated, gold: day.stock.gold }
    : { date: day.date, raw: day.inflow.raw, curated: day.inflow.curated, gold: day.inflow.gold });
}

export interface ContributionRow {
  key: SourceKind | "total";
  label: string;
  count: number;
}

export function contributionRows(source: DataAdminOverview["sourceContributions"], language: Language): ContributionRow[] {
  return [
    { key: "operational_chat", label: sourceKindLabel("operational_chat", language), count: source.operational_chat },
    { key: "contributor", label: sourceKindLabel("contributor", language), count: source.contributor },
    { key: "synthetic", label: sourceKindLabel("synthetic", language), count: source.synthetic },
    { key: "total", label: pick(language, "Tổng", "Total"), count: source.total },
  ];
}

/** Honest summary line for the contribution chips (never implies more than stored). */
export function overallContributionLabel(total: number, language: Language): string {
  return pick(language, `Tổng số tài sản theo nguồn: ${total}`, `Assets by source: ${total}`);
}

// ── Small form helpers shared by the panels (kept here so they are testable) ──

export const MAX_FILTER_ROWS = 12;
export const MAX_EVIDENCE_LINES = 20;

/** Parse `key=value` evidence lines into a bounded array, dropping blanks. */
export function parseEvidenceLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE_LINES);
}

/** Parse the Gold conditions textarea. Returns null when empty, undefined when invalid JSON. */
export function parseConditions(value: string): unknown {
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Convert expected-filter rows into an object; throws `invalid` on a half-filled or oversized row. */
export function parseFilterRows(rows: { key: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    const value = row.value.trim();
    if (!key && !value) continue;
    if (!key || !value) throw new Error("invalid");
    out[key] = value;
    if (Object.keys(out).length > MAX_FILTER_ROWS) throw new Error("invalid");
  }
  return out;
}

export function exportFileName(now: Date): string {
  return `vnagent-dataset-${now.toISOString().slice(0, 10)}.md`;
}

/**
 * A mutation whose response was lost (network) or came back 5xx may or may not
 * have been applied. The UI must reconcile by reading durable state before it
 * allows a retry instead of blindly resubmitting.
 */
export function isUncertainMutationStatus(status: number): boolean {
  return status === 0 || status >= 500;
}
