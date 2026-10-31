// Server-side Jev evaluator for saved dispatch-report photos.
//
// Jev (typesafe-ai/jev) is a text decision model, so the image is first read by
// the shared OCR helper in index.ts and only the recognised text is sent here.
// One evaluation call answers one bounded `kind` choice question:
//
//   phieu_xuat_kho | bien_ban_giao_hang | hoa_don | khac
//
// PO numbers and quantities are the document fields the OCR text exposes; the
// evaluator validates and bounds them into the fixed result shape
// {kind, po_numbers[], quantities[{po_number, qty}], summary} before the
// handler stores anything. The transport is the verified AI Gateway contract
// copied from kho-review-jev: POST https://ai-gateway.vercel.sh/v1/evaluate,
// model typesafe-ai/jev, providerOptions.gateway {zeroDataRetention: true,
// only: ["typesafe-ai"]}, one deadline per call and no retry.
//
// This module holds no database client and never sees an API key from the
// caller: the key is supplied by index.ts from the server environment only.

import {
  DecisionsError,
  decisionsFailureCode,
  evaluateDecisions,
  type DecisionsOutcome,
} from "../_shared/decisions-provider.ts";
import {
  JEV_BODY_LIMIT,
  JEV_CIRCUIT_COOLDOWN_MS,
  JEV_CIRCUIT_THRESHOLD,
  JEV_ENDPOINT,
  JEV_MAX_TIMEOUT_MS,
  JEV_MODEL,
  createJevCircuit,
  type JevCircuit,
} from "../bmq-analytics/jev.ts";

export const DISPATCH_REPORT_JEV_PROMPT_VERSION = "jev-dispatch-report-2026-11-01.1";
export const DISPATCH_REPORT_JEV_MODEL = JEV_MODEL;
export const DISPATCH_REPORT_JEV_TIMEOUT_MS = 6000;
export const DISPATCH_REPORT_JEV_BODY_LIMIT = JEV_BODY_LIMIT;
export const DISPATCH_REPORT_JEV_MAX_PO = 10;
export const DISPATCH_REPORT_JEV_OCR_MAX_CHARS = 12_000;
export const DISPATCH_REPORT_JEV_SUMMARY_MAX_CHARS = 500;
export const DISPATCH_REPORT_JEV_ERROR_MAX_CHARS = 200;

export type DispatchReportJevKind =
  | "phieu_xuat_kho"
  | "bien_ban_giao_hang"
  | "hoa_don"
  | "khac";

export const DISPATCH_REPORT_JEV_KINDS: readonly DispatchReportJevKind[] = [
  "phieu_xuat_kho",
  "bien_ban_giao_hang",
  "hoa_don",
  "khac",
];

export const DISPATCH_REPORT_JEV_KIND_LABELS: Record<DispatchReportJevKind, string> = {
  phieu_xuat_kho: "Phiếu xuất kho",
  bien_ban_giao_hang: "Biên bản giao hàng",
  hoa_don: "Hoá đơn",
  khac: "Khác",
};

export interface DispatchReportJevQuantity {
  po_number: string;
  qty: number;
}

export interface DispatchReportJevEvaluation {
  kind: DispatchReportJevKind;
  po_numbers: string[];
  quantities: DispatchReportJevQuantity[];
  summary: string;
}

export interface DispatchReportJevEvaluatorParams {
  /** Text returned by the shared OCR helper; never raw image bytes. */
  ocrText: string;
  date: string;
  signal: AbortSignal;
  /** Absolute epoch-ms budget for the whole request, if any. */
  deadlineAt?: number;
}

export type DispatchReportJevEvaluator = (
  params: DispatchReportJevEvaluatorParams,
) => Promise<DispatchReportJevEvaluation>;

export interface DispatchReportJevConfig {
  apiKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  circuit?: JevCircuit;
}

export class DispatchReportJevError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly detail: string | null = null,
  ) {
    super(code);
    this.name = "DispatchReportJevError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** The one semantic question Jev answers. Everything else is document text. */
export function dispatchReportJevQuestions() {
  return {
    kind: {
      type: "choice",
      instructions:
        "Ảnh chứng từ xuất kho này là loại giấy tờ nào? Chỉ chọn theo nội dung nhìn thấy trong phần chữ OCR.",
      criteria: {
        phieu_xuat_kho:
          "Phiếu xuất kho / phiếu giao hàng nội bộ có số phiếu, ngày xuất, tên hàng và số lượng xuất.",
        bien_ban_giao_hang:
          "Biên bản giao hàng / biên bản bàn giao có người giao, người nhận và danh sách hàng giao.",
        hoa_don:
          "Hoá đơn bán hàng / hoá đơn GTGT có ký hiệu hoá đơn, số hoá đơn, tiền thuế hoặc tổng tiền.",
        khac:
          "Không phải một trong ba loại trên, hoặc ảnh không đọc được nội dung chứng từ.",
      },
    },
  };
}

function validateKindAnswer(body: unknown): DispatchReportJevKind {
  if (!isRecord(body) || body.model !== JEV_MODEL) {
    throw new DispatchReportJevError("jev_invalid_response", 502);
  }
  if (!isRecord(body.answers)) {
    throw new DispatchReportJevError("jev_invalid_response", 502);
  }
  const answer = body.answers.kind;
  if (!isRecord(answer) || answer.type !== "choice") {
    throw new DispatchReportJevError("jev_invalid_response", 502);
  }
  for (const key of Object.keys(answer)) {
    if (key !== "type" && key !== "choice" && key !== "probabilities" && key !== "confidence") {
      throw new DispatchReportJevError("jev_invalid_response", 502);
    }
  }
  if (Object.hasOwn(answer, "confidence") && !finiteUnit(answer.confidence)) {
    throw new DispatchReportJevError("jev_invalid_response", 502);
  }
  if (
    typeof answer.choice !== "string"
    || !DISPATCH_REPORT_JEV_KINDS.includes(answer.choice as DispatchReportJevKind)
  ) {
    throw new DispatchReportJevError("jev_invalid_response", 502);
  }
  if (!isRecord(answer.probabilities)) {
    throw new DispatchReportJevError("jev_invalid_response", 502);
  }
  const probabilities = answer.probabilities;
  if (
    Object.keys(probabilities).length !== DISPATCH_REPORT_JEV_KINDS.length
    || DISPATCH_REPORT_JEV_KINDS.some((option) => !Object.hasOwn(probabilities, option))
  ) {
    throw new DispatchReportJevError("jev_invalid_response", 502);
  }
  let sum = 0;
  for (const option of DISPATCH_REPORT_JEV_KINDS) {
    if (!finiteUnit(probabilities[option])) {
      throw new DispatchReportJevError("jev_invalid_response", 502);
    }
    sum += probabilities[option] as number;
  }
  const choice = answer.choice as DispatchReportJevKind;
  const chosen = probabilities[choice] as number;
  if (
    DISPATCH_REPORT_JEV_KINDS.some(
      (option) => option !== choice && (probabilities[option] as number) >= chosen,
    )
  ) {
    throw new DispatchReportJevError("jev_invalid_response", 502);
  }
  if (Math.abs(sum - 1) > 0.02) {
    throw new DispatchReportJevError("jev_invalid_response", 502);
  }
  return choice;
}

const PO_PATTERN = /\bPO\s*[:\-]?\s*(\d{8,12})\b/gi;
const NUMBER_PATTERN = /\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;

/** Normalise one PO token to "PO" + digits; returns null for a bad shape. */
export function normalizeDispatchPoNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^PO\s*[:\-]?\s*(\d{8,12})$/i.exec(value.trim());
  return match ? `PO${match[1]}` : null;
}

/** Parse a Vietnamese/English quantity token; null when it is not a number. */
export function parseDispatchQuantityToken(token: string): number | null {
  const value = token.trim();
  if (!/^\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?$/.test(value)) return null;
  let text = value;
  if (value.includes(",") && value.includes(".")) {
    if (value.lastIndexOf(",") > value.lastIndexOf(".")) {
      text = value.replace(/\./g, "").replace(",", ".");
    } else {
      text = value.replace(/,/g, "");
    }
  } else if (value.includes(",")) {
    text = /^\d{1,3}(?:,\d{3})+$/.test(value)
      ? value.replace(/,/g, "")
      : value.replace(",", ".");
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(value)) {
    text = value.replace(/\./g, "");
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function lineNumbersAfterPo(line: string, po: string): number[] {
  const upper = line.toUpperCase();
  const index = upper.indexOf(po);
  const segment = index >= 0 ? line.slice(index + po.length) : line;
  // Another PO or a date on the same/next line is not a delivered quantity.
  const cleaned = segment
    .replace(/\bPO\s*[:\-]?\s*\d{8,12}\b/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{1,2}[\/]\d{1,2}[\/]\d{2,4}\b/g, " ");
  const numbers: number[] = [];
  for (const match of cleaned.matchAll(NUMBER_PATTERN)) {
    const token = match[0];
    const value = parseDispatchQuantityToken(token);
    if (value === null) continue;
    // A year or a clock/date fragment is not a delivered quantity.
    if (value >= 1900 && value <= 2099 && !token.includes(".") && !token.includes(",")) continue;
    if (value > 1_000_000_000) continue;
    numbers.push(value);
  }
  return numbers;
}

/**
 * Read PO numbers and the first plausible quantity on each PO's line from OCR
 * text. Jev owns the document kind; these are bounded document fields and every
 * value is sanitised again by sanitizeDispatchReportJevEvaluation().
 */
export function extractDispatchDocumentFields(ocrText: string): {
  po_numbers: string[];
  quantities: DispatchReportJevQuantity[];
} {
  const text = clip(String(ocrText ?? ""), DISPATCH_REPORT_JEV_OCR_MAX_CHARS);
  const lines = text.split(/\r?\n/);
  const poNumbers: string[] = [];
  const quantities: DispatchReportJevQuantity[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const match of line.matchAll(PO_PATTERN)) {
      const po = `PO${match[1]}`;
      if (seen.has(po)) continue;
      seen.add(po);
      poNumbers.push(po);
      if (poNumbers.length >= DISPATCH_REPORT_JEV_MAX_PO) break;

      const context = `${line} ${lines[index + 1] ?? ""}`;
      const numbers = lineNumbersAfterPo(context, po);
      if (numbers.length > 0) {
        quantities.push({ po_number: po, qty: numbers[0] });
      }
    }
    if (poNumbers.length >= DISPATCH_REPORT_JEV_MAX_PO) break;
  }

  return { po_numbers: poNumbers, quantities };
}

function buildSummary(
  kind: DispatchReportJevKind,
  poNumbers: string[],
  quantities: DispatchReportJevQuantity[],
): string {
  const parts: string[] = [DISPATCH_REPORT_JEV_KIND_LABELS[kind]];
  if (poNumbers.length > 0) {
    parts.push(`PO ${poNumbers.join(", ")}`);
  }
  if (quantities.length > 0) {
    parts.push(
      `SL ${quantities.map((item) => `${item.po_number}: ${item.qty}`).join(", ")}`,
    );
  }
  if (poNumbers.length === 0) {
    parts.push("chưa đọc được số PO");
  }
  return clip(parts.join(" · "), DISPATCH_REPORT_JEV_SUMMARY_MAX_CHARS);
}

/**
 * Validate an arbitrary value as the fixed result shape. Unknown kinds, extra
 * keys, bad PO values and non-finite quantities are dropped instead of stored.
 */
export function sanitizeDispatchReportJevEvaluation(
  value: unknown,
): DispatchReportJevEvaluation | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.kind !== "string"
    || !DISPATCH_REPORT_JEV_KINDS.includes(value.kind as DispatchReportJevKind)
  ) {
    return null;
  }
  const kind = value.kind as DispatchReportJevKind;

  const poNumbers: string[] = [];
  const seenPo = new Set<string>();
  if (Array.isArray(value.po_numbers)) {
    for (const raw of value.po_numbers) {
      const po = normalizeDispatchPoNumber(raw);
      if (po === null || seenPo.has(po)) continue;
      seenPo.add(po);
      poNumbers.push(po);
      if (poNumbers.length >= DISPATCH_REPORT_JEV_MAX_PO) break;
    }
  }

  const quantities: DispatchReportJevQuantity[] = [];
  const seenQty = new Set<string>();
  if (Array.isArray(value.quantities)) {
    for (const raw of value.quantities) {
      if (!isRecord(raw)) continue;
      const po = normalizeDispatchPoNumber(raw.po_number);
      if (po === null || seenQty.has(po)) continue;
      const qty = typeof raw.qty === "number"
        ? raw.qty
        : typeof raw.qty === "string"
          ? Number(raw.qty)
          : Number.NaN;
      if (!Number.isFinite(qty) || qty < 0) continue;
      seenQty.add(po);
      quantities.push({ po_number: po, qty });
      if (quantities.length >= DISPATCH_REPORT_JEV_MAX_PO) break;
    }
  }

  const summary = clip(
    typeof value.summary === "string"
      ? value.summary.replace(/\s+/g, " ").trim()
      : buildSummary(kind, poNumbers, quantities),
    DISPATCH_REPORT_JEV_SUMMARY_MAX_CHARS,
  );

  return { kind, po_numbers: poNumbers, quantities, summary };
}

export function createDispatchReportJevEvaluator(
  config: DispatchReportJevConfig,
): DispatchReportJevEvaluator {
  const apiKey = config.apiKey ?? "";
  if (!apiKey) throw new DispatchReportJevError("jev_unconfigured", 503);
  const fetcher = config.fetcher ?? fetch;
  const circuit = config.circuit ?? createJevCircuit({
    threshold: JEV_CIRCUIT_THRESHOLD,
    cooldownMs: JEV_CIRCUIT_COOLDOWN_MS,
  });
  const configuredTimeout = Math.max(
    1,
    Math.min(config.timeoutMs ?? DISPATCH_REPORT_JEV_TIMEOUT_MS, JEV_MAX_TIMEOUT_MS),
  );

  return async ({ ocrText, date, signal, deadlineAt }): Promise<DispatchReportJevEvaluation> => {
    signal.throwIfAborted();
    if (!circuit.canAttempt()) throw new DispatchReportJevError("jev_circuit_open", 503);
    const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    if (remaining <= 0) throw new DispatchReportJevError("jev_deadline_exceeded", 504);
    const budget = Math.max(1, Math.min(configuredTimeout, remaining));
    const requestBody = {
      model: JEV_MODEL,
      state: {
        report_date: date,
        document_text: clip(String(ocrText ?? ""), DISPATCH_REPORT_JEV_OCR_MAX_CHARS),
      },
      questions: dispatchReportJevQuestions(),
      // Server-side key only; no caller bearer token is sent to the provider.
      providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } },
    };
    let outcome: DecisionsOutcome;
    try {
      outcome = await evaluateDecisions(requestBody, {
        fetcher,
        gatewayUrl: JEV_ENDPOINT,
        gatewayKey: apiKey,
        timeoutMs: budget,
        signal,
        maxBodyBytes: DISPATCH_REPORT_JEV_BODY_LIMIT,
      });
    } catch (error) {
      signal.throwIfAborted();
      circuit.recordFailure();
      const code = decisionsFailureCode(error);
      throw new DispatchReportJevError(
        code,
        code === "jev_timeout" ? 504 : code === "jev_invalid_response" ? 502 : 503,
        error instanceof DecisionsError ? error.detail : null,
      );
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      circuit.recordFailure();
      const detail = outcome.body == null
        ? `HTTP ${outcome.status}`
        : `HTTP ${outcome.status}: ${String(outcome.body).replace(/\s+/g, " ").slice(0, 300)}`;
      if (outcome.status === 429) {
        throw new DispatchReportJevError("jev_rate_limited", 429, detail);
      }
      throw new DispatchReportJevError("jev_http_error", 502, detail);
    }
    let kind: DispatchReportJevKind;
    try {
      kind = validateKindAnswer(outcome.body);
    } catch (error) {
      circuit.recordFailure();
      throw error;
    }
    circuit.recordSuccess();
    const fields = extractDispatchDocumentFields(ocrText);
    const evaluation = sanitizeDispatchReportJevEvaluation({
      kind,
      po_numbers: fields.po_numbers,
      quantities: fields.quantities,
      summary: buildSummary(kind, fields.po_numbers, fields.quantities),
    });
    if (evaluation === null) {
      throw new DispatchReportJevError("jev_invalid_response", 502);
    }
    return evaluation;
  };
}

export function dispatchReportJevErrorCode(error: unknown): string {
  if (error instanceof DispatchReportJevError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[a-z0-9_]+$/i.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name !== "" ? name : "request_failed";
}
