/**
 * Pure helpers for stock-material alias learning (Giai đoạn 2).
 *
 * The score below mirrors `public.material_alias_candidate_score` /
 * `public.material_alias_candidates` in
 * supabase/migrations/20261016100000_material_alias_learning.sql so the same
 * test-case table can be shared by the SQL smoke test and the node test. The
 * parsers validate the JSON returned by suggest_material_aliases, the
 * stock-alias-jev edge function and get_material_alias_review.
 */

import { normalizeStockItemName } from "./stock-ledger.ts";
import { normalizeTokens, tokenJaccard } from "./stock-catalog.ts";

export type MaterialAliasStatus = "learning" | "auto" | "disabled";

export const MATERIAL_ALIAS_STATUS_LABELS: Record<MaterialAliasStatus, string> = {
  learning: "Đang học",
  auto: "Tự động",
  disabled: "Đã tắt",
};

export type MaterialAliasAction = "confirm" | "correct" | "undo" | "auto_promoted" | "disabled";

export const MATERIAL_ALIAS_ACTION_LABELS: Record<MaterialAliasAction, string> = {
  confirm: "Xác nhận",
  correct: "Sửa lại",
  undo: "Hoàn tác",
  auto_promoted: "Tự động tin dùng",
  disabled: "Đã tắt",
};

export function materialAliasStatusLabel(value: string | null | undefined): string {
  if (value && value in MATERIAL_ALIAS_STATUS_LABELS) {
    return MATERIAL_ALIAS_STATUS_LABELS[value as MaterialAliasStatus];
  }
  return value ?? "";
}

export function materialAliasActionLabel(value: string | null | undefined): string {
  if (value && value in MATERIAL_ALIAS_ACTION_LABELS) {
    return MATERIAL_ALIAS_ACTION_LABELS[value as MaterialAliasAction];
  }
  return value ?? "";
}

/** The alias may auto-apply after three confirms or two distinct confirmers. */
export function aliasStatusAfterConfirm(
  confirmCount: number,
  distinctConfirmers: number,
): "learning" | "auto" {
  return confirmCount >= 3 || distinctConfirmers >= 2 ? "auto" : "learning";
}

/** Shared scoring test cases: [rawName, candidateName, expectedScore]. */
export const MATERIAL_ALIAS_SCORE_TEST_CASES: ReadonlyArray<
  readonly [string, string, number]
> = [
  ["Tỏi ngày 10", "Tỏi bóc vỏ", 0.9],
  ["Tỏi ngày 10", "Tỏi phi", 0.9],
  ["Bột mì 888", "Bột mì 888 (25kg)", 1],
  ["Bột mì 888", "Gạo tám", 0],
];

/**
 * Mirror of `public.material_alias_candidate_score`: 1.0 for an equal normalized
 * name, 0.9 when the candidate contains every word of the raw name, otherwise the
 * shared token Jaccard.
 */
export function scoreCandidate(rawName: string | null | undefined, candidateName: string | null | undefined): number {
  const raw = normalizeStockItemName(rawName);
  const candidate = normalizeStockItemName(candidateName);
  if (raw !== "" && raw === candidate) return 1;
  const rawTokens = normalizeTokens(rawName);
  const candidateTokens = normalizeTokens(candidateName);
  if (rawTokens.length > 0 && rawTokens.every((token) => candidateTokens.includes(token))) {
    return 0.9;
  }
  return tokenJaccard(rawName, candidateName);
}

export interface ScoredCandidate<T> {
  candidate: T;
  score: number;
}

/**
 * Deterministic candidate order used by the SQL: score desc, then name asc, then
 * id asc. The name tie-break is what makes "Tỏi bóc vỏ" rank above "Tỏi phi"
 * when both contain the raw word "tỏi".
 */
export function rankMaterialAliasCandidates<T extends { id: string; name: string }>(
  rawName: string | null | undefined,
  candidates: readonly T[],
): ScoredCandidate<T>[] {
  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(rawName, candidate.name) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const byName = left.candidate.name.localeCompare(right.candidate.name, "vi");
      if (byName !== 0) return byName;
      return left.candidate.id.localeCompare(right.candidate.id);
    });
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export interface MaterialAliasCandidateRow {
  id: string;
  item_id: string | null;
  sku_id: string | null;
  name: string;
  unit: string;
  score: number;
  reason: string;
}

export interface MaterialAliasAlias {
  alias_id: string;
  status: MaterialAliasStatus;
  item_id: string | null;
  sku_id: string | null;
  item_name: string | null;
  unit: string;
  conversion_factor: number;
  pack_label: string | null;
  confirm_count: number;
  confirmers_count: number;
  jev_disagreed: boolean;
}

export interface MaterialAliasPackGuess {
  pack_size: number | null;
  pack_label: string | null;
  base_qty: number | null;
  base_unit: string | null;
  multiplier: number | null;
}

export interface MaterialAliasSuggestion {
  line_key: string;
  normalized_name: string | null;
  alias: MaterialAliasAlias | null;
  needs_prompt: boolean;
  candidates: MaterialAliasCandidateRow[];
  candidates_hash: string;
  jev: Record<string, unknown> | null;
  pack_guess: MaterialAliasPackGuess | null;
}

export interface MaterialAliasReviewEvent {
  id: string | null;
  action: MaterialAliasAction | null;
  actor_id: string | null;
  created_at: string;
}

export interface MaterialAliasReviewAlias {
  alias_id: string;
  normalized_name: string;
  supplier_id: string | null;
  supplier_name: string | null;
  location: "q7" | "tan_tao";
  item_id: string | null;
  sku_id: string | null;
  item_name: string | null;
  unit: string;
  conversion_factor: number;
  pack_label: string | null;
  status: MaterialAliasStatus;
  confirm_count: number;
  confirmers_count: number;
  jev_disagreed: boolean;
  last_confirmed_at: string | null;
  last_event: MaterialAliasReviewEvent | null;
  applied_lines: number;
}

export interface MaterialAliasReviewSummary {
  auto_count: number;
  learning_count: number;
  disabled_count: number;
  pending_lines: number;
  jev_usage: { usage_date: string; calls: number; cost: number; call_limit: number };
}

export interface MaterialAliasReview {
  days: number;
  aliases: MaterialAliasReviewAlias[];
  summary: MaterialAliasReviewSummary;
}

export interface StockAliasJevAnswer {
  choice: string | null;
  item_id: string | null;
  probability: number;
  confidence: number | null;
  pack: MaterialAliasPackGuess | null;
}

export interface StockAliasJevLineResult {
  line_key: string;
  normalized_name: string | null;
  candidates_hash: string;
  cached: boolean;
  answer: StockAliasJevAnswer;
}

export interface StockAliasJevLinesResponse {
  mode: "lines";
  results: StockAliasJevLineResult[];
  calls: number;
  cost: number;
  cached: number;
  failed: number;
  usage: { date: string; calls: number; limit: number };
  stopped: "daily_limit" | null;
}

export interface StockAliasJevBacklogResponse {
  mode: "backlog";
  candidates: number;
  evaluated: number;
  skipped_existing: number;
  failed: number;
  calls: number;
  cost: number;
  usage: { date: string; calls: number; limit: number };
  stopped: "daily_limit" | null;
}

export type StockAliasJevResponse = StockAliasJevLinesResponse | StockAliasJevBacklogResponse;

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError(`${path} must be a string or null`);
  return value;
}

function asNumber(value: unknown, path: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) throw new TypeError(`${path} must be a finite number`);
  return numeric;
}

function asNullableNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, path);
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
  return value;
}

function asStatus(value: unknown, path: string): MaterialAliasStatus {
  const status = asString(value, path);
  if (status !== "learning" && status !== "auto" && status !== "disabled") {
    throw new TypeError(`${path} is invalid`);
  }
  return status;
}

function asLocation(value: unknown, path: string): "q7" | "tan_tao" {
  const location = asString(value, path);
  if (location !== "q7" && location !== "tan_tao") throw new TypeError(`${path} is invalid`);
  return location;
}

function asAction(value: unknown, path: string): MaterialAliasAction {
  const action = asString(value, path);
  if (!(action in MATERIAL_ALIAS_ACTION_LABELS)) throw new TypeError(`${path} is invalid`);
  return action as MaterialAliasAction;
}

function parsePackGuess(value: unknown, path: string): MaterialAliasPackGuess | null {
  if (value === null || value === undefined) return null;
  const pack = asRecord(value, path);
  return {
    pack_size: asNullableNumber(pack.pack_size, `${path}.pack_size`),
    pack_label: asNullableString(pack.pack_label, `${path}.pack_label`),
    base_qty: asNullableNumber(pack.base_qty, `${path}.base_qty`),
    base_unit: asNullableString(pack.base_unit, `${path}.base_unit`),
    multiplier: asNullableNumber(pack.multiplier, `${path}.multiplier`),
  };
}

function parseCandidateRow(entry: unknown, path: string): MaterialAliasCandidateRow {
  const row = asRecord(entry, path);
  const score = asNumber(row.score, `${path}.score`);
  if (score < 0 || score > 1) throw new TypeError(`${path}.score must be within 0..1`);
  return {
    id: asString(row.id, `${path}.id`),
    item_id: asNullableString(row.item_id, `${path}.item_id`),
    sku_id: asNullableString(row.sku_id, `${path}.sku_id`),
    name: asString(row.name, `${path}.name`),
    unit: asString(row.unit, `${path}.unit`),
    score,
    reason: asString(row.reason, `${path}.reason`),
  };
}

function parseAlias(entry: unknown, path: string): MaterialAliasAlias {
  const alias = asRecord(entry, path);
  return {
    alias_id: asString(alias.alias_id, `${path}.alias_id`),
    status: asStatus(alias.status, `${path}.status`),
    item_id: asNullableString(alias.item_id, `${path}.item_id`),
    sku_id: asNullableString(alias.sku_id, `${path}.sku_id`),
    item_name: asNullableString(alias.item_name, `${path}.item_name`),
    unit: asString(alias.unit, `${path}.unit`),
    conversion_factor: asNumber(alias.conversion_factor, `${path}.conversion_factor`),
    pack_label: asNullableString(alias.pack_label, `${path}.pack_label`),
    confirm_count: asNumber(alias.confirm_count, `${path}.confirm_count`),
    confirmers_count: asNumber(alias.confirmers_count ?? 0, `${path}.confirmers_count`),
    jev_disagreed: asBoolean(alias.jev_disagreed ?? false, `${path}.jev_disagreed`),
  };
}

/** Parse and validate the JSON returned by `suggest_material_aliases`. */
export function parseSuggestMaterialAliases(raw: unknown): MaterialAliasSuggestion[] {
  if (!Array.isArray(raw)) throw new TypeError("materialAliasSuggestions must be an array");
  return raw.map((entry, index) => {
    const path = `suggestions[${index}]`;
    const row = asRecord(entry, path);
    const rawCandidates = row.candidates;
    if (!Array.isArray(rawCandidates)) throw new TypeError(`${path}.candidates must be an array`);
    const jev = row.jev === null || row.jev === undefined ? null : asRecord(row.jev, `${path}.jev`);
    return {
      line_key: asString(row.line_key, `${path}.line_key`),
      normalized_name: asNullableString(row.normalized_name, `${path}.normalized_name`),
      alias: row.alias === null || row.alias === undefined ? null : parseAlias(row.alias, `${path}.alias`),
      needs_prompt: asBoolean(row.needs_prompt, `${path}.needs_prompt`),
      candidates: rawCandidates.map((candidate, candidateIndex) =>
        parseCandidateRow(candidate, `${path}.candidates[${candidateIndex}]`),
      ),
      candidates_hash: asString(row.candidates_hash ?? "", `${path}.candidates_hash`),
      jev,
      pack_guess: parsePackGuess(row.pack_guess, `${path}.pack_guess`),
    };
  });
}

function parseJevAnswer(entry: unknown, path: string): StockAliasJevAnswer {
  const answer = asRecord(entry, path);
  return {
    choice: asNullableString(answer.choice, `${path}.choice`),
    item_id: asNullableString(answer.item_id, `${path}.item_id`),
    probability: asNumber(answer.probability, `${path}.probability`),
    confidence: asNullableNumber(answer.confidence, `${path}.confidence`),
    pack: parsePackGuess(answer.pack, `${path}.pack`),
  };
}

function parseUsage(value: unknown, path: string): { date: string; calls: number; limit: number } {
  const usage = asRecord(value, path);
  return {
    date: asString(usage.date, `${path}.date`),
    calls: asNumber(usage.calls, `${path}.calls`),
    limit: asNumber(usage.limit, `${path}.limit`),
  };
}

function parseStopped(value: unknown, path: string): "daily_limit" | null {
  if (value === null || value === undefined) return null;
  if (value !== "daily_limit") throw new TypeError(`${path} is invalid`);
  return "daily_limit";
}

/** Parse and validate the JSON returned by the `stock-alias-jev` edge function. */
export function parseStockAliasJevResponse(raw: unknown): StockAliasJevResponse {
  const root = asRecord(raw, "stockAliasJev");
  const mode = asString(root.mode, "mode");
  if (mode === "lines") {
    const rawResults = root.results;
    if (!Array.isArray(rawResults)) throw new TypeError("results must be an array");
    return {
      mode: "lines",
      results: rawResults.map((entry, index) => {
        const path = `results[${index}]`;
        const row = asRecord(entry, path);
        return {
          line_key: asString(row.line_key, `${path}.line_key`),
          normalized_name: asNullableString(row.normalized_name, `${path}.normalized_name`),
          candidates_hash: asString(row.candidates_hash ?? "", `${path}.candidates_hash`),
          cached: asBoolean(row.cached, `${path}.cached`),
          answer: parseJevAnswer(row.answer, `${path}.answer`),
        };
      }),
      calls: asNumber(root.calls, "calls"),
      cost: asNumber(root.cost, "cost"),
      cached: asNumber(root.cached ?? 0, "cached"),
      failed: asNumber(root.failed ?? 0, "failed"),
      usage: parseUsage(root.usage, "usage"),
      stopped: parseStopped(root.stopped, "stopped"),
    };
  }
  if (mode === "backlog") {
    return {
      mode: "backlog",
      candidates: asNumber(root.candidates, "candidates"),
      evaluated: asNumber(root.evaluated, "evaluated"),
      skipped_existing: asNumber(root.skipped_existing ?? 0, "skipped_existing"),
      failed: asNumber(root.failed ?? 0, "failed"),
      calls: asNumber(root.calls, "calls"),
      cost: asNumber(root.cost, "cost"),
      usage: parseUsage(root.usage, "usage"),
      stopped: parseStopped(root.stopped, "stopped"),
    };
  }
  throw new TypeError("mode must be 'lines' or 'backlog'");
}

/** Parse and validate the JSON returned by `get_material_alias_review`. */
export function parseMaterialAliasReview(raw: unknown): MaterialAliasReview {
  const root = asRecord(raw, "materialAliasReview");
  const rawAliases = root.aliases;
  if (!Array.isArray(rawAliases)) throw new TypeError("aliases must be an array");
  const aliases = rawAliases.map((entry, index): MaterialAliasReviewAlias => {
    const path = `aliases[${index}]`;
    const row = asRecord(entry, path);
    let lastEvent: MaterialAliasReviewEvent | null = null;
    if (row.last_event !== null && row.last_event !== undefined) {
      const event = asRecord(row.last_event, `${path}.last_event`);
      lastEvent = {
        id: asNullableString(event.id, `${path}.last_event.id`),
        action: event.action === null || event.action === undefined ? null : asAction(event.action, `${path}.last_event.action`),
        actor_id: asNullableString(event.actor_id, `${path}.last_event.actor_id`),
        created_at: asString(event.created_at, `${path}.last_event.created_at`),
      };
    }
    return {
      alias_id: asString(row.alias_id, `${path}.alias_id`),
      normalized_name: asString(row.normalized_name, `${path}.normalized_name`),
      supplier_id: asNullableString(row.supplier_id, `${path}.supplier_id`),
      supplier_name: asNullableString(row.supplier_name, `${path}.supplier_name`),
      location: asLocation(row.location, `${path}.location`),
      item_id: asNullableString(row.item_id, `${path}.item_id`),
      sku_id: asNullableString(row.sku_id, `${path}.sku_id`),
      item_name: asNullableString(row.item_name, `${path}.item_name`),
      unit: asString(row.unit, `${path}.unit`),
      conversion_factor: asNumber(row.conversion_factor, `${path}.conversion_factor`),
      pack_label: asNullableString(row.pack_label, `${path}.pack_label`),
      status: asStatus(row.status, `${path}.status`),
      confirm_count: asNumber(row.confirm_count, `${path}.confirm_count`),
      confirmers_count: asNumber(row.confirmers_count ?? 0, `${path}.confirmers_count`),
      jev_disagreed: asBoolean(row.jev_disagreed ?? false, `${path}.jev_disagreed`),
      last_confirmed_at: asNullableString(row.last_confirmed_at, `${path}.last_confirmed_at`),
      last_event: lastEvent,
      applied_lines: asNumber(row.applied_lines ?? 0, `${path}.applied_lines`),
    };
  });

  const summary = asRecord(root.summary, "summary");
  const usage = asRecord(summary.jev_usage, "summary.jev_usage");
  return {
    days: asNumber(root.days ?? 7, "days"),
    aliases,
    summary: {
      auto_count: asNumber(summary.auto_count ?? 0, "summary.auto_count"),
      learning_count: asNumber(summary.learning_count ?? 0, "summary.learning_count"),
      disabled_count: asNumber(summary.disabled_count ?? 0, "summary.disabled_count"),
      pending_lines: asNumber(summary.pending_lines ?? 0, "summary.pending_lines"),
      jev_usage: {
        usage_date: asString(usage.usage_date, "summary.jev_usage.usage_date"),
        calls: asNumber(usage.calls, "summary.jev_usage.calls"),
        cost: asNumber(usage.cost, "summary.jev_usage.cost"),
        call_limit: asNumber(usage.call_limit, "summary.jev_usage.call_limit"),
      },
    },
  };
}
