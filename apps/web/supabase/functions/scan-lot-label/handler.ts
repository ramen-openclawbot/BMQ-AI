// HTTP shell for reading NSX / HSD / lot / manufacturer from a package label.
//
// The caller is authenticated with the same JWT pattern as
// kho-review-read-line.  The handler asks the local Indra OCR service first
// (when SCAN_OCR_ENGINE=indra and configured), then DeepSeek text; if Indra is
// unavailable or the OCR text misses every lot field, DeepSeek reads the image
// directly.  Missing fields stay null: this function never guesses a date.

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

export const SCAN_LOT_LABEL_BODY_LIMIT = 12_000_000;
export const SCAN_LOT_LABEL_BUDGET_MS = 60_000;
export const SCAN_LOT_LABEL_PROMPT_VERSION = "scan-lot-label-v1";
export const SCAN_LOT_LABEL_MAX_BASE64 = 10_000_000;

export type ScanLotLabelErrorCode =
  | "invalid_content_type"
  | "invalid_json"
  | "invalid_request"
  | "body_limit"
  | "unauthorized"
  | "no_image"
  | "ocr_failed"
  | "timeout"
  | "request_failed";

export class ScanLotLabelError extends Error {
  readonly code: ScanLotLabelErrorCode;
  readonly status: number;

  constructor(code: ScanLotLabelErrorCode, status: number) {
    super(code);
    this.name = "ScanLotLabelError";
    this.code = code;
    this.status = status;
  }
}

export type ScanLotLabelOcrEngine = "indra" | "deepseek";

/** Only values printed on the label; every absent field is null. */
export interface ScanLotLabelFields {
  manufacture_date: string | null;
  expiry_date: string | null;
  lot: string | null;
  manufacturer: string | null;
  product_name: string | null;
  evidence_text: string | null;
}

export interface ScanLotLabelImage {
  base64: string;
  mimeType: string;
}

export interface ScanLotLabelInput {
  imagePath?: string;
  imageBase64?: string;
  mimeType?: string;
}

export interface ScanLotLabelResult extends ScanLotLabelFields {
  ok: true;
  ocr_engine: ScanLotLabelOcrEngine;
  ocr_fallback_reason: string | null;
}

export interface ScanLotLabelDeps {
  authenticate: (
    request: Request,
    signal: AbortSignal,
  ) => Promise<{ userId: string }>;
  loadImageFromPath: (
    path: string,
    signal: AbortSignal,
  ) => Promise<ScanLotLabelImage | null>;
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

export const SCAN_LOT_LABEL_MESSAGES: Record<ScanLotLabelErrorCode, string> = {
  invalid_content_type: "Yêu cầu đọc nhãn phải là JSON.",
  invalid_json: "Nội dung yêu cầu đọc nhãn không hợp lệ.",
  invalid_request: "Yêu cầu đọc nhãn không hợp lệ.",
  body_limit: "Ảnh nhãn quá lớn.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  no_image: "Không tìm thấy ảnh nhãn.",
  ocr_failed: "Chưa đọc được nhãn. Anh thử lại giúp.",
  timeout: "Đọc nhãn vượt thời gian cho phép. Anh thử lại sau.",
  request_failed: "Chưa đọc được nhãn. Anh thử lại giúp.",
};

const SYSTEM_PROMPT = `Bạn đọc nhãn bao bì / nhãn sản phẩm của một lô hàng.
Chỉ trả về MỘT JSON object, không markdown, đúng dạng:
{
  "manufacture_date": "YYYY-MM-DD" hoặc null,
  "expiry_date": "YYYY-MM-DD" hoặc null,
  "lot": "mã lô in trên nhãn" hoặc null,
  "manufacturer": "tên nhà sản xuất in trên nhãn" hoặc null,
  "product_name": "tên sản phẩm in trên nhãn" hoặc null,
  "evidence_text": "đoạn chữ ngắn trên nhãn chứng minh kết quả" hoặc null
}

Quy tắc bắt buộc:
- NSX / MFG / MFG DATE / Ngày sản xuất là manufacture_date.
- HSD / EXP / EXPIRY / Best before / Use by / Hạn sử dụng là expiry_date.
- Nếu nhãn chỉ ghi "sử dụng trong N tháng" / "N months from manufacture" và có NSX, hãy tính expiry_date từ NSX.
- lot là mã lô / LOT / BATCH in trên nhãn; không lấy số lô của sản phẩm khác.
- manufacturer là tên nhà sản xuất in trên nhãn, không phải nhà phân phối.
- Ngày trả về đúng YYYY-MM-DD. Không thấy thì null. KHÔNG tự bịa, KHÔNG đoán, KHÔNG dùng ngày hôm nay.
- Chỉ đọc nhãn; không suy ra từ kiến thức bên ngoài.`;

const DATE_LABEL = String.raw`(?:NSX|MFG|MFD|MANUFACTURE(?:D)?(?:\s+ON)?|NG[ÀA]Y\s+S[ẢA]N\s+XU[ẤA]T|S[ẢA]N\s+XU[ẤA]T)`;
const EXPIRY_LABEL = String.raw`(?:HSD|HSĐ|EXP(?:IRY|IRES)?|BEST\s+BEFORE|BBE|USE\s+BY|H[ẠA]N\s+S[ỬU]\s+D[ỤU]NG)`;

const MANUFACTURE_DATE_RE = new RegExp(
  `${DATE_LABEL}\\s*[:\\-]?\\s*(\\d{1,4}[./-]\\d{1,2}[./-]\\d{1,4})`,
  "iu",
);
const EXPIRY_DATE_RE = new RegExp(
  `${EXPIRY_LABEL}\\s*[:\\-]?\\s*(\\d{1,4}[./-]\\d{1,2}[./-]\\d{1,4})`,
  "iu",
);
const LOT_RE = /(?:LOT|LÔ|LO|BATCH|SỐ\s+LÔ)\b\s*(?:NO\.?|#|:)?\s*([A-Z0-9][A-Z0-9./_-]{1,39})/iu;
const MANUFACTURER_RE =
  /(?:NHÀ\s+SẢN\s+XUẤT|MANUFACTURER|MANUFACTURED\s+BY|PRODUCED\s+BY|CÔNG\s+TY)\s*[:\-]?\s*([^\n]{2,120})/iu;
const PRODUCT_NAME_RE =
  /(?:TÊN\s+SẢN\s+PHẨM|PRODUCT\s+NAME)\s*[:\-]?\s*([^\n]{2,120})/iu;

function emptyFields(): ScanLotLabelFields {
  return {
    manufacture_date: null,
    expiry_date: null,
    lot: null,
    manufacturer: null,
    product_name: null,
    evidence_text: null,
  };
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Parse one printed date.  Accepted: YYYY-MM-DD, DD/MM/YYYY, DD.MM.YY,
 * DD-MM-YYYY (and a trailing time is ignored).  Two-digit years are 20YY.
 * Invalid calendar days such as 31/02/2026 return null.
 */
export function normalizeLotDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === "") return null;

  const times = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(raw);
  const dotted = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[T\s].*)?$/.exec(raw);
  let year: number;
  let month: number;
  let day: number;

  if (times) {
    year = Number(times[1]);
    month = Number(times[2]);
    day = Number(times[3]);
  } else if (dotted) {
    day = Number(dotted[1]);
    month = Number(dotted[2]);
    year = Number(dotted[3]);
    if (year < 100) year += 2000;
  } else {
    return null;
  }

  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isoParts(iso: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Add calendar months; Jan 31 + 1 month becomes Feb 28/29. */
export function addMonthsIso(iso: string, months: number): string | null {
  const parts = isoParts(iso);
  if (!parts || !Number.isFinite(months)) return null;
  const [year, month, day] = parts;
  const total = year * 12 + (month - 1) + Math.trunc(months);
  const nextYear = Math.floor(total / 12);
  const nextMonth = total % 12;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth + 1, 0)).getUTCDate();
  const nextDay = Math.min(day, lastDay);
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth + 1).padStart(2, "0")}-${String(nextDay).padStart(2, "0")}`;
}

export function addDaysIso(iso: string, days: number): string | null {
  const parts = isoParts(iso);
  if (!parts || !Number.isFinite(days)) return null;
  const base = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  const next = new Date(base + Math.trunc(days) * 86_400_000);
  return `${String(next.getUTCFullYear()).padStart(4, "0")}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

function shelfLifeUnit(unit: string): "month" | "day" | "year" {
  const normalized = unit.toLowerCase();
  if (/^(tháng|months?)/u.test(normalized)) return "month";
  if (/^(năm|years?)/u.test(normalized)) return "year";
  return "day";
}

/** Apply "sử dụng trong N tháng/ngày/năm" to the printed manufacture date. */
export function relativeExpiryFromText(
  text: string,
  manufactureDate: string | null,
): string | null {
  if (!manufactureDate) return null;

  const patterns: RegExp[] = [
    /(?:SỬ\s+DỤNG|DÙNG|USE)\s+(?:TRONG|WITHIN)\s+(\d{1,4})\s*(THÁNG|MONTHS?|NGÀY|DAYS?|NĂM|YEARS?)/iu,
    /(?:HẠN\s+SỬ\s+DỤNG|SHELF\s+LIFE|BEST\s+BEFORE)\s*[:\-]?\s*(\d{1,4})\s*(THÁNG|MONTHS?|NGÀY|DAYS?|NĂM|YEARS?)/iu,
    /(\d{1,4})\s*(THÁNG|MONTHS?|NGÀY|DAYS?|NĂM|YEARS?)\s*(?:KỂ\s+TỪ|TỪ|FROM)\s*(?:NGÀY\s+)?(?:SẢN\s+XUẤT|NSX|MANUFACTURE)/iu,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 3650) continue;
    const unit = shelfLifeUnit(match[2]);
    const expiry = unit === "month"
      ? addMonthsIso(manufactureDate, amount)
      : unit === "year"
        ? addMonthsIso(manufactureDate, amount * 12)
        : addDaysIso(manufactureDate, amount);
    if (expiry) return expiry;
  }

  return null;
}

/**
 * Best-effort extraction from OCR text.  The model answer is authoritative for
 * a field; this helper fills only fields the model left null.
 */
export function parseLotLabelText(text: string): ScanLotLabelFields {
  const fields = emptyFields();
  const body = String(text ?? "").normalize("NFC");
  if (body.trim() === "") return fields;

  fields.manufacture_date = normalizeLotDate(MANUFACTURE_DATE_RE.exec(body)?.[1]);
  fields.expiry_date = normalizeLotDate(EXPIRY_DATE_RE.exec(body)?.[1]);

  const lot = LOT_RE.exec(body)?.[1];
  fields.lot = lot ? lot.replace(/[.,;:]+$/g, "") : null;

  const manufacturer = MANUFACTURER_RE.exec(body)?.[1];
  fields.manufacturer = manufacturer
    ? manufacturer.replace(/\s+/g, " ").replace(/[.,;:]+$/g, "").trim() || null
    : null;

  const productName = PRODUCT_NAME_RE.exec(body)?.[1];
  fields.product_name = productName
    ? productName.replace(/\s+/g, " ").replace(/[.,;:]+$/g, "").trim() || null
    : null;

  if (!fields.expiry_date && fields.manufacture_date) {
    fields.expiry_date = relativeExpiryFromText(body, fields.manufacture_date);
  }

  return fields;
}

/** Validate one model answer.  A non-object answer is a bad OCR result. */
export function parseLotLabelAnswer(raw: Record<string, unknown>): ScanLotLabelFields {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ScanLotLabelError("ocr_failed", 502);
  }
  return {
    manufacture_date: normalizeLotDate(raw.manufacture_date),
    expiry_date: normalizeLotDate(raw.expiry_date),
    lot: textOrNull(raw.lot),
    manufacturer: textOrNull(raw.manufacturer),
    product_name: textOrNull(raw.product_name),
    evidence_text: textOrNull(raw.evidence_text),
  };
}

/** Model values win; OCR-text values fill only the gaps. */
export function mergeLotLabelFields(
  model: ScanLotLabelFields,
  text: ScanLotLabelFields,
): ScanLotLabelFields {
  return {
    manufacture_date: model.manufacture_date ?? text.manufacture_date,
    expiry_date: model.expiry_date ?? text.expiry_date,
    lot: model.lot ?? text.lot,
    manufacturer: model.manufacturer ?? text.manufacturer,
    product_name: model.product_name ?? text.product_name,
    evidence_text: model.evidence_text ?? text.evidence_text,
  };
}

export function hasAnyLotLabelValue(fields: ScanLotLabelFields): boolean {
  return fields.manufacture_date !== null
    || fields.expiry_date !== null
    || fields.lot !== null
    || fields.manufacturer !== null
    || fields.product_name !== null;
}

/** Map an image path to one of the two allowed private storage buckets. */
export function parseScanImagePath(raw: string): {
  bucket: "warehouse-photos" | "invoices";
  path: string;
} | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;

  let candidate = input;
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      const marker = "/storage/v1/object/";
      const idx = url.pathname.indexOf(marker);
      if (idx < 0) return null;
      const parts = url.pathname.slice(idx + marker.length).split("/").filter(Boolean);
      if (parts.length < 3 || !["public", "sign", "authenticated"].includes(parts[0])) {
        return null;
      }
      const bucket = parts[1];
      if (bucket !== "warehouse-photos" && bucket !== "invoices") return null;
      candidate = `${bucket}/${decodeURIComponent(parts.slice(2).join("/"))}`;
    } catch {
      return null;
    }
  }

  candidate = candidate.split("?")[0].split("#")[0].replace(/^\/+/, "");
  if (!candidate) return null;

  const otherBuckets = [
    "payment-slips",
    "purchase-orders",
    "payment-requests",
    "product-photos",
    "sku-images",
  ];
  if (otherBuckets.some((bucket) => candidate.startsWith(`${bucket}/`))) return null;
  if (candidate.includes("..")) return null;

  if (candidate.startsWith("warehouse-photos/")) {
    const path = candidate.slice("warehouse-photos/".length);
    return path ? { bucket: "warehouse-photos", path } : null;
  }
  if (candidate.startsWith("invoices/")) {
    const path = candidate.slice("invoices/".length);
    return path ? { bucket: "invoices", path } : null;
  }

  // Bare paths are package-label photos, which live in warehouse-photos.
  return { bucket: "warehouse-photos", path: candidate };
}

export function imageMimeFromPath(path: string): string {
  const lower = String(path ?? "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  return "image/jpeg";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseScanLotLabelInput(raw: Record<string, unknown>): ScanLotLabelInput {
  const allowed = new Set(["image_path", "image_base64", "mime_type"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new ScanLotLabelError("invalid_request", 400);
  }

  const hasPath = Object.prototype.hasOwnProperty.call(raw, "image_path");
  const hasBase64 = Object.prototype.hasOwnProperty.call(raw, "image_base64");
  if (hasPath === hasBase64) {
    throw new ScanLotLabelError("invalid_request", 400);
  }

  if (hasPath) {
    if (Object.prototype.hasOwnProperty.call(raw, "mime_type")) {
      throw new ScanLotLabelError("invalid_request", 400);
    }
    const value = raw.image_path;
    if (typeof value !== "string" || value.trim() === "" || value.length > 2_048) {
      throw new ScanLotLabelError("invalid_request", 400);
    }
    return { imagePath: value.trim() };
  }

  const base64 = raw.image_base64;
  const mime = raw.mime_type;
  if (typeof base64 !== "string" || base64.trim() === "" || base64.length > SCAN_LOT_LABEL_MAX_BASE64) {
    throw new ScanLotLabelError("invalid_request", 400);
  }
  if (typeof mime !== "string" || !/^image\/[a-z0-9.+-]+$/i.test(mime.trim())) {
    throw new ScanLotLabelError("invalid_request", 400);
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
    throw new ScanLotLabelError("invalid_request", 400);
  }
  return { imageBase64: base64.replace(/\s+/g, ""), mimeType: mime.trim().toLowerCase() };
}

async function readBody(req: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    throw new ScanLotLabelError("invalid_content_type", 415);
  }
  if (!req.body) throw new ScanLotLabelError("invalid_request", 400);
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
      if (size > SCAN_LOT_LABEL_BODY_LIMIT) {
        await reader.cancel();
        throw new ScanLotLabelError("body_limit", 413);
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
    if (!isRecord(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw new ScanLotLabelError("invalid_json", 400);
  }
}

function buildUserText(ocrText: string | null): string {
  if (ocrText === null) return "Ảnh nhãn được gửi kèm. Hãy đọc các trường lot.";
  const clipped = ocrText.length > 20_000 ? ocrText.slice(0, 20_000) : ocrText;
  return ["Nội dung nhãn (OCR):", "<<<OCR>>>", clipped].join("\n");
}

function errorCode(error: unknown): string {
  if (error instanceof IndraOcrError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.trim() !== "") return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() !== "" ? name : "error";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

export function createScanLotLabelHandler(deps: ScanLotLabelDeps) {
  const now = deps.now ?? Date.now;
  const readConfig = deps.indraConfig ?? readIndraOcrConfig;
  const runIndra = deps.callIndraOcr ?? callIndraOcr;
  const askDeepSeek = deps.callDeepSeekJson ?? callDeepSeekJson;

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
    const deadlineAt = started + SCAN_LOT_LABEL_BUDGET_MS;
    const signal = AbortSignal.any([
      req.signal,
      AbortSignal.timeout(SCAN_LOT_LABEL_BUDGET_MS),
    ]);
    const log = (engine: string, fallbackReason: string | null, ocrMs: number) => {
      deps.audit?.({
        fn: "scan-lot-label",
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
      const input = parseScanLotLabelInput(await readBody(req, signal));

      let image: ScanLotLabelImage;
      if (input.imagePath) {
        const loaded = await deps.loadImageFromPath(input.imagePath, signal);
        if (!loaded) throw new ScanLotLabelError("no_image", 422);
        image = loaded;
      } else {
        image = {
          base64: input.imageBase64 ?? "",
          mimeType: input.mimeType ?? "image/jpeg",
        };
      }
      if (!image.base64) throw new ScanLotLabelError("no_image", 422);

      let config: IndraOcrConfig | null = null;
      try {
        config = readConfig();
      } catch {
        config = null;
      }

      let fields: ScanLotLabelFields | null = null;
      let engine: ScanLotLabelOcrEngine = "deepseek";
      let fallbackReason: string | null = null;
      let ocrMs = 0;

      if (config?.engine === "indra") {
        if (!config.url || !config.token) {
          fallbackReason = "not_configured";
        } else {
          const ocrStarted = now();
          try {
            const result = await runIndra({
              base64: image.base64,
              mimeType: image.mimeType || "image/jpeg",
              config,
              signal,
            });
            const text = result.markdown.trim() ? result.markdown : result.text;
            ocrMs = now() - ocrStarted;
            if (!text.trim()) {
              fallbackReason = "empty_text";
            } else {
              const raw = await askDeepSeek({
                system: SYSTEM_PROMPT,
                userText: buildUserText(text),
                timeoutMs: remainingMs(),
                signal,
              });
              const model = parseLotLabelAnswer(raw);
              fields = mergeLotLabelFields(model, parseLotLabelText(text));
              engine = "indra";
              // OCR text can miss a small label: let the image path look once
              // before returning an all-null answer.
              if (!hasAnyLotLabelValue(fields)) {
                fallbackReason = "indra_empty";
                fields = null;
              }
            }
          } catch (error) {
            if (signal.aborted) throw error;
            ocrMs = ocrMs > 0 ? ocrMs : now() - ocrStarted;
            fallbackReason = errorCode(error);
            fields = null;
          }
        }
      }

      if (!fields) {
        try {
          const raw = await askDeepSeek({
            system: SYSTEM_PROMPT,
            userText: buildUserText(null),
            images: [{
              base64: image.base64,
              mimeType: image.mimeType || "image/jpeg",
            }],
            timeoutMs: remainingMs(),
            signal,
          });
          const model = parseLotLabelAnswer(raw);
          fields = mergeLotLabelFields(model, emptyFields());
          engine = "deepseek";
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof ScanLotLabelError) throw error;
          throw new ScanLotLabelError("ocr_failed", 502);
        }
      }

      log(engine, fallbackReason, ocrMs);
      return json({
        ok: true,
        ...fields,
        ocr_engine: engine,
        ocr_fallback_reason: fallbackReason,
      });
    } catch (error) {
      const timedOut = signal.aborted
        || (error as { name?: unknown } | null)?.name === "TimeoutError"
        || (error as { name?: unknown } | null)?.name === "AbortError";
      const code: ScanLotLabelErrorCode = timedOut
        ? "timeout"
        : error instanceof ScanLotLabelError
          ? error.code
          : "request_failed";
      const status = timedOut
        ? 504
        : error instanceof ScanLotLabelError
          ? error.status
          : 503;
      deps.audit?.({
        fn: "scan-lot-label",
        engine: "none",
        fallback_reason: code,
        ocr_ms: 0,
        total_ms: now() - started,
        error_code: code,
      });
      return json({
        ok: false,
        code,
        error: SCAN_LOT_LABEL_MESSAGES[code] ?? SCAN_LOT_LABEL_MESSAGES.request_failed,
      }, status);
    }
  };
}
