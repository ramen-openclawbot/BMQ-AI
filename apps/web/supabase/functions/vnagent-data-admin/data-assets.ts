// Pure domain logic for the VNAgent data-assets admin.
//
// Everything here is deterministic and side-effect free so it can be unit
// tested offline (node --test) and reused by the HTTP handler. No database,
// network, auth or environment access lives in this module.

export const TENANT = "bmq" as const;

export const ASSET_STAGES = ["raw", "curated", "gold"] as const;
export const SOURCE_KINDS = ["operational_chat", "contributor", "synthetic"] as const;
export const SOURCE_DESIGNATIONS = ["manual", "llm_generated"] as const;
export const EVALUATION_STATUSES = ["not_evaluated", "pending_review", "verified", "rejected"] as const;
export const RESPONSE_STATUSES = ["success", "abstained", "error", "unknown"] as const;
export const TIMESERIES_DAYS = [7, 30, 90] as const;

export type AssetStage = (typeof ASSET_STAGES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type SourceDesignation = (typeof SOURCE_DESIGNATIONS)[number];

export const QUESTION_MAX = 4000;
export const INTENT_MAX = 2000;
export const REASON_MAX = 500;
export const FILTER_KEYS_MAX = 12;
export const FILTER_VALUE_MAX = 200;
export const EVIDENCE_MAX = 20;
export const EVIDENCE_TEXT_MAX = 2000;
export const EXPORT_MAX = 200;
export const EXPORT_DEFAULT = 50;
export const EXPORT_ASSET_IDS_MAX = 50;
export const CELL_MAX = 400;
/** Hard cap on a single export response; exceeding it is an explicit error, never a silent drop. */
export const EXPORT_BYTES_MAX = 4_000_000;

/** Bounded HTTP error with a stable machine code and a safe user message. */
export class DataAdminError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = "DataAdminError";
    this.code = code;
    this.status = status;
  }
}

export interface DataAsset {
  id: string;
  tenant: string;
  dataset_stage: AssetStage;
  source_kind: SourceKind;
  source_designation: SourceDesignation | null;
  interaction_id: string | null;
  question: string;
  source_answer: string | null;
  expected_intent: Record<string, unknown>;
  expected_filters: Record<string, string>;
  provenance: Record<string, unknown>;
  snapshot_at: string | null;
  effective_at: string;
  evaluation_status: string;
  verified_intent: string | null;
  verified_conditions: unknown;
  evidence: unknown[];
  reviewer_id: string | null;
  version: number;
  dedupe_key: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContributionInput {
  question: string;
  sourceKind: SourceKind;
  sourceDesignation: SourceDesignation;
  expectedIntent: Record<string, unknown>;
  expectedFilters: Record<string, string>;
  provenance: Record<string, unknown>;
  snapshotAt: string | null;
}

export interface TransitionInput {
  assetId: string;
  expectedVersion: number;
  toStage: AssetStage;
  reason: string | null;
  verified: { intent: string; conditions: unknown; evidence: unknown[] } | null;
}

export interface AssetFilterInput {
  stage: AssetStage | null;
  sourceKind: SourceKind | null;
  evaluationStatus: string | null;
  search: string | null;
  limit: number;
  offset: number;
}

export interface ExportFilterInput {
  stage: AssetStage | null;
  sourceKind: SourceKind | null;
  evaluationStatus: string | null;
  from: string | null;
  to: string | null;
  assetIds: string[] | null;
  limit: number;
}

/** SQL-level query for the export listing: every filter is applied before LIMIT. */
export interface ExportQuery {
  stage: AssetStage | null;
  sourceKind: SourceKind | null;
  evaluationStatus: string | null;
  from: string | null;
  to: string | null;
  assetIds: string[] | null;
  limit: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[], code = "invalid_request"): void {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new DataAdminError(code, 400);
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\p{Cc}/gu, " ").trim();
  if (text.length === 0 || text.length > max) return null;
  return text;
}

/** Normalize a question to its final, comparable semantics. */
export function normalizeQuestion(value: unknown): string {
  if (typeof value !== "string") throw new DataAdminError("question_required", 400);
  const text = value
    .replace(/\p{Cc}/gu, (character) => (character === "\n" || character === "\t" ? " " : " "))
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length === 0) throw new DataAdminError("question_required", 400);
  if (text.length > QUESTION_MAX) throw new DataAdminError("question_too_long", 400);
  return text;
}

/** Deterministic JSON with sorted object keys, used for a stable dedupe scope. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null) ?? "null";
}

/**
 * Bounded sha256 dedupe key over source kind + normalized question + the FULL
 * expected scope. The same question with a genuinely different expected intent
 * or filter set must stay a distinct contribution, never collapse into one.
 */
export async function dedupeKey(
  question: string,
  sourceKind: SourceKind,
  expectedIntent: Record<string, unknown> = {},
  expectedFilters: Record<string, string> = {},
): Promise<string> {
  const scope = `${canonicalJson(expectedIntent)}|${canonicalJson(expectedFilters)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${TENANT}|${sourceKind}|${question}|${scope}`));
  const hex = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${sourceKind}:${hex.slice(0, 40)}`;
}

/** Keep only bounded JSON scalars/arrays/objects so a client cannot store huge or nested payloads. */
export function sanitizeJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.replace(/\p{Cc}/gu, " ").slice(0, EVIDENCE_TEXT_MAX);
  if (depth >= 3) return null;
  if (Array.isArray(value)) return value.slice(0, EVIDENCE_MAX).map((item) => sanitizeJson(item, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 24)) {
      if (key.length > 80 || /[\u0000-\u001f]/.test(key)) continue;
      out[key] = sanitizeJson(item, depth + 1);
    }
    return out;
  }
  return null;
}

function sanitizeObject(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeJson(value);
  if (!isRecord(sanitized)) throw new DataAdminError("invalid_object", 400);
  return sanitized;
}

/**
 * Gold evidence must be meaningful. Empty strings, nulls, empty containers and
 * numeric/boolean placeholders (0, false, ...) do not prove anything. The
 * database CHECK constraint and helper enforce the same rule.
 */
export function evidenceIsMeaningful(evidence: unknown[]): boolean {
  if (evidence.length === 0) return false;
  return evidence.every((item) => {
    if (typeof item === "string") return item.trim().length > 0;
    if (Array.isArray(item)) return item.length > 0;
    if (isRecord(item)) return Object.keys(item).length > 0;
    // null/undefined, numbers (including 0) and booleans (including false) are not evidence.
    return false;
  });
}

function isoDay(value: unknown, code: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DataAdminError(code, 400);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new DataAdminError(code, 400);
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new DataAdminError(code, 400);
  return value as T;
}

/** Validate the manual contribution form. `source_kind = operational_chat` is never accepted here. */
export function validateContribution(raw: unknown): ContributionInput {
  if (!isRecord(raw)) throw new DataAdminError("invalid_request", 400);
  assertOnlyKeys(raw, ["question", "source_kind", "source_designation", "expected_intent", "expected_filters", "provenance", "snapshot_at"]);
  const question = normalizeQuestion(raw.question);
  const sourceKind = enumValue(raw.source_kind, ["contributor", "synthetic"] as const, "invalid_source_kind");
  const sourceDesignation = enumValue(raw.source_designation, SOURCE_DESIGNATIONS, "invalid_source_designation");

  const intent = raw.expected_intent === undefined ? {} : sanitizeObject(raw.expected_intent);
  if (intent.intent !== undefined && !boundedText(intent.intent, INTENT_MAX)) throw new DataAdminError("invalid_expected_intent", 400);

  const filtersRaw = raw.expected_filters === undefined ? {} : raw.expected_filters;
  if (!isRecord(filtersRaw)) throw new DataAdminError("invalid_expected_filters", 400);
  const entries = Object.entries(filtersRaw);
  if (entries.length > FILTER_KEYS_MAX) throw new DataAdminError("invalid_expected_filters", 400);
  const expectedFilters: Record<string, string> = {};
  for (const [key, value] of entries) {
    const safeKey = boundedText(key, 60);
    const safeValue = boundedText(value, FILTER_VALUE_MAX);
    if (!safeKey || !safeValue) throw new DataAdminError("invalid_expected_filters", 400);
    expectedFilters[safeKey] = safeValue;
  }

  const provenance = raw.provenance === undefined ? {} : sanitizeObject(raw.provenance);
  const snapshotRaw = raw.snapshot_at;
  let snapshotAt: string | null = null;
  if (snapshotRaw !== undefined && snapshotRaw !== null && snapshotRaw !== "") {
    if (typeof snapshotRaw !== "string" || Number.isNaN(Date.parse(snapshotRaw))) throw new DataAdminError("invalid_snapshot_at", 400);
    snapshotAt = new Date(snapshotRaw).toISOString();
  }

  return { question, sourceKind, sourceDesignation, expectedIntent: intent, expectedFilters, provenance, snapshotAt };
}

export function validateTransition(raw: unknown): TransitionInput {
  if (!isRecord(raw)) throw new DataAdminError("invalid_request", 400);
  assertOnlyKeys(raw, ["asset_id", "expected_version", "to_stage", "reason", "verified"]);
  const assetId = typeof raw.asset_id === "string" ? raw.asset_id.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new DataAdminError("invalid_asset_id", 400);
  if (typeof raw.expected_version !== "number" || !Number.isInteger(raw.expected_version) || raw.expected_version < 1) {
    throw new DataAdminError("invalid_expected_version", 400);
  }
  const toStage = enumValue(raw.to_stage, ASSET_STAGES, "invalid_stage");
  let reason: string | null = null;
  if (raw.reason !== undefined && raw.reason !== null && raw.reason !== "") {
    reason = boundedText(raw.reason, REASON_MAX);
    if (!reason) throw new DataAdminError("invalid_reason", 400);
  }

  let verified: TransitionInput["verified"] = null;
  if (toStage === "gold") {
    if (!isRecord(raw.verified)) throw new DataAdminError("gold_verification_required", 400);
    const intent = boundedText(raw.verified.intent, INTENT_MAX);
    if (!intent) throw new DataAdminError("gold_intent_required", 400);
    const conditions = sanitizeJson(raw.verified.conditions);
    if (conditions === null || conditions === undefined) throw new DataAdminError("gold_conditions_required", 400);
    const evidenceRaw = raw.verified.evidence;
    if (!Array.isArray(evidenceRaw) || evidenceRaw.length === 0 || evidenceRaw.length > EVIDENCE_MAX) {
      throw new DataAdminError("gold_evidence_required", 400);
    }
    const evidence = evidenceRaw.map((item) => sanitizeJson(item));
    if (!evidenceIsMeaningful(evidence)) throw new DataAdminError("gold_evidence_required", 400);
    verified = { intent, conditions, evidence };
  }

  return { assetId, expectedVersion: raw.expected_version, toStage, reason, verified };
}

export function validateAssetFilters(raw: unknown): AssetFilterInput {
  const source = isRecord(raw) ? raw : {};
  assertOnlyKeys(source, ["stage", "source_kind", "evaluation_status", "search", "limit", "offset"]);
  const limitRaw = source.limit === undefined ? 25 : source.limit;
  const offsetRaw = source.offset === undefined ? 0 : source.offset;
  if (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) throw new DataAdminError("invalid_limit", 400);
  if (typeof offsetRaw !== "number" || !Number.isInteger(offsetRaw) || offsetRaw < 0 || offsetRaw > 100000) throw new DataAdminError("invalid_offset", 400);
  let search: string | null = null;
  if (source.search !== undefined && source.search !== null && source.search !== "") {
    search = boundedText(source.search, 200);
    if (!search) throw new DataAdminError("invalid_search", 400);
  }
  return {
    stage: source.stage === undefined || source.stage === null || source.stage === "" ? null : enumValue(source.stage, ASSET_STAGES, "invalid_stage"),
    sourceKind: source.source_kind === undefined || source.source_kind === null || source.source_kind === "" ? null : enumValue(source.source_kind, SOURCE_KINDS, "invalid_source_kind"),
    evaluationStatus: source.evaluation_status === undefined || source.evaluation_status === null || source.evaluation_status === "" ? null : enumValue(source.evaluation_status, EVALUATION_STATUSES, "invalid_evaluation_status"),
    search,
    limit: limitRaw,
    offset: offsetRaw,
  };
}

export function validateExportFilters(raw: unknown): ExportFilterInput {
  const source = isRecord(raw) ? raw : {};
  assertOnlyKeys(source, ["stage", "source_kind", "evaluation_status", "from", "to", "asset_ids", "limit"]);
  const from = isoDay(source.from, "invalid_from");
  const to = isoDay(source.to, "invalid_to");
  if (from && to && from > to) throw new DataAdminError("invalid_range", 400);
  const limitRaw = source.limit === undefined ? EXPORT_DEFAULT : source.limit;
  if (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > EXPORT_MAX) throw new DataAdminError("invalid_limit", 400);

  let assetIds: string[] | null = null;
  const idsRaw = source.asset_ids;
  if (idsRaw !== undefined && idsRaw !== null && idsRaw !== "") {
    if (!Array.isArray(idsRaw) || idsRaw.length === 0 || idsRaw.length > EXPORT_ASSET_IDS_MAX) throw new DataAdminError("invalid_asset_id", 400);
    assetIds = idsRaw.map((id) => {
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id.trim())) throw new DataAdminError("invalid_asset_id", 400);
      return id.trim();
    });
  }

  return {
    stage: source.stage === undefined || source.stage === null || source.stage === "" ? null : enumValue(source.stage, ASSET_STAGES, "invalid_stage"),
    sourceKind: source.source_kind === undefined || source.source_kind === null || source.source_kind === "" ? null : enumValue(source.source_kind, SOURCE_KINDS, "invalid_source_kind"),
    evaluationStatus: source.evaluation_status === undefined || source.evaluation_status === null || source.evaluation_status === "" ? null : enumValue(source.evaluation_status, EVALUATION_STATUSES, "invalid_evaluation_status"),
    from,
    to,
    assetIds,
    limit: limitRaw,
  };
}

/** Wire echo for the asset listing, matching the frontend Zod schema exactly. */
export function assetFiltersWire(filters: AssetFilterInput) {
  return {
    stage: filters.stage,
    source_kind: filters.sourceKind,
    evaluation_status: filters.evaluationStatus,
    search: filters.search,
    limit: filters.limit,
    offset: filters.offset,
  };
}

/** Wire echo for the export, matching the frontend Zod schema exactly. */
export function exportFiltersWire(filters: ExportFilterInput) {
  return {
    stage: filters.stage,
    source_kind: filters.sourceKind,
    evaluation_status: filters.evaluationStatus,
    from: filters.from,
    to: filters.to,
    asset_ids: filters.assetIds,
    limit: filters.limit,
  };
}

/** SQL-level query derived from validated export filters (no post-filtering). */
export function exportQuery(filters: ExportFilterInput): ExportQuery {
  return {
    stage: filters.stage,
    sourceKind: filters.sourceKind,
    evaluationStatus: filters.evaluationStatus,
    from: filters.from,
    to: filters.to,
    assetIds: filters.assetIds,
    limit: filters.limit,
  };
}

/** Marker appended to a summary cell that was shortened for the compact table. */
export const SUMMARY_TRUNCATION_MARKER = " …[summary truncated — full value in the Full case section]";

/**
 * Escape one value for a Markdown table cell. Prevents pipe/newline/HTML
 * breakage AND neutralizes markdown link/image syntax (`[`, `]`), so untrusted
 * captured data can never become an active image or external link in the table.
 * The compact table is deliberately shortened, and a truncation marker makes
 * that explicit; the complete value is preserved in the full case sections.
 */
export function escapeMarkdownCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const escaped = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\s+/g, " ")
    .trim();
  if (escaped.length === 0) return "—";
  if (escaped.length <= CELL_MAX) return escaped;
  return `${escaped.slice(0, CELL_MAX)}${SUMMARY_TRUNCATION_MARKER}`;
}

function jsonCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return escapeMarkdownCell(value);
  try {
    return escapeMarkdownCell(JSON.stringify(value));
  } catch {
    return "—";
  }
}

/** Longest run of backticks in `text`, used to pick a fence that cannot be closed early. */
function longestBacktickRun(text: string): number {
  let best = 0;
  let current = 0;
  for (const character of text) {
    if (character === "`") {
      current += 1;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
}

/**
 * Fence `value` as JSON so captured text (including backticks, markdown images
 * and links) is inert. The fence is always longer than any backtick run inside,
 * so the block cannot be closed early and no content can escape into markup.
 */
export function fencedJson(value: unknown): string {
  const body = JSON.stringify(value, null, 2) ?? "null";
  const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
  return `${fence}json\n${body}\n${fence}`;
}

/** Every stored field of one asset, in a stable order, for lossless verification. */
function fullCaseRecord(row: DataAsset): Record<string, unknown> {
  return {
    id: row.id,
    tenant: row.tenant,
    dataset_stage: row.dataset_stage,
    source_kind: row.source_kind,
    source_designation: row.source_designation,
    interaction_id: row.interaction_id,
    question: row.question,
    source_answer: row.source_answer,
    expected_intent: row.expected_intent,
    expected_filters: row.expected_filters,
    provenance: row.provenance,
    snapshot_at: row.snapshot_at,
    effective_at: row.effective_at,
    evaluation_status: row.evaluation_status,
    verified_intent: row.verified_intent,
    verified_conditions: row.verified_conditions,
    evidence: row.evidence,
    reviewer_id: row.reviewer_id,
    version: row.version,
    dedupe_key: row.dedupe_key,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface ExportResult {
  markdown: string;
  count: number;
  truncated: boolean;
  total: number;
  filters: ExportFilterInput;
}

/**
 * Render a bounded, escaped Markdown export of the selected/filtered assets.
 * Each row keeps the ORIGINAL question/answer/provenance separate from the
 * Gold-reviewed intent/conditions/evidence, so a correction never hides the
 * original observation or the verified semantics.
 *
 * The compact table is a readable index and may shorten long cells (explicitly
 * marked). The per-case "Full case" sections then carry every stored field
 * verbatim inside a safe fenced JSON block, so nothing is silently lost. If the
 * complete document would exceed EXPORT_BYTES_MAX the render fails with an
 * explicit error instead of dropping content.
 */
export function renderAssetsMarkdown(
  rows: DataAsset[],
  filters: ExportFilterInput,
  generatedAt: string,
  total = rows.length,
): ExportResult {
  const bounded = rows.slice(0, filters.limit);
  const truncated = total > filters.limit;
  const scope = [
    `stage=${filters.stage ?? "all"}`,
    `source_kind=${filters.sourceKind ?? "all"}`,
    `evaluation_status=${filters.evaluationStatus ?? "all"}`,
    `from=${filters.from ?? "unbounded"}`,
    `to=${filters.to ?? "unbounded"}`,
    `asset_ids=${filters.assetIds ? filters.assetIds.length : "all"}`,
    `limit=${filters.limit}`,
  ].join(" · ");

  const lines: string[] = [];
  lines.push("# VNAgent dataset export");
  lines.push("");
  lines.push(`- Generated: ${escapeMarkdownCell(generatedAt)}`);
  lines.push(`- Filter scope: ${escapeMarkdownCell(scope)}`);
  lines.push(`- Rows: ${bounded.length} of ${total}${truncated ? " (truncated to the requested limit)" : ""}`);
  lines.push(`- Summary table cells over ${CELL_MAX} characters are shortened and marked "${SUMMARY_TRUNCATION_MARKER.trim()}"; the complete stored value is in the Full case section below.`);
  lines.push("- Raw/curated/gold are stages of the same asset inventory, not independent assets.");
  lines.push("- Original answer is the captured observation, not verified truth. Gold columns are the reviewer's verified semantics and evidence.");
  lines.push("- Exported answers are evaluation material. Financial figures are point-in-time observations, not timeless truth.");
  lines.push("- This export is not used to train a model.");
  lines.push("");
  if (bounded.length === 0) {
    lines.push("_No assets matched the current filters._");
    return { markdown: lines.join("\n"), count: 0, truncated, total, filters };
  }
  lines.push("| Stage | Source | Original question | Original answer | Executed filters | Expected intent | Verified intent | Verified conditions | Evidence | Provenance / snapshot | Reviewer / version | Evaluation |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of bounded) {
    const provenance = row.provenance ?? {};
    const executed = isRecord(provenance.executedFilters) ? provenance.executedFilters : null;
    lines.push([
      escapeMarkdownCell(row.dataset_stage),
      escapeMarkdownCell(`${row.source_kind}${row.source_designation ? `/${row.source_designation}` : ""}`),
      escapeMarkdownCell(row.question),
      escapeMarkdownCell(row.source_answer),
      jsonCell(executed ?? row.expected_filters),
      jsonCell(row.expected_intent),
      escapeMarkdownCell(row.verified_intent),
      jsonCell(row.verified_conditions),
      jsonCell(row.evidence),
      escapeMarkdownCell(`${jsonCell(provenance)} · ${row.snapshot_at ?? row.created_at}`),
      escapeMarkdownCell(`${row.reviewer_id ?? "unreviewed"} / v${row.version}`),
      escapeMarkdownCell(row.evaluation_status),
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  // Complete, lossless per-case sections. Fenced JSON keeps untrusted data inert
  // (no active images/links) while preserving every stored bounded field.
  lines.push("");
  lines.push("## Full cases");
  lines.push("");
  lines.push("Every stored field of each exported case, verbatim. Nothing here is shortened.");
  lines.push("");
  bounded.forEach((row, index) => {
    lines.push(`### Case ${index + 1} — ${escapeMarkdownCell(row.id)}`);
    lines.push("");
    lines.push(fencedJson(fullCaseRecord(row)));
    lines.push("");
  });

  const markdown = lines.join("\n").replace(/\n+$/, "\n");
  const bytes = new TextEncoder().encode(markdown).length;
  if (bytes > EXPORT_BYTES_MAX) {
    // Explicit failure: never silently drop the content the reviewer must verify.
    throw new DataAdminError("export_too_large", 413);
  }
  return { markdown, count: bounded.length, truncated, total, filters };
}

export interface SourceContributions {
  operational_chat: number;
  contributor: number;
  synthetic: number;
  total: number;
}

export interface OverviewSummary {
  asOf: string;
  assets: { raw: number; curated: number; gold: number; total: number };
  createdToday: number;
  promotionsToday: { rawToCurated: number; curatedToGold: number; demotions: number };
  promotions7d: { rawToCurated: number; curatedToGold: number };
  collected: { today: number; last7d: number; total: number };
  reviewed: { verified: number; pending: number; rejected: number; notEvaluated: number; denominator: number };
  unknown: { abstainedToday: number; abstainedTotal: number; errorsToday: number; errorsTotal: number };
  sourceContributions: SourceContributions;
  scopeNote: string;
}

export interface TimeseriesDay {
  date: string;
  stock: { raw: number; curated: number; gold: number; total: number };
  inflow: { raw: number; curated: number; gold: number };
}

export interface TimeseriesSummary {
  from: string;
  to: string;
  timezone: string;
  days: TimeseriesDay[];
  sourceContributions: SourceContributions;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function group(source: unknown, keys: string[]): Record<string, number> {
  const record = isRecord(source) ? source : {};
  return Object.fromEntries(keys.map((field) => [field, count(record[field])]));
}

/** Normalize the SQL metric payload and strip anything unexpected. */
export function summarizeOverview(metrics: unknown): OverviewSummary {
  if (!isRecord(metrics)) throw new DataAdminError("metrics_unavailable", 503);
  return {
    asOf: typeof metrics.asOf === "string" ? metrics.asOf : "",
    assets: group(metrics.assets, ["raw", "curated", "gold", "total"]) as OverviewSummary["assets"],
    createdToday: count(metrics.createdToday),
    promotionsToday: group(metrics.promotionsToday, ["rawToCurated", "curatedToGold", "demotions"]) as OverviewSummary["promotionsToday"],
    promotions7d: group(metrics.promotions7d, ["rawToCurated", "curatedToGold"]) as OverviewSummary["promotions7d"],
    collected: group(metrics.collected, ["today", "last7d", "total"]) as OverviewSummary["collected"],
    reviewed: group(metrics.reviewed, ["verified", "pending", "rejected", "notEvaluated", "denominator"]) as OverviewSummary["reviewed"],
    unknown: group(metrics.unknown, ["abstainedToday", "abstainedTotal", "errorsToday", "errorsTotal"]) as OverviewSummary["unknown"],
    sourceContributions: group(metrics.sourceContributions, ["operational_chat", "contributor", "synthetic", "total"]) as unknown as SourceContributions,
    scopeNote: typeof metrics.scopeNote === "string" ? metrics.scopeNote : "raw/curated/gold are stages of the same asset inventory, not independent assets",
  };
}

/** Normalize the daily timeseries payload; rejects anything that is not a day series. */
export function summarizeTimeseries(value: unknown): TimeseriesSummary {
  if (!isRecord(value) || !Array.isArray(value.days)) throw new DataAdminError("metrics_unavailable", 503);
  const days: TimeseriesDay[] = value.days.map((day) => {
    if (!isRecord(day)) throw new DataAdminError("metrics_unavailable", 503);
    return {
      date: typeof day.date === "string" ? day.date : "",
      stock: group(day.stock, ["raw", "curated", "gold", "total"]) as TimeseriesDay["stock"],
      inflow: group(day.inflow, ["raw", "curated", "gold"]) as TimeseriesDay["inflow"],
    };
  });
  return {
    from: typeof value.from === "string" ? value.from : "",
    to: typeof value.to === "string" ? value.to : "",
    timezone: typeof value.timezone === "string" ? value.timezone : "Asia/Ho_Chi_Minh",
    days,
    sourceContributions: group(value.sourceContributions, ["operational_chat", "contributor", "synthetic", "total"]) as unknown as SourceContributions,
  };
}
