// HTTP shell for reading one candidate receipt line from its photo.
//
// The handler authenticates the caller, then reads
// public.kho_review_line_context(receipt_item_id) as that caller, so the
// database gate decides who may review.  A cached answer for the same line,
// image set and prompt version is returned without OCR.  Otherwise it asks the
// local Indra OCR service first (when SCAN_OCR_ENGINE=indra and configured) and
// DeepSeek to locate the matching printed row; if Indra is unavailable or the
// read is below its quality threshold, the existing DeepSeek image path is the
// fallback.
//
// This function only reads and caches.  It never links a line, creates an item
// or writes a ledger movement.

import { getCorsHeaders } from "../_shared/cors.ts";
import {
  callIndraOcr,
  IndraOcrError,
  readIndraOcrConfig,
  type IndraOcrConfig,
  type IndraOcrResult,
} from "../_shared/indra-ocr.ts";
import {
  callDeepSeekJson,
  type CallDeepSeekJsonOptions,
} from "../_shared/deepseek-json.ts";

export const KHO_REVIEW_READ_LINE_BODY_LIMIT = 8_192;
export const KHO_REVIEW_READ_LINE_BUDGET_MS = 60_000;
export const KHO_REVIEW_READ_LINE_MAX_IMAGES = 3;
export const KHO_REVIEW_READ_LINE_PROMPT_VERSION = "kho-review-read-line-v1";

export type KhoReviewReadOcrEngine = "indra" | "deepseek";

export type KhoReviewReadLineErrorCode =
  | "invalid_content_type"
  | "invalid_json"
  | "invalid_request"
  | "body_limit"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "no_image"
  | "ocr_failed"
  | "not_on_document"
  | "timeout"
  | "request_failed";

export class KhoReviewReadLineError extends Error {
  readonly code: KhoReviewReadLineErrorCode;
  readonly status: number;

  constructor(code: KhoReviewReadLineErrorCode, status: number) {
    super(code);
    this.name = "KhoReviewReadLineError";
    this.code = code;
    this.status = status;
  }
}

export interface KhoReviewLineContext {
  receipt_item_id?: string;
  product_name?: string | null;
  unit?: string | null;
  actual_quantity?: number | null;
  unit_price?: number | null;
  receipt_number?: string | null;
  receipt_date?: string | null;
  supplier_name?: string | null;
  location?: string | null;
  image_url?: string | null;
  product_photos?: string[] | null;
  image_paths?: string[] | null;
  posted?: boolean;
  linked_item_id?: string | null;
  linked_factor?: number | null;
  [key: string]: unknown;
}

export interface KhoReviewReadImage {
  base64: string;
  mimeType: string;
}

export interface KhoReviewAiAnswer {
  found: boolean;
  printed_name: string | null;
  doc_unit: string | null;
  doc_quantity: number | null;
  doc_unit_price: number | null;
  line_total: number | null;
  pack_count: number | null;
  pack_unit: string | null;
  evidence_text: string | null;
}

export interface KhoReviewLineReadResult {
  ok: true;
  found: boolean;
  doc_unit: string | null;
  doc_quantity: number | null;
  doc_unit_price: number | null;
  pack_count: number | null;
  pack_unit: string | null;
  evidence_text: string | null;
  unit_mismatch: boolean;
  ocr_engine: KhoReviewReadOcrEngine;
  ocr_fallback_reason: string | null;
  cached: boolean;
}

export interface KhoReviewLineReadCacheRow {
  result: Record<string, unknown>;
  ocr_engine: string | null;
}

export interface KhoReviewReadLineDeps {
  authenticate: (
    request: Request,
    signal: AbortSignal,
  ) => Promise<{
    userId: string;
    loadContext: (receiptItemId: string) => Promise<KhoReviewLineContext>;
  }>;
  loadImages: (context: KhoReviewLineContext) => Promise<KhoReviewReadImage[]>;
  loadCached: (key: {
    receiptItemId: string;
    imagesSha: string;
    promptVersion: string;
  }) => Promise<KhoReviewLineReadCacheRow | null>;
  saveCached: (row: {
    receiptItemId: string;
    imagesSha: string;
    promptVersion: string;
    result: Record<string, unknown>;
    ocrEngine: KhoReviewReadOcrEngine;
    userId: string;
  }) => Promise<void>;
  indraConfig?: () => IndraOcrConfig;
  callIndraOcr?: (options: {
    base64?: string;
    mimeType: string;
    config: IndraOcrConfig;
    signal?: AbortSignal;
  }) => Promise<IndraOcrResult>;
  callDeepSeekJson?: (options: CallDeepSeekJsonOptions) => Promise<Record<string, unknown>>;
  audit?: (event: Record<string, unknown>) => void;
  now?: () => number;
}

export const KHO_REVIEW_READ_LINE_MESSAGES: Record<string, string> = {
  invalid_content_type: "Yêu cầu đọc phiếu phải là JSON.",
  invalid_json: "Nội dung yêu cầu đọc phiếu không hợp lệ.",
  invalid_request: "Yêu cầu đọc phiếu không hợp lệ.",
  body_limit: "Yêu cầu đọc phiếu quá lớn.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Tính năng đọc phiếu chỉ dành cho người có quyền sửa kho.",
  not_found: "Không tìm thấy dòng phiếu nhập.",
  no_image: "Dòng phiếu này chưa có ảnh để đọc.",
  ocr_failed: "Chưa đọc được ảnh phiếu. Anh thử lại giúp.",
  not_on_document: "Không thấy dòng hàng này trên phiếu.",
  timeout: "Đọc phiếu vượt thời gian cho phép. Anh thử lại sau.",
  request_failed: "Chưa đọc được phiếu. Anh thử lại giúp.",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM_PROMPT = `Bạn đọc một chứng từ nhập hàng đã được OCR hoặc ảnh chứng từ.
Nhiệm vụ: tìm ĐÚNG MỘT dòng hàng có tên khớp với tên hàng cần tìm (so khớp mờ, bỏ dấu tiếng Việt, không phân biệt hoa thường), rồi đọc các số in trên chính dòng đó.

Chỉ trả về MỘT JSON object, không markdown, đúng dạng:
{
  "found": true hoặc false,
  "printed_name": "tên in trên phiếu" hoặc null,
  "doc_unit": "đơn vị in trên phiếu" hoặc null,
  "doc_quantity": số lượng in trên phiếu hoặc null,
  "doc_unit_price": đơn giá in trên phiếu hoặc null,
  "line_total": thành tiền in trên phiếu hoặc null,
  "pack_count": số lượng trong một đơn vị đóng gói hoặc null,
  "pack_unit": đơn vị của pack_count hoặc null,
  "evidence_text": "đoạn chữ ngắn chứng minh dòng này" hoặc null
}

Quy tắc bắt buộc:
- Không thấy dòng khớp thì "found": false và mọi trường khác null.
- Chỉ chép số đã in; KHÔNG tự tính, KHÔNG làm tròn, KHÔNG suy đoán.
- doc_unit, doc_quantity, doc_unit_price là của chính dòng khớp, không lấy dòng khác.
- Nhiều phiếu bán lẻ KHÔNG có cột đơn vị: đơn vị nằm trong ngoặc cuối tên hàng. Ví dụ "BAO TAY Y TẾ ĐEN SIZE M (HỘP 100 CÁI)" => doc_unit "hộp", pack_count 100, pack_unit "cái"; "BAO PE 50X70 (BAO 10 KG)" => doc_unit "bao", pack_count 10, pack_unit "kg"; "BAO XỐP 2LY (kg)" => doc_unit "kg", không có quy cách.
- pack_count/pack_unit CHỈ khi phiếu in rõ quy cách đóng gói, ví dụ "Hộp 100 cái" => pack_count 100, pack_unit "cái"; "100c/h" => 100, "cái". Không in rõ thì cả hai null.
- Nếu không thấy số lượng nhưng có đơn giá và thành tiền in trên dòng, doc_quantity = thành tiền / đơn giá khi chia hết.
- Số lượng/đơn giá/pack_count nếu có phải lớn hơn 0.`;

function jsonBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    throw new KhoReviewReadLineError("invalid_content_type", 415);
  }
  if (!req.body) throw new KhoReviewReadLineError("invalid_request", 400);
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
      if (size > KHO_REVIEW_READ_LINE_BODY_LIMIT) {
        await reader.cancel();
        throw new KhoReviewReadLineError("body_limit", 413);
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
    throw new KhoReviewReadLineError("invalid_json", 400);
  }
}

export function parseKhoReviewReadLineInput(raw: Record<string, unknown>): { receiptItemId: string } {
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== "receipt_item_id") {
    throw new KhoReviewReadLineError("invalid_request", 400);
  }
  const value = raw.receipt_item_id;
  if (typeof value !== "string" || !UUID_RE.test(value.trim())) {
    throw new KhoReviewReadLineError("invalid_request", 400);
  }
  return { receiptItemId: value.trim() };
}

/**
 * Mirror of public.normalize_document_unit (immutable SQL helper): only the
 * known misreads are corrected, the same way every server-side unit check does.
 */
export function normalizeDocumentUnit(value: string | null | undefined): string | null {
  let v = String(value ?? "").toLowerCase().trim().replace(/\s+/g, " ");
  v = v.replace(/^\s*\(\s*kg\s*\)\s*$/, "kg");
  v = v.replace(/\s*\(\s*pack\s*\)\s*$/i, "");
  v = v.replace(/\([^()]*\)/g, "");
  v = v.replace(/[()]/g, "");
  v = v.trim().replace(/\s+/g, " ");
  if (v === "") return null;
  switch (v) {
    case "ky":
    case "ký":
    case "kilogram":
      return "kg";
    case "b bao":
      return "bao";
    case "hop":
    case "hôp":
    case "hộp":
      return "hộp";
    default:
      return v;
  }
}

export function imagePathsForContext(context: KhoReviewLineContext): string[] {
  const raw = [
    context.image_url,
    ...(Array.isArray(context.product_photos) ? context.product_photos : []),
    ...(Array.isArray(context.image_paths) ? context.image_paths : []),
  ];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const path = value.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/** Stable sha of the image path set (order-independent, duplicates removed). */
export async function imageSetSha(paths: readonly string[]): Promise<string> {
  const unique = [...new Set(paths.map((path) => path.trim()).filter(Boolean))].sort();
  const bytes = new TextEncoder().encode(unique.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function positiveNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function parseKhoReviewAiAnswer(raw: Record<string, unknown>): KhoReviewAiAnswer {
  if (raw.found !== true && raw.found !== false) {
    throw new KhoReviewReadLineError("ocr_failed", 502);
  }
  if (raw.found === false) {
    return {
      found: false,
      printed_name: textOrNull(raw.printed_name),
      doc_unit: null,
      doc_quantity: null,
      doc_unit_price: null,
      line_total: null,
      pack_count: null,
      pack_unit: null,
      evidence_text: textOrNull(raw.evidence_text),
    };
  }

  const docUnit = normalizeDocumentUnit(textOrNull(raw.doc_unit));
  const docQuantity = positiveNumber(raw.doc_quantity);
  if (docUnit === null || docQuantity === null) {
    throw new KhoReviewReadLineError("ocr_failed", 502);
  }

  const packCount = positiveNumber(raw.pack_count);
  let packUnit = normalizeDocumentUnit(textOrNull(raw.pack_unit));
  if (packCount === null || packUnit === null) {
    // Never keep half of a printed pack: no guessed count and no guessed unit.
    if (packCount !== null && packUnit === null) {
      throw new KhoReviewReadLineError("ocr_failed", 502);
    }
    packUnit = null;
  }

  return {
    found: true,
    printed_name: textOrNull(raw.printed_name),
    doc_unit: docUnit,
    doc_quantity: docQuantity,
    doc_unit_price: positiveNumber(raw.doc_unit_price),
    line_total: positiveNumber(raw.line_total),
    pack_count: packCount === null ? null : packCount,
    pack_unit: packCount === null ? null : packUnit,
    evidence_text: textOrNull(raw.evidence_text),
  };
}

function buildUserText(context: KhoReviewLineContext, ocrText: string | null): string {
  const lines = [
    `Dòng hàng cần tìm: ${JSON.stringify(context.product_name ?? "")}`,
    `Đơn vị đang lưu: ${JSON.stringify(context.unit ?? "")}`,
    `Số lượng đang lưu: ${context.actual_quantity ?? "null"}`,
    `Đơn giá đang lưu: ${context.unit_price ?? "null"}`,
  ];
  if (ocrText !== null) {
    lines.push("", "Nội dung chứng từ (OCR):", "<<<OCR>>>", ocrText);
  } else {
    lines.push("", "Ảnh chứng từ được gửi kèm. Hãy tìm dòng hàng trên ảnh.");
  }
  return lines.join("\n");
}

export function unitMismatch(
  answer: Pick<KhoReviewAiAnswer, "found" | "doc_unit">,
  storedUnit: string | null | undefined,
): boolean {
  if (!answer.found) return false;
  const doc = normalizeDocumentUnit(answer.doc_unit);
  const stored = normalizeDocumentUnit(storedUnit);
  if (doc === null || stored === null) return false;
  return doc !== stored;
}

function errorCode(error: unknown): string {
  if (error instanceof IndraOcrError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.trim() !== "") return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() !== "" ? name : "error";
}

function toResult(
  answer: KhoReviewAiAnswer,
  context: KhoReviewLineContext,
  engine: KhoReviewReadOcrEngine,
  fallbackReason: string | null,
  cached: boolean,
): KhoReviewLineReadResult {
  return {
    ok: true,
    found: answer.found,
    doc_unit: answer.doc_unit,
    doc_quantity: answer.doc_quantity,
    doc_unit_price: answer.doc_unit_price,
    pack_count: answer.pack_count,
    pack_unit: answer.pack_unit,
    evidence_text: answer.evidence_text,
    unit_mismatch: unitMismatch(answer, context.unit),
    ocr_engine: engine,
    ocr_fallback_reason: fallbackReason,
    cached,
  };
}

export function createKhoReviewReadLineHandler(deps: KhoReviewReadLineDeps) {
  const now = deps.now ?? Date.now;
  const readConfig = deps.indraConfig ?? readIndraOcrConfig;
  const runIndra = deps.callIndraOcr ?? callIndraOcr;
  const askDeepSeek = deps.callDeepSeekJson ?? callDeepSeekJson;
  const promptVersion = KHO_REVIEW_READ_LINE_PROMPT_VERSION;

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
      return json({ ok: false, code: "method_not_allowed", error: "Method not allowed" }, 405);
    }

    const started = now();
    const deadlineAt = started + KHO_REVIEW_READ_LINE_BUDGET_MS;
    const signal = AbortSignal.any([
      req.signal,
      AbortSignal.timeout(KHO_REVIEW_READ_LINE_BUDGET_MS),
    ]);
    const log = (engine: string, fallbackReason: string | null, ocrMs: number) => {
      deps.audit?.({
        fn: "kho-review-read-line",
        engine,
        fallback_reason: fallbackReason,
        ocr_ms: ocrMs,
        total_ms: now() - started,
      });
    };
    const remainingMs = () => Math.max(1, deadlineAt - now());

    try {
      throwIfAborted(signal);
      const auth = await deps.authenticate(req, signal);
      throwIfAborted(signal);
      const input = parseKhoReviewReadLineInput(await readBody(req, signal));

      const context = await auth.loadContext(input.receiptItemId);
      throwIfAborted(signal);

      const paths = imagePathsForContext(context);
      if (paths.length === 0) throw new KhoReviewReadLineError("no_image", 422);
      const imagesSha = await imageSetSha(paths);

      let cached: KhoReviewLineReadCacheRow | null = null;
      try {
        cached = await deps.loadCached({
          receiptItemId: input.receiptItemId,
          imagesSha,
          promptVersion,
        });
      } catch {
        cached = null;
      }
      if (cached) {
        try {
          const answer = parseKhoReviewAiAnswer(cached.result);
          const fallbackReason = textOrNull(cached.result.ocr_fallback_reason);
          const engine: KhoReviewReadOcrEngine = cached.ocr_engine === "indra" ? "indra" : "deepseek";
          log(engine, fallbackReason, 0);
          return json(toResult(answer, context, engine, fallbackReason, true));
        } catch {
          // A stale/corrupt cache row is ignored and re-read.
        }
      }

      const images = (await deps.loadImages(context)).slice(0, KHO_REVIEW_READ_LINE_MAX_IMAGES);
      if (images.length === 0) throw new KhoReviewReadLineError("no_image", 422);
      throwIfAborted(signal);

      let config: IndraOcrConfig | null = null;
      try {
        config = readConfig();
      } catch {
        config = null;
      }

      let answer: KhoReviewAiAnswer | null = null;
      let engine: KhoReviewReadOcrEngine = "deepseek";
      let fallbackReason: string | null = null;
      let ocrMs = 0;

      if (config?.engine === "indra") {
        if (!config.url || !config.token) {
          fallbackReason = "not_configured";
        } else {
          const ocrStarted = now();
          try {
            const texts: string[] = [];
            for (const image of images) {
              const result = await runIndra({
                base64: image.base64,
                mimeType: image.mimeType || "image/jpeg",
                config,
                signal,
              });
              texts.push(result.markdown.trim() ? result.markdown : result.text);
            }
            ocrMs = now() - ocrStarted;
            const raw = await askDeepSeek({
              system: SYSTEM_PROMPT,
              userText: buildUserText(context, texts.join("\n\n")),
              timeoutMs: remainingMs(),
              signal,
            });
            answer = parseKhoReviewAiAnswer(raw);
            engine = "indra";
            // OCR text can miss a row (handwriting, cropped photo): let the
            // image path look before answering "not on the document".
            if (!answer.found) {
              fallbackReason = "indra_not_found";
              answer = null;
            }
          } catch (error) {
            ocrMs = ocrMs > 0 ? ocrMs : now() - ocrStarted;
            fallbackReason = errorCode(error);
            answer = null;
          }
        }
      }

      if (!answer) {
        try {
          const raw = await askDeepSeek({
            system: SYSTEM_PROMPT,
            userText: buildUserText(context, null),
            images: images.map((image) => ({
              base64: image.base64,
              mimeType: image.mimeType || "image/jpeg",
            })),
            timeoutMs: remainingMs(),
            signal,
          });
          answer = parseKhoReviewAiAnswer(raw);
          engine = "deepseek";
        } catch (error) {
          // A bad/unparseable model answer, including DeepSeekJsonError, is a
          // failed OCR read for the caller; a timeout stays a timeout.
          if (error instanceof KhoReviewReadLineError) throw error;
          if (signal.aborted) throw error;
          throw new KhoReviewReadLineError("ocr_failed", 502);
        }
      }

      const result = toResult(answer, context, engine, fallbackReason, false);
      try {
        await deps.saveCached({
          receiptItemId: input.receiptItemId,
          imagesSha,
          promptVersion,
          result: {
            ...answer,
            ocr_fallback_reason: fallbackReason,
          },
          ocrEngine: engine,
          userId: auth.userId,
        });
      } catch {
        // A cache write is an optimization; the read itself already succeeded.
      }

      log(engine, fallbackReason, ocrMs);
      return json(result);
    } catch (error) {
      const timedOut = signal.aborted
        || (error as { name?: unknown } | null)?.name === "TimeoutError"
        || (error as { name?: unknown } | null)?.name === "AbortError";
      const code: KhoReviewReadLineErrorCode = timedOut
        ? "timeout"
        : error instanceof KhoReviewReadLineError
          ? error.code
          : "request_failed";
      const status = timedOut
        ? 504
        : error instanceof KhoReviewReadLineError
          ? error.status
          : 503;
      deps.audit?.({
        fn: "kho-review-read-line",
        engine: "none",
        fallback_reason: code,
        ocr_ms: 0,
        total_ms: now() - started,
        error_code: code,
      });
      return json({
        ok: false,
        code,
        error: KHO_REVIEW_READ_LINE_MESSAGES[code] ?? KHO_REVIEW_READ_LINE_MESSAGES.request_failed,
      }, status);
    }
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}
