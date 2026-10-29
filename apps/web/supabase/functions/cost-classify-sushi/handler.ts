// HTTP shell for Sushi cost classification.
//
// It authenticates the caller server-side (a valid 'sushi-cost' worker secret
// or an owner user token), enforces a body budget and asks one Decisions choice
// question per unclassified expense line. Every write goes through the audited
// service-role RPC robot_apply_cost_classification, which owns the manual
// override / approved guard and the robot_settings.cost_daily_cap. A low
// probability is written as UNMAPPED_REVIEW with the Sushi top choice noted.
//
// `dry_run: true` returns the decisions without calling the writer.

import { getCorsHeaders } from "../_shared/cors.ts";
import {
  JevError,
  PRODUCT_LINE_THRESHOLD,
  allowedOptions,
  buildCostState,
  formatCostCorrection,
  type CostCategoryOption,
  type CostClassificationCandidate,
  type CostEvaluator,
  type CostFeedbackRow,
  type ProductLineCode,
} from "./jev.ts";

export const COST_CLASSIFY_REQUEST_BODY_LIMIT = 32_768;
export const COST_CLASSIFY_REQUEST_BUDGET_MS = 110_000;
export const COST_CLASSIFY_MAX_LIMIT = 50;
export const COST_CLASSIFY_DEFAULT_THRESHOLD = 0.95;
export const COST_CLASSIFY_DEFAULT_DAILY_CAP = 200;

export class CostClassifyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "CostClassifyError";
    this.code = code;
    this.status = status;
  }
}

export interface CostSettings {
  cost_threshold: number;
  cost_daily_cap: number;
  cost_auto_enabled: boolean;
}

export interface CostCategoryRow {
  code: string;
  label: string;
  parent_code?: string | null;
  sushi_hint?: string | null;
  is_active?: boolean;
  sort_order?: number;
}

export interface ApplyCostInput {
  source_type: string;
  source_line_id: string;
  category_code: string;
  probability: number;
  note: string;
  product_line: ProductLineCode;
}

export interface ApplyCostResult {
  status: string;
  reason?: string;
  classification_id?: string;
  action_id?: string;
  category_code?: string;
  product_line?: string;
  review_status?: string;
}

export interface CostLineResult {
  source_type: string;
  source_line_id: string;
  status: string;
  category_code?: string;
  product_line?: ProductLineCode;
  probability?: number;
  review_status?: string;
  note?: string;
  reason?: string;
  classification_id?: string;
  action_id?: string;
}

export interface CostClassifyHandlerDeps {
  evaluator: () => CostEvaluator | null;
  authenticate: (request: Request, signal: AbortSignal) => Promise<{ userId: string; owner: boolean }>;
  /** The shared secret for worker 'sushi-cost'; missing => no worker access. */
  getWorkerSecret?: () => Promise<string | null>;
  getSettings: () => Promise<CostSettings>;
  listCategories: () => Promise<CostCategoryRow[]>;
  listCandidates: (limit: number) => Promise<CostClassificationCandidate[]>;
  getFeedback: (subjectKeys: string[]) => Promise<CostFeedbackRow[]>;
  apply: (input: ApplyCostInput) => Promise<ApplyCostResult>;
  audit?: (event: Record<string, unknown>) => void;
}

interface ParsedInput {
  limit: number;
  dryRun: boolean;
  mode: "batch" | "suggest";
  suggest?: {
    supplierName: string;
    description: string;
    amount: number | null;
  };
}

const MESSAGES: Record<string, string> = {
  disabled: "Tính năng tự phân loại chi phí bằng Sushi đang tắt.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Tính năng tự phân loại chi phí chỉ dành cho chủ.",
  invalid_content_type: "Yêu cầu phân loại chi phí phải là JSON.",
  invalid_json: "Nội dung yêu cầu phân loại chi phí không hợp lệ.",
  invalid_request: "Yêu cầu phân loại chi phí không hợp lệ.",
  body_limit: "Yêu cầu phân loại chi phí quá lớn.",
  unconfigured: "Máy chủ chưa cấu hình khoá AI Gateway hoặc danh mục chi phí cho Sushi.",
  scan_failed: "Chưa thể phân loại chi phí. Không có thay đổi nào được ghi.",
  timeout: "Phân loại chi phí vượt thời gian cho phép. Không có thay đổi nào được ghi.",
};

function jsonBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Constant-time string compare for the worker secret. Kept local so the pure
 * handler does not pull Deno / https imports into the test bundle.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readBody(req: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    throw new CostClassifyError("invalid_content_type", 415);
  }
  if (!req.body) throw new CostClassifyError("invalid_request", 400);
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
      if (size > COST_CLASSIFY_REQUEST_BODY_LIMIT) {
        await reader.cancel();
        throw new CostClassifyError("body_limit", 413);
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
    throw new CostClassifyError("invalid_json", 400);
  }
}

function parseInput(raw: Record<string, unknown>): ParsedInput {
  if (raw.mode !== undefined) {
    if (raw.mode !== "suggest") throw new CostClassifyError("invalid_request", 400);
    for (const field of Object.keys(raw)) {
      if (field !== "mode" && field !== "supplier_name" && field !== "description" && field !== "amount") {
        throw new CostClassifyError("invalid_request", 400);
      }
    }
    if (typeof raw.description !== "string" || raw.description.trim() === "" || raw.description.length > 500) {
      throw new CostClassifyError("invalid_request", 400);
    }
    if (
      raw.supplier_name !== undefined && raw.supplier_name !== null
      && (typeof raw.supplier_name !== "string" || raw.supplier_name.length > 200)
    ) {
      throw new CostClassifyError("invalid_request", 400);
    }
    if (raw.amount !== undefined && raw.amount !== null) {
      if (typeof raw.amount !== "number" || !Number.isFinite(raw.amount) || raw.amount < 0) {
        throw new CostClassifyError("invalid_request", 400);
      }
    }
    return {
      limit: 0,
      dryRun: true,
      mode: "suggest",
      suggest: {
        supplierName: typeof raw.supplier_name === "string" ? raw.supplier_name.trim() : "",
        description: raw.description.trim(),
        amount: typeof raw.amount === "number" ? raw.amount : null,
      },
    };
  }
  for (const field of Object.keys(raw)) {
    if (field !== "limit" && field !== "dry_run") {
      throw new CostClassifyError("invalid_request", 400);
    }
  }
  let limit = COST_CLASSIFY_MAX_LIMIT;
  if (raw.limit !== undefined && raw.limit !== null) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1) {
      throw new CostClassifyError("invalid_request", 400);
    }
    limit = Math.min(raw.limit, COST_CLASSIFY_MAX_LIMIT);
  }
  if (raw.dry_run !== undefined && typeof raw.dry_run !== "boolean") {
    throw new CostClassifyError("invalid_request", 400);
  }
  return { limit, dryRun: raw.dry_run === true, mode: "batch" };
}

function thresholdOf(settings: CostSettings): number {
  if (settings.cost_threshold === null || settings.cost_threshold === undefined) {
    return COST_CLASSIFY_DEFAULT_THRESHOLD;
  }
  const value = Number(settings.cost_threshold);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : COST_CLASSIFY_DEFAULT_THRESHOLD;
}

function formatPercent(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

function categoryCriterion(row: CostCategoryRow): string {
  const label = typeof row.label === "string" ? row.label : "";
  const hint = typeof row.sushi_hint === "string" ? row.sushi_hint.trim() : "";
  return hint !== "" ? `${label} — ví dụ: ${hint}` : label;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function fallbackSubjectKey(candidate: CostClassificationCandidate): string {
  return `${candidate.supplier_id ?? ""}|${String(candidate.product_name ?? "").toLowerCase()}`;
}

export function createCostClassifyHandler(deps: CostClassifyHandlerDeps) {
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

    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(COST_CLASSIFY_REQUEST_BUDGET_MS)]);
    const deadlineAt = Date.now() + COST_CLASSIFY_REQUEST_BUDGET_MS;
    try {
      const workerHeader = req.headers.get("x-worker-secret");
      if (workerHeader !== null) {
        // Worker path: the shared secret is the only credential. Never fall back
        // to user auth when the header is present.
        const storedSecret = typeof deps.getWorkerSecret === "function" ? await deps.getWorkerSecret() : null;
        if (storedSecret === null || storedSecret === "" || !timingSafeEqual(workerHeader, storedSecret)) {
          throw new CostClassifyError("unauthorized", 401);
        }
      } else {
        const auth = await deps.authenticate(req, signal);
        if (!auth.owner) throw new CostClassifyError("forbidden", 403);
      }
      signal.throwIfAborted();

      const raw = await readBody(req, signal);
      const input = parseInput(raw);
      signal.throwIfAborted();

      const settings = await deps.getSettings();
      if (settings.cost_auto_enabled === false) throw new CostClassifyError("disabled", 503);
      const threshold = thresholdOf(settings);

      const rows = await deps.listCategories();
      const activeRows = rows.filter((row) => row.is_active !== false && hasText(row.code));
      const activeParentCodes = new Set(
        activeRows.map((row) => row.parent_code).filter((code): code is string => hasText(code)),
      );
      const options: CostCategoryOption[] = activeRows
        .filter((row) =>
          row.code !== "UNMAPPED_REVIEW"
          && !activeParentCodes.has(row.code)
          && hasText(row.label))
        .map((row) => ({ code: row.code, label: categoryCriterion(row) }));

      if (input.mode === "suggest") {
        // Read-only single-line suggestion for the merchant bank-slip card.
        // Only an owner bearer token may call it; a worker-secret caller never
        // reaches the provider through this mode.
        if (workerHeader !== null) throw new CostClassifyError("forbidden", 403);
        if (options.length < 2) return json({ category_code: null, reason: "unconfigured" });

        let suggestEvaluator: CostEvaluator | null = null;
        try {
          suggestEvaluator = deps.evaluator();
        } catch {
          suggestEvaluator = null;
        }
        if (!suggestEvaluator) return json({ category_code: null, reason: "unconfigured" });

        const suggest = input.suggest!;
        const candidate: CostClassificationCandidate = {
          source_type: "chat_suggest",
          source_line_id: "chat_suggest",
          supplier_name: suggest.supplierName || null,
          product_name: suggest.description,
          line_amount: suggest.amount,
        };
        let evaluation;
        try {
          evaluation = await suggestEvaluator({
            state: buildCostState(candidate),
            options,
            signal,
            deadlineAt,
          });
        } catch (error) {
          const reason = error instanceof JevError ? error.code : "jev_unavailable";
          return json({ category_code: null, reason });
        }
        if (evaluation === null) return json({ category_code: null, reason: "jev_no_answer" });

        const chosenRow = activeRows.find((row) => row.code === evaluation.category_code);
        const productLine: ProductLineCode = evaluation.product_line_probability >= PRODUCT_LINE_THRESHOLD
          ? evaluation.product_line
          : "shared";
        return json({
          category_code: evaluation.category_code,
          label: chosenRow?.label ?? null,
          probability: evaluation.probability,
          product_line: productLine,
        });
      }

      if (options.length < 2) throw new CostClassifyError("unconfigured", 503);

      let evaluator: CostEvaluator | null = null;
      try {
        evaluator = deps.evaluator();
      } catch {
        evaluator = null;
      }
      if (!evaluator) throw new CostClassifyError("unconfigured", 503);

      const candidates = (await deps.listCandidates(input.limit)).slice(0, input.limit);
      const subjectKeys = [...new Set(
        candidates.map((candidate) => candidate.subject_key ?? fallbackSubjectKey(candidate)).filter((key) => key !== ""),
      )];

      let feedback: CostFeedbackRow[] = [];
      if (subjectKeys.length > 0) {
        try {
          feedback = await deps.getFeedback(subjectKeys);
        } catch {
          feedback = [];
        }
      }
      const feedbackBySubject = new Map<string, CostFeedbackRow[]>();
      for (const row of feedback) {
        const list = feedbackBySubject.get(row.subject_key) ?? [];
        if (list.length < 5) list.push(row);
        feedbackBySubject.set(row.subject_key, list);
      }

      let applied = 0;
      let needsReview = 0;
      let skipped = 0;
      let capReached = 0;
      let errors = 0;
      let stopped: string | null = null;
      const results: CostLineResult[] = [];

      for (const candidate of candidates) {
        signal.throwIfAborted();
        const subjectKey = candidate.subject_key ?? fallbackSubjectKey(candidate);
        const corrections = (feedbackBySubject.get(subjectKey) ?? []).slice(0, 5).map(formatCostCorrection);
        const state = buildCostState(candidate, corrections);

        let evaluation;
        try {
          evaluation = await evaluator({ state, options, signal, deadlineAt });
        } catch (error) {
          errors += 1;
          const code = error instanceof JevError ? error.code : "jev_unavailable";
          results.push({
            source_type: candidate.source_type,
            source_line_id: candidate.source_line_id,
            status: "error",
            reason: code,
          });
          continue;
        }
        if (evaluation === null) {
          errors += 1;
          results.push({
            source_type: candidate.source_type,
            source_line_id: candidate.source_line_id,
            status: "error",
            reason: "jev_no_answer",
          });
          continue;
        }

        const categoryCode = evaluation.probability >= threshold
          ? evaluation.category_code
          : "UNMAPPED_REVIEW";
        const productLine: ProductLineCode = evaluation.product_line_probability >= PRODUCT_LINE_THRESHOLD
          ? evaluation.product_line
          : "shared";
        const reviewStatus = categoryCode === "UNMAPPED_REVIEW" ? "needs_review" : "suggested";
        const note = categoryCode === "UNMAPPED_REVIEW"
          ? `Sushi chọn ${evaluation.category_code} (${formatPercent(evaluation.probability)}) — cần review`
          : `Sushi chọn ${evaluation.category_code} (${formatPercent(evaluation.probability)})`;

        if (input.dryRun) {
          if (categoryCode === "UNMAPPED_REVIEW") needsReview += 1;
          else applied += 1;
          results.push({
            source_type: candidate.source_type,
            source_line_id: candidate.source_line_id,
            status: "dry_run",
            category_code: categoryCode,
            product_line: productLine,
            probability: evaluation.probability,
            review_status: reviewStatus,
            note,
          });
          continue;
        }

        const outcome = await deps.apply({
          source_type: candidate.source_type,
          source_line_id: candidate.source_line_id,
          category_code: categoryCode,
          probability: evaluation.probability,
          note,
          product_line: productLine,
        });

        if (outcome.status === "applied") {
          const writtenReviewStatus = outcome.review_status ?? reviewStatus;
          const writtenCategory = outcome.category_code ?? categoryCode;
          if (writtenReviewStatus === "needs_review" || writtenCategory === "UNMAPPED_REVIEW") needsReview += 1;
          else applied += 1;
          results.push({
            source_type: candidate.source_type,
            source_line_id: candidate.source_line_id,
            status: "applied",
            category_code: writtenCategory,
            product_line: productLine,
            probability: evaluation.probability,
            review_status: writtenReviewStatus,
            note,
            classification_id: outcome.classification_id,
            action_id: outcome.action_id,
          });
        } else if (outcome.status === "skipped") {
          skipped += 1;
          results.push({
            source_type: candidate.source_type,
            source_line_id: candidate.source_line_id,
            status: "skipped",
            reason: outcome.reason ?? "skipped",
            probability: evaluation.probability,
          });
        } else if (outcome.status === "cap_reached") {
          capReached += 1;
          stopped = "cap_reached";
          results.push({
            source_type: candidate.source_type,
            source_line_id: candidate.source_line_id,
            status: "cap_reached",
          });
          break;
        } else {
          errors += 1;
          results.push({
            source_type: candidate.source_type,
            source_line_id: candidate.source_line_id,
            status: "error",
            reason: outcome.reason ?? outcome.status ?? "apply_failed",
          });
        }
      }

      deps.audit?.({
        event: "cost_classify_sushi",
        dry_run: input.dryRun,
        candidates: candidates.length,
        applied,
        needs_review: needsReview,
        skipped,
        cap_reached: capReached,
        errors,
      });

      return json({
        candidates: candidates.length,
        applied,
        needs_review: needsReview,
        skipped,
        cap_reached: capReached,
        errors,
        dry_run: input.dryRun,
        threshold,
        stopped,
        results,
      });
    } catch (error) {
      const code = signal.aborted
        ? "timeout"
        : error instanceof CostClassifyError
          ? error.code
          : error instanceof JevError
            ? error.code
            : "scan_failed";
      const status = signal.aborted
        ? 504
        : error instanceof CostClassifyError
          ? error.status
          : error instanceof JevError
            ? error.status
            : 503;
      deps.audit?.({ event: "cost_classify_sushi_error", code, status });
      return json({ error: MESSAGES[code] ?? MESSAGES.scan_failed, code }, status);
    }
  };
}

// Re-exported for the tests that build a fake provider response.
export { allowedOptions, buildCostState, formatCostCorrection };
