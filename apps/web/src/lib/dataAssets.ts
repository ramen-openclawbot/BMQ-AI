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
