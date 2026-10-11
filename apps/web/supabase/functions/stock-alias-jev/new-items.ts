// New-item review for purchased names that still have no stock item (2026-10-21).
//
// A name that was bought in the last 60 days, has no stock-material alias and no
// stock kitchen item cannot be received. This module holds the deterministic part
// of the flow (name scoring, union-find grouping, the suggested name / unit) and
// the two extra Jev questions the review needs: a boolean "same item?" and a
// 3-option item class. The transport mirrors stock-catalog-jev/jev.ts exactly
// (one deadline per call, no retry, key only from the server environment) and it
// never sends a user id or a financial amount to the provider.

import { createHash } from "node:crypto";
import {
  createJevCircuit,
  finiteUnit,
  gatewayCost,
  isRecord,
  JEV_BODY_LIMIT,
  JEV_ENDPOINT,
  JEV_MAX_TIMEOUT_MS,
  JEV_MODEL,
  JEV_TIMEOUT_MS,
  JevError,
  normalizeItemName,
  readBoundedBody,
  validateUsage,
  type JevCircuit,
  type JevUsage,
} from "./jev.ts";

/** Bump whenever a question, an option or the criteria below change. */
export const NEW_ITEM_PROMPT_VERSION = "jev-new-item-2026-10-21.1";
/** Two names are grouped by Jev only when it is at least this sure. */
export const NEW_ITEM_SAME_THRESHOLD = 0.8;
/** At or above this deterministic score the names are grouped without asking Jev. */
export const NEW_ITEM_AUTO_MERGE_SCORE = 0.9;
/** Never ask more than four Jev questions at the same time. */
export const NEW_ITEM_MAX_CONCURRENCY = 4;
export const NEW_ITEM_DEFAULT_DAYS = 60;
export const NEW_ITEM_MAX_DAYS = 365;
export const NEW_ITEM_DAY_LIMIT = 600;

export const NEW_ITEM_CLASS_OPTIONS = ["raw_material", "packaging_supply", "non_stock"] as const;
export type NewItemClass = (typeof NEW_ITEM_CLASS_OPTIONS)[number];

export const NEW_ITEM_CLASS_CRITERIA: Record<NewItemClass, string> = {
  raw_material: "Nguyên liệu làm bánh.",
  packaging_supply: "Bao bì, túi, hộp, nhãn, giấy gói, màng bọc, vật tư tiêu hao.",
  non_stock: "Dụng cụ, đồ dùng không theo dõi tồn.",
};

export const NEW_ITEM_CLASS_INSTRUCTIONS = "Nhóm hàng này thuộc loại mặt hàng nào?";

export const NEW_ITEM_SAME_ITEM_INSTRUCTIONS =
  "Hai dòng hóa đơn này có phải cùng một mặt hàng không?";
export const NEW_ITEM_SAME_ITEM_CRITERIA = {
  true: "Cùng một mặt hàng khi chỉ khác cách ghi tên, viết tắt, dấu tiếng Việt, mã nhà cung cấp hoặc đơn vị đo và khi quy đổi thì dùng thay thế nhau trong bếp.",
  false: "KHÁC khi là hai mặt hàng khác nhau dù tên gần giống, ví dụ bột mì 888 và bột mì 999 là KHÁC; hộp 500ml và hộp 1 lít là KHÁC.",
};

/** One (supplier, normalized_name) returned by list_unmatched_purchase_names. */
export interface NewItemUnmatchedRow {
  supplier_id: string | null;
  normalized_name: string;
  raw_name: string;
  raw_unit: string | null;
  receipt_count: number;
  receipt_days: number;
  first_date: string | null;
  last_date: string | null;
  has_exact_candidate: boolean;
  cached_match_item_id: string | null;
  cached_match_line_type: string | null;
}

/** One way of writing a name inside a suggestion group. */
export interface NewItemMember {
  supplier_id: string | null;
  normalized_name: string;
  raw_name: string;
  raw_unit: string | null;
  receipt_count: number;
  last_date: string | null;
  /** Aggregation only; the members jsonb keeps exactly the six fields above. */
  receipt_days?: number;
  first_date?: string | null;
}

/** The exact member shape stored in stock_new_item_suggestions.members. */
export function toStoredMember(member: NewItemMember): NewItemMember {
  return {
    supplier_id: member.supplier_id,
    normalized_name: member.normalized_name,
    raw_name: member.raw_name,
    raw_unit: member.raw_unit,
    receipt_count: member.receipt_count,
    last_date: member.last_date,
  };
}

/** One row written through upsert_new_item_suggestions. */
export interface NewItemSuggestionRow {
  cluster_key: string;
  members: NewItemMember[];
  suggested_name: string;
  suggested_unit: string | null;
  suggested_class: NewItemClass | null;
  class_probability: number | null;
  receipt_count: number;
  receipt_days: number;
  first_date: string | null;
  last_date: string | null;
  is_recurring: boolean;
  prompt_version: string;
}

// ---------------------------------------------------------------------------
// Prompt builders and strict response validation
// ---------------------------------------------------------------------------

export type NewItemJevMode = "same_item" | "item_class";

export interface SameItemJevState {
  a: { name: string; unit: string | null; supplier: string | null };
  b: { name: string; unit: string | null; supplier: string | null };
}

export interface ItemClassJevState {
  group: { names: string[]; units: string[]; receipt_count: number };
}

export function newItemJevQuestions(mode: NewItemJevMode) {
  if (mode === "same_item") {
    return {
      same_item: {
        type: "boolean",
        instructions: NEW_ITEM_SAME_ITEM_INSTRUCTIONS,
        criteria: NEW_ITEM_SAME_ITEM_CRITERIA,
      },
    };
  }
  return {
    item_class: {
      type: "choice",
      instructions: NEW_ITEM_CLASS_INSTRUCTIONS,
      criteria: NEW_ITEM_CLASS_CRITERIA,
    },
  };
}

export interface NewItemJevEvaluation {
  mode: NewItemJevMode;
  /** Probability that the two names are the same item (`same_item` only). */
  same_item: number | null;
  item_class: NewItemClass | null;
  class_probability: number | null;
  usage: JevUsage;
  cost: number | null;
}

export interface NewItemJevEvaluatorParams {
  mode: NewItemJevMode;
  state: unknown;
  signal: AbortSignal;
  deadlineAt?: number;
}

export type NewItemJevEvaluator = (params: NewItemJevEvaluatorParams) => Promise<NewItemJevEvaluation>;

function validateSameItemAnswer(body: Record<string, unknown>): number {
  if (!isRecord(body.answers)) throw new JevError("jev_invalid_response", 502);
  const answers = body.answers;
  if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, "same_item")) {
    throw new JevError("jev_invalid_response", 502);
  }
  const answer = answers.same_item;
  if (!isRecord(answer) || answer.type !== "boolean") throw new JevError("jev_invalid_response", 502);
  for (const key of Object.keys(answer)) {
    if (key !== "type" && key !== "probability" && key !== "confidence") {
      throw new JevError("jev_invalid_response", 502);
    }
  }
  if (Object.hasOwn(answer, "confidence") && !finiteUnit(answer.confidence)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (!finiteUnit(answer.probability)) throw new JevError("jev_invalid_response", 502);
  return answer.probability as number;
}

function validateItemClassAnswer(body: Record<string, unknown>): { itemClass: NewItemClass; probability: number } {
  if (!isRecord(body.answers)) throw new JevError("jev_invalid_response", 502);
  const answers = body.answers;
  if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, "item_class")) {
    throw new JevError("jev_invalid_response", 502);
  }
  const answer = answers.item_class;
  if (!isRecord(answer) || answer.type !== "choice") throw new JevError("jev_invalid_response", 502);
  for (const key of Object.keys(answer)) {
    if (key !== "type" && key !== "choice" && key !== "probabilities" && key !== "confidence") {
      throw new JevError("jev_invalid_response", 502);
    }
  }
  if (Object.hasOwn(answer, "confidence") && !finiteUnit(answer.confidence)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (typeof answer.choice !== "string" || !NEW_ITEM_CLASS_OPTIONS.includes(answer.choice as NewItemClass)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (!isRecord(answer.probabilities)) throw new JevError("jev_invalid_response", 502);
  const probabilities = answer.probabilities;
  if (
    Object.keys(probabilities).length !== NEW_ITEM_CLASS_OPTIONS.length
    || NEW_ITEM_CLASS_OPTIONS.some((option) => !Object.hasOwn(probabilities, option))
  ) {
    throw new JevError("jev_invalid_response", 502);
  }
  let sum = 0;
  for (const option of NEW_ITEM_CLASS_OPTIONS) {
    if (!finiteUnit(probabilities[option])) throw new JevError("jev_invalid_response", 502);
    sum += probabilities[option] as number;
  }
  const itemClass = answer.choice as NewItemClass;
  const chosen = probabilities[itemClass] as number;
  if (NEW_ITEM_CLASS_OPTIONS.some((option) => option !== itemClass && (probabilities[option] as number) >= chosen)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (Math.abs(sum - 1) > 0.02) throw new JevError("jev_invalid_response", 502);
  return { itemClass, probability: chosen };
}

export function validateNewItemJevResponse(mode: NewItemJevMode, body: unknown): NewItemJevEvaluation {
  if (!isRecord(body) || body.model !== JEV_MODEL) throw new JevError("jev_invalid_response", 502);
  const usage = validateUsage(body);
  const cost = gatewayCost(body.providerMetadata);
  if (mode === "same_item") {
    return {
      mode,
      same_item: validateSameItemAnswer(body),
      item_class: null,
      class_probability: null,
      usage,
      cost,
    };
  }
  const result = validateItemClassAnswer(body);
  return {
    mode,
    same_item: null,
    item_class: result.itemClass,
    class_probability: result.probability,
    usage,
    cost,
  };
}

export interface NewItemJevConfig {
  apiKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  circuit?: JevCircuit;
}

export function createNewItemJevEvaluator(config: NewItemJevConfig): NewItemJevEvaluator {
  const apiKey = config.apiKey ?? "";
  if (!apiKey) throw new JevError("jev_unconfigured", 503);
  const fetcher = config.fetcher ?? fetch;
  const circuit = config.circuit ?? createJevCircuit();
  const configuredTimeout = Math.max(1, Math.min(config.timeoutMs ?? JEV_TIMEOUT_MS, JEV_MAX_TIMEOUT_MS));

  return async ({ mode, state, signal, deadlineAt }): Promise<NewItemJevEvaluation> => {
    signal.throwIfAborted();
    if (!circuit.canAttempt()) throw new JevError("jev_circuit_open", 503);
    const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    if (remaining <= 0) throw new JevError("jev_deadline_exceeded", 504);
    const budget = Math.max(1, Math.min(configuredTimeout, remaining));
    const body = JSON.stringify({
      model: JEV_MODEL,
      state,
      questions: newItemJevQuestions(mode),
      providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } },
    });
    const deadline = AbortSignal.timeout(budget);
    const combined = AbortSignal.any([signal, deadline]);
    let response: Response;
    try {
      response = await fetcher(JEV_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: combined,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
      });
    } catch {
      signal.throwIfAborted();
      circuit.recordFailure();
      throw new JevError(deadline.aborted ? "jev_timeout" : "jev_unavailable", deadline.aborted ? 504 : 503);
    }
    if (!response.ok) {
      circuit.recordFailure();
      let detail: string | null = null;
      try {
        detail = `HTTP ${response.status}: ${(await response.text()).replace(/\s+/g, " ").slice(0, 300)}`;
      } catch {
        detail = `HTTP ${response.status}`;
      }
      if (response.status === 429) throw new JevError("jev_rate_limited", 429, detail);
      throw new JevError("jev_http_error", 502, detail);
    }
    const parsed = await readBoundedBody(response, combined, signal, deadline);
    let evaluation: NewItemJevEvaluation;
    try {
      evaluation = validateNewItemJevResponse(mode, parsed);
    } catch (error) {
      circuit.recordFailure();
      throw error;
    }
    circuit.recordSuccess();
    return evaluation;
  };
}

// ---------------------------------------------------------------------------
// Deterministic name matching (mirror of the material-alias SQL helpers)
// ---------------------------------------------------------------------------

const COUNTING_UNITS = new Set([
  "chai", "hop", "thung", "bao", "goi", "qua", "cai", "chiec", "ky",
  "can", "bich", "vi", "mieng",
]);

/** Mirror of public.material_alias_clean_name: drop a [Thùng]/[Carton] prefix. */
export function cleanNewItemName(name: string | null | undefined): string | null {
  const cleaned = (name ?? "").replace(/\[[^\]]*\]/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

/** Mirror of public.material_alias_match_tokens. */
export function meaningfulTokens(name: string | null | undefined): string[] {
  const normalized = normalizeItemName(cleanNewItemName(name));
  const tokens = normalized.split(/\s+/).filter((token) => token !== "");
  const out = new Set<string>();
  for (const token of tokens) {
    if (/^[0-9]+$/.test(token)) continue;
    if (/^[0-9]+([.,][0-9]+)?(kg|g|gr|gram|kilogram|l|lit|ml|cm)$/.test(token)) continue;
    if (/^x[0-9]+$/.test(token)) continue;
    if (token === "x") continue;
    if (COUNTING_UNITS.has(token)) continue;
    out.add(token);
  }
  return [...out].sort();
}

/** Mirror of public.material_alias_tokens_match. */
export function tokensMatch(left: string | null, right: string | null): boolean {
  if (left === null || right === null || left === "" || right === "") return false;
  if (left === right) return true;
  if (left.length < 4 || right.length < 4) return false;
  if (left.slice(0, 4) === right.slice(0, 4)) return true;
  for (let index = 0; index + 4 <= left.length; index += 1) {
    if (right.includes(left.slice(index, index + 4))) return true;
  }
  return false;
}

/** True when the two names share at least one meaningful token. */
export function sharesMeaningfulToken(left: string, right: string): boolean {
  const leftTokens = meaningfulTokens(left);
  const rightTokens = meaningfulTokens(right);
  return leftTokens.some((token) => rightTokens.some((other) => tokensMatch(token, other)));
}

/** Pair score: max of public.material_alias_candidate_score in both directions. */
export function newItemPairScore(left: string, right: string): number {
  return Math.max(scoreOneWay(left, right), scoreOneWay(right, left));
}

function scoreOneWay(raw: string, candidate: string): number {
  const rawNorm = normalizeItemName(cleanNewItemName(raw));
  const candidateNorm = normalizeItemName(cleanNewItemName(candidate));
  if (rawNorm !== "" && rawNorm === candidateNorm) return 1;
  const rawTokens = meaningfulTokens(raw);
  const candidateTokens = meaningfulTokens(candidate);
  if (rawTokens.length > 0 && rawTokens.every((token) => candidateTokens.includes(token))) return 0.9;
  if (rawTokens.length === 0 || candidateTokens.length === 0) return 0;
  const shared = rawTokens.filter((token) => candidateTokens.includes(token)).length;
  return shared / (rawTokens.length + candidateTokens.length - shared);
}

// ---------------------------------------------------------------------------
// Union-find and grouping
// ---------------------------------------------------------------------------

export interface UnionFind {
  find: (key: string) => string;
  union: (left: string, right: string) => void;
  groups: () => string[][];
}

export function makeUnionFind(keys: readonly string[]): UnionFind {
  const parent = new Map<string, string>();
  for (const key of keys) parent.set(key, key);
  const find = (key: string): string => {
    let current = key;
    while (parent.get(current) !== current) {
      const next = parent.get(current);
      if (next === undefined) break;
      parent.set(current, parent.get(next) ?? next);
      current = parent.get(current) ?? next;
    }
    return parent.get(current) ?? current;
  };
  const union = (left: string, right: string): void => {
    if (!parent.has(left) || !parent.has(right)) return;
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
  };
  const groups = (): string[][] => {
    const byRoot = new Map<string, string[]>();
    for (const key of parent.keys()) {
      const root = find(key);
      const bucket = byRoot.get(root);
      if (bucket) bucket.push(key);
      else byRoot.set(root, [key]);
    }
    return [...byRoot.values()].map((bucket) => bucket.sort());
  };
  return { find, union, groups };
}

export interface SameItemPlan {
  /** Deterministic merges: same name after the spec / pack is removed. */
  autoPairs: Array<[string, string]>;
  /** Pairs that still need the Jev boolean question. */
  questionPairs: Array<[string, string]>;
}

const PACK_TOKEN = /^\d+(?:[.,]\d+)?(?:kg|g|gr|gram|l|lit|ml)$/;
const FILLER_TOKENS = new Set(["khoi", "goi", "can", "thung", "hop", "chai"]);

/** Name tokens without "[Thùng]", "ngày N", pack weights / volumes and pack words. */
function identityTokens(name: string): { core: string[]; packs: string[] } {
  const text = name.replace(/^\s*(\[[^\]]*\]\s*)+/, "").replace(/(^|\s)ng[aà]y\s*\d+(?=\s|$)/g, " ");
  const core: string[] = [];
  const packs: string[] = [];
  for (const token of text.split(/\s+/).filter(Boolean)) {
    if (PACK_TOKEN.test(token)) packs.push(token.replace(",", "."));
    else if (!FILLER_TOKENS.has(token)) core.push(token);
  }
  return { core: [...new Set(core)].sort(), packs: [...new Set(packs)].sort() };
}

/**
 * Code may merge two names only when they are the same words once "ngày N",
 * the pack weight and pack words are removed, and they do not state two
 * different pack sizes ("Nhãn Patê 200gr" vs "500gr" still asks Jev; "Ớt" vs
 * "Tương ớt 10g" always asks Jev).
 */
export function sameNameIgnoringPack(left: string, right: string): boolean {
  const a = identityTokens(left);
  const b = identityTokens(right);
  if (a.core.length === 0 || a.core.join(" ") !== b.core.join(" ")) return false;
  if (a.packs.length > 0 && b.packs.length > 0 && a.packs.join(" ") !== b.packs.join(" ")) return false;
  return true;
}

/** Plan the pairs of `names` (cheap pairs merge in code, the rest need Jev). */
export function planSameItemPairs(names: readonly string[]): SameItemPlan {
  const autoPairs: Array<[string, string]> = [];
  const questionPairs: Array<[string, string]> = [];
  const unionFind = makeUnionFind(names);
  const scored: Array<{ left: string; right: string; score: number }> = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const left = names[i];
      const right = names[j];
      if (!sharesMeaningfulToken(left, right)) continue;
      scored.push({ left, right, score: newItemPairScore(left, right) });
    }
  }
  const isAuto = (pair: { left: string; right: string; score: number }) =>
    pair.score >= NEW_ITEM_AUTO_MERGE_SCORE && sameNameIgnoringPack(pair.left, pair.right);
  for (const pair of scored) {
    if (isAuto(pair)) {
      unionFind.union(pair.left, pair.right);
      autoPairs.push([pair.left, pair.right]);
    }
  }
  for (const pair of scored) {
    if (isAuto(pair)) continue;
    if (unionFind.find(pair.left) === unionFind.find(pair.right)) continue;
    questionPairs.push([pair.left, pair.right]);
  }
  return { autoPairs, questionPairs };
}

/** Stable md5 of the sorted, distinct member normalized names joined by '|'. */
export function clusterKey(normalizedNames: readonly string[]): string {
  const canonical = [...new Set(normalizedNames.filter((name) => name !== ""))].sort().join("|");
  return createHash("md5").update(canonical, "utf8").digest("hex");
}

/** Stable cache key for one same-item question: the sorted pair joined by '|'. */
export function sameItemPairKey(left: string, right: string): string {
  return [left, right].sort().join("|");
}

// ---------------------------------------------------------------------------
// Suggested name / unit / group summary (always computed by code, never by Jev)
// ---------------------------------------------------------------------------

const VIETNAMESE_DIACRITICS = /[ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

export function hasVietnameseDiacritics(value: string): boolean {
  return VIETNAMESE_DIACRITICS.test(value);
}

function stripPrefix(value: string): string {
  return value.replace(/^\s*\[(?:\s*thùng|\s*carton|\s*thung)\s*\]\s*/i, "").trim();
}

function stripDaySuffix(value: string): string {
  return value.replace(/\s*(?:ngày|ngay)\s*[0-9]+\s*$/i, "").trim();
}

function pickBilingualPart(value: string): string {
  const parts = value.split("/").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length <= 1) return value.trim();
  const vietnamese = parts.find((part) => hasVietnameseDiacritics(part));
  return (vietnamese ?? parts[0]).trim();
}

function capitalizeFirst(value: string): string {
  if (value === "") return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Turn a raw receipt name into a clean stock item name. */
export function suggestedNameFromRaw(rawName: string): string {
  const withoutPrefix = stripPrefix(rawName);
  const chosen = pickBilingualPart(withoutPrefix);
  const withoutDay = stripDaySuffix(chosen);
  return capitalizeFirst(withoutDay);
}

function memberScore(member: NewItemMember): [number, string, string] {
  return [member.receipt_count, member.last_date ?? "", member.normalized_name];
}

function betterMember(left: NewItemMember, right: NewItemMember): NewItemMember {
  const leftScore = memberScore(left);
  const rightScore = memberScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) {
      return leftScore[index] > rightScore[index] ? left : right;
    }
  }
  return left;
}

/** The name of the member with the most receipts, cleaned by code. */
export function suggestedNameFromMembers(members: readonly NewItemMember[]): string {
  if (members.length === 0) return "";
  let best = members[0];
  for (const member of members.slice(1)) best = betterMember(best, member);
  return suggestedNameFromRaw(best.raw_name);
}

/** Mirror of the SQL unit rule: kg/g/gr -> g, l/ml -> ml, everything else kept. */
export function normalizeSuggestedUnit(unit: string | null | undefined): string | null {
  const value = (unit ?? "").trim().toLowerCase();
  if (value === "") return null;
  if (value === "kg" || value === "g" || value === "gr" || value === "gram" || value === "kilogram") return "g";
  if (value === "l" || value === "lit" || value === "ml") return "ml";
  return (unit ?? "").trim();
}

/** The most common receipt unit, mapped to its base unit. */
export function suggestedUnitFromMembers(members: readonly NewItemMember[]): string | null {
  if (members.length === 0) return null;
  const counts = new Map<string, { label: string; count: number }>();
  for (const member of members) {
    const label = (member.raw_unit ?? "").trim();
    if (label === "") continue;
    const key = label.toLowerCase();
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { label, count: 1 });
  }
  if (counts.size === 0) return null;
  let best: { label: string; count: number } | null = null;
  for (const value of counts.values()) {
    if (best === null || value.count > best.count) best = value;
  }
  return normalizeSuggestedUnit(best?.label ?? null);
}

export interface NewItemGroupSummary {
  suggested_name: string;
  suggested_unit: string | null;
  receipt_count: number;
  receipt_days: number;
  first_date: string | null;
  last_date: string | null;
  is_recurring: boolean;
}

function minDate(values: Array<string | null>): string | null {
  const dates = values.filter((value): value is string => typeof value === "string" && value !== "").sort();
  return dates[0] ?? null;
}

function maxDate(values: Array<string | null>): string | null {
  const dates = values.filter((value): value is string => typeof value === "string" && value !== "").sort();
  return dates.length === 0 ? null : dates[dates.length - 1];
}

/** Aggregate the member rows into the suggestion columns (code only). */
export function summarizeMembers(members: readonly NewItemMember[]): NewItemGroupSummary {
  const receiptCount = members.reduce((total, member) => total + member.receipt_count, 0);
  const receiptDays = members.reduce((total, member) => total + (member.receipt_days ?? 0), 0);
  return {
    suggested_name: suggestedNameFromMembers(members),
    suggested_unit: suggestedUnitFromMembers(members),
    receipt_count: receiptCount,
    receipt_days: receiptDays,
    first_date: minDate(members.map((member) => member.first_date ?? member.last_date)),
    last_date: maxDate(members.map((member) => member.last_date)),
    is_recurring: receiptCount >= 2,
  };
}

// ---------------------------------------------------------------------------
// Bounded parallel Jev run with the shared daily quota
// ---------------------------------------------------------------------------

export interface QuestionRunOptions<T, R> {
  items: readonly T[];
  /** How many Jev calls the shared daily quota still allows. */
  remaining: number;
  concurrency?: number;
  ask: (item: T, index: number) => Promise<R>;
  /** Called right after each successful answer (usage increment + cache write). */
  onAnswered?: (item: T, result: R, index: number) => void | Promise<void>;
  /** Called when a question throws; the failed call frees its concurrency slot. */
  onError?: (item: T, error: unknown, index: number) => void;
}

export interface QuestionRunResult<R> {
  results: Array<R | null>;
  asked: number;
  stopped: boolean;
}

/**
 * Ask at most `concurrency` questions at a time, never more than `remaining`,
 * and call `onAnswered` immediately after every answer so usage is recorded
 * per call (never batched). A failed call is not counted and frees its slot.
 */
export async function runQuestionsWithQuota<T, R>(
  options: QuestionRunOptions<T, R>,
): Promise<QuestionRunResult<R>> {
  const items = options.items;
  const results: Array<R | null> = items.map(() => null);
  const remaining = Math.max(0, Math.floor(options.remaining));
  const concurrency = Math.max(
    1,
    Math.min(
      options.concurrency ?? NEW_ITEM_MAX_CONCURRENCY,
      NEW_ITEM_MAX_CONCURRENCY,
      items.length || 1,
    ),
  );
  let next = 0;
  let asked = 0;
  let inFlight = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (asked + inFlight >= remaining) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      inFlight += 1;
      let result: R;
      try {
        result = await options.ask(items[index], index);
      } catch (error) {
        inFlight -= 1;
        options.onError?.(items[index], error, index);
        continue;
      }
      inFlight -= 1;
      asked += 1;
      results[index] = result;
      await options.onAnswered?.(items[index], result, index);
    }
  });
  await Promise.all(runners);
  return { results, asked, stopped: asked >= remaining && items.length > asked };
}
