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

/** Giai đoạn 3: a line is either posted to stock or explicitly not stock. */
export type MaterialAliasLineClass = "stock" | "non_stock";

export const MATERIAL_ALIAS_LINE_CLASS_LABELS: Record<MaterialAliasLineClass, string> = {
  stock: "Nhập kho",
  non_stock: "Không nhập kho",
};

export function materialAliasLineClassLabel(value: string | null | undefined): string {
  if (value && value in MATERIAL_ALIAS_LINE_CLASS_LABELS) {
    return MATERIAL_ALIAS_LINE_CLASS_LABELS[value as MaterialAliasLineClass];
  }
  return value ?? "";
}

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

// ---------------------------------------------------------------------------
// Fixed non-stock rule (mirror of public.stock_line_auto_non_stock)
// ---------------------------------------------------------------------------

export type MaterialAliasAutoNonStockRuleReason = "vat" | "fee" | "service";
export type MaterialAliasAutoNonStockReason = MaterialAliasAutoNonStockRuleReason | "jev";
export type MaterialAliasAutoNonStockSource = "rule" | "jev";
/** Giai đoạn 4: second Jev choice, sent for every ranked line. */
export type MaterialAliasAutoNonStockLineType = "goods" | "non_goods";

export interface MaterialAliasAutoNonStock {
  reason: MaterialAliasAutoNonStockReason;
  source: MaterialAliasAutoNonStockSource;
  /** Present for a Jev answer (line_type_probability). */
  probability?: number;
}

/**
 * Shared case table, byte-for-byte the same as the SQL comment table in
 * 20261019100000_purchase_must_stock.sql, the edge mirror in
 * supabase/functions/stock-alias-jev/jev.ts and the smoke test.
 */
export const STOCK_LINE_AUTO_NON_STOCK_TEST_CASES: ReadonlyArray<
  readonly [string, MaterialAliasAutoNonStockRuleReason | null]
> = [
  ["Thuế VAT 8%", "vat"],
  ["VAT", "vat"],
  ["Thuế GTGT", "vat"],
  ["Phí vận chuyển", "fee"],
  ["Phụ phí giao hàng", "fee"],
  ["Cước ship nội thành", "fee"],
  ["Vận chuyển hàng", "fee"],
  ["Xử lý côn trùng", "service"],
  ["Phí phân tích mẫu", "service"],
  ["Thuê máy", "service"],
  ["Tỏi phi", null],
  ["Bánh mì lớn 17", null],
  ["Phô mai Dairymont", null],
  ["Ship hàng", "fee"],
  ["Cước Rửa Chén TBP x 4 Miếng", null],
  ["Cước điện thoại_0966998998", "fee"],
  ["Thuê nhà Q.7 T9/26", "service"],
];

const AUTO_NON_STOCK_VAT_TOKENS = [" vat ", " thue gtgt ", " thue vat ", " gtgt "];
const AUTO_NON_STOCK_FEE_TOKENS = [
  " phi van chuyen ",
  " phi giao hang ",
  " phu phi ",
  " phi ship ",
  " cuoc van chuyen ",
  " cuoc ship ",
  " cuoc giao hang ",
  " cuoc dien thoai",
  " cuoc dau so",
  " cuoc internet",
  " van chuyen ",
  " giao hang ",
  " ship ",
];
const AUTO_NON_STOCK_SERVICE_TOKENS = [
  " dich vu ",
  " xu ly con trung ",
  " phan tich mau ",
  " thue may ",
  " bao tri ",
  " sua chua ",
  " chiet khau ",
];

/**
 * Mirror of `public.stock_line_auto_non_stock`: a line whose normalized name
 * contains one of the fixed VAT / fee / service phrases is non-stock. Matching
 * is token based, so the single token "phi" never matches ("Tỏi phi" is stock).
 */
export function autoNonStockReason(
  name: string | null | undefined,
): MaterialAliasAutoNonStockRuleReason | null {
  const normalized = ` ${normalizeStockItemName(name)} `;
  // Rent is a service even though it starts with "thue" and carries a month number.
  if (normalized.startsWith(" thue nha ") || normalized.includes(" thue mat bang ") || normalized.includes(" tien nha ")) {
    return "service";
  }
  if (
    AUTO_NON_STOCK_VAT_TOKENS.some((token) => normalized.includes(token))
    || (normalized.startsWith(" thue ") && (/[0-9]/.test(normalized) || normalized.includes("vat")))
  ) {
    return "vat";
  }
  if (AUTO_NON_STOCK_FEE_TOKENS.some((token) => normalized.includes(token))) return "fee";
  if (AUTO_NON_STOCK_SERVICE_TOKENS.some((token) => normalized.includes(token))) return "service";
  return null;
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
  line_class: MaterialAliasLineClass;
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
  /** Giai đoạn 4: set when the fixed rule or a confident Jev answer says non-stock. */
  auto_non_stock: MaterialAliasAutoNonStock | null;
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
  line_class: MaterialAliasLineClass;
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
  /** Giai đoạn 4: the second Jev answer (null for a pre-line_type cache row). */
  line_type: MaterialAliasAutoNonStockLineType | null;
  line_type_probability: number | null;
  confidence: number | null;
  pack: MaterialAliasPackGuess | null;
  /** 'exact' when the code matched a normalized name, otherwise 'jev' | 'rule' | 'none'. */
  source: string | null;
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
  /** Names ranked in this batch (deterministic exact + Jev). */
  processed: number;
  /** Names with candidates that still need ranking after this batch. */
  remaining: number;
  batch_size: number;
  evaluated: number;
  skipped_existing: number;
  failed: number;
  calls: number;
  cost: number;
  usage: { date: string; calls: number; limit: number };
  stopped: "daily_limit" | null;
}

export type StockAliasJevResponse =
  | StockAliasJevLinesResponse
  | StockAliasJevBacklogResponse
  | StockAliasJevNewItemsResponse;

export interface StockAliasJevNewItemsResponse {
  mode: "new_items";
  /** Confirmed receipt names without an item in the last `days` days. */
  candidates: number;
  names: number;
  groups: number;
  processed: number;
  remaining: number;
  batch_size: number;
  days: number;
  auto_merged: number;
  same_item_asked: number;
  class_asked: number;
  failed: number;
  calls: number;
  cost: number;
  usage: { date: string; calls: number; limit: number };
  stopped: "daily_limit" | null;
}

export interface MaterialAliasBacklogReviewCandidate {
  item_id: string | null;
  sku_id: string | null;
  name: string;
  unit: string;
  score: number;
  reason: string;
}

/** One pending backlog name with its top candidate and latest Jev suggestion. */
export interface MaterialAliasBacklogReviewRow {
  normalized_name: string;
  raw_name: string;
  line_count: number;
  supplier_id: string | null;
  supplier_name: string | null;
  last_receipt_date: string | null;
  top_candidate: MaterialAliasBacklogReviewCandidate | null;
  jev_item_id: string | null;
  jev_item_name: string | null;
  jev_unit: string | null;
  jev_probability: number | null;
  jev_line_type: MaterialAliasAutoNonStockLineType | null;
  jev_source: string | null;
  /** Tân Tạo: the Jev pick is a finished-goods SKU, not a shared NVL item. */
  jev_is_sku: boolean;
  /** The unit printed on the receipts for this pending name (null if blank). */
  raw_unit: string | null;
  /** Distinct receipt units for this name, by line_count desc. */
  raw_units: Array<{ unit: string; line_count: number }>;
}

export interface CreateStockMaterialItemResult {
  item_id: string;
  created: boolean;
}

// ---------------------------------------------------------------------------
// New-item review (2026-10-21): grouped purchased names without a stock item
// ---------------------------------------------------------------------------

export type NewItemSuggestionClass = "raw_material" | "packaging_supply" | "non_stock";
export type NewItemSuggestionStatus = "pending" | "applied" | "dismissed";

export interface NewItemSuggestionMember {
  supplier_id: string | null;
  normalized_name: string;
  raw_name: string;
  raw_unit: string | null;
  receipt_count: number;
  last_date: string | null;
}

export interface NewItemSuggestion {
  id: string;
  location: "q7" | "tan_tao";
  cluster_key: string;
  members: NewItemSuggestionMember[];
  suggested_name: string;
  suggested_unit: string | null;
  suggested_class: NewItemSuggestionClass | null;
  class_probability: number | null;
  receipt_count: number;
  receipt_days: number;
  first_date: string | null;
  last_date: string | null;
  is_recurring: boolean;
  status: NewItemSuggestionStatus;
  item_id: string | null;
  prompt_version: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewItemDecisionResult {
  status: string;
  suggestion_id: string | null;
  item_id: string | null;
  item_class: string | null;
  members_applied: number;
}

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

function asLineClass(value: unknown, path: string): MaterialAliasLineClass {
  // Aliases created before Giai đoạn 3 have no line_class and are stock.
  if (value === null || value === undefined) return "stock";
  const lineClass = asString(value, path);
  if (lineClass !== "stock" && lineClass !== "non_stock") throw new TypeError(`${path} is invalid`);
  return lineClass;
}

function asLineType(value: unknown, path: string): MaterialAliasAutoNonStockLineType {
  const lineType = asString(value, path);
  if (lineType !== "goods" && lineType !== "non_goods") throw new TypeError(`${path} is invalid`);
  return lineType;
}

function parseNullableLineType(value: unknown, path: string): MaterialAliasAutoNonStockLineType | null {
  if (value === null || value === undefined) return null;
  return asLineType(value, path);
}

/**
 * Parse `auto_non_stock`: null for a stock line, otherwise the fixed-rule
 * reason (`vat` | `fee` | `service`, source `rule`) or the confident Jev answer
 * (`jev`, source `jev`, with its probability).
 */
function parseAutoNonStock(value: unknown, path: string): MaterialAliasAutoNonStock | null {
  if (value === null || value === undefined) return null;
  const row = asRecord(value, path);
  const reason = asString(row.reason, `${path}.reason`);
  const source = asString(row.source, `${path}.source`);
  if (reason !== "vat" && reason !== "fee" && reason !== "service" && reason !== "jev") {
    throw new TypeError(`${path}.reason is invalid`);
  }
  if (source !== "rule" && source !== "jev") throw new TypeError(`${path}.source is invalid`);
  if ((source === "rule") !== (reason !== "jev")) {
    throw new TypeError(`${path}.reason and ${path}.source disagree`);
  }
  const probability = row.probability === null || row.probability === undefined
    ? undefined
    : asNumber(row.probability, `${path}.probability`);
  return probability === undefined ? { reason, source } : { reason, source, probability };
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

export type MaterialAliasCandidateKind = "nvl" | "sku";

/**
 * Tân Tạo now offers both shared NVL kitchen items and finished-goods SKUs. A
 * candidate is a SKU when sku_id is set, or when the SQL reason carries the
 * '+sku' suffix the shared catalog adds for finished products.
 */
export function materialAliasCandidateKind(
  candidate: Pick<MaterialAliasCandidateRow, "sku_id" | "reason">,
): MaterialAliasCandidateKind {
  const isSku =
    (candidate.sku_id !== null && candidate.sku_id !== undefined)
    || (candidate.reason ?? "").split("+").includes("sku");
  return isSku ? "sku" : "nvl";
}

function parseAlias(entry: unknown, path: string): MaterialAliasAlias {
  const alias = asRecord(entry, path);
  return {
    alias_id: asString(alias.alias_id, `${path}.alias_id`),
    status: asStatus(alias.status, `${path}.status`),
    line_class: asLineClass(alias.line_class, `${path}.line_class`),
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
      auto_non_stock: parseAutoNonStock(row.auto_non_stock, `${path}.auto_non_stock`),
    };
  });
}

function parseJevAnswer(entry: unknown, path: string): StockAliasJevAnswer {
  const answer = asRecord(entry, path);
  return {
    choice: asNullableString(answer.choice, `${path}.choice`),
    item_id: asNullableString(answer.item_id, `${path}.item_id`),
    probability: asNumber(answer.probability, `${path}.probability`),
    line_type: parseNullableLineType(answer.line_type, `${path}.line_type`),
    line_type_probability: asNullableNumber(answer.line_type_probability, `${path}.line_type_probability`),
    confidence: asNullableNumber(answer.confidence, `${path}.confidence`),
    pack: parsePackGuess(answer.pack, `${path}.pack`),
    source: asNullableString(answer.source, `${path}.source`),
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
      processed: asNumber(root.processed ?? root.evaluated ?? 0, "processed"),
      remaining: asNumber(root.remaining ?? 0, "remaining"),
      batch_size: asNumber(root.batch_size ?? root.evaluated ?? 0, "batch_size"),
      evaluated: asNumber(root.evaluated, "evaluated"),
      skipped_existing: asNumber(root.skipped_existing ?? 0, "skipped_existing"),
      failed: asNumber(root.failed ?? 0, "failed"),
      calls: asNumber(root.calls, "calls"),
      cost: asNumber(root.cost, "cost"),
      usage: parseUsage(root.usage, "usage"),
      stopped: parseStopped(root.stopped, "stopped"),
    };
  }
  if (mode === "new_items") {
    return {
      mode: "new_items",
      candidates: asNumber(root.candidates ?? 0, "candidates"),
      names: asNumber(root.names ?? 0, "names"),
      groups: asNumber(root.groups ?? 0, "groups"),
      processed: asNumber(root.processed ?? 0, "processed"),
      remaining: asNumber(root.remaining ?? 0, "remaining"),
      batch_size: asNumber(root.batch_size ?? 0, "batch_size"),
      days: asNumber(root.days ?? 60, "days"),
      auto_merged: asNumber(root.auto_merged ?? 0, "auto_merged"),
      same_item_asked: asNumber(root.same_item_asked ?? 0, "same_item_asked"),
      class_asked: asNumber(root.class_asked ?? 0, "class_asked"),
      failed: asNumber(root.failed ?? 0, "failed"),
      calls: asNumber(root.calls, "calls"),
      cost: asNumber(root.cost, "cost"),
      usage: parseUsage(root.usage, "usage"),
      stopped: parseStopped(root.stopped, "stopped"),
    };
  }
  throw new TypeError("mode must be 'lines', 'backlog' or 'new_items'");
}

function parseNewItemSuggestionClass(value: unknown, path: string): NewItemSuggestionClass | null {
  if (value === null || value === undefined) return null;
  const itemClass = asString(value, path);
  if (itemClass !== "raw_material" && itemClass !== "packaging_supply" && itemClass !== "non_stock") {
    throw new TypeError(`${path} is invalid`);
  }
  return itemClass;
}

function parseNewItemSuggestionMember(entry: unknown, path: string): NewItemSuggestionMember {
  const row = asRecord(entry, path);
  return {
    supplier_id: asNullableString(row.supplier_id, `${path}.supplier_id`),
    normalized_name: asString(row.normalized_name, `${path}.normalized_name`),
    raw_name: asString(row.raw_name, `${path}.raw_name`),
    raw_unit: asNullableString(row.raw_unit, `${path}.raw_unit`),
    receipt_count: asNumber(row.receipt_count ?? 0, `${path}.receipt_count`),
    last_date: asNullableString(row.last_date, `${path}.last_date`),
  };
}

/** Parse and validate the JSON returned by `get_new_item_suggestions`. */
export function parseNewItemSuggestions(raw: unknown): NewItemSuggestion[] {
  if (!Array.isArray(raw)) throw new TypeError("newItemSuggestions must be an array");
  return raw.map((entry, index) => {
    const path = `newItemSuggestions[${index}]`;
    const row = asRecord(entry, path);
    const status = asString(row.status ?? "pending", `${path}.status`);
    if (status !== "pending" && status !== "applied" && status !== "dismissed") {
      throw new TypeError(`${path}.status is invalid`);
    }
    if (!Array.isArray(row.members)) throw new TypeError(`${path}.members must be an array`);
    return {
      id: asString(row.id, `${path}.id`),
      location: asLocation(row.location, `${path}.location`),
      cluster_key: asString(row.cluster_key, `${path}.cluster_key`),
      members: row.members.map((member, memberIndex) =>
        parseNewItemSuggestionMember(member, `${path}.members[${memberIndex}]`)),
      suggested_name: asString(row.suggested_name, `${path}.suggested_name`),
      suggested_unit: asNullableString(row.suggested_unit, `${path}.suggested_unit`),
      suggested_class: parseNewItemSuggestionClass(row.suggested_class, `${path}.suggested_class`),
      class_probability: asNullableNumber(row.class_probability, `${path}.class_probability`),
      receipt_count: asNumber(row.receipt_count ?? 0, `${path}.receipt_count`),
      receipt_days: asNumber(row.receipt_days ?? 0, `${path}.receipt_days`),
      first_date: asNullableString(row.first_date, `${path}.first_date`),
      last_date: asNullableString(row.last_date, `${path}.last_date`),
      is_recurring: asBoolean(row.is_recurring ?? false, `${path}.is_recurring`),
      status,
      item_id: asNullableString(row.item_id, `${path}.item_id`),
      prompt_version: asNullableString(row.prompt_version, `${path}.prompt_version`),
      decided_by: asNullableString(row.decided_by, `${path}.decided_by`),
      decided_at: asNullableString(row.decided_at, `${path}.decided_at`),
      created_at: asString(row.created_at, `${path}.created_at`),
      updated_at: asString(row.updated_at, `${path}.updated_at`),
    };
  });
}

/** Parse and validate the JSON returned by apply / dismiss new-item suggestion. */
export function parseNewItemDecisionResult(raw: unknown): NewItemDecisionResult {
  const root = asRecord(raw, "newItemDecision");
  return {
    status: asString(root.status, "newItemDecision.status"),
    suggestion_id: asNullableString(root.suggestion_id, "newItemDecision.suggestion_id"),
    item_id: asNullableString(root.item_id, "newItemDecision.item_id"),
    item_class: parseNewItemSuggestionClass(root.item_class, "newItemDecision.item_class"),
    members_applied: asNumber(root.members_applied ?? 0, "newItemDecision.members_applied"),
  };
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
      line_class: asLineClass(row.line_class, `${path}.line_class`),
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

/** Parse and validate the JSON returned by `get_material_alias_backlog_review`. */
function parseBacklogRawUnits(
  value: unknown,
  path: string,
): Array<{ unit: string; line_count: number }> {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((entry, index) => {
    const unit = asRecord(entry, `${path}[${index}]`);
    return {
      unit: asNullableString(unit.unit, `${path}[${index}].unit`) ?? "",
      line_count: asNumber(unit.line_count ?? 0, `${path}[${index}].line_count`),
    };
  });
}

export function parseMaterialAliasBacklogReview(raw: unknown): MaterialAliasBacklogReviewRow[] {
  if (!Array.isArray(raw)) throw new TypeError("materialAliasBacklogReview must be an array");
  return raw.map((entry, index) => {
    const path = `backlogReview[${index}]`;
    const row = asRecord(entry, path);
    let topCandidate: MaterialAliasBacklogReviewCandidate | null = null;
    if (row.top_candidate !== null && row.top_candidate !== undefined) {
      const candidate = asRecord(row.top_candidate, `${path}.top_candidate`);
      topCandidate = {
        item_id: asNullableString(candidate.item_id, `${path}.top_candidate.item_id`),
        sku_id: asNullableString(candidate.sku_id, `${path}.top_candidate.sku_id`),
        name: asString(candidate.name, `${path}.top_candidate.name`),
        unit: asString(candidate.unit, `${path}.top_candidate.unit`),
        score: asNumber(candidate.score, `${path}.top_candidate.score`),
        reason: asString(candidate.reason, `${path}.top_candidate.reason`),
      };
    }
    return {
      normalized_name: asString(row.normalized_name, `${path}.normalized_name`),
      raw_name: asString(row.raw_name, `${path}.raw_name`),
      line_count: asNumber(row.line_count ?? 0, `${path}.line_count`),
      supplier_id: asNullableString(row.supplier_id, `${path}.supplier_id`),
      supplier_name: asNullableString(row.supplier_name, `${path}.supplier_name`),
      last_receipt_date: asNullableString(row.last_receipt_date, `${path}.last_receipt_date`),
      top_candidate: topCandidate,
      jev_item_id: asNullableString(row.jev_item_id, `${path}.jev_item_id`),
      jev_item_name: asNullableString(row.jev_item_name, `${path}.jev_item_name`),
      jev_unit: asNullableString(row.jev_unit, `${path}.jev_unit`),
      jev_probability: asNullableNumber(row.jev_probability, `${path}.jev_probability`),
      jev_line_type: parseNullableLineType(row.jev_line_type, `${path}.jev_line_type`),
      jev_source: asNullableString(row.jev_source, `${path}.jev_source`),
      jev_is_sku: row.jev_is_sku === true,
      raw_unit: asNullableString(row.raw_unit, `${path}.raw_unit`),
      raw_units: parseBacklogRawUnits(row.raw_units, `${path}.raw_units`),
    };
  });
}

/** Parse and validate the JSON returned by `create_stock_material_item`. */
export function parseCreateStockMaterialItem(raw: unknown): CreateStockMaterialItemResult {
  const root = asRecord(raw, "createStockMaterialItem");
  return {
    item_id: asString(root.item_id, "createStockMaterialItem.item_id"),
    created: asBoolean(root.created, "createStockMaterialItem.created"),
  };
}
