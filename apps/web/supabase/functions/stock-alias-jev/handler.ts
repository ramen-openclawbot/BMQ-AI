// HTTP shell for the stock-material alias Jev ranking (Giai đoạn 2).
//
// It authenticates the caller server-side, enforces a body budget, enforces the
// shared daily Jev quota stored in stock_catalog_jev_usage and writes only the
// material_alias_jev_cache. For `lines` it ranks the candidate list code built
// for each receipt line; for `backlog` (Q7 editor only) it ranks the confirmed
// receipt names that still have no alias. Jev never selects its own candidates
// and no alias, PO, receipt, payment or allocation is written here.

import {
  autoNonStockReason,
  candidatesHash,
  isPackagingLabelName,
  LINE_TYPE_GOODS,
  LINE_TYPE_NON_GOODS,
  NONE_OPTION,
  normalizeItemName,
  parsePackFromName,
  JevError,
  JEV_PROMPT_VERSION,
  type JevEvaluator,
  type JevLineType,
  type JevMatchEvaluation,
  type MaterialAliasCandidate,
} from "./jev.ts";
import {
  clusterKey,
  makeUnionFind,
  NEW_ITEM_CLASS_OPTIONS,
  NEW_ITEM_MAX_CONCURRENCY,
  NEW_ITEM_PROMPT_VERSION,
  NEW_ITEM_SAME_THRESHOLD,
  planSameItemPairs,
  runQuestionsWithQuota,
  sameItemPairKey,
  summarizeMembers,
  toStoredMember,
  type NewItemClass,
  type NewItemJevEvaluation,
  type NewItemJevEvaluator,
  type NewItemMember,
  type NewItemSuggestionRow,
  type NewItemUnmatchedRow,
} from "./new-items.ts";
import { getCorsHeaders } from "../_shared/cors.ts";

export const MATERIAL_ALIAS_REQUEST_BODY_LIMIT = 32_768;
export const MATERIAL_ALIAS_REQUEST_BUDGET_MS = 110_000;
export const MATERIAL_ALIAS_DAILY_CALL_LIMIT = 600;
export const MATERIAL_ALIAS_BACKLOG_LIMIT = 200;
export const MATERIAL_ALIAS_MAX_CANDIDATES = 150;
export const MATERIAL_ALIAS_BACKLOG_BATCH_DEFAULT = 10;
export const MATERIAL_ALIAS_BACKLOG_BATCH_MAX = 15;
export const MATERIAL_ALIAS_NEW_ITEM_DAYS_DEFAULT = 60;
export const MATERIAL_ALIAS_NEW_ITEM_DAYS_MAX = 365;
export const MATERIAL_ALIAS_NEW_ITEM_BATCH_DEFAULT = 10;
export const MATERIAL_ALIAS_NEW_ITEM_BATCH_MAX = 20;

export type MaterialAliasMode = "lines" | "backlog" | "new_items";

export class MaterialAliasError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "MaterialAliasError";
  }
}

export interface MaterialAliasUsage {
  usage_date: string;
  calls: number;
  cost: number;
  call_limit: number;
}

export interface MaterialAliasCacheKey {
  supplierId: string | null;
  normalizedName: string;
  location: string;
  promptVersion: string;
  candidatesHash: string;
}

export interface CachedJevAnswer {
  choice: string | null;
  item_id: string | null;
  probability: number;
  /** Second Jev answer: goods to receive or a non-goods VAT / fee / service line. */
  line_type: JevLineType | null;
  line_type_probability: number | null;
  confidence: number | null;
  pack: { label: string; base_qty: number | null; base_unit: string | null; multiplier: number } | null;
  /** Where the answer came from: 'exact' | 'jev' | 'rule' | 'none'. */
  source: string | null;
}

export interface MaterialAliasBacklogRow {
  supplier_id: string | null;
  normalized_name: string;
  raw_name: string;
  raw_unit: string | null;
  location: string;
}

export interface MaterialAliasLineInput {
  line_key: string;
  raw_name: string;
  raw_unit: string | null;
  candidates: MaterialAliasCandidate[];
}

export interface MaterialAliasHandlerDeps {
  killSwitch: () => boolean;
  evaluator: () => JevEvaluator | null;
  authenticate: (request: Request, signal: AbortSignal) => Promise<{ userId: string; q7Editor: boolean }>;
  getCache: (key: MaterialAliasCacheKey) => Promise<{ answer: CachedJevAnswer; cost: number | null } | null>;
  putCache: (key: MaterialAliasCacheKey, answer: CachedJevAnswer, cost: number | null) => Promise<void>;
  getUsage: (usageDate: string) => Promise<MaterialAliasUsage>;
  /** Atomically add one successful Jev call immediately after it happens. */
  incrementUsage: (usageDate: string, calls: number, cost: number) => Promise<void>;
  listBacklog: (location: string, limit: number) => Promise<MaterialAliasBacklogRow[]>;
  candidatesFor: (name: string, location: string, limit: number) => Promise<MaterialAliasCandidate[]>;
  /**
   * Display-name overrides from public.stock_name_corrections for a batch of
   * normalized names. Optional: without it, or when the read fails, the raw
   * machine name is used and the run still succeeds.
   */
  getStockNameCorrections?: (normalizedNames: string[]) => Promise<Map<string, string>>;
  /** Whole live catalog of a location, appended after the token candidates. */
  catalogOptions?: (location: string) => Promise<MaterialAliasCandidate[]>;
  /** new_items mode: confirmed receipt names without an item / alias. */
  listUnmatched?: (location: string, days: number) => Promise<NewItemUnmatchedRow[]>;
  upsertNewItemSuggestions?: (location: string, rows: NewItemSuggestionRow[]) => Promise<void>;
  /** Raw answer cache used by the same_item / item_class questions. */
  getRawCache?: (key: MaterialAliasCacheKey) => Promise<{ answer: Record<string, unknown>; cost: number | null } | null>;
  putRawCache?: (key: MaterialAliasCacheKey, answer: Record<string, unknown>, cost: number | null) => Promise<void>;
  /** Batched reads: one DB round-trip per phase instead of one per row. */
  getCacheMany?: (keys: MaterialAliasCacheKey[]) => Promise<Array<{ answer: CachedJevAnswer; cost: number | null } | null>>;
  getRawCacheMany?: (keys: MaterialAliasCacheKey[]) => Promise<Array<{ answer: Record<string, unknown>; cost: number | null } | null>>;
  newItemEvaluator?: () => NewItemJevEvaluator | null;
  /** Background new-item run bookkeeping (stock_new_item_runs). */
  getActiveNewItemRun?: (location: string) => Promise<NewItemRunRow | null>;
  createNewItemRun?: (location: string, startedBy: string | null) => Promise<NewItemRunRow>;
  updateNewItemRun?: (runId: string, patch: Partial<NewItemRunRow> & { finished_at?: string | null }) => Promise<void>;
  /** EdgeRuntime.waitUntil; a test can await the background promise directly. */
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => Date;
  audit?: (event: Record<string, unknown>) => void;
}

/** One row of public.stock_new_item_runs. */
export interface NewItemRunRow {
  id: string;
  location: string;
  status: "queued" | "running" | "paused" | "done" | "failed";
  processed: number;
  remaining: number;
  calls: number;
  groups: number;
  last_error: string | null;
}

interface ParsedLinesInput {
  mode: "lines";
  supplierId: string | null;
  location: string;
  lines: MaterialAliasLineInput[];
}

interface ParsedBacklogInput {
  mode: "backlog";
  location: string;
  batchSize: number;
}

interface ParsedNewItemsInput {
  mode: "new_items";
  location: string;
  days: number;
  batchSize: number;
  background: boolean;
}

type ParsedInput = ParsedLinesInput | ParsedBacklogInput | ParsedNewItemsInput;

const MESSAGES: Record<string, string> = {
  disabled: "Tính năng học bí danh NVL bằng Jev đang tắt.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Tính năng học bí danh NVL chỉ dành cho người có quyền sửa kho NVL Q7 hoặc sửa đơn hàng / phiếu chi.",
  invalid_content_type: "Yêu cầu học bí danh NVL phải là JSON.",
  invalid_json: "Nội dung yêu cầu học bí danh NVL không hợp lệ.",
  invalid_request: "Yêu cầu học bí danh NVL không hợp lệ.",
  body_limit: "Yêu cầu học bí danh NVL quá lớn.",
  unconfigured: "Máy chủ chưa cấu hình khoá AI Gateway cho Jev.",
  scan_failed: "Chưa thể xếp hạng bí danh NVL. Không có thay đổi nào được ghi ngoài cache Jev.",
  timeout: "Xếp hạng bí danh NVL vượt thời gian cho phép. Không có thay đổi nào được ghi.",
};

const VN_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date (YYYY-MM-DD) of an instant in Vietnam time (UTC+7). */
export function vietnamDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = VN_DATE.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function jsonBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    throw new MaterialAliasError("invalid_content_type", 415);
  }
  if (!req.body) throw new MaterialAliasError("invalid_request", 400);
  const reader = req.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MATERIAL_ALIAS_REQUEST_BODY_LIMIT) {
        await reader.cancel();
        throw new MaterialAliasError("body_limit", 413);
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!jsonBody(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw new MaterialAliasError("invalid_json", 400);
  }
}

function asCandidateList(raw: unknown): MaterialAliasCandidate[] {
  if (!Array.isArray(raw) || raw.length > MATERIAL_ALIAS_MAX_CANDIDATES) {
    throw new MaterialAliasError("invalid_request", 400);
  }
  return raw.map((entry) => {
    if (!jsonBody(entry)) throw new MaterialAliasError("invalid_request", 400);
    const id = entry.id;
    const name = entry.name;
    const unit = entry.unit;
    const reason = entry.reason;
    const skuId = entry.sku_id;
    if (typeof id !== "string" || id.trim() === "" || id === NONE_OPTION) {
      throw new MaterialAliasError("invalid_request", 400);
    }
    if (typeof name !== "string" || typeof unit !== "string") {
      throw new MaterialAliasError("invalid_request", 400);
    }
    if (reason !== undefined && typeof reason !== "string") {
      throw new MaterialAliasError("invalid_request", 400);
    }
    if (skuId !== undefined && skuId !== null && typeof skuId !== "string") {
      throw new MaterialAliasError("invalid_request", 400);
    }
    return {
      id,
      name,
      unit,
      reason: typeof reason === "string" ? reason : "",
      sku_id: typeof skuId === "string" && skuId.trim() !== "" ? skuId : null,
    };
  });
}

function asLine(entry: unknown): MaterialAliasLineInput {
  if (!jsonBody(entry)) throw new MaterialAliasError("invalid_request", 400);
  for (const field of Object.keys(entry)) {
    if (!["line_key", "raw_name", "raw_unit", "candidates"].includes(field)) {
      throw new MaterialAliasError("invalid_request", 400);
    }
  }
  const lineKey = entry.line_key;
  const rawName = entry.raw_name;
  const rawUnit = entry.raw_unit === undefined ? null : entry.raw_unit;
  if (typeof lineKey !== "string" || lineKey.trim() === "") throw new MaterialAliasError("invalid_request", 400);
  if (typeof rawName !== "string" || rawName.trim() === "") throw new MaterialAliasError("invalid_request", 400);
  if (rawUnit !== null && typeof rawUnit !== "string") throw new MaterialAliasError("invalid_request", 400);
  return {
    line_key: lineKey,
    raw_name: rawName,
    raw_unit: rawUnit,
    candidates: asCandidateList(entry.candidates ?? []),
  };
}

function parseInput(raw: Record<string, unknown>): ParsedInput {
  for (const field of Object.keys(raw)) {
    if (!["mode", "supplier_id", "location", "lines", "batch_size", "days", "background"].includes(field)) {
      throw new MaterialAliasError("invalid_request", 400);
    }
  }
  const location = raw.location;
  if (location !== "q7" && location !== "tan_tao") throw new MaterialAliasError("invalid_request", 400);
  const mode = raw.mode;
  if (mode === "backlog") {
    if (raw.supplier_id !== undefined || raw.lines !== undefined || raw.days !== undefined || raw.background !== undefined) {
      throw new MaterialAliasError("invalid_request", 400);
    }
    const rawBatch = raw.batch_size;
    if (
      rawBatch !== undefined
      && (typeof rawBatch !== "number" || !Number.isInteger(rawBatch) || rawBatch < 1)
    ) {
      throw new MaterialAliasError("invalid_request", 400);
    }
    const batchSize = Math.min(
      (rawBatch as number | undefined) ?? MATERIAL_ALIAS_BACKLOG_BATCH_DEFAULT,
      MATERIAL_ALIAS_BACKLOG_BATCH_MAX,
    );
    return { mode: "backlog", location, batchSize };
  }

  if (mode === "new_items") {
    if (raw.supplier_id !== undefined || raw.lines !== undefined) {
      throw new MaterialAliasError("invalid_request", 400);
    }
    const rawDays = raw.days;
    if (
      rawDays !== undefined
      && (typeof rawDays !== "number" || !Number.isInteger(rawDays) || rawDays < 1 || rawDays > MATERIAL_ALIAS_NEW_ITEM_DAYS_MAX)
    ) {
      throw new MaterialAliasError("invalid_request", 400);
    }
    const rawBatch = raw.batch_size;
    if (
      rawBatch !== undefined
      && (typeof rawBatch !== "number" || !Number.isInteger(rawBatch) || rawBatch < 1)
    ) {
      throw new MaterialAliasError("invalid_request", 400);
    }
    if (raw.background !== undefined && typeof raw.background !== "boolean") {
      throw new MaterialAliasError("invalid_request", 400);
    }
    return {
      mode: "new_items",
      location,
      days: (rawDays as number | undefined) ?? MATERIAL_ALIAS_NEW_ITEM_DAYS_DEFAULT,
      batchSize: Math.min(
        (rawBatch as number | undefined) ?? MATERIAL_ALIAS_NEW_ITEM_BATCH_DEFAULT,
        MATERIAL_ALIAS_NEW_ITEM_BATCH_MAX,
      ),
      background: raw.background === true,
    };
  }

  if (mode !== "lines") throw new MaterialAliasError("invalid_request", 400);
  if (raw.batch_size !== undefined || raw.days !== undefined || raw.background !== undefined) {
    throw new MaterialAliasError("invalid_request", 400);
  }
  const supplierId = raw.supplier_id === undefined ? null : raw.supplier_id;
  if (supplierId !== null && typeof supplierId !== "string") throw new MaterialAliasError("invalid_request", 400);
  if (!Array.isArray(raw.lines) || raw.lines.length === 0 || raw.lines.length > 200) {
    throw new MaterialAliasError("invalid_request", 400);
  }
  const lines = raw.lines.map(asLine);
  return { mode: "lines", supplierId, location, lines };
}

function evaluationCost(evaluation: JevMatchEvaluation | undefined): number {
  return evaluation?.cost != null && Number.isFinite(evaluation.cost) ? evaluation.cost : 0;
}

function buildAnswer(
  evaluation: JevMatchEvaluation | null,
  rawName: string,
  choice: string | null,
): CachedJevAnswer {
  const parsedPack = parsePackFromName(rawName);
  return {
    choice,
    item_id: choice,
    probability: evaluation?.probability ?? 0,
    line_type: evaluation?.lineType ?? null,
    line_type_probability: evaluation?.lineTypeProbability ?? null,
    confidence: evaluation?.confidence ?? null,
    pack: parsedPack,
    source: evaluation ? "jev" : "none",
  };
}

/**
 * Deterministic answer for a line the fixed rule already calls non-goods
 * (VAT / fee / service): the handler answers from code and never calls Jev.
 */
function ruleAnswer(rawName: string): CachedJevAnswer {
  return {
    choice: null,
    item_id: null,
    probability: 0,
    line_type: LINE_TYPE_NON_GOODS,
    line_type_probability: 1,
    confidence: null,
    pack: parsePackFromName(rawName),
    source: "rule",
  };
}

/**
 * Deterministic answer when exactly one candidate is an exact normalized name
 * match: the answer is code, not Jev. No call is spent; the answer is cached.
 */
function exactCandidateAnswer(
  candidates: readonly MaterialAliasCandidate[],
  rawName: string,
): CachedJevAnswer | null {
  const exact = candidates.filter((candidate) => (candidate.reason ?? "").startsWith("name_exact"));
  if (exact.length !== 1) return null;
  const candidate = exact[0];
  return {
    choice: candidate.id,
    item_id: candidate.id,
    probability: 1,
    line_type: LINE_TYPE_GOODS,
    line_type_probability: 1,
    confidence: null,
    pack: parsePackFromName(rawName),
    source: "exact",
  };
}

function candidateIds(candidates: readonly MaterialAliasCandidate[]): string[] {
  return candidates.map((candidate) => candidate.id);
}

/** A finished-goods SKU option carries sku_id, or the SQL '+sku' reason suffix. */
function isFinishedProductCandidate(candidate: MaterialAliasCandidate): boolean {
  return (candidate.sku_id !== null && candidate.sku_id !== undefined)
    || (candidate.reason ?? "").split("+").includes("sku");
}

/**
 * Options for a label name (Nhãn / Tem / Decal / Nắp / Giấy decal): a finished
 * product named after the label must never be suggested.
 */
function rejectFinishedProductCandidates(
  candidates: readonly MaterialAliasCandidate[],
): MaterialAliasCandidate[] {
  return candidates.filter((candidate) => !isFinishedProductCandidate(candidate));
}

/**
 * One grouped read of public.stock_name_corrections for a whole batch. A
 * missing dependency or a failed read falls back to the machine names and never
 * fails the ranking run.
 */
async function loadStockNameCorrections(
  deps: MaterialAliasHandlerDeps,
  normalizedNames: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(normalizedNames.filter((name) => name !== ""))];
  if (unique.length === 0 || typeof deps.getStockNameCorrections !== "function") return new Map();
  try {
    return await deps.getStockNameCorrections(unique);
  } catch {
    return new Map();
  }
}

/**
 * The option list Jev sees for one backlog row: the token candidates first
 * (they carry the exact / contains reasons), then every remaining catalog
 * option, de-duplicated by id and capped at `limit`.
 */
export function mergeCandidateOptions(
  tokenCandidates: readonly MaterialAliasCandidate[],
  catalog: readonly MaterialAliasCandidate[],
  limit: number = MATERIAL_ALIAS_MAX_CANDIDATES,
): MaterialAliasCandidate[] {
  const merged: MaterialAliasCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of [...tokenCandidates, ...catalog]) {
    if (candidate.id === "" || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    merged.push(candidate);
    if (merged.length >= limit) break;
  }
  return merged;
}

interface NewItemScanContext {
  signal: AbortSignal;
  deadlineAt: number;
  matchEvaluator: JevEvaluator | null;
  newItemEvaluator: NewItemJevEvaluator | null;
  usageDate: string;
  remainingQuota: number;
}

interface NewItemScanResult {
  candidates: number;
  names: number;
  groups: number;
  processed: number;
  remaining: number;
  autoMerged: number;
  sameItemAsked: number;
  classAsked: number;
  failed: number;
  calls: number;
  cost: number;
  stopped: "daily_limit" | null;
}

function newItemRepresentative(members: readonly NewItemMember[]): NewItemMember | null {
  return members.length > 0 ? members[0] : null;
}

/**
 * One new-item batch: (a) rank the names that have a candidate but no cached
 * match answer, (b) group the remaining names with the deterministic score and
 * the Jev same_item question, (c) ask Jev the item class for every group, then
 * upsert the suggestion rows. Same-item and class answers are cached with the
 * new prompt version; usage is incremented immediately after every call.
 */
async function runNewItemScan(
  deps: MaterialAliasHandlerDeps,
  input: ParsedNewItemsInput,
  context: NewItemScanContext,
): Promise<NewItemScanResult> {
  const location = input.location;
  const rows = (await deps.listUnmatched!(location, input.days))
    .filter((row) => row.normalized_name !== "" && row.raw_name !== "");
  const rawKey = (normalizedName: string): MaterialAliasCacheKey => ({
    supplierId: null,
    normalizedName,
    location,
    promptVersion: NEW_ITEM_PROMPT_VERSION,
    candidatesHash: "",
  });

  let calls = 0;
  let cost = 0;
  let failed = 0;
  let sameItemAsked = 0;
  let classAsked = 0;
  let autoMerged = 0;

  const resolved = new Map<string, { itemId: string | null; lineType: string | null }>();
  const pendingMatch = new Set<string>();

  // (a) Names with a candidate but no cached answer run the existing match
  // question. Candidates are resolved first so every cache read can go out in
  // one batch, and the questions then run at most four in parallel.
  let matchCallsThisRequest = 0;
  type MatchEntry = {
    row: NewItemUnmatchedRow;
    candidates: MaterialAliasCandidate[];
    key: MaterialAliasCacheKey;
  };
  const matchEntries: MatchEntry[] = [];
  const seenMatch = new Set<string>();
  for (const row of rows) {
    if (row.cached_match_item_id !== null) continue;
    if (resolved.has(row.normalized_name) || pendingMatch.has(row.normalized_name)) continue;
    if (seenMatch.has(row.normalized_name)) continue;
    seenMatch.add(row.normalized_name);
    const candidates = await deps.candidatesFor(row.raw_name, location, 5);
    if (candidates.length === 0) {
      resolved.set(row.normalized_name, { itemId: null, lineType: null });
      continue;
    }
    matchEntries.push({
      row,
      candidates,
      key: {
        supplierId: row.supplier_id,
        normalizedName: row.normalized_name,
        location,
        promptVersion: JEV_PROMPT_VERSION,
        candidatesHash: candidatesHash(candidateIds(candidates)),
      },
    });
  }

  const matchHits = deps.getCacheMany && matchEntries.length > 0
    ? await deps.getCacheMany(matchEntries.map((entry) => entry.key))
    : null;

  const matchToAsk: MatchEntry[] = [];
  for (let index = 0; index < matchEntries.length; index += 1) {
    const entry = matchEntries[index];
    const hit = matchHits ? matchHits[index] : await deps.getCache(entry.key);
    if (hit) {
      resolved.set(entry.row.normalized_name, { itemId: hit.answer.item_id, lineType: hit.answer.line_type });
      continue;
    }
    const exact = exactCandidateAnswer(entry.candidates, entry.row.raw_name);
    if (exact) {
      await deps.putCache(entry.key, exact, null);
      resolved.set(entry.row.normalized_name, { itemId: exact.item_id, lineType: exact.line_type });
      continue;
    }
    matchToAsk.push(entry);
  }

  if (matchToAsk.length > 0) {
    const matchQuota = Math.max(0, context.remainingQuota - calls);
    const matchBudget = Math.min(matchQuota, Math.max(0, input.batchSize - matchCallsThisRequest));
    if (context.matchEvaluator && matchBudget > 0) {
      await runQuestionsWithQuota<MatchEntry, JevMatchEvaluation>({
        items: matchToAsk,
        remaining: matchBudget,
        concurrency: NEW_ITEM_MAX_CONCURRENCY,
        ask: async (entry) => context.matchEvaluator!({
          state: { line: { name: entry.row.raw_name, unit: entry.row.raw_unit, supplier: entry.row.supplier_id }, candidates: entry.candidates },
          signal: context.signal,
          deadlineAt: context.deadlineAt,
        }),
        onAnswered: async (entry, evaluation) => {
          calls += 1;
          matchCallsThisRequest += 1;
          const callCost = evaluationCost(evaluation);
          cost += callCost;
          await deps.incrementUsage(context.usageDate, 1, callCost);
          const answer = buildAnswer(evaluation, entry.row.raw_name, evaluation.choice);
          await deps.putCache(entry.key, answer, evaluation.cost ?? null);
          resolved.set(entry.row.normalized_name, { itemId: answer.item_id, lineType: answer.line_type });
        },
        onError: (entry) => {
          failed += 1;
          pendingMatch.add(entry.row.normalized_name);
        },
      });
    }
    // Anything the quota did not answer stays pending for a later batch.
    for (const entry of matchToAsk) {
      if (!resolved.has(entry.row.normalized_name)) pendingMatch.add(entry.row.normalized_name);
    }
  }

  // Grouping must see every name at once, otherwise a later batch regroups the
  // same names under another key. Finish the match answers first.
  if (pendingMatch.size > 0) {
    const stopped = calls >= context.remainingQuota ? "daily_limit" : null;
    return {
      candidates: rows.length, names: 0, groups: 0, processed: matchCallsThisRequest, remaining: pendingMatch.size,
      autoMerged: 0, sameItemAsked: 0, classAsked: 0, failed, calls, cost, stopped,
    };
  }

  // Only names without an item, and not a non-goods line, can be grouped. A name
  // with an exact candidate belongs to the "chờ gán mã" list instead.
  const membersByNorm = new Map<string, NewItemMember[]>();
  for (const row of rows) {
    if (pendingMatch.has(row.normalized_name)) continue;
    if (row.has_exact_candidate) continue;
    const fromMatch = resolved.get(row.normalized_name);
    const itemId = fromMatch ? fromMatch.itemId : row.cached_match_item_id;
    const lineType = fromMatch ? fromMatch.lineType : row.cached_match_line_type;
    if (itemId !== null) continue;
    if (lineType === LINE_TYPE_NON_GOODS) continue;
    const list = membersByNorm.get(row.normalized_name) ?? [];
    list.push({
      supplier_id: row.supplier_id,
      normalized_name: row.normalized_name,
      raw_name: row.raw_name,
      raw_unit: row.raw_unit,
      receipt_count: row.receipt_count,
      last_date: row.last_date,
      receipt_days: row.receipt_days,
      first_date: row.first_date,
    });
    membersByNorm.set(row.normalized_name, list);
  }

  const names = [...membersByNorm.keys()].sort();
  const plan = planSameItemPairs(names);
  const unionFind = makeUnionFind(names);
  for (const [left, right] of plan.autoPairs) unionFind.union(left, right);
  autoMerged = plan.autoPairs.length;

  // (b) The remaining pairs ask the Jev boolean question, cache first with one
  // batched read.
  const pairEntries = plan.questionPairs.map((pair) => ({
    left: pair[0],
    right: pair[1],
    key: rawKey(sameItemPairKey(pair[0], pair[1])),
  }));
  const pairHits = deps.getRawCacheMany && pairEntries.length > 0
    ? await deps.getRawCacheMany(pairEntries.map((entry) => entry.key))
    : null;
  const toAsk: Array<[string, string]> = [];
  for (let index = 0; index < pairEntries.length; index += 1) {
    const entry = pairEntries[index];
    const hit = pairHits ? pairHits[index] : (deps.getRawCache ? await deps.getRawCache(entry.key) : null);
    const probability = hit && typeof hit.answer.p_same === "number" ? hit.answer.p_same : null;
    if (probability === null) {
      toAsk.push([entry.left, entry.right]);
      continue;
    }
    if (probability >= NEW_ITEM_SAME_THRESHOLD) unionFind.union(entry.left, entry.right);
  }

  let pairsAnswered = 0;
  if (toAsk.length > 0 && context.newItemEvaluator) {
    const sameQuota = Math.max(0, context.remainingQuota - calls);
    const pairRun = await runQuestionsWithQuota<[string, string], NewItemJevEvaluation>({
      items: toAsk,
      remaining: Math.min(sameQuota, input.batchSize),
      concurrency: NEW_ITEM_MAX_CONCURRENCY,
      ask: async ([left, right]) => {
        const leftMember = newItemRepresentative(membersByNorm.get(left) ?? []);
        const rightMember = newItemRepresentative(membersByNorm.get(right) ?? []);
        return context.newItemEvaluator!({
          mode: "same_item",
          state: {
            a: { name: leftMember?.raw_name ?? left, unit: leftMember?.raw_unit ?? null, supplier: leftMember?.supplier_id ?? null },
            b: { name: rightMember?.raw_name ?? right, unit: rightMember?.raw_unit ?? null, supplier: rightMember?.supplier_id ?? null },
          },
          signal: context.signal,
          deadlineAt: context.deadlineAt,
        });
      },
      onAnswered: async ([left, right], evaluation) => {
        calls += 1;
        sameItemAsked += 1;
        const callCost = evaluationCost(evaluation);
        cost += callCost;
        await deps.incrementUsage(context.usageDate, 1, callCost);
        await deps.putRawCache?.(
          rawKey(sameItemPairKey(left, right)),
          { kind: "same_item", p_same: evaluation.same_item },
          evaluation.cost ?? null,
        );
        if ((evaluation.same_item ?? 0) >= NEW_ITEM_SAME_THRESHOLD) unionFind.union(left, right);
      },
      onError: () => { failed += 1; },
    });
    pairsAnswered = pairRun.asked;
  } else if (toAsk.length > 0) {
    failed += toAsk.length;
  }

  // Groups are final only when every same_item pair is answered; until then
  // write nothing and ask the client for another batch.
  const pairsLeft = context.newItemEvaluator ? toAsk.length - pairsAnswered : 0;
  if (pairsLeft > 0) {
    const stopped = calls >= context.remainingQuota ? "daily_limit" : null;
    return {
      candidates: rows.length, names: names.length, groups: 0, processed: pairsAnswered, remaining: pairsLeft,
      autoMerged, sameItemAsked, classAsked: 0, failed, calls, cost, stopped,
    };
  }

  // (c) One item_class question per group, cache first with one batched read,
  // at most four in flight.
  const clusters = unionFind.groups();
  const classByCluster = new Map<string, { itemClass: NewItemClass; probability: number }>();
  const classEntries = clusters.map((cluster) => ({ cluster, key: rawKey(clusterKey(cluster)) }));
  const classHits = deps.getRawCacheMany && classEntries.length > 0
    ? await deps.getRawCacheMany(classEntries.map((entry) => entry.key))
    : null;
  const classToAsk: string[][] = [];
  for (let index = 0; index < classEntries.length; index += 1) {
    const entry = classEntries[index];
    const hit = classHits ? classHits[index] : (deps.getRawCache ? await deps.getRawCache(entry.key) : null);
    const value = hit?.answer.item_class;
    const probability = hit?.answer.class_probability;
    if (
      typeof value === "string"
      && NEW_ITEM_CLASS_OPTIONS.includes(value as NewItemClass)
      && typeof probability === "number"
    ) {
      classByCluster.set(entry.key.normalizedName, { itemClass: value as NewItemClass, probability });
    } else {
      classToAsk.push(entry.cluster);
    }
  }

  let classStopped = false;
  let classAnswered = 0;
  if (classToAsk.length > 0 && context.newItemEvaluator) {
    const classQuota = Math.max(0, context.remainingQuota - calls);
    const run = await runQuestionsWithQuota<string[], NewItemJevEvaluation>({
      items: classToAsk,
      remaining: Math.min(classQuota, input.batchSize),
      concurrency: NEW_ITEM_MAX_CONCURRENCY,
      ask: async (cluster) => {
        const rawNames = cluster.map((name) => newItemRepresentative(membersByNorm.get(name) ?? [])?.raw_name ?? name);
        const units = cluster
          .map((name) => newItemRepresentative(membersByNorm.get(name) ?? [])?.raw_unit ?? "")
          .filter((unit) => unit !== "");
        const receiptCount = cluster.reduce(
          (total, name) => total + (membersByNorm.get(name) ?? []).reduce((sum, member) => sum + member.receipt_count, 0),
          0,
        );
        return context.newItemEvaluator!({
          mode: "item_class",
          state: { group: { names: rawNames, units, receipt_count: receiptCount } },
          signal: context.signal,
          deadlineAt: context.deadlineAt,
        });
      },
      onAnswered: async (cluster, evaluation) => {
        calls += 1;
        classAsked += 1;
        const callCost = evaluationCost(evaluation);
        cost += callCost;
        await deps.incrementUsage(context.usageDate, 1, callCost);
        const key = rawKey(clusterKey(cluster));
        await deps.putRawCache?.(key, {
          kind: "item_class",
          item_class: evaluation.item_class,
          class_probability: evaluation.class_probability,
        }, evaluation.cost ?? null);
        if (evaluation.item_class !== null) {
          classByCluster.set(key.normalizedName, {
            itemClass: evaluation.item_class,
            probability: evaluation.class_probability ?? 0,
          });
        }
      },
      onError: () => { failed += 1; },
    });
    classStopped = run.stopped;
    classAnswered = run.asked;
  } else if (classToAsk.length > 0) {
    failed += classToAsk.length;
  }

  // Write the groups. A dismissed / applied group is never overwritten by the RPC.
  const suggestionRows: NewItemSuggestionRow[] = [];
  for (const cluster of clusters) {
    const members: NewItemMember[] = [];
    for (const name of cluster) members.push(...(membersByNorm.get(name) ?? []));
    if (members.length === 0) continue;
    const summary = summarizeMembers(members);
    const key = clusterKey(cluster);
    const cls = classByCluster.get(key);
    suggestionRows.push({
      cluster_key: key,
      members: members.map((member) => toStoredMember(member)),
      suggested_name: summary.suggested_name,
      suggested_unit: summary.suggested_unit,
      suggested_class: cls?.itemClass ?? null,
      class_probability: cls?.probability ?? null,
      receipt_count: summary.receipt_count,
      receipt_days: summary.receipt_days,
      first_date: summary.first_date,
      last_date: summary.last_date,
      is_recurring: summary.is_recurring,
      prompt_version: NEW_ITEM_PROMPT_VERSION,
    });
  }
  if (suggestionRows.length > 0) await deps.upsertNewItemSuggestions!(location, suggestionRows);

  const unaskedClasses = classStopped ? Math.max(0, classToAsk.length - classAnswered) : 0;
  const remaining = pendingMatch.size + unaskedClasses;
  const classified = suggestionRows.filter((row) => row.suggested_class !== null).length;
  const processed = resolved.size + classified;
  const stopped = remaining > 0 && calls >= context.remainingQuota ? "daily_limit" : null;

  return {
    candidates: rows.length,
    names: names.length,
    groups: suggestionRows.length,
    processed,
    remaining,
    autoMerged,
    sameItemAsked,
    classAsked,
    failed,
    calls,
    cost,
    stopped,
  };
}

export const MATERIAL_ALIAS_BACKGROUND_BUDGET_MS = 100_000;

/** The background loop leaves enough time for one more batch, then pauses. */
async function runNewItemBackgroundLoop(
  deps: MaterialAliasHandlerDeps,
  input: ParsedNewItemsInput,
  runId: string,
  context: { matchEvaluator: JevEvaluator | null; newItemEvaluator: NewItemJevEvaluator | null },
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const deadlineAt = Date.now() + MATERIAL_ALIAS_BACKGROUND_BUDGET_MS;
  let processed = 0;
  let remaining = 0;
  let calls = 0;
  let groups = 0;
  try {
    while (true) {
      const usageDate = vietnamDate(now().toISOString());
      const usage = await deps.getUsage(usageDate);
      const callLimit = Number.isFinite(usage.call_limit) && usage.call_limit > 0
        ? usage.call_limit
        : MATERIAL_ALIAS_DAILY_CALL_LIMIT;
      const remainingQuota = Math.max(0, callLimit - usage.calls);
      const budget = Math.max(1000, deadlineAt - Date.now());
      const scan = await runNewItemScan(deps, input, {
        signal: AbortSignal.timeout(budget),
        deadlineAt,
        matchEvaluator: context.matchEvaluator,
        newItemEvaluator: context.newItemEvaluator,
        usageDate,
        remainingQuota,
      });
      processed += scan.processed;
      remaining = scan.remaining;
      calls += scan.calls;
      groups = Math.max(groups, scan.groups);

      if (scan.remaining <= 0) {
        await deps.updateNewItemRun?.(runId, {
          status: "done", processed, remaining: 0, calls, groups,
          finished_at: now().toISOString(),
        });
        return;
      }
      await deps.updateNewItemRun?.(runId, {
        status: "running", processed, remaining, calls, groups,
      });
      if (scan.stopped === "daily_limit" || Date.now() >= deadlineAt) {
        await deps.updateNewItemRun?.(runId, { status: "paused", processed, remaining, calls, groups });
        return;
      }
    }
  } catch (error) {
    await deps.updateNewItemRun?.(runId, {
      status: "failed",
      processed,
      remaining,
      calls,
      groups,
      last_error: String((error as { message?: unknown })?.message ?? error).slice(0, 500),
      finished_at: now().toISOString(),
    });
  }
}

export function createMaterialAliasHandler(deps: MaterialAliasHandlerDeps) {
  const now = deps.now ?? (() => new Date());

  return async (req: Request): Promise<Response> => {
    const headers: Record<string, string> = {
      ...getCorsHeaders(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return json({ error: "Method not allowed", code: "method_not_allowed" }, 405);

    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(MATERIAL_ALIAS_REQUEST_BUDGET_MS)]);
    const deadlineAt = Date.now() + MATERIAL_ALIAS_REQUEST_BUDGET_MS;
    try {
      const { userId, q7Editor } = await deps.authenticate(req, signal);
      signal.throwIfAborted();
      if (deps.killSwitch()) throw new MaterialAliasError("disabled", 503);
      const raw = await readBody(req, signal);
      const input = parseInput(raw);
      if ((input.mode === "backlog" || input.mode === "new_items") && !q7Editor) {
        throw new MaterialAliasError("forbidden", 403);
      }
      signal.throwIfAborted();

      const usageDate = vietnamDate(now().toISOString());
      const usage = await deps.getUsage(usageDate);
      const callLimit = Number.isFinite(usage.call_limit) && usage.call_limit > 0
        ? usage.call_limit
        : MATERIAL_ALIAS_DAILY_CALL_LIMIT;
      const remainingQuota = Math.max(0, callLimit - usage.calls);

      let evaluator: JevEvaluator | null = null;
      try {
        evaluator = deps.evaluator();
      } catch {
        evaluator = null;
      }

      let calls = 0;
      let cost = 0;
      let failed = 0;
      let cached = 0;

      if (input.mode === "lines") {
        const normalizedNames = input.lines.map((line) => normalizeItemName(line.raw_name));
        const corrections = await loadStockNameCorrections(deps, normalizedNames);
        const results: unknown[] = [];
        for (const [index, line] of input.lines.entries()) {
          const normalizedName = normalizedNames[index];
          // The operator-facing corrected name, when the machine read it wrong.
          const displayName = corrections.get(normalizedName) ?? line.raw_name;
          // The fixed rule already knows VAT / fee / service: answer from code
          // and never spend a Jev call on it.
          if (autoNonStockReason(line.raw_name) !== null) {
            results.push({
              line_key: line.line_key,
              normalized_name: normalizedName,
              candidates_hash: "",
              cached: false,
              answer: ruleAnswer(line.raw_name),
            });
            continue;
          }
          // A label / sticker line must never be matched to the finished product
          // whose name it carries. The cache key still uses the machine name.
          const candidateList = isPackagingLabelName(displayName)
            ? rejectFinishedProductCandidates(line.candidates)
            : line.candidates;
          const hash = candidatesHash(candidateIds(candidateList));
          const key: MaterialAliasCacheKey = {
            supplierId: input.supplierId,
            normalizedName,
            location: input.location,
            promptVersion: JEV_PROMPT_VERSION,
            candidatesHash: hash,
          };
          let answer: CachedJevAnswer;
          let usedCache = false;
          const exact = exactCandidateAnswer(candidateList, line.raw_name);
          const hit = await deps.getCache(key);
          if (hit) {
            answer = hit.answer;
            usedCache = true;
            cached += 1;
          } else if (exact) {
            // Exactly one candidate is the normalized name: assign it in code,
            // never call Jev, but still cache the deterministic answer.
            answer = exact;
            await deps.putCache(key, answer, null);
          } else if (candidateList.length === 0) {
            answer = buildAnswer(null, line.raw_name, null);
            await deps.putCache(key, answer, null);
          } else if (!evaluator || calls >= remainingQuota) {
            answer = buildAnswer(null, line.raw_name, null);
          } else {
            const evaluation = await evaluator({ state: { line: { name: displayName, unit: line.raw_unit, supplier: input.supplierId }, candidates: candidateList }, signal, deadlineAt });
            calls += 1;
            const callCost = evaluationCost(evaluation);
            cost += callCost;
            answer = buildAnswer(evaluation, line.raw_name, evaluation.choice);
            if (!evaluation) failed += 1;
            await deps.incrementUsage(usageDate, 1, callCost);
            await deps.putCache(key, answer, evaluation.cost ?? null);
          }
          results.push({
            line_key: line.line_key,
            normalized_name: normalizedName,
            candidates_hash: hash,
            cached: usedCache,
            answer,
          });
        }
        const stopped = remainingQuota <= 0 ? "daily_limit" : null;
        deps.audit?.({ event: "stock_alias_jev", mode: "lines", lines: input.lines.length, cached, calls, cost, failed });
        return json({
          mode: "lines",
          results,
          calls,
          cost,
          cached,
          failed,
          usage: { date: usageDate, calls: usage.calls + calls, limit: callLimit },
          stopped,
        });
      }

      if (input.mode === "backlog") {
        // backlog: process one batch, then report how much is still pending.
        const rows = await deps.listBacklog(input.location, MATERIAL_ALIAS_BACKLOG_LIMIT);
      // One grouped read of the operator display-name overrides for the batch.
      const corrections = await loadStockNameCorrections(deps, rows.map((row) => row.normalized_name));
      // The catalog is the same for every row: read it once, then offer Jev the
      // token matches plus the whole catalog so a translated / abbreviated /
      // OCR-damaged name still has real options.
      const catalog = deps.catalogOptions ? await deps.catalogOptions(input.location) : [];
      type BacklogEntry = {
        row: MaterialAliasBacklogRow;
        /** The corrected name when the machine read is wrong, else the raw name. */
        displayName: string;
        candidates: MaterialAliasCandidate[];
        key: MaterialAliasCacheKey;
      };
      const eligible: BacklogEntry[] = [];
      // Token candidates: ten rows at a time (58 sequential RPCs took ~15 s per request).
      const tokenByRow: MaterialAliasCandidate[][] = [];
      for (let from = 0; from < rows.length; from += 10) {
        const chunk = rows.slice(from, from + 10);
        tokenByRow.push(...await Promise.all(chunk.map((row) => deps.candidatesFor(row.raw_name, row.location, 5))));
      }
      for (const [rowIndex, row] of rows.entries()) {
        const tokenCandidates = tokenByRow[rowIndex] ?? [];
        const displayName = corrections.get(row.normalized_name) ?? row.raw_name;
        const merged = mergeCandidateOptions(tokenCandidates, catalog);
        // A label / sticker line must never be matched to the finished product
        // whose name it carries. The cache key still uses the machine name.
        const candidates = isPackagingLabelName(displayName)
          ? rejectFinishedProductCandidates(merged)
          : merged;
        // A row with no token match but catalog options is still evaluated; only
        // a row with no option at all (an empty catalog, or a label with only
        // SKU options) is skipped.
        if (candidates.length === 0) continue;
        eligible.push({
          row,
          displayName,
          candidates,
          key: {
            supplierId: row.supplier_id,
            normalizedName: row.normalized_name,
            location: row.location,
            promptVersion: JEV_PROMPT_VERSION,
            candidatesHash: candidatesHash(candidateIds(candidates)),
          },
        });
      }

      const pending: BacklogEntry[] = [];
      let skippedExisting = 0;
      for (const entry of eligible) {
        const hit = await deps.getCache(entry.key);
        if (hit) skippedExisting += 1;
        else pending.push(entry);
      }

      let evaluated = 0;
      let processed = 0;
      for (const entry of pending) {
        if (processed >= input.batchSize) break;
        const exact = exactCandidateAnswer(entry.candidates, entry.row.raw_name);
        if (exact) {
          await deps.putCache(entry.key, exact, null);
          processed += 1;
          continue;
        }
        if (!evaluator || calls >= remainingQuota) break;
        try {
          const evaluation = await evaluator({
            state: { line: { name: entry.displayName, unit: entry.row.raw_unit, supplier: entry.row.supplier_id }, candidates: entry.candidates },
            signal,
            deadlineAt,
          });
          calls += 1;
          const callCost = evaluationCost(evaluation);
          cost += callCost;
          evaluated += 1;
          processed += 1;
          await deps.incrementUsage(usageDate, 1, callCost);
          await deps.putCache(entry.key, buildAnswer(evaluation, entry.row.raw_name, evaluation.choice), evaluation.cost ?? null);
        } catch (error) {
          if (error instanceof JevError) throw error;
          failed += 1;
          processed += 1;
        }
      }

      const remaining = Math.max(0, pending.length - processed);
      // Only a spent quota stops the scan; a finished / empty backlog is not.
      const stopped = remainingQuota <= 0 && remaining > 0 ? "daily_limit" : null;
      deps.audit?.({
        event: "stock_alias_jev",
        mode: "backlog",
        candidates: eligible.length,
        catalog_size: catalog.length,
        batch_size: input.batchSize,
        processed,
        remaining,
        evaluated,
        cached: skippedExisting,
        calls,
        cost,
        failed,
      });
      return json({
        mode: "backlog",
        candidates: eligible.length,
        processed,
        remaining,
        batch_size: input.batchSize,
        evaluated,
        skipped_existing: skippedExisting,
        failed,
        calls,
        cost,
        usage: { date: usageDate, calls: usage.calls + calls, limit: callLimit },
        stopped,
      });
      }

      // new_items: rank, group, classify and upsert the suggestion rows.
      let newItemEvaluator: NewItemJevEvaluator | null = null;
      try {
        newItemEvaluator = deps.newItemEvaluator?.() ?? null;
      } catch {
        newItemEvaluator = null;
      }

      // background: true starts a run, answers 202 immediately and keeps going
      // through EdgeRuntime.waitUntil. One live run per location.
      if (input.background) {
        const existing = (await deps.getActiveNewItemRun?.(input.location)) ?? null;
        if (!existing && (!deps.createNewItemRun || !deps.updateNewItemRun)) {
          throw new MaterialAliasError("unconfigured", 503);
        }
        const run = existing ?? await deps.createNewItemRun!(input.location, userId);
        if (!existing) {
          const promise = runNewItemBackgroundLoop(deps, input, run.id, {
            matchEvaluator: evaluator,
            newItemEvaluator,
          });
          if (deps.waitUntil) deps.waitUntil(promise);
          else void promise;
        }
        deps.audit?.({
          event: "stock_alias_jev",
          mode: "new_items",
          background: true,
          run_id: run.id,
          resumed: existing !== null,
          location: input.location,
        });
        return json({
          mode: "new_items",
          background: true,
          run_id: run.id,
          status: run.status,
          location: input.location,
          days: input.days,
          processed: run.processed,
          remaining: run.remaining,
          calls: run.calls,
          groups: run.groups,
        }, 202);
      }

      const scan = await runNewItemScan(deps, input, {
        signal,
        deadlineAt,
        matchEvaluator: evaluator,
        newItemEvaluator,
        usageDate,
        remainingQuota,
      });
      deps.audit?.({
        event: "stock_alias_jev",
        mode: "new_items",
        candidates: scan.candidates,
        groups: scan.groups,
        processed: scan.processed,
        remaining: scan.remaining,
        auto_merged: scan.autoMerged,
        same_item_asked: scan.sameItemAsked,
        class_asked: scan.classAsked,
        batch_size: input.batchSize,
        calls: scan.calls,
        cost: scan.cost,
        failed: scan.failed,
      });
      return json({
        mode: "new_items",
        candidates: scan.candidates,
        names: scan.names,
        groups: scan.groups,
        processed: scan.processed,
        remaining: scan.remaining,
        batch_size: input.batchSize,
        days: input.days,
        auto_merged: scan.autoMerged,
        same_item_asked: scan.sameItemAsked,
        class_asked: scan.classAsked,
        failed: scan.failed,
        calls: scan.calls,
        cost: scan.cost,
        usage: { date: usageDate, calls: usage.calls + scan.calls, limit: callLimit },
        stopped: scan.stopped,
      });
    } catch (error) {
      const code = signal.aborted
        ? "timeout"
        : error instanceof MaterialAliasError
          ? error.code
          : error instanceof JevError
            ? error.code
            : "scan_failed";
      const status = signal.aborted
        ? 504
        : error instanceof MaterialAliasError
          ? error.status
          : error instanceof JevError
            ? error.status
            : 503;
      deps.audit?.({ event: "stock_alias_jev_error", code, status });
      return json({ error: MESSAGES[code] ?? MESSAGES.scan_failed, code }, status);
    }
  };
}
