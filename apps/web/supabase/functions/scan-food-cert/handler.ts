// HTTP shell for reading a Vietnamese food-safety certificate.
//
// Structure follows scan-lot-label: the caller's JWT only authenticates them,
// the kho_item_can_edit gate is checked through the RPC, and the image/PDF is
// either inline base64 or downloaded from the private food-safety-docs bucket.
// Indra OCR runs first; DeepSeek JSON is the fallback (and the only engine when
// Indra is disabled).  This function never writes a certificate row.

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

export const SCAN_FOOD_CERT_BODY_LIMIT = 12_000_000;
export const SCAN_FOOD_CERT_BUDGET_MS = 60_000;
export const SCAN_FOOD_CERT_PROMPT_VERSION = "scan-food-cert-v1";
export const SCAN_FOOD_CERT_MAX_BASE64 = 10_000_000;

// _shared/indra-ocr.ts forwards the request body and mime type unchanged to
// POST /v1/ocr, so a PDF can be sent to Indra when it is configured.
export const INDRA_SUPPORTS_PDF = true;

export type ScanFoodCertType =
  | "attp_facility"
  | "coa"
  | "product_declaration"
  | "quarantine"
  | "other";

export type ScanFoodCertErrorCode =
  | "invalid_content_type"
  | "invalid_json"
  | "invalid_request"
  | "body_limit"
  | "unauthorized"
  | "forbidden"
  | "no_file"
  | "invalid_mime"
  | "ocr_failed"
  | "timeout"
  | "request_failed";

export class ScanFoodCertError extends Error {
  readonly code: ScanFoodCertErrorCode;
  readonly status: number;

  constructor(code: ScanFoodCertErrorCode, status: number) {
    super(code);
    this.name = "ScanFoodCertError";
    this.code = code;
    this.status = status;
  }
}

export type ScanFoodCertOcrEngine = "indra" | "deepseek";

export interface ScanFoodCertFile {
  base64: string;
  mimeType: string;
}

export interface ScanFoodCertInput {
  filePath?: string;
  imageBase64?: string;
  mimeType?: string;
}

export interface ScanFoodCertParty {
  id: string;
  name: string;
}

export interface ScanFoodCertMatch {
  kind: "manufacturer" | "supplier";
  id: string;
  name: string;
  score: number;
}

export interface ScanFoodCertEvidence {
  holder: string | null;
  cert_no: string | null;
  expires: string | null;
}

/** Only values printed on the paper; every absent field is null. */
export interface ScanFoodCertFields {
  cert_type: ScanFoodCertType;
  holder_name: string | null;
  cert_no: string | null;
  issuer: string | null;
  issued_on: string | null;
  expires_on: string | null;
  validity_years: number | null;
  product_name: string | null;
  evidence: ScanFoodCertEvidence;
  expires_computed: boolean;
}

export interface ScanFoodCertResult extends ScanFoodCertFields {
  ok: true;
  ocr_engine: ScanFoodCertOcrEngine;
  ocr_fallback_reason: string | null;
  match: ScanFoodCertMatch | null;
  suggested_item_ids: string[];
}

export interface ScanFoodCertDeps {
  authenticate: (
    request: Request,
    signal: AbortSignal,
  ) => Promise<{ userId: string }>;
  checkGate: (userId: string, signal: AbortSignal) => Promise<boolean>;
  loadFileFromPath: (
    path: string,
    signal: AbortSignal,
  ) => Promise<ScanFoodCertFile | null>;
  indraConfig?: () => IndraOcrConfig;
  callIndraOcr?: (options: {
    base64?: string;
    mimeType: string;
    config: IndraOcrConfig;
    signal?: AbortSignal;
  }) => Promise<IndraOcrResult>;
  callDeepSeekJson?: (options: CallDeepSeekJsonOptions) => Promise<Record<string, unknown>>;
  loadParties: (signal: AbortSignal) => Promise<{
    manufacturers: ScanFoodCertParty[];
    suppliers: ScanFoodCertParty[];
  }>;
  loadSuggestedItems: (
    match: ScanFoodCertMatch,
    signal: AbortSignal,
  ) => Promise<string[]>;
  audit?: (event: Record<string, unknown>) => void;
  now?: () => number;
}

export const SCAN_FOOD_CERT_MESSAGES: Record<ScanFoodCertErrorCode, string> = {
  invalid_content_type: "Yêu cầu đọc giấy tờ phải là JSON.",
  invalid_json: "Nội dung yêu cầu đọc giấy tờ không hợp lệ.",
  invalid_request: "Yêu cầu đọc giấy tờ không hợp lệ.",
  body_limit: "Tệp giấy tờ quá lớn.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Anh không có quyền sửa hồ sơ kho.",
  no_file: "Không tìm thấy tệp giấy tờ.",
  invalid_mime: "Chỉ nhận ảnh hoặc PDF.",
  ocr_failed: "Chưa đọc được giấy tờ. Anh thử lại giúp.",
  timeout: "Đọc giấy tờ vượt thời gian cho phép. Anh thử lại sau.",
  request_failed: "Chưa đọc được giấy tờ. Anh thử lại giúp.",
};

const SYSTEM_PROMPT = `Bạn đọc giấy tờ an toàn thực phẩm của một cơ sở / sản phẩm / lô hàng Việt Nam.
Chỉ trả về MỘT JSON object, không markdown, đúng dạng:
{
  "cert_type": "attp_facility" | "coa" | "product_declaration" | "quarantine" | "other",
  "holder_name": "tên đơn vị được cấp / chủ giấy" hoặc null,
  "cert_no": "số giấy / số chứng nhận" hoặc null,
  "issuer": "cơ quan / đơn vị cấp" hoặc null,
  "issued_on": "YYYY-MM-DD" hoặc null,
  "expires_on": "YYYY-MM-DD" hoặc null,
  "validity_years": số năm hiệu lực hoặc null,
  "product_name": "tên sản phẩm / nhóm sản phẩm" hoặc null,
  "evidence": {
    "holder": "đoạn chữ ngắn chứng minh tên đơn vị" hoặc null,
    "cert_no": "đoạn chữ ngắn chứng minh số giấy" hoặc null,
    "expires": "đoạn chữ ngắn chứng minh ngày hết hạn / hiệu lực" hoặc null
  }
}

Quy tắc bắt buộc:
- "Giấy chứng nhận cơ sở đủ điều kiện ATTP" / "Giấy chứng nhận ATTP" là attp_facility.
- "Phiếu kiểm nghiệm" / "COA" / "Certificate of Analysis" là coa.
- "Bản công bố sản phẩm" / "Tự công bố" là product_declaration.
- "Giấy kiểm dịch" / "Giấy chứng nhận kiểm dịch" là quarantine.
- Giấy khác là other.
- holder_name là tên đơn vị được cấp, không phải người ký.
- issued_on / expires_on trả đúng YYYY-MM-DD. Không thấy thì null. KHÔNG tự bịa, KHÔNG đoán, KHÔNG dùng ngày hôm nay.
- validity_years chỉ lấy khi giấy ghi rõ hiệu lực, ví dụ "có hiệu lực 03 năm" -> 3.
- evidence chỉ là đoạn chữ ngắn lấy từ giấy, không diễn giải.
- Chỉ đọc giấy tờ; không suy ra từ kiến thức bên ngoài.`;

function emptyEvidence(): ScanFoodCertEvidence {
  return { holder: null, cert_no: null, expires: null };
}

function emptyFields(): ScanFoodCertFields {
  return {
    cert_type: "other",
    holder_name: null,
    cert_no: null,
    issuer: null,
    issued_on: null,
    expires_on: null,
    validity_years: null,
    product_name: null,
    evidence: emptyEvidence(),
    expires_computed: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Parse one printed date.  Accepted: YYYY-MM-DD, DD/MM/YYYY, DD.MM.YY,
 * DD-MM-YYYY (and a trailing time is ignored).  Two-digit years are 20YY.
 */
export function normalizeCertDate(value: unknown): string | null {
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

function isoFromUtc(value: Date): string {
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

/**
 * "Có hiệu lực 03 năm" means the paper is valid through the day before the
 * same date N years later.  Invalid years/dates return null.
 */
export function addValidityYearsMinusOneDay(
  issuedOn: string | null,
  validityYears: number | null,
): string | null {
  if (!issuedOn || validityYears === null) return null;
  if (!Number.isFinite(validityYears) || validityYears <= 0 || validityYears > 100) return null;
  const parts = isoParts(issuedOn);
  if (!parts) return null;
  const [year, month, day] = parts;
  const end = new Date(Date.UTC(year + Math.trunc(validityYears), month - 1, day));
  end.setUTCDate(end.getUTCDate() - 1);
  return isoFromUtc(end);
}

export function parseValidityYears(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value <= 100 ? Math.trunc(value) : null;
  }
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;

  const years = /(\d{1,3})\s*(?:năm|nam|years?|tuổi)/iu.exec(raw);
  if (years) {
    const amount = Number(years[1]);
    return amount > 0 && amount <= 100 ? amount : null;
  }

  const months = /(\d{1,4})\s*(?:tháng|thang|months?)/iu.exec(raw);
  if (months) {
    const amount = Number(months[1]);
    if (amount > 0 && amount % 12 === 0 && amount / 12 <= 100) return amount / 12;
    return null;
  }

  const bare = /^(\d{1,3})$/.exec(raw);
  if (bare) {
    const amount = Number(bare[1]);
    return amount > 0 && amount <= 100 ? amount : null;
  }
  return null;
}

function normalizeCertType(value: unknown): ScanFoodCertType {
  const raw = String(value ?? "").trim().toLowerCase();
  if (
    raw === "attp_facility"
    || raw === "coa"
    || raw === "product_declaration"
    || raw === "quarantine"
    || raw === "other"
  ) {
    return raw;
  }
  // Tolerate a model that answers with the Vietnamese paper name.
  if (raw.includes("kiểm dịch") || raw.includes("kiem dich")) return "quarantine";
  if (raw.includes("công bố") || raw.includes("cong bo")) return "product_declaration";
  if (raw.includes("kiểm nghiệm") || raw.includes("kiem nghiem") || raw.includes("coa")) return "coa";
  if (raw.includes("attp") || raw.includes("atp") || raw.includes("cơ sở")) return "attp_facility";
  return "other";
}

/** Validate one model answer and compute expires_on from issued + validity. */
export function parseFoodCertAnswer(raw: Record<string, unknown>): ScanFoodCertFields {
  if (!isRecord(raw)) throw new ScanFoodCertError("ocr_failed", 502);

  const evidenceRaw = isRecord(raw.evidence) ? raw.evidence : {};
  const fields: ScanFoodCertFields = {
    cert_type: normalizeCertType(raw.cert_type),
    holder_name: textOrNull(raw.holder_name),
    cert_no: textOrNull(raw.cert_no),
    issuer: textOrNull(raw.issuer),
    issued_on: normalizeCertDate(raw.issued_on),
    expires_on: normalizeCertDate(raw.expires_on),
    validity_years: parseValidityYears(raw.validity_years),
    product_name: textOrNull(raw.product_name),
    evidence: {
      holder: textOrNull(evidenceRaw.holder),
      cert_no: textOrNull(evidenceRaw.cert_no),
      expires: textOrNull(evidenceRaw.expires),
    },
    expires_computed: false,
  };

  if (!fields.expires_on && fields.issued_on && fields.validity_years !== null) {
    const computed = addValidityYearsMinusOneDay(fields.issued_on, fields.validity_years);
    if (computed) {
      fields.expires_on = computed;
      fields.expires_computed = true;
    }
  }

  return fields;
}

export function hasAnyFoodCertValue(fields: ScanFoodCertFields): boolean {
  return fields.cert_type !== "other"
    || fields.holder_name !== null
    || fields.cert_no !== null
    || fields.issuer !== null
    || fields.issued_on !== null
    || fields.expires_on !== null
    || fields.product_name !== null;
}

const PARTY_STOP_WORDS = new Set([
  "cong",
  "ty",
  "cty",
  "tnhh",
  "co",
  "phan",
  "cp",
  "viet",
  "nam",
  "vn",
]);

/** Case/accent-insensitive party name with corporate tokens removed. */
export function normalizePartyName(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token !== "" && !PARTY_STOP_WORDS.has(token))
    .join(" ");
}

function bigrams(value: string): string[] {
  if (value.length < 2) return [value];
  const result: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    result.push(value.slice(index, index + 2));
  }
  return result;
}

/** Dice bigram score; exact/containment get a small bonus. */
export function partyNameScore(left: string, right: string): number {
  const a = normalizePartyName(left);
  const b = normalizePartyName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;

  const leftBigrams = bigrams(a);
  const rightBigrams = bigrams(b);
  const counts = new Map<string, number>();
  for (const gram of leftBigrams) counts.set(gram, (counts.get(gram) ?? 0) + 1);

  let overlap = 0;
  for (const gram of rightBigrams) {
    const count = counts.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      counts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

export function matchFoodCertHolder(
  holder: string | null,
  parties: { manufacturers: ScanFoodCertParty[]; suppliers: ScanFoodCertParty[] },
): ScanFoodCertMatch | null {
  if (!holder || !normalizePartyName(holder)) return null;

  const candidates: Array<{
    kind: "manufacturer" | "supplier";
    party: ScanFoodCertParty;
  }> = [
    ...parties.manufacturers.map((party) => ({ kind: "manufacturer" as const, party })),
    ...parties.suppliers.map((party) => ({ kind: "supplier" as const, party })),
  ];

  let best: ScanFoodCertMatch | null = null;
  for (const candidate of candidates) {
    const score = partyNameScore(holder, candidate.party.name);
    if (best === null || score > best.score) {
      best = {
        kind: candidate.kind,
        id: candidate.party.id,
        name: candidate.party.name,
        score: Math.round(score * 100) / 100,
      };
    }
  }

  if (best === null) return null;
  return best.score >= 0.55 ? best : null;
}

function isSupportedMime(value: string): boolean {
  return /^image\/[a-z0-9.+-]+$/i.test(value) || value === "application/pdf";
}

export function normalizeMime(value: string): string {
  return String(value ?? "").trim().toLowerCase().split(";")[0].trim();
}

function isPdfMime(value: string): boolean {
  return normalizeMime(value) === "application/pdf";
}

export function parseScanFoodCertInput(raw: Record<string, unknown>): ScanFoodCertInput {
  const allowed = new Set(["file_path", "image_base64", "mime_type"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new ScanFoodCertError("invalid_request", 400);
  }

  const hasPath = Object.prototype.hasOwnProperty.call(raw, "file_path");
  const hasBase64 = Object.prototype.hasOwnProperty.call(raw, "image_base64");
  if (hasPath === hasBase64) {
    throw new ScanFoodCertError("invalid_request", 400);
  }

  if (hasPath) {
    if (Object.prototype.hasOwnProperty.call(raw, "mime_type")) {
      throw new ScanFoodCertError("invalid_request", 400);
    }
    const value = raw.file_path;
    if (typeof value !== "string" || value.trim() === "" || value.length > 2_048) {
      throw new ScanFoodCertError("invalid_request", 400);
    }
    if (value.includes("..")) throw new ScanFoodCertError("invalid_request", 400);
    return { filePath: value.trim() };
  }

  const base64 = raw.image_base64;
  const mime = raw.mime_type;
  if (typeof base64 !== "string" || base64.trim() === "" || base64.length > SCAN_FOOD_CERT_MAX_BASE64) {
    throw new ScanFoodCertError("invalid_request", 400);
  }
  if (typeof mime !== "string" || !isSupportedMime(normalizeMime(mime))) {
    throw new ScanFoodCertError("invalid_mime", 415);
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
    throw new ScanFoodCertError("invalid_request", 400);
  }
  return { imageBase64: base64.replace(/\s+/g, ""), mimeType: normalizeMime(mime) };
}

export function certMimeFromPath(path: string): string {
  const lower = String(path ?? "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  return "image/jpeg";
}

async function readBody(req: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    throw new ScanFoodCertError("invalid_content_type", 415);
  }
  if (!req.body) throw new ScanFoodCertError("invalid_request", 400);
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
      if (size > SCAN_FOOD_CERT_BODY_LIMIT) {
        await reader.cancel();
        throw new ScanFoodCertError("body_limit", 413);
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
    throw new ScanFoodCertError("invalid_json", 400);
  }
}

function buildUserText(ocrText: string | null): string {
  if (ocrText === null) return "Ảnh/PDF giấy tờ được gửi kèm. Hãy đọc các trường hồ sơ ATTP.";
  const clipped = ocrText.length > 20_000 ? ocrText.slice(0, 20_000) : ocrText;
  return ["Nội dung giấy tờ (OCR):", "<<<OCR>>>", clipped].join("\n");
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

export function createScanFoodCertHandler(deps: ScanFoodCertDeps) {
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
    const deadlineAt = started + SCAN_FOOD_CERT_BUDGET_MS;
    const signal = AbortSignal.any([
      req.signal,
      AbortSignal.timeout(SCAN_FOOD_CERT_BUDGET_MS),
    ]);
    const log = (engine: string, fallbackReason: string | null, ocrMs: number) => {
      deps.audit?.({
        fn: "scan-food-cert",
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

      const allowed = await deps.checkGate(auth.userId, signal);
      if (!allowed) throw new ScanFoodCertError("forbidden", 403);
      throwIfAborted(signal);

      const input = parseScanFoodCertInput(await readBody(req, signal));

      let file: ScanFoodCertFile;
      if (input.filePath) {
        const loaded = await deps.loadFileFromPath(input.filePath, signal);
        if (!loaded) throw new ScanFoodCertError("no_file", 422);
        file = loaded;
      } else {
        file = {
          base64: input.imageBase64 ?? "",
          mimeType: input.mimeType ?? "image/jpeg",
        };
      }
      if (!file.base64) throw new ScanFoodCertError("no_file", 422);
      file.mimeType = normalizeMime(file.mimeType || "image/jpeg");
      if (!isSupportedMime(file.mimeType)) {
        throw new ScanFoodCertError("invalid_mime", 415);
      }

      let config: IndraOcrConfig | null = null;
      try {
        config = readConfig();
      } catch {
        config = null;
      }

      let fields: ScanFoodCertFields | null = null;
      let engine: ScanFoodCertOcrEngine = "deepseek";
      let fallbackReason: string | null = null;
      let ocrMs = 0;

      if (config?.engine === "indra") {
        if (!config.url || !config.token) {
          fallbackReason = "not_configured";
        } else if (isPdfMime(file.mimeType) && !INDRA_SUPPORTS_PDF) {
          fallbackReason = "pdf_not_supported";
        } else {
          const ocrStarted = now();
          try {
            const result = await runIndra({
              base64: file.base64,
              mimeType: file.mimeType,
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
              const answer = parseFoodCertAnswer(raw);
              if (!hasAnyFoodCertValue(answer)) {
                fallbackReason = "indra_empty";
              } else {
                fields = answer;
                engine = "indra";
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
              base64: file.base64,
              mimeType: file.mimeType,
            }],
            timeoutMs: remainingMs(),
            signal,
          });
          fields = parseFoodCertAnswer(raw);
          engine = "deepseek";
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof ScanFoodCertError) throw error;
          throw new ScanFoodCertError("ocr_failed", 502);
        }
      }

      if (!fields) throw new ScanFoodCertError("ocr_failed", 502);

      let match: ScanFoodCertMatch | null = null;
      let suggestedItemIds: string[] = [];
      try {
        const parties = await deps.loadParties(signal);
        match = matchFoodCertHolder(fields.holder_name, parties);
      } catch (error) {
        if (signal.aborted) throw error;
        // A suggestion lookup must not discard a good OCR answer.
        match = null;
      }
      if (match) {
        try {
          suggestedItemIds = await deps.loadSuggestedItems(match, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          suggestedItemIds = [];
        }
      }

      log(engine, fallbackReason, ocrMs);
      return json({
        ok: true,
        ...fields,
        ocr_engine: engine,
        ocr_fallback_reason: fallbackReason,
        match,
        suggested_item_ids: [...new Set(suggestedItemIds)],
      });
    } catch (error) {
      const timedOut = signal.aborted
        || (error as { name?: unknown } | null)?.name === "TimeoutError"
        || (error as { name?: unknown } | null)?.name === "AbortError";
      const code: ScanFoodCertErrorCode = timedOut
        ? "timeout"
        : error instanceof ScanFoodCertError
          ? error.code
          : "request_failed";
      const status = timedOut
        ? 504
        : error instanceof ScanFoodCertError
          ? error.status
          : 503;
      deps.audit?.({
        fn: "scan-food-cert",
        engine: "none",
        fallback_reason: code,
        ocr_ms: 0,
        total_ms: now() - started,
        error_code: code,
      });
      return json({
        ok: false,
        code,
        error: SCAN_FOOD_CERT_MESSAGES[code] ?? SCAN_FOOD_CERT_MESSAGES.request_failed,
      }, status);
    }
  };
}
