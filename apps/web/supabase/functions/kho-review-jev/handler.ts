// HTTP shell for owner-triggered Jev scoring of the kho review tab.
//
// The handler authenticates the caller and reads public.kho_review_list() as
// that caller (so the database gate decides who may review). It asks Jev one
// boolean same-item question per (target, receipt line) pair, plus one
// suggested-class choice question for a recipe material. Answers are stored as
// suggestions only: there is no code path here that links a line or creates an
// item.
//
// Pairs already marked for the current prompt_version are skipped, and one
// request asks at most 40 pairs (default 20).

import { getCorsHeaders } from "../_shared/cors.ts";
import {
  KHO_REVIEW_JEV_MAX_CONCURRENCY,
  KHO_REVIEW_JEV_MODEL,
  KHO_REVIEW_JEV_PROMPT_VERSION,
  KhoReviewJevError,
  verdictFromProbability,
  type KhoReviewJevClass,
  type KhoReviewJevEvaluator,
  type KhoReviewJevState,
  type KhoReviewJevTargetKind,
  type KhoReviewJevVerdict,
} from "./jev.ts";

export const KHO_REVIEW_JEV_REQUEST_BODY_LIMIT = 16_384;
export const KHO_REVIEW_JEV_REQUEST_BUDGET_MS = 110_000;
export const KHO_REVIEW_JEV_DEFAULT_LIMIT = 20;
export const KHO_REVIEW_JEV_MAX_LIMIT = 40;

export interface KhoReviewJevCandidate {
  receipt_item_id: string;
  product_name?: string | null;
  unit?: string | null;
  supplier_name?: string | null;
  receipt_date?: string | null;
  location?: string | null;
  [key: string]: unknown;
}

export interface KhoReviewJevItem {
  target_key: string;
  item_id: string;
  item_code: string;
  name: string;
  unit: string;
  item_class?: string | null;
  location: string;
  candidates?: KhoReviewJevCandidate[];
  [key: string]: unknown;
}

export interface KhoReviewJevMaterial {
  target_key: string;
  canonical_material_id: string;
  name: string;
  recipe_unit: string;
  sku_codes?: string[];
  candidates?: KhoReviewJevCandidate[];
  [key: string]: unknown;
}

export interface KhoReviewJevReview {
  items?: KhoReviewJevItem[];
  materials?: KhoReviewJevMaterial[];
}

export interface KhoReviewJevPair {
  target_key: string;
  target_kind: KhoReviewJevTargetKind;
  receipt_item_id: string;
  state: KhoReviewJevState;
}

export interface KhoReviewJevMarkRow {
  target_key: string;
  receipt_item_id: string;
  verdict: KhoReviewJevVerdict;
  probability: number;
  suggested_class: KhoReviewJevClass | null;
  prompt_version: string;
  model: string;
  provider: string;
  created_by: string;
}

export interface KhoReviewJevMark {
  target_key: string;
  receipt_item_id: string;
  verdict: KhoReviewJevVerdict;
  probability: number;
  suggested_class: KhoReviewJevClass | null;
}

export interface KhoReviewJevResponse {
  asked: number;
  cached: number;
  skipped: number;
  marks: KhoReviewJevMark[];
}

export interface KhoReviewJevDeps {
  authenticate: (
    request: Request,
    signal: AbortSignal,
  ) => Promise<{ userId: string; review: KhoReviewJevReview }>;
  evaluator: () => KhoReviewJevEvaluator | null;
  listMarkedPairs: (promptVersion: string, targetKeys: string[]) => Promise<Set<string>>;
  upsertMarks: (rows: KhoReviewJevMarkRow[]) => Promise<void>;
  promptVersion?: string;
  concurrency?: number;
  audit?: (event: Record<string, unknown>) => void;
}

interface ParsedInput {
  targetKeys: string[] | null;
  limit: number;
}

const MESSAGES: Record<string, string> = {
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Tính năng chấm gợi ý chỉ dành cho người có quyền sửa kho.",
  invalid_content_type: "Yêu cầu chấm gợi ý phải là JSON.",
  invalid_json: "Nội dung yêu cầu chấm gợi ý không hợp lệ.",
  invalid_request: "Yêu cầu chấm gợi ý không hợp lệ.",
  body_limit: "Yêu cầu chấm gợi ý quá lớn.",
  unconfigured: "Máy chủ chưa cấu hình khoá AI Gateway cho Jev.",
  review_failed: "Chưa đọc được danh sách rà soát nhập kho.",
  store_failed: "Chưa lưu được điểm Jev. Không có liên kết nào được tạo.",
  timeout: "Chấm gợi ý vượt thời gian cho phép. Không có liên kết nào được tạo.",
  request_failed: "Chưa thể chấm gợi ý. Không có liên kết nào được tạo.",
  jev_invalid_response: "Jev trả lời không hợp lệ. Không có liên kết nào được tạo.",
  jev_rate_limited: "Jev đang quá tải. Anh thử lại sau.",
  jev_http_error: "Jev tạm thời không phản hồi. Anh thử lại sau.",
  jev_timeout: "Jev phản hồi chậm. Anh thử lại sau.",
  jev_unavailable: "Jev tạm thời không phản hồi. Anh thử lại sau.",
  jev_circuit_open: "Jev tạm thời không phản hồi. Anh thử lại sau.",
  jev_deadline_exceeded: "Chấm gợi ý vượt thời gian cho phép. Anh thử lại sau.",
};

function jsonBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    throw new KhoReviewJevError("invalid_content_type", 415);
  }
  if (!req.body) throw new KhoReviewJevError("invalid_request", 400);
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
      if (size > KHO_REVIEW_JEV_REQUEST_BODY_LIMIT) {
        await reader.cancel();
        throw new KhoReviewJevError("body_limit", 413);
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
    throw new KhoReviewJevError("invalid_json", 400);
  }
}

export function parseKhoReviewJevInput(raw: Record<string, unknown>): ParsedInput {
  for (const field of Object.keys(raw)) {
    if (field !== "target_keys" && field !== "limit") {
      throw new KhoReviewJevError("invalid_request", 400);
    }
  }

  let targetKeys: string[] | null = null;
  if (raw.target_keys !== undefined) {
    if (
      !Array.isArray(raw.target_keys)
      || raw.target_keys.some((key) => typeof key !== "string" || key.trim() === "")
    ) {
      throw new KhoReviewJevError("invalid_request", 400);
    }
    targetKeys = [...new Set(raw.target_keys.map((key) => key.trim()))];
  }

  let limit = KHO_REVIEW_JEV_DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    if (
      typeof raw.limit !== "number"
      || !Number.isInteger(raw.limit)
      || raw.limit < 1
    ) {
      throw new KhoReviewJevError("invalid_request", 400);
    }
    // The server hard-caps one request at 40 provider pairs.
    limit = Math.min(raw.limit, KHO_REVIEW_JEV_MAX_LIMIT);
  }

  return { targetKeys, limit };
}

export function pairKey(targetKey: string, receiptItemId: string): string {
  return `${targetKey}\u0000${receiptItemId}`;
}

/**
 * Collect every (target, receipt line) pair offered by kho_review_list(), in
 * list order. `target_keys` optionally narrows the targets; duplicates are
 * removed by (target_key, receipt_item_id).
 */
export function collectKhoReviewJevPairs(
  review: KhoReviewJevReview,
  targetKeys: string[] | null = null,
): KhoReviewJevPair[] {
  const requested = targetKeys !== null ? new Set(targetKeys) : null;
  const seen = new Set<string>();
  const pairs: KhoReviewJevPair[] = [];

  const add = (pair: KhoReviewJevPair) => {
    if (requested !== null && !requested.has(pair.target_key)) return;
    const key = pairKey(pair.target_key, pair.receipt_item_id);
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push(pair);
  };

  for (const item of review.items ?? []) {
    const targetKey = item.target_key;
    if (typeof targetKey !== "string" || targetKey === "") continue;
    for (const candidate of item.candidates ?? []) {
      const receiptItemId = candidate.receipt_item_id;
      if (typeof receiptItemId !== "string" || receiptItemId === "") continue;
      add({
        target_key: targetKey,
        target_kind: "item",
        receipt_item_id: receiptItemId,
        state: {
          target: {
            kind: "item",
            name: item.name,
            unit: item.unit,
            item_code: item.item_code,
            item_class: item.item_class ?? null,
            location: item.location,
          },
          line: {
            name: candidate.product_name ?? "",
            unit: candidate.unit ?? null,
            supplier: candidate.supplier_name ?? null,
            receipt_date: candidate.receipt_date ?? null,
            location: candidate.location ?? null,
          },
        },
      });
    }
  }

  for (const material of review.materials ?? []) {
    const targetKey = material.target_key;
    if (typeof targetKey !== "string" || targetKey === "") continue;
    for (const candidate of material.candidates ?? []) {
      const receiptItemId = candidate.receipt_item_id;
      if (typeof receiptItemId !== "string" || receiptItemId === "") continue;
      add({
        target_key: targetKey,
        target_kind: "material",
        receipt_item_id: receiptItemId,
        state: {
          target: {
            kind: "material",
            name: material.name,
            recipe_unit: material.recipe_unit,
            sku_codes: material.sku_codes ?? [],
          },
          line: {
            name: candidate.product_name ?? "",
            unit: candidate.unit ?? null,
            supplier: candidate.supplier_name ?? null,
            receipt_date: candidate.receipt_date ?? null,
            location: candidate.location ?? null,
          },
        },
      });
    }
  }

  return pairs;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

interface PairOutcome {
  pair: KhoReviewJevPair;
  evaluation?: Awaited<ReturnType<KhoReviewJevEvaluator>>;
  error?: unknown;
}

export function createKhoReviewJevHandler(deps: KhoReviewJevDeps) {
  const promptVersion = deps.promptVersion ?? KHO_REVIEW_JEV_PROMPT_VERSION;
  const concurrency = Math.max(
    1,
    Math.min(deps.concurrency ?? KHO_REVIEW_JEV_MAX_CONCURRENCY, KHO_REVIEW_JEV_MAX_CONCURRENCY),
  );

  return async (req: Request): Promise<Response> => {
    const headers: Record<string, string> = {
      ...getCorsHeaders(req),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
    };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") {
      return json({ error: "Method not allowed", code: "method_not_allowed" }, 405);
    }

    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(KHO_REVIEW_JEV_REQUEST_BUDGET_MS)]);
    const deadlineAt = Date.now() + KHO_REVIEW_JEV_REQUEST_BUDGET_MS;
    try {
      throwIfAborted(signal);
      const { userId, review } = await deps.authenticate(req, signal);
      throwIfAborted(signal);
      const input = parseKhoReviewJevInput(await readBody(req, signal));

      const allPairs = collectKhoReviewJevPairs(review, input.targetKeys);
      const keysForMarks = input.targetKeys !== null
        ? input.targetKeys
        : [...new Set(allPairs.map((pair) => pair.target_key))];
      const marked = keysForMarks.length > 0
        ? await deps.listMarkedPairs(promptVersion, keysForMarks)
        : new Set<string>();

      const fresh = allPairs.filter((pair) => !marked.has(pairKey(pair.target_key, pair.receipt_item_id)));
      const cached = allPairs.length - fresh.length;
      const batch = fresh.slice(0, input.limit);
      let skipped = fresh.length - batch.length;

      let evaluator: KhoReviewJevEvaluator | null = null;
      try {
        evaluator = deps.evaluator();
      } catch {
        evaluator = null;
      }
      if (batch.length > 0 && evaluator === null) {
        throw new KhoReviewJevError("unconfigured", 503);
      }
      const runEvaluator = evaluator;

      let asked = 0;
      const rows: KhoReviewJevMarkRow[] = [];
      const marks: KhoReviewJevMark[] = [];

      if (batch.length > 0 && runEvaluator !== null) {
        const outcomes = await mapWithConcurrency<KhoReviewJevPair, PairOutcome>(
          batch,
          concurrency,
          async (pair) => {
            asked += 1;
            try {
              const evaluation = await runEvaluator({
                kind: pair.target_kind,
                state: pair.state,
                signal,
                deadlineAt,
              });
              return { pair, evaluation };
            } catch (error) {
              return { pair, error };
            }
          },
        );

        for (const outcome of outcomes) {
          if (outcome.error || !outcome.evaluation) {
            // A provider failure skips only that pair; it never links anything.
            skipped += 1;
            continue;
          }
          const evaluation = outcome.evaluation;
          const verdict = verdictFromProbability(evaluation.p_same);
          rows.push({
            target_key: outcome.pair.target_key,
            receipt_item_id: outcome.pair.receipt_item_id,
            verdict,
            probability: evaluation.p_same,
            suggested_class: evaluation.suggested_class,
            prompt_version: promptVersion,
            model: KHO_REVIEW_JEV_MODEL,
            provider: evaluation.provider ?? "typesafe",
            created_by: userId,
          });
          marks.push({
            target_key: outcome.pair.target_key,
            receipt_item_id: outcome.pair.receipt_item_id,
            verdict,
            probability: evaluation.p_same,
            suggested_class: evaluation.suggested_class,
          });
        }
      }

      if (rows.length > 0) await deps.upsertMarks(rows);

      deps.audit?.({
        event: "kho_review_jev",
        pairs: allPairs.length,
        asked,
        cached,
        skipped,
        marks: marks.length,
      });

      const response: KhoReviewJevResponse = { asked, cached, skipped, marks };
      return json(response);
    } catch (error) {
      const timedOut = signal.aborted;
      const code = timedOut
        ? "timeout"
        : error instanceof KhoReviewJevError
          ? error.code
          : error instanceof Error && error.name === "AbortError"
            ? "timeout"
            : "request_failed";
      const status = timedOut
        ? 504
        : error instanceof KhoReviewJevError
          ? error.status
          : code === "timeout"
            ? 504
            : 503;
      deps.audit?.({ event: "kho_review_jev_error", code, status });
      return json({ error: MESSAGES[code] ?? MESSAGES.request_failed, code }, status);
    }
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}
