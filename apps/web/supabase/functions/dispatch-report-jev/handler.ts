// HTTP shell for dispatch-report photo classification.
//
// The handler authenticates the caller, parses {date, photo_ids}, calls
// public.dispatch_report_save() through the caller's JWT (so the database, not
// this function, decides who may save) and then classifies only the photos the
// database accepted. Each image is read by the shared OCR helper, the text is
// sent to Jev, and the typed result is stored through the service-role
// dispatch_report_jev_mark RPC.
//
// Failure of one photo never blocks the others: a provider/OCR error stores
// failed + jev_error for that photo; a missing AI Gateway key stores skipped.
// The handler never returns the Gateway key, a signed URL or OCR text.

import { getCorsHeaders } from "../_shared/cors.ts";
import {
  DISPATCH_REPORT_JEV_MAX_PO,
  DISPATCH_REPORT_JEV_PROMPT_VERSION,
  DISPATCH_REPORT_JEV_SUMMARY_MAX_CHARS,
  DISPATCH_REPORT_JEV_ERROR_MAX_CHARS,
  DispatchReportJevError,
  dispatchReportJevErrorCode,
  sanitizeDispatchReportJevEvaluation,
  type DispatchReportJevEvaluation,
  type DispatchReportJevEvaluator,
  type DispatchReportJevKind,
  type DispatchReportJevQuantity,
} from "./jev.ts";

export const DISPATCH_REPORT_JEV_REQUEST_BODY_LIMIT = 16_384;
export const DISPATCH_REPORT_JEV_REQUEST_BUDGET_MS = 110_000;
export const DISPATCH_REPORT_JEV_PHOTO_TIMEOUT_MS = 20_000;
export const DISPATCH_REPORT_JEV_MAX_PHOTOS = 10;
export const DISPATCH_REPORT_JEV_MAX_CONCURRENCY = 3;

export type DispatchReportJevPhotoStatus = "done" | "failed" | "skipped";

export interface DispatchReportJevPhoto {
  id: string;
  storagePath: string;
}

export interface DispatchReportJevMark {
  id: string;
  status: DispatchReportJevPhotoStatus;
  kind: DispatchReportJevKind | null;
  poNumbers: string[];
  quantities: DispatchReportJevQuantity[];
  summary: string | null;
  mismatch: boolean | null;
  error: string | null;
  promptVersion: string;
}

export interface DispatchReportJevPhotoResult {
  id: string;
  status: DispatchReportJevPhotoStatus;
  kind: DispatchReportJevKind | null;
  mismatch: boolean | null;
}

export interface DispatchReportJevResponse {
  saved: string[];
  results: DispatchReportJevPhotoResult[];
}

export interface DispatchReportJevCaller {
  userId: string;
  save: (date: string, photoIds: string[]) => Promise<string[]>;
  loadReport: (date: string) => Promise<unknown>;
}

export interface DispatchReportJevDeps {
  authenticate: (
    request: Request,
    signal: AbortSignal,
  ) => Promise<DispatchReportJevCaller>;
  loadPhotos: (ids: string[]) => Promise<DispatchReportJevPhoto[]>;
  signPhoto: (storagePath: string, signal: AbortSignal) => Promise<string>;
  /** null means OCR is not configured; the photo is stored as skipped. */
  ocrPhoto: (signedUrl: string, signal: AbortSignal) => Promise<string | null>;
  evaluator: () => DispatchReportJevEvaluator | null;
  markPhoto: (mark: DispatchReportJevMark) => Promise<void>;
  promptVersion?: string;
  concurrency?: number;
  audit?: (event: Record<string, unknown>) => void;
}

interface ParsedInput {
  date: string;
  photoIds: string[];
}

const MESSAGES: Record<string, string> = {
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Chỉ người có quyền sửa kho mới được lưu ảnh báo cáo xuất kho.",
  invalid_content_type: "Yêu cầu lưu ảnh phải là JSON.",
  invalid_json: "Nội dung yêu cầu lưu ảnh không hợp lệ.",
  invalid_request: "Yêu cầu lưu ảnh không hợp lệ.",
  invalid_date: "Ngày báo cáo không hợp lệ.",
  invalid_photo: "Có ảnh không thuộc ngày báo cáo đã chọn. Anh tải lại trang và thử lại.",
  body_limit: "Yêu cầu lưu ảnh quá lớn.",
  save_failed: "Chưa lưu được ảnh báo cáo. Anh thử lại sau.",
  store_failed: "Chưa ghi được kết quả Jev cho ảnh.",
  no_photos: "Không có ảnh nào đã lưu để phân loại.",
  request_failed: "Chưa phân loại được ảnh. Anh thử lại sau.",
  timeout: "Phân loại ảnh vượt thời gian cho phép. Anh thử lại sau.",
};

function jsonBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    throw new DispatchReportJevError("invalid_content_type", 415);
  }
  if (!req.body) throw new DispatchReportJevError("invalid_request", 400);
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
      if (size > DISPATCH_REPORT_JEV_REQUEST_BODY_LIMIT) {
        await reader.cancel();
        throw new DispatchReportJevError("body_limit", 413);
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
    throw new DispatchReportJevError("invalid_json", 400);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function parseDispatchReportJevInput(raw: Record<string, unknown>): ParsedInput {
  for (const field of Object.keys(raw)) {
    if (field !== "date" && field !== "photo_ids") {
      throw new DispatchReportJevError("invalid_request", 400);
    }
  }
  if (typeof raw.date !== "string" || !validDate(raw.date)) {
    throw new DispatchReportJevError("invalid_date", 400);
  }
  if (!Array.isArray(raw.photo_ids)) {
    throw new DispatchReportJevError("invalid_request", 400);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.photo_ids) {
    if (typeof item !== "string" || !UUID_PATTERN.test(item)) {
      throw new DispatchReportJevError("invalid_request", 400);
    }
    const id = item.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    throw new DispatchReportJevError("no_photos", 400);
  }
  if (ids.length > DISPATCH_REPORT_JEV_MAX_PHOTOS) {
    throw new DispatchReportJevError("invalid_request", 400);
  }
  return { date: raw.date, photoIds: ids };
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "";
  const record = error as { message?: unknown; details?: unknown; hint?: unknown };
  return [record.message, record.details, record.hint]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
}

function saveError(error: unknown): DispatchReportJevError {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const text = errorText(error).toLowerCase();
  if (code === "42501" || text.includes("insufficient_privilege") || text.includes("permission denied")) {
    return new DispatchReportJevError("forbidden", 403);
  }
  if (code === "22023" || text.includes("invalid_photo")) {
    return new DispatchReportJevError("invalid_photo", 400);
  }
  return new DispatchReportJevError("save_failed", 503);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Map delivered_qty by normalised PO number from kfm_daily_delivery_report. */
export function dispatchReportDeliveredQty(value: unknown): Map<string, number> {
  const rows = new Map<string, number>();
  if (!jsonBody(value) || !Array.isArray(value.pos)) return rows;
  for (const raw of value.pos) {
    if (!jsonBody(raw)) continue;
    const poNumber = String(raw.po_number ?? raw.poNumber ?? "").trim().toUpperCase();
    if (poNumber === "") continue;
    const delivered = asNumber(raw.delivered_qty ?? raw.deliveredQty);
    if (delivered !== null) rows.set(poNumber, delivered);
  }
  return rows;
}

/**
 * True when a PO read from the photo is absent from the day, or its read
 * quantity differs from the delivered quantity for that PO.
 */
export function dispatchReportMismatch(
  evaluation: Pick<DispatchReportJevEvaluation, "po_numbers" | "quantities">,
  deliveredByPo: Map<string, number>,
): boolean {
  const quantities = new Map(
    evaluation.quantities.map((item) => [item.po_number.toUpperCase(), item.qty]),
  );
  for (const poNumber of evaluation.po_numbers) {
    const po = poNumber.toUpperCase();
    if (!deliveredByPo.has(po)) return true;
    const readQty = quantities.get(po);
    if (readQty !== undefined) {
      const delivered = deliveredByPo.get(po) as number;
      if (Math.abs(readQty - delivered) > 0.000001) return true;
    }
  }
  return false;
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

function clipped(value: string | null, max: number): string | null {
  if (value === null) return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text === "" ? null : text.slice(0, max);
}

export function createDispatchReportJevHandler(deps: DispatchReportJevDeps) {
  const promptVersion = deps.promptVersion ?? DISPATCH_REPORT_JEV_PROMPT_VERSION;
  const concurrency = Math.max(
    1,
    Math.min(deps.concurrency ?? DISPATCH_REPORT_JEV_MAX_CONCURRENCY, DISPATCH_REPORT_JEV_MAX_PHOTOS),
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

    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(DISPATCH_REPORT_JEV_REQUEST_BUDGET_MS)]);
    const started = Date.now();
    try {
      throwIfAborted(signal);
      const caller = await deps.authenticate(req, signal);
      throwIfAborted(signal);
      const input = parseDispatchReportJevInput(await readBody(req, signal));

      let saved: string[];
      try {
        saved = await caller.save(input.date, input.photoIds);
      } catch (error) {
        throw saveError(error);
      }
      const requested = new Set(input.photoIds);
      saved = [...new Set(saved.map((id) => id.toLowerCase()))].filter((id) => requested.has(id));

      const report = await caller.loadReport(input.date);
      const deliveredByPo = dispatchReportDeliveredQty(report);
      const photos = saved.length > 0 ? await deps.loadPhotos(saved) : [];
      const photoById = new Map(photos.map((photo) => [photo.id.toLowerCase(), photo]));

      let evaluator: DispatchReportJevEvaluator | null = null;
      try {
        evaluator = deps.evaluator();
      } catch {
        evaluator = null;
      }

      const outcomes = await mapWithConcurrency<string, DispatchReportJevPhotoResult>(
        saved,
        concurrency,
        async (id) => {
          const photo = photoById.get(id);
          const photoSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(DISPATCH_REPORT_JEV_PHOTO_TIMEOUT_MS),
          ]);

          if (!photo) {
            await deps.markPhoto({
              id,
              status: "failed",
              kind: null,
              poNumbers: [],
              quantities: [],
              summary: null,
              mismatch: null,
              error: "photo_not_found",
              promptVersion,
            });
            return { id, status: "failed", kind: null, mismatch: null };
          }

          if (evaluator === null) {
            await deps.markPhoto({
              id,
              status: "skipped",
              kind: null,
              poNumbers: [],
              quantities: [],
              summary: null,
              mismatch: null,
              error: "jev_unconfigured",
              promptVersion,
            });
            return { id, status: "skipped", kind: null, mismatch: null };
          }

          try {
            const signedUrl = await deps.signPhoto(photo.storagePath, photoSignal);
            const ocrText = await deps.ocrPhoto(signedUrl, photoSignal);
            if (ocrText === null) {
              await deps.markPhoto({
                id,
                status: "skipped",
                kind: null,
                poNumbers: [],
                quantities: [],
                summary: null,
                mismatch: null,
                error: "ocr_unconfigured",
                promptVersion,
              });
              return { id, status: "skipped", kind: null, mismatch: null };
            }
            if (ocrText.trim() === "") {
              throw new DispatchReportJevError("ocr_empty", 422);
            }

            const raw = await evaluator({
              ocrText,
              date: input.date,
              signal: photoSignal,
              deadlineAt: Date.now() + DISPATCH_REPORT_JEV_PHOTO_TIMEOUT_MS,
            });
            const evaluation = sanitizeDispatchReportJevEvaluation(raw);
            if (evaluation === null) {
              throw new DispatchReportJevError("jev_invalid_response", 502);
            }
            const mismatch = dispatchReportMismatch(evaluation, deliveredByPo);
            await deps.markPhoto({
              id,
              status: "done",
              kind: evaluation.kind,
              poNumbers: evaluation.po_numbers.slice(0, DISPATCH_REPORT_JEV_MAX_PO),
              quantities: evaluation.quantities.slice(0, DISPATCH_REPORT_JEV_MAX_PO),
              summary: clipped(evaluation.summary, DISPATCH_REPORT_JEV_SUMMARY_MAX_CHARS),
              mismatch,
              error: null,
              promptVersion,
            });
            return { id, status: "done", kind: evaluation.kind, mismatch };
          } catch (error) {
            const code = signal.aborted
              ? "timeout"
              : photoSignal.aborted
                ? "photo_timeout"
                : dispatchReportJevErrorCode(error);
            await deps.markPhoto({
              id,
              status: "failed",
              kind: null,
              poNumbers: [],
              quantities: [],
              summary: null,
              mismatch: null,
              error: clipped(code, DISPATCH_REPORT_JEV_ERROR_MAX_CHARS),
              promptVersion,
            });
            return { id, status: "failed", kind: null, mismatch: null };
          }
        },
      );

      const response: DispatchReportJevResponse = { saved, results: outcomes };
      deps.audit?.({
        event: "dispatch_report_jev",
        saved: saved.length,
        done: outcomes.filter((item) => item.status === "done").length,
        failed: outcomes.filter((item) => item.status === "failed").length,
        skipped: outcomes.filter((item) => item.status === "skipped").length,
        ms: Date.now() - started,
      });
      return json(response);
    } catch (error) {
      const timedOut = signal.aborted;
      const code = timedOut
        ? "timeout"
        : error instanceof DispatchReportJevError
          ? error.code
          : error instanceof Error && error.name === "AbortError"
            ? "timeout"
            : "request_failed";
      const status = timedOut
        ? 504
        : error instanceof DispatchReportJevError
          ? error.status
          : code === "timeout"
            ? 504
            : 503;
      deps.audit?.({ event: "dispatch_report_jev_error", code, status });
      return json({ error: MESSAGES[code] ?? MESSAGES.request_failed, code }, status);
    }
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}
