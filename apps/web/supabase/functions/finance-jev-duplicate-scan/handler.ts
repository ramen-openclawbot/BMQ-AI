// Owner-only HTTP shell for the finance Jev duplicate scan.
//
// It authenticates the caller server-side, enforces a body budget, builds the
// candidate pairs in code (Jev never selects its own candidates), asks Jev for
// two independent judgments per pair and routes the result through a temporary
// threshold policy. `dry_run` returns the items without writing anything; `run`
// upserts the Jev result by pair_key and never touches an existing CEO
// review_decision. There is no path that changes a payment, allocation, PO,
// goods receipt or invoice.

import {
  CANDIDATE_DEFAULT_LIMIT,
  CANDIDATE_MAX_LIMIT,
  CANDIDATE_MIN_LIMIT,
  selectCandidateBatch,
  buildCandidatePairs,
  type CandidatePair,
  type CandidateRequest,
  type ExistingStateHash,
} from "./candidates.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { JEV_MODEL, JEV_PROMPT_VERSION, JevError, type JevEvaluator, type JevEvaluation, type JevRelation } from "./jev.ts";
import { decideJevStatus, type JevDuplicateStatus } from "./policy.ts";
import { buildPairState, stateHash, type JevPairState, type RequestStateInput } from "./state.ts";

export const JEV_SCAN_REQUEST_BODY_LIMIT = 16_384;
export const JEV_SCAN_REQUEST_BUDGET_MS = 110_000;
export const JEV_SCAN_DEFAULT_DAYS = 90;
export const JEV_SCAN_MIN_DAYS = 1;
export const JEV_SCAN_MAX_DAYS = 400;
export const JEV_SCAN_LOOKBACK_LIMIT = 2_000;
export const JEV_SCAN_MAX_PAIR_KEYS = 100;
export const JEV_SCAN_MAX_CONCURRENCY = 4;

export type JevDuplicateMode = "dry_run" | "run";

export class JevScanError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "JevScanError";
  }
}

export interface ExistingCheck extends ExistingStateHash {
  pr_older: string;
  pr_newer: string;
}

export interface JevDuplicateDataSource {
  /** Fixed SELECT of non-rejected, priced phiếu in the window (or exact ids). */
  listRequests(input: { sinceIso: string; ids?: string[] }): Promise<CandidateRequest[]>;
  /** Fixed SELECT of prior check rows, optionally limited to pair_keys. */
  listExistingChecks(pairKeys?: string[]): Promise<ExistingCheck[]>;
  /** Fixed SELECTs for the named ids; supplier names keyed by supplier id. */
  loadContext(input: { requestIds: string[]; supplierIds: string[] }): Promise<{
    supplierNames: Record<string, string | null>;
    requests: Record<string, RequestStateInput>;
  }>;
}

/** Service-role writer. Only `run` reaches it; `dry_run` never calls it. */
export interface JevDuplicateSink {
  upsertChecks(rows: JevCheckRow[]): Promise<void>;
}

export interface JevCheckRow {
  pair_key: string;
  pr_older: string;
  pr_newer: string;
  supplier_id: string | null;
  amount_older: number;
  amount_newer: number;
  days_apart: number;
  state_hash: string;
  p_same: number;
  relation: JevRelation;
  relation_prob: number;
  relation_confidence: number | null;
  status: JevDuplicateStatus;
  model: string;
  prompt_version: string;
  checked_at: string;
  // review_decision / review_note / reviewed_by / reviewed_at are deliberately
  // absent: the upsert must never overwrite a CEO decision.
}

export interface JevScanItem {
  pair_key: string;
  pr_older: string;
  pr_newer: string;
  older_request: string;
  newer_request: string;
  status: JevDuplicateStatus | null;
  p_same: number | null;
  relation: string | null;
  relation_probability: number | null;
  relation_confidence: number | null;
  error: string | null;
}

export interface JevScanSummary {
  mode: JevDuplicateMode;
  candidates: number;
  checked: number;
  auto_clear: number;
  needs_review: number;
  auto_flag: number;
  failed: number;
  skipped_unchanged: number;
  items?: JevScanItem[];
}

export interface JevDuplicateScanConfig {
  killSwitch: () => boolean;
  evaluator: () => JevEvaluator | null;
  dataSource: () => JevDuplicateDataSource;
  sink: () => JevDuplicateSink;
  authenticate: (request: Request, signal: AbortSignal) => Promise<{ userId: string }>;
  now?: () => Date;
  concurrency?: number;
  audit?: (event: Record<string, unknown>) => void;
}

interface ParsedInput {
  mode: JevDuplicateMode;
  limit: number;
  days: number;
  pairKeys: string[] | null;
}

interface EvalOutcome {
  pair: CandidatePair;
  evaluation?: JevEvaluation;
  error?: unknown;
}

const MESSAGES: Record<string, string> = {
  disabled: "Tính năng quét trùng Jev đang tắt.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Tính năng quét trùng Jev chỉ dành cho chủ doanh nghiệp.",
  invalid_content_type: "Yêu cầu quét trùng Jev phải là JSON.",
  invalid_json: "Nội dung yêu cầu quét trùng Jev không hợp lệ.",
  invalid_request: "Yêu cầu quét trùng Jev không hợp lệ.",
  body_limit: "Yêu cầu quét trùng Jev quá lớn.",
  unconfigured: "Máy chủ chưa cấu hình khoá AI Gateway cho Jev.",
  scan_failed: "Chưa thể quét trùng Jev. Không có thay đổi nào được ghi.",
  timeout: "Quét trùng Jev vượt thời gian cho phép. Không có thay đổi nào được ghi.",
};

function jsonBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    throw new JevScanError("invalid_content_type", 415);
  }
  if (!req.body) throw new JevScanError("invalid_request", 400);
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
      if (size > JEV_SCAN_REQUEST_BODY_LIMIT) { await reader.cancel(); throw new JevScanError("body_limit", 413); }
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
    throw new JevScanError("invalid_json", 400);
  }
}

function parseInput(raw: Record<string, unknown>): ParsedInput {
  for (const field of Object.keys(raw)) {
    if (!["mode", "limit", "days", "pair_keys"].includes(field)) throw new JevScanError("invalid_request", 400);
  }
  const mode = raw.mode === undefined ? "dry_run" : raw.mode;
  if (mode !== "dry_run" && mode !== "run") throw new JevScanError("invalid_request", 400);
  const limit = raw.limit === undefined ? CANDIDATE_DEFAULT_LIMIT : raw.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < CANDIDATE_MIN_LIMIT || limit > CANDIDATE_MAX_LIMIT) {
    throw new JevScanError("invalid_request", 400);
  }
  const days = raw.days === undefined ? JEV_SCAN_DEFAULT_DAYS : raw.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < JEV_SCAN_MIN_DAYS || days > JEV_SCAN_MAX_DAYS) {
    throw new JevScanError("invalid_request", 400);
  }
  let pairKeys: string[] | null = null;
  if (raw.pair_keys !== undefined) {
    if (!Array.isArray(raw.pair_keys) || raw.pair_keys.length === 0 || raw.pair_keys.length > JEV_SCAN_MAX_PAIR_KEYS) {
      throw new JevScanError("invalid_request", 400);
    }
    pairKeys = raw.pair_keys.map((key) => {
      if (typeof key !== "string" || key.trim() === "" || key.length > 200) throw new JevScanError("invalid_request", 400);
      return key.trim();
    });
  }
  return { mode, limit, days, pairKeys };
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

export function createJevScanHandler(config: JevDuplicateScanConfig) {
  const now = config.now ?? (() => new Date());
  const concurrency = Math.max(1, Math.min(config.concurrency ?? JEV_SCAN_MAX_CONCURRENCY, JEV_SCAN_MAX_CONCURRENCY));

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

    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(JEV_SCAN_REQUEST_BUDGET_MS)]);
    const deadlineAt = Date.now() + JEV_SCAN_REQUEST_BUDGET_MS;
    try {
      await config.authenticate(req, signal);
      signal.throwIfAborted();
      if (config.killSwitch()) throw new JevScanError("disabled", 503);
      const raw = await readBody(req, signal);
      const input = parseInput(raw);
      signal.throwIfAborted();

      const source = config.dataSource();
      const pairKeySet = input.pairKeys ? new Set(input.pairKeys) : null;
      let requests: CandidateRequest[];
      let existing: ExistingCheck[];
      if (input.pairKeys) {
        existing = await source.listExistingChecks(input.pairKeys);
        const ids = [...new Set(existing.flatMap((row) => [row.pr_older, row.pr_newer]))];
        requests = ids.length > 0 ? await source.listRequests({ sinceIso: "", ids }) : [];
      } else {
        const sinceIso = new Date(now().getTime() - input.days * 86_400_000).toISOString();
        requests = await source.listRequests({ sinceIso });
        existing = await source.listExistingChecks();
      }
      signal.throwIfAborted();

      const allPairs = buildCandidatePairs(requests);
      const requestIds = [...new Set(allPairs.flatMap((pair) => [pair.pr_older, pair.pr_newer]))];
      const supplierIds = [...new Set(allPairs.map((pair) => pair.supplier_id))];
      const context = await source.loadContext({ requestIds, supplierIds });
      const usableRequests = requests.filter((row) => context.requests[row.id] !== undefined);

      const stateByPair = new Map<string, JevPairState>();
      const hashByPair = new Map<string, string>();
      for (const pair of allPairs) {
        const older = context.requests[pair.pr_older];
        const newer = context.requests[pair.pr_newer];
        if (!older || !newer) continue;
        const state = buildPairState({ supplier_name: context.supplierNames[pair.supplier_id] ?? null, older, newer });
        stateByPair.set(pair.pair_key, state);
        hashByPair.set(pair.pair_key, await stateHash(state));
      }

      const selection = await selectCandidateBatch(usableRequests, {
        limit: input.limit,
        existing,
        pairKeys: pairKeySet ?? undefined,
        stateHashOf: (pair) => hashByPair.get(pair.pair_key) ?? "",
      });
      signal.throwIfAborted();

      let evaluator: JevEvaluator | null = null;
      try {
        evaluator = config.evaluator();
      } catch {
        evaluator = null;
      }

      const rows: JevCheckRow[] = [];
      const items: JevScanItem[] = [];
      let checked = 0;
      let failed = 0;
      let autoClear = 0;
      let needsReview = 0;
      let autoFlag = 0;

      const results = await mapWithConcurrency<CandidatePair, EvalOutcome>(selection.pairs, concurrency, async (pair) => {
        if (!evaluator) return { pair, error: new JevScanError("unconfigured", 503) };
        try {
          const evaluation = await evaluator({ state: stateByPair.get(pair.pair_key), signal, deadlineAt });
          return { pair, evaluation };
        } catch (error) {
          return { pair, error };
        }
      });

      for (const result of results) {
        const pair = result.pair;
        if (result.error) {
          failed += 1;
          items.push({
            pair_key: pair.pair_key,
            pr_older: pair.pr_older,
            pr_newer: pair.pr_newer,
            older_request: pair.older.request_number,
            newer_request: pair.newer.request_number,
            status: null,
            p_same: null,
            relation: null,
            relation_probability: null,
            relation_confidence: null,
            error: result.error instanceof JevError
              ? (result.error.detail ? `${result.error.code} (${result.error.detail})` : result.error.code)
              : result.error instanceof JevScanError ? result.error.code : "jev_unavailable",
          });
          continue;
        }
        const evaluation = result.evaluation as JevEvaluation;
        const status = decideJevStatus({
          p_same: evaluation.p_same,
          relation: evaluation.relation,
          relation_probability: evaluation.relation_probability,
        });
        checked += 1;
        if (status === "auto_clear") autoClear += 1;
        else if (status === "needs_review") needsReview += 1;
        else autoFlag += 1;
        const stateHashValue = hashByPair.get(pair.pair_key) ?? "";
        rows.push({
          pair_key: pair.pair_key,
          pr_older: pair.pr_older,
          pr_newer: pair.pr_newer,
          supplier_id: pair.supplier_id,
          amount_older: pair.amount_older,
          amount_newer: pair.amount_newer,
          days_apart: pair.days_apart,
          state_hash: stateHashValue,
          p_same: evaluation.p_same,
          relation: evaluation.relation,
          relation_prob: evaluation.relation_probability,
          relation_confidence: evaluation.relation_confidence,
          status,
          model: JEV_MODEL,
          prompt_version: JEV_PROMPT_VERSION,
          checked_at: now().toISOString(),
        });
        items.push({
          pair_key: pair.pair_key,
          pr_older: pair.pr_older,
          pr_newer: pair.pr_newer,
          older_request: pair.older.request_number,
          newer_request: pair.newer.request_number,
          status,
          p_same: evaluation.p_same,
          relation: evaluation.relation,
          relation_probability: evaluation.relation_probability,
          relation_confidence: evaluation.relation_confidence,
          error: null,
        });
      }

      // dry_run returns the items and never writes. run upserts only the Jev
      // result; an existing review_decision is untouched by the upsert.
      if (input.mode === "run" && rows.length > 0) {
        await config.sink().upsertChecks(rows);
      }

      const summary: JevScanSummary = {
        mode: input.mode,
        candidates: selection.candidates,
        checked,
        auto_clear: autoClear,
        needs_review: needsReview,
        auto_flag: autoFlag,
        failed,
        skipped_unchanged: selection.skipped_unchanged,
      };
      if (input.mode === "dry_run") summary.items = items;
      {
        const firstFailure = items.find((item) => item.error && item.error.includes("HTTP "));
        if (firstFailure) config.audit?.({ event: "finance_jev_provider_error", detail: firstFailure.error });
      }
      config.audit?.({
        event: "finance_jev_duplicate_scan",
        mode: input.mode,
        candidates: summary.candidates,
        checked,
        failed,
        skippedUnchanged: summary.skipped_unchanged,
      });
      return json(summary);
    } catch (error) {
      const code = signal.aborted ? "timeout" : error instanceof JevScanError ? error.code : "scan_failed";
      const status = signal.aborted ? 504 : error instanceof JevScanError ? error.status : 503;
      config.audit?.({ event: "finance_jev_duplicate_scan_error", code, status });
      return json({ error: MESSAGES[code] ?? MESSAGES.scan_failed, code }, status);
    }
  };
}
