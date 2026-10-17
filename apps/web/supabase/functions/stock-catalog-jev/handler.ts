// HTTP shell for the Q7 stock catalog Jev scan.
//
// It authenticates the caller server-side (owner or q7_material_inventory /
// kitchen_inventory edit), enforces a body budget, enforces the daily Jev call
// quota stored in stock_catalog_jev_usage, builds candidate pairs / classification
// states in code (Jev never selects its own candidates) and writes only
// stock_catalog_suggestions rows. There is no path that merges an item, changes a
// payment, an allocation, a PO, a goods receipt or an invoice.

import {
  buildClassifyState,
  buildSameItemState,
  candidatePairKey,
  selectPrimaryItem,
  type StockCatalogCandidate,
  type StockCatalogClassifyItem,
} from "./candidates.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { JEV_PROMPT_VERSION, JevError, type JevEvaluator, type JevEvaluation } from "./jev.ts";

export const STOCK_CATALOG_REQUEST_BODY_LIMIT = 16_384;
export const STOCK_CATALOG_REQUEST_BUDGET_MS = 110_000;
export const STOCK_CATALOG_MIN_LIMIT = 1;
export const STOCK_CATALOG_DEFAULT_LIMIT = 50;
export const STOCK_CATALOG_MAX_LIMIT = 200;
export const STOCK_CATALOG_DAILY_CALL_LIMIT = 600;
export const STOCK_CATALOG_MAX_CONCURRENCY = 4;
/** Never store a dedupe suggestion below this Jev probability. */
export const STOCK_CATALOG_MIN_PROBABILITY = 0.5;

export type StockCatalogMode = "dedupe" | "classify";

export class StockCatalogError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "StockCatalogError";
  }
}

export interface StockCatalogUsage {
  usage_date: string;
  calls: number;
  cost: number;
  call_limit: number;
}

export interface StockCatalogSuggestionRow {
  kind: "merge" | "classify";
  item_id: string;
  other_item_id: string | null;
  proposed_target_id: string | null;
  proposed_factor: number | null;
  factor_source: "unit_rule" | "none" | null;
  proposed_class: string | null;
  probability: number;
  jev_answer: Record<string, unknown>;
  prompt_version: string;
  cost: number | null;
}

export interface StockCatalogSummary {
  mode: StockCatalogMode;
  candidates: number;
  suggestions: number;
  skipped_existing: number;
  failed: number;
  calls: number;
  cost: number;
  usage: { date: string; calls: number; limit: number };
  stopped: "daily_limit" | null;
  /** Additive: classify suggestions auto-applied by robot_auto_apply_class. */
  auto_applied: number;
  auto_skipped: Record<string, number>;
}

/** Additive auto-apply counters returned by the store after inserting rows. */
export interface CatalogAutoApplySummary {
  applied: number;
  skipped: Record<string, number>;
}

export interface InsertSuggestionsResult {
  inserted: number;
  auto: CatalogAutoApplySummary;
}

/** A classify item the store may decorate with past corrections. */
export type ClassifyItemWithCorrections = StockCatalogClassifyItem & { corrections?: string[] };

export interface StockCatalogHandlerDeps {
  killSwitch: () => boolean;
  evaluator: () => JevEvaluator | null;
  authenticate: (request: Request, signal: AbortSignal) => Promise<{ userId: string }>;
  listCandidates: () => Promise<StockCatalogCandidate[]>;
  listExistingMergePairKeys: (promptVersion: string) => Promise<string[]>;
  listUnclassifiedItems: (promptVersion: string) => Promise<StockCatalogClassifyItem[]>;
  getUsage: (usageDate: string) => Promise<StockCatalogUsage>;
  recordUsage: (usage: StockCatalogUsage) => Promise<void>;
  insertSuggestions: (rows: StockCatalogSuggestionRow[]) => Promise<InsertSuggestionsResult>;
  now?: () => Date;
  concurrency?: number;
  audit?: (event: Record<string, unknown>) => void;
}

interface ParsedInput {
  mode: StockCatalogMode;
  limit: number;
}

interface DedupeOutcome {
  pair: StockCatalogCandidate;
  evaluation?: JevEvaluation;
  error?: unknown;
}

interface ClassifyOutcome {
  item: StockCatalogClassifyItem;
  evaluation?: JevEvaluation;
  error?: unknown;
}

const MESSAGES: Record<string, string> = {
  disabled: "Tính năng dọn danh mục NVL bằng Sushi đang tắt.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Tính năng dọn danh mục NVL chỉ dành cho chủ doanh nghiệp hoặc người có quyền sửa kho NVL Q7.",
  invalid_content_type: "Yêu cầu dọn danh mục NVL phải là JSON.",
  invalid_json: "Nội dung yêu cầu dọn danh mục NVL không hợp lệ.",
  invalid_request: "Yêu cầu dọn danh mục NVL không hợp lệ.",
  body_limit: "Yêu cầu dọn danh mục NVL quá lớn.",
  unconfigured: "Máy chủ chưa cấu hình khoá AI Gateway cho Sushi.",
  scan_failed: "Chưa thể chạy dọn danh mục NVL. Không có thay đổi nào được ghi ngoài đề xuất.",
  timeout: "Dọn danh mục NVL vượt thời gian cho phép. Không có thay đổi nào được ghi.",
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
    throw new StockCatalogError("invalid_content_type", 415);
  }
  if (!req.body) throw new StockCatalogError("invalid_request", 400);
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
      if (size > STOCK_CATALOG_REQUEST_BODY_LIMIT) { await reader.cancel(); throw new StockCatalogError("body_limit", 413); }
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
    throw new StockCatalogError("invalid_json", 400);
  }
}

function parseInput(raw: Record<string, unknown>): ParsedInput {
  for (const field of Object.keys(raw)) {
    if (!["mode", "limit"].includes(field)) throw new StockCatalogError("invalid_request", 400);
  }
  const mode = raw.mode;
  if (mode !== "dedupe" && mode !== "classify") throw new StockCatalogError("invalid_request", 400);
  const limit = raw.limit === undefined ? STOCK_CATALOG_DEFAULT_LIMIT : raw.limit;
  if (
    typeof limit !== "number"
    || !Number.isInteger(limit)
    || limit < STOCK_CATALOG_MIN_LIMIT
    || limit > STOCK_CATALOG_MAX_LIMIT
  ) {
    throw new StockCatalogError("invalid_request", 400);
  }
  return { mode, limit };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function evaluationCost(evaluation: JevEvaluation | undefined): number {
  return evaluation?.cost != null && Number.isFinite(evaluation.cost) ? evaluation.cost : 0;
}

function jevAnswer(evaluation: JevEvaluation): Record<string, unknown> {
  return {
    mode: evaluation.mode,
    p_same: evaluation.p_same,
    item_class: evaluation.item_class,
    class_probability: evaluation.class_probability,
    class_confidence: evaluation.class_confidence,
    usage: evaluation.usage,
    cost: evaluation.cost,
  };
}

export function createStockCatalogHandler(deps: StockCatalogHandlerDeps) {
  const now = deps.now ?? (() => new Date());
  const concurrency = Math.max(1, Math.min(deps.concurrency ?? STOCK_CATALOG_MAX_CONCURRENCY, STOCK_CATALOG_MAX_CONCURRENCY));

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

    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(STOCK_CATALOG_REQUEST_BUDGET_MS)]);
    const deadlineAt = Date.now() + STOCK_CATALOG_REQUEST_BUDGET_MS;
    try {
      await deps.authenticate(req, signal);
      signal.throwIfAborted();
      if (deps.killSwitch()) throw new StockCatalogError("disabled", 503);
      const raw = await readBody(req, signal);
      const input = parseInput(raw);
      signal.throwIfAborted();

      const usageDate = vietnamDate(now().toISOString());
      const usage = await deps.getUsage(usageDate);
      const callLimit = Number.isFinite(usage.call_limit) && usage.call_limit > 0 ? usage.call_limit : STOCK_CATALOG_DAILY_CALL_LIMIT;
      const remainingQuota = Math.max(0, callLimit - usage.calls);
      const budget = Math.min(input.limit, remainingQuota, STOCK_CATALOG_MAX_LIMIT);

      let evaluator: JevEvaluator | null = null;
      try {
        evaluator = deps.evaluator();
      } catch {
        evaluator = null;
      }

      let candidates = 0;
      let suggestions = 0;
      let skippedExisting = 0;
      let failed = 0;
      let calls = 0;
      let cost = 0;
      const rows: StockCatalogSuggestionRow[] = [];

      if (budget > 0) {
        if (input.mode === "dedupe") {
          const all = await deps.listCandidates();
          candidates = all.length;
          const existing = new Set(await deps.listExistingMergePairKeys(JEV_PROMPT_VERSION));
          const fresh = all.filter((pair) => !existing.has(candidatePairKey(pair.left_id, pair.right_id)));
          skippedExisting = all.length - fresh.length;
          const batch = fresh.slice(0, budget);
          const results = await mapWithConcurrency<StockCatalogCandidate, DedupeOutcome>(batch, concurrency, async (pair) => {
            if (!evaluator) return { pair, error: new StockCatalogError("unconfigured", 503) };
            try {
              const evaluation = await evaluator({
                mode: "same_item",
                state: buildSameItemState(pair),
                signal,
                deadlineAt,
              });
              return { pair, evaluation };
            } catch (error) {
              return { pair, error };
            }
          });
          for (const result of results) {
            if (evaluator) calls += 1;
            if (result.error) {
              failed += 1;
              continue;
            }
            const evaluation = result.evaluation as JevEvaluation;
            cost += evaluationCost(evaluation);
            if (evaluation.p_same == null || evaluation.p_same < STOCK_CATALOG_MIN_PROBABILITY) continue;
            const selection = selectPrimaryItem(result.pair);
            const factor = selection.factor != null && Number.isFinite(selection.factor) && selection.factor > 0
              ? selection.factor
              : null;
            rows.push({
              kind: "merge",
              item_id: selection.source.id,
              other_item_id: selection.target.id,
              proposed_target_id: selection.target.id,
              proposed_factor: factor,
              factor_source: factor === null ? "none" : "unit_rule",
              proposed_class: null,
              probability: evaluation.p_same,
              jev_answer: jevAnswer(evaluation),
              prompt_version: JEV_PROMPT_VERSION,
              cost: evaluation.cost ?? null,
            });
          }
        } else {
          const all = await deps.listUnclassifiedItems(JEV_PROMPT_VERSION);
          candidates = all.length;
          const batch = all.slice(0, budget);
          const results = await mapWithConcurrency<StockCatalogClassifyItem, ClassifyOutcome>(batch, concurrency, async (item) => {
            if (!evaluator) return { item, error: new StockCatalogError("unconfigured", 503) };
            try {
              const corrections = (item as ClassifyItemWithCorrections).corrections;
              const evaluation = await evaluator({
                mode: "item_class",
                state: buildClassifyState(item),
                signal,
                deadlineAt,
                ...(corrections && corrections.length ? { corrections } : {}),
              });
              return { item, evaluation };
            } catch (error) {
              return { item, error };
            }
          });
          for (const result of results) {
            if (evaluator) calls += 1;
            if (result.error) {
              failed += 1;
              continue;
            }
            const evaluation = result.evaluation as JevEvaluation;
            cost += evaluationCost(evaluation);
            if (!evaluation.item_class) continue;
            rows.push({
              kind: "classify",
              item_id: result.item.id,
              other_item_id: null,
              proposed_target_id: null,
              proposed_factor: null,
              factor_source: null,
              proposed_class: evaluation.item_class,
              probability: evaluation.class_probability ?? 0,
              jev_answer: jevAnswer(evaluation),
              prompt_version: JEV_PROMPT_VERSION,
              cost: evaluation.cost ?? null,
            });
          }
        }
      }

      let insertResult: InsertSuggestionsResult = { inserted: 0, auto: { applied: 0, skipped: {} } };
      if (rows.length > 0) insertResult = await deps.insertSuggestions(rows);
      suggestions = insertResult.inserted;

      if (calls > 0 || cost > 0) {
        await deps.recordUsage({
          usage_date: usageDate,
          calls: usage.calls + calls,
          cost: usage.cost + cost,
          call_limit: callLimit,
        });
      }

      const firstFailure = failed > 0 ? "jev_pair_failed" : null;
      deps.audit?.({
        event: "stock_catalog_jev",
        mode: input.mode,
        candidates,
        suggestions,
        skippedExisting,
        failed,
        calls,
        cost,
        firstFailure,
      });

      const summary: StockCatalogSummary = {
        mode: input.mode,
        candidates,
        suggestions,
        skipped_existing: skippedExisting,
        failed,
        calls,
        cost,
        usage: { date: usageDate, calls: usage.calls + calls, limit: callLimit },
        stopped: budget <= 0 ? "daily_limit" : null,
        auto_applied: insertResult.auto.applied,
        auto_skipped: insertResult.auto.skipped,
      };
      return json(summary);
    } catch (error) {
      const code = signal.aborted
        ? "timeout"
        : error instanceof StockCatalogError
          ? error.code
          : error instanceof JevError
            ? error.code
            : "scan_failed";
      const status = signal.aborted
        ? 504
        : error instanceof StockCatalogError
          ? error.status
          : error instanceof JevError
            ? error.status
            : 503;
      deps.audit?.({ event: "stock_catalog_jev_error", code, status });
      return json({ error: MESSAGES[code] ?? MESSAGES.scan_failed, code }, status);
    }
  };
}
