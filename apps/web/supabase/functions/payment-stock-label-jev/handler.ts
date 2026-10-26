// HTTP shell for the whole payment request stock label (Jev).
//
// It authenticates the caller server-side (a valid 'payment-stock-label-jev'
// worker secret used by pg_cron, or a service-role bearer token), enforces a
// body budget, honours BMQ_JEV_KILL_SWITCH before reading any settings or
// candidates, and asks one Decisions choice question per unlabelled payment
// request. Every write goes through the audited service-role RPC
// apply_payment_request_stock_label_jev, which owns the manual-label guard,
// the enabled switch, the confidence threshold and the run log.
//
// A result below settings.min_confidence is still sent to the writer so the
// jev_* suggestion columns are stored; the writer leaves stock_label_source
// null in that case.

import { getCorsHeaders } from "../_shared/cors.ts";
import {
  buildStockLabelState,
  JEV_MODEL,
  JevError,
  type StockLabelCandidate,
  type StockLabelClass,
  type StockLabelEvaluator,
} from "./jev.ts";

export const STOCK_LABEL_REQUEST_BODY_LIMIT = 32_768;
export const STOCK_LABEL_REQUEST_BUDGET_MS = 110_000;
export const STOCK_LABEL_MAX_LIMIT = 50;
export const STOCK_LABEL_DEFAULT_MIN_CONFIDENCE = 0.9;
export const STOCK_LABEL_DEFAULT_DAILY_LIMIT = 200;

export class StockLabelError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "StockLabelError";
    this.code = code;
    this.status = status;
  }
}

export interface StockLabelSettings {
  enabled: boolean;
  min_confidence: number;
  daily_limit: number;
}

export interface ApplyStockLabelInput {
  request_id: string;
  class: StockLabelClass;
  confidence: number;
  reason: string;
  model: string;
}

export interface ApplyStockLabelResult {
  status: string;
  reason?: string;
  applied?: boolean;
  requires_receipt?: boolean | null;
  no_receipt_reason?: string | null;
  class?: StockLabelClass;
}

export interface StockLabelRunResult {
  request_id: string;
  status: "applied" | "suggested" | "skipped" | "error";
  class?: StockLabelClass;
  confidence?: number;
  reason?: string;
  requires_receipt?: boolean | null;
}

export interface StockLabelHandlerDeps {
  killSwitch: () => boolean;
  evaluator: () => StockLabelEvaluator | null;
  authenticate: (request: Request, signal: AbortSignal) => Promise<{ service: boolean }>;
  /** The shared secret for the pg_cron worker; missing => no cron access. */
  getWorkerSecret?: () => Promise<string | null>;
  getSettings: () => Promise<StockLabelSettings>;
  countToday: () => Promise<number>;
  listCandidates: (limit: number) => Promise<StockLabelCandidate[]>;
  apply: (input: ApplyStockLabelInput) => Promise<ApplyStockLabelResult>;
  audit?: (event: Record<string, unknown>) => void;
}

interface ParsedInput {
  limit: number;
}

const MESSAGES: Record<string, string> = {
  disabled: "Tính năng tự gắn nhãn nhập kho bằng Jev đang tắt.",
  unauthorized: "Phiên gọi không hợp lệ.",
  forbidden: "Chức năng tự gắn nhãn nhập kho chỉ dành cho máy chủ.",
  invalid_content_type: "Yêu cầu gắn nhãn nhập kho phải là JSON.",
  invalid_json: "Nội dung yêu cầu gắn nhãn nhập kho không hợp lệ.",
  invalid_request: "Yêu cầu gắn nhãn nhập kho không hợp lệ.",
  body_limit: "Yêu cầu gắn nhãn nhập kho quá lớn.",
  unconfigured: "Máy chủ chưa cấu hình khoá AI Gateway cho Jev.",
  scan_failed: "Chưa thể gắn nhãn nhập kho. Không có thay đổi nào được ghi.",
  timeout: "Gắn nhãn nhập kho vượt thời gian cho phép. Không có thay đổi nào được ghi.",
};

function jsonBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Constant-time string compare for the worker secret. Kept local so the pure
 * handler does not pull Deno / https imports into the test bundle.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readBody(req: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!req.body) return {};
  if (!req.headers.get("content-type")?.includes("application/json")) {
    throw new StockLabelError("invalid_content_type", 415);
  }
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
      if (size > STOCK_LABEL_REQUEST_BODY_LIMIT) {
        await reader.cancel();
        throw new StockLabelError("body_limit", 413);
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (size === 0) return {};
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!jsonBody(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw new StockLabelError("invalid_json", 400);
  }
}

function parseInput(raw: Record<string, unknown>): ParsedInput {
  for (const field of Object.keys(raw)) {
    if (field !== "limit") throw new StockLabelError("invalid_request", 400);
  }
  let limit = STOCK_LABEL_MAX_LIMIT;
  if (raw.limit !== undefined && raw.limit !== null) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit < 1) {
      throw new StockLabelError("invalid_request", 400);
    }
    limit = Math.min(raw.limit, STOCK_LABEL_MAX_LIMIT);
  }
  return { limit };
}

function thresholdOf(settings: StockLabelSettings): number {
  if (settings.min_confidence === null || settings.min_confidence === undefined) {
    return STOCK_LABEL_DEFAULT_MIN_CONFIDENCE;
  }
  const value = Number(settings.min_confidence);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : STOCK_LABEL_DEFAULT_MIN_CONFIDENCE;
}

function dailyLimitOf(settings: StockLabelSettings): number {
  if (settings.daily_limit === null || settings.daily_limit === undefined) {
    return STOCK_LABEL_DEFAULT_DAILY_LIMIT;
  }
  const value = Number(settings.daily_limit);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : STOCK_LABEL_DEFAULT_DAILY_LIMIT;
}

export function createStockLabelHandler(deps: StockLabelHandlerDeps) {
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

    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(STOCK_LABEL_REQUEST_BUDGET_MS)]);
    const deadlineAt = Date.now() + STOCK_LABEL_REQUEST_BUDGET_MS;
    try {
      // Refuse before reading any settings, candidates or request body.
      if (deps.killSwitch()) throw new StockLabelError("disabled", 503);

      const workerHeader = req.headers.get("x-worker-secret");
      if (workerHeader !== null) {
        // Worker path: the shared secret is the only credential. Never fall back
        // to user auth when the header is present.
        const storedSecret = typeof deps.getWorkerSecret === "function" ? await deps.getWorkerSecret() : null;
        if (storedSecret === null || storedSecret === "" || !timingSafeEqual(workerHeader, storedSecret)) {
          throw new StockLabelError("unauthorized", 401);
        }
      } else {
        const auth = await deps.authenticate(req, signal);
        if (!auth.service) throw new StockLabelError("forbidden", 403);
      }
      signal.throwIfAborted();

      const raw = await readBody(req, signal);
      const input = parseInput(raw);
      signal.throwIfAborted();

      const settings = await deps.getSettings();
      const threshold = thresholdOf(settings);
      if (settings.enabled !== true) {
        deps.audit?.({ event: "payment_stock_label_jev", skipped: "disabled" });
        return json({
          skipped: true,
          reason: "disabled",
          candidates: 0,
          applied: 0,
          suggested: 0,
          skipped_count: 0,
          errors: 0,
          threshold,
          daily_limit: dailyLimitOf(settings),
          used_today: 0,
          stopped: "disabled",
          results: [],
        });
      }

      const dailyLimit = dailyLimitOf(settings);
      const usedToday = await deps.countToday();
      if (dailyLimit <= 0 || usedToday >= dailyLimit) {
        deps.audit?.({ event: "payment_stock_label_jev", skipped: "daily_limit", used_today: usedToday });
        return json({
          skipped: true,
          reason: "daily_limit",
          candidates: 0,
          applied: 0,
          suggested: 0,
          skipped_count: 0,
          errors: 0,
          threshold,
          daily_limit: dailyLimit,
          used_today: usedToday,
          stopped: "daily_limit",
          results: [],
        });
      }

      let evaluator: StockLabelEvaluator | null = null;
      try {
        evaluator = deps.evaluator();
      } catch {
        evaluator = null;
      }
      if (!evaluator) throw new StockLabelError("unconfigured", 503);

      const remaining = Math.min(input.limit, Math.max(0, dailyLimit - usedToday));
      const candidates = (await deps.listCandidates(remaining)).slice(0, remaining);

      let used = usedToday;
      let applied = 0;
      let suggested = 0;
      let skipped = 0;
      let errors = 0;
      let stopped: string | null = null;
      const results: StockLabelRunResult[] = [];

      for (const candidate of candidates) {
        if (used >= dailyLimit) {
          stopped = "daily_limit";
          break;
        }
        signal.throwIfAborted();

        let evaluation;
        try {
          evaluation = await evaluator({
            state: buildStockLabelState(candidate),
            signal,
            deadlineAt,
          });
        } catch (error) {
          errors += 1;
          const code = error instanceof JevError ? error.code : "jev_unavailable";
          results.push({ request_id: candidate.request_id, status: "error", reason: code });
          continue;
        }
        if (evaluation === null) {
          errors += 1;
          results.push({ request_id: candidate.request_id, status: "error", reason: "jev_no_answer" });
          continue;
        }

        used += 1;
        let outcome: ApplyStockLabelResult;
        try {
          outcome = await deps.apply({
            request_id: candidate.request_id,
            class: evaluation.class,
            confidence: evaluation.confidence,
            reason: evaluation.reason,
            model: JEV_MODEL,
          });
        } catch {
          errors += 1;
          results.push({
            request_id: candidate.request_id,
            status: "error",
            class: evaluation.class,
            confidence: evaluation.confidence,
            reason: "apply_failed",
          });
          continue;
        }

        if (outcome.status === "applied") {
          applied += 1;
          results.push({
            request_id: candidate.request_id,
            status: "applied",
            class: outcome.class ?? evaluation.class,
            confidence: evaluation.confidence,
            reason: evaluation.reason,
            requires_receipt: outcome.requires_receipt ?? null,
          });
        } else if (outcome.status === "suggested") {
          suggested += 1;
          results.push({
            request_id: candidate.request_id,
            status: "suggested",
            class: evaluation.class,
            confidence: evaluation.confidence,
            reason: evaluation.reason,
            requires_receipt: outcome.requires_receipt ?? null,
          });
        } else if (outcome.status === "skipped") {
          skipped += 1;
          results.push({
            request_id: candidate.request_id,
            status: "skipped",
            class: evaluation.class,
            confidence: evaluation.confidence,
            reason: outcome.reason ?? "skipped",
          });
        } else {
          errors += 1;
          results.push({
            request_id: candidate.request_id,
            status: "error",
            class: evaluation.class,
            confidence: evaluation.confidence,
            reason: outcome.reason ?? outcome.status ?? "apply_failed",
          });
        }

        if (used >= dailyLimit) {
          stopped = "daily_limit";
          break;
        }
      }

      deps.audit?.({
        event: "payment_stock_label_jev",
        candidates: candidates.length,
        applied,
        suggested,
        skipped,
        errors,
        used_today: used,
        daily_limit: dailyLimit,
      });

      return json({
        skipped: false,
        candidates: candidates.length,
        applied,
        suggested,
        skipped_count: skipped,
        errors,
        threshold,
        daily_limit: dailyLimit,
        used_today: used,
        stopped,
        results,
      });
    } catch (error) {
      const code = signal.aborted
        ? "timeout"
        : error instanceof StockLabelError
          ? error.code
          : error instanceof JevError
            ? error.code
            : "scan_failed";
      const status = signal.aborted
        ? 504
        : error instanceof StockLabelError
          ? error.status
          : error instanceof JevError
            ? error.status
            : 503;
      deps.audit?.({ event: "payment_stock_label_jev_error", code, status });
      return json({ error: MESSAGES[code] ?? MESSAGES.scan_failed, code }, status);
    }
  };
}
