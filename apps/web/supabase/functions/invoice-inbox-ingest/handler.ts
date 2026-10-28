// HTTP shell for the invoice inbox ingest worker.
//
// The handler authenticates the caller server-side (the 'invoice-ingest' worker
// secret or an owner user token), then reads the two invoice inboxes:
//   * Gmail hoadon@bmq.vn through an OAuth read-only refresh token;
//   * supplier_order_uploads (link NCC) from the last 30 days.
//
// Every write is idempotent on incoming_invoices.source_ref and goes through
// public.ingest_incoming_invoice, which never approves, pays, edits or deletes a
// payment request. New payment requests are always pending.
//
// Pure handler: no Deno / Supabase / Gmail imports. The runtime wiring lives in
// index.ts; tests inject fake Gmail, storage, RPC and Jev deps.

import { getCorsHeaders } from "../_shared/cors.ts";
import { parseVietnamEInvoiceXml } from "../_shared/einvoice-xml.ts";
import type { InvoiceJevEvaluation, InvoiceJevEvaluator } from "./jev.ts";

export const INVOICE_INGEST_BODY_LIMIT = 32_768;
export const INVOICE_INGEST_REQUEST_BUDGET_MS = 110_000;
export const INVOICE_INGEST_DEFAULT_MAX = 20;
export const INVOICE_INGEST_MAX_LIMIT = 40;
export const INVOICE_INGEST_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const INVOICE_MIN_IMAGE_BYTES = 20 * 1024;
export const INVOICE_INBOX_BUCKET = "invoices";
export const SUPPLIER_DOCS_BUCKET = "supplier-delivery-docs";
export const INVOICE_GMAIL_QUERY = "(has:attachment OR meinvoice) newer_than:21d";
export const PDF_UNREAD_NOTE = "PDF chưa đọc được tự động";

export class InvoiceInboxError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "InvoiceInboxError";
    this.code = code;
    this.status = status;
  }
}

export interface GmailPart {
  filename?: string | null;
  mimeType?: string | null;
  body?: {
    attachmentId?: string | null;
    size?: number | null;
    data?: string | null;
  } | null;
  parts?: GmailPart[] | null;
}

export interface GmailMessage {
  id: string;
  payload?: GmailPart | null;
}

export interface GmailAttachment {
  name: string;
  mime: string;
  size: number;
  attachmentId: string | null;
  data: string | null;
}

export interface SupplierUploadRow {
  id: string;
  storage_path: string;
  file_name: string | null;
  mime_type: string;
  size_bytes: number | null;
  supplier_id: string | null;
  purchase_order_id: string | null;
}

export interface IngestPayload {
  source: "email" | "supplier_link";
  source_ref: string;
  file_path?: string;
  file_mime?: string;
  file_name?: string;
  seller_name?: string | null;
  seller_tax_code?: string | null;
  invoice_number?: string | null;
  invoice_series?: string | null;
  invoice_date?: string | null;
  subtotal?: number | null;
  vat_amount?: number | null;
  total_amount?: number | null;
  raw?: unknown;
  supplier_id?: string | null;
  purchase_order_id?: string | null;
  note?: string | null;
}

export interface IngestResult {
  id: string;
  status: string;
  match_source: string | null;
  payment_request_id: string | null;
  linked_payment_request_id: string | null;
  needs_jev: boolean;
  duplicate?: boolean;
}

export interface JevCandidates {
  invoice: {
    id: string;
    seller_name: string | null;
    invoice_number: string | null;
    invoice_date: string | null;
    total_amount: number | null;
    lines: unknown[];
  };
  templates: {
    id: string;
    label: string;
    cadence?: string | null;
    amount_median?: number | null;
    amount_min?: number | null;
    amount_max?: number | null;
    last_period?: string | null;
    title_pattern?: string | null;
  }[];
}

export interface InvoiceInboxIngestDeps {
  getWorkerSecret: () => Promise<string | null>;
  authenticate: (
    request: Request,
    signal: AbortSignal,
  ) => Promise<{ userId: string; owner: boolean }>;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
  /** Returns a Gmail access token, or null when invoice Gmail is not connected. */
  getInvoiceGmailAccessToken: () => Promise<string | null>;
  gmail: {
    listMessages: (
      accessToken: string,
      query: string,
      max: number,
    ) => Promise<{ id: string }[]>;
    getMessage: (accessToken: string, messageId: string) => Promise<GmailMessage>;
    getAttachment: (
      accessToken: string,
      messageId: string,
      attachmentId: string,
    ) => Promise<Uint8Array>;
  };
  listSupplierUploads: (max: number) => Promise<SupplierUploadRow[]>;
  downloadStorage: (bucket: string, path: string) => Promise<Uint8Array>;
  /** Upload with upsert=false. A pre-existing object is reported as reused. */
  uploadStorage: (
    bucket: string,
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ) => Promise<{ reused: boolean }>;
  sourceRefExists: (value: string, exact: boolean) => Promise<boolean>;
  /** Fetches the signed XML behind a MISA meInvoice lookup code, or null. */
  fetchMeinvoiceXml: (code: string) => Promise<string | null>;
  ingest: (payload: IngestPayload) => Promise<IngestResult>;
  getJevCandidates: (invoiceId: string) => Promise<JevCandidates>;
  applyJevTemplate: (
    invoiceId: string,
    templateId: string,
    confidence: number,
    reason: string,
  ) => Promise<IngestResult>;
  extractInvoicePage: (input: {
    imageBase64: string;
    mimeType: string;
    fileName: string;
  }) => Promise<Record<string, unknown>>;
  evaluator: () => InvoiceJevEvaluator | null;
  now?: () => Date;
  audit?: (event: Record<string, unknown>) => void;
}

interface ParsedInput {
  source: "all" | "email" | "supplier_link";
  max: number;
  dryRun: boolean;
}

interface SectionSummary {
  scanned: number;
  ingested: number;
  skipped: number;
  reason?: string;
}

interface RunSummary {
  email: SectionSummary;
  supplier_link: SectionSummary;
  created_prs: number;
  linked: number;
  needs_review: number;
  jev: { asked: number; applied: number };
  errors: string[];
}

const MESSAGES: Record<string, string> = {
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Chức năng nạp hóa đơn chỉ dành cho chủ.",
  invalid_content_type: "Yêu cầu nạp hóa đơn phải là JSON.",
  invalid_json: "Nội dung yêu cầu nạp hóa đơn không hợp lệ.",
  invalid_request: "Yêu cầu nạp hóa đơn không hợp lệ.",
  body_limit: "Yêu cầu nạp hóa đơn quá lớn.",
  scan_failed: "Chưa thể nạp hóa đơn. Không có thay đổi nào được ghi.",
};

function jsonBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    throw new InvoiceInboxError("invalid_content_type", 415);
  }
  const text = await req.text();
  if (text.length > INVOICE_INGEST_BODY_LIMIT) {
    throw new InvoiceInboxError("body_limit", 413);
  }
  try {
    const parsed = JSON.parse(text);
    if (!jsonBody(parsed)) throw new Error("not object");
    return parsed;
  } catch {
    throw new InvoiceInboxError("invalid_json", 400);
  }
}

function parseInput(raw: Record<string, unknown>): ParsedInput {
  for (const field of Object.keys(raw)) {
    if (field !== "source" && field !== "max" && field !== "dry_run") {
      throw new InvoiceInboxError("invalid_request", 400);
    }
  }
  const source = raw.source === undefined || raw.source === null ? "all" : raw.source;
  if (source !== "all" && source !== "email" && source !== "supplier_link") {
    throw new InvoiceInboxError("invalid_request", 400);
  }
  let max = INVOICE_INGEST_DEFAULT_MAX;
  if (raw.max !== undefined && raw.max !== null) {
    if (typeof raw.max !== "number" || !Number.isInteger(raw.max) || raw.max < 1) {
      throw new InvoiceInboxError("invalid_request", 400);
    }
    max = Math.min(raw.max, INVOICE_INGEST_MAX_LIMIT);
  }
  if (raw.dry_run !== undefined && typeof raw.dry_run !== "boolean") {
    throw new InvoiceInboxError("invalid_request", 400);
  }
  return { source, max, dryRun: raw.dry_run === true };
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/\s/g, "").replace(/,/g, "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function textOrNull(value: unknown): string | null {
  return hasText(value) ? value.trim() : null;
}

function errorCode(error: unknown): string {
  if (error instanceof InvoiceInboxError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  return "scan_failed";
}

function errorMessage(error: unknown): string {
  if (error instanceof InvoiceInboxError) return error.code;
  if (error instanceof Error) return error.message.slice(0, 200);
  return "unknown_error";
}

// ---------------------------------------------------------------------------
// Gmail payload helpers (pure, exported for the tests)
// ---------------------------------------------------------------------------

function isSignatureAttachment(name: string, mime: string): boolean {
  const lower = name.toLowerCase();
  const lowerMime = mime.toLowerCase();
  return lower.endsWith(".p7s")
    || lower.endsWith(".sig")
    || lowerMime.includes("pkcs7-signature")
    || lowerMime.includes("x-pkcs7-signature");
}

function isXmlAttachment(name: string, mime: string): boolean {
  const lower = name.toLowerCase();
  const lowerMime = mime.toLowerCase();
  return lower.endsWith(".xml") || lowerMime.includes("xml");
}

function isImageAttachment(name: string, mime: string): boolean {
  const lower = name.toLowerCase();
  const lowerMime = mime.toLowerCase();
  return lowerMime === "image/jpeg"
    || lowerMime === "image/png"
    || lowerMime === "image/webp"
    || lower.endsWith(".jpg")
    || lower.endsWith(".jpeg")
    || lower.endsWith(".png")
    || lower.endsWith(".webp");
}

function isPdfAttachment(name: string, mime: string): boolean {
  return name.toLowerCase().endsWith(".pdf") || mime.toLowerCase() === "application/pdf";
}

/** Flatten Gmail payload parts recursively into named attachments. */
export function collectGmailAttachments(
  payload: GmailPart | null | undefined,
  out: GmailAttachment[] = [],
): GmailAttachment[] {
  if (!payload) return out;
  const body = payload.body ?? null;
  const attachmentId = hasText(body?.attachmentId) ? body!.attachmentId! : null;
  const data = hasText(body?.data) ? body!.data! : null;
  const filename = hasText(payload.filename) ? payload.filename!.trim() : "";
  const mime = hasText(payload.mimeType) ? payload.mimeType!.trim() : "application/octet-stream";

  if (filename !== "" && (attachmentId !== null || data !== null)) {
    out.push({
      name: filename,
      mime,
      size: typeof body?.size === "number" && Number.isFinite(body.size) ? body.size : 0,
      attachmentId,
      data,
    });
  }
  for (const part of payload.parts ?? []) {
    collectGmailAttachments(part, out);
  }
  return out;
}

const MEINVOICE_CODE_PATTERN = "[A-Za-z0-9_\\-]{6,40}";
const MEINVOICE_NEAR_DISTANCE = 500;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

function collectGmailTextParts(payload: GmailPart, out: string[]): void {
  const mime = (payload.mimeType ?? "").toLowerCase();
  const filename = hasText(payload.filename) ? payload.filename!.trim() : "";
  const data = payload.body?.data;
  if (filename === "" && hasText(data)) {
    const decoded = new TextDecoder().decode(decodeBase64Url(data!));
    if (mime.startsWith("text/plain")) out.push(decoded);
    else if (mime.startsWith("text/html")) out.push(htmlToPlainText(decoded));
  }
  for (const part of payload.parts ?? []) {
    collectGmailTextParts(part, out);
  }
}

/** Plain text from the body parts of a Gmail message payload. */
export function extractGmailPlainText(payload: GmailPart | null | undefined): string {
  if (!payload) return "";
  const parts: string[] = [];
  collectGmailTextParts(payload, parts);
  return parts.join("\n").trim();
}

/**
 * MISA meInvoice lookup codes in an email body:
 *   * `mã số: <CODE>` / `ma so: <CODE>` near a meinvoice reference;
 *   * `Code=<CODE>` / `transactionID=<CODE>` inside a meinvoice.vn URL.
 */
export function extractMeinvoiceLookupCodes(text: string): string[] {
  if (typeof text !== "string" || text.trim() === "") return [];

  const lower = text.toLowerCase();
  const anchors: number[] = [];
  let anchor = lower.indexOf("meinvoice");
  while (anchor !== -1) {
    anchors.push(anchor);
    anchor = lower.indexOf("meinvoice", anchor + 1);
  }
  if (anchors.length === 0) return [];

  const nearMeinvoice = (position: number): boolean =>
    anchors.some((item) => Math.abs(item - position) <= MEINVOICE_NEAR_DISTANCE);

  const found: { index: number; code: string }[] = [];
  const label = new RegExp(
    `m[ãa]\\s*s[ốo]\\s*:\\s*(${MEINVOICE_CODE_PATTERN})`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = label.exec(text)) !== null) {
    if (nearMeinvoice(match.index)) found.push({ index: match.index, code: match[1] });
  }

  const url = /(?:https?:\/\/)?[^\s"'<>]*meinvoice\.vn[^\s"'<>]*/gi;
  while ((match = url.exec(text)) !== null) {
    const param = new RegExp(
      `(?:Code|transactionID)=(${MEINVOICE_CODE_PATTERN})`,
      "i",
    ).exec(match[0]);
    if (!param) continue;
    found.push({ index: match.index + param.index, code: param[1] });
  }

  found.sort((left, right) => left.index - right.index);
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const entry of found) {
    if (seen.has(entry.code)) continue;
    seen.add(entry.code);
    codes.push(entry.code);
  }
  return codes;
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function sha256Hex16(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const byte of view) hex += byte.toString(16).padStart(2, "0");
  return hex.slice(0, 16);
}

function extensionFor(name: string, mime: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(name);
  if (match) return match[1].toLowerCase();
  const lower = mime.toLowerCase();
  if (lower === "application/pdf") return "pdf";
  if (lower === "image/jpeg") return "jpg";
  if (lower === "image/png") return "png";
  if (lower === "image/webp") return "webp";
  if (lower.includes("xml")) return "xml";
  return "bin";
}

function monthOf(dateText: string | null | undefined, now: Date): string {
  const match = /^(\d{4})-(\d{2})/.exec(dateText ?? "");
  if (match) return `${match[1]}-${match[2]}`;
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function sameBasePdf(xmlName: string, pdfs: GmailAttachment[]): GmailAttachment | null {
  const base = xmlName.toLowerCase().replace(/\.xml$/, "");
  return pdfs.find((pdf) => pdf.name.toLowerCase().replace(/\.pdf$/, "") === base) ?? null;
}

function sumLines(items: unknown[]): number | null {
  let sum = 0;
  let seen = false;
  for (const item of items) {
    if (!jsonBody(item)) continue;
    const amount = numberOrNull(item.line_total)
      ?? numberOrNull(item.amount)
      ?? (
        (numberOrNull(item.quantity) ?? 0) * (numberOrNull(item.unit_price) ?? 0)
      );
    if (amount !== null) {
      sum += amount;
      seen = true;
    }
  }
  return seen ? Math.round(sum * 100) / 100 : null;
}

function extractionToPayload(
  data: Record<string, unknown>,
): {
  seller_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  subtotal: number | null;
  vat_amount: number | null;
  total_amount: number | null;
  raw: { lines: unknown[] };
} {
  const items = Array.isArray(data.items) ? data.items : [];
  const subtotal = sumLines(items);
  const vat = numberOrNull(data.vat_amount);
  return {
    seller_name: textOrNull(data.supplier_name) ?? textOrNull(data.seller_name),
    invoice_number: textOrNull(data.invoice_number),
    invoice_date: textOrNull(data.invoice_date),
    subtotal,
    vat_amount: vat,
    total_amount: subtotal === null && vat === null ? null : (subtotal ?? 0) + (vat ?? 0),
    raw: { lines: items },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createInvoiceInboxIngestHandler(deps: InvoiceInboxIngestDeps) {
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

    const signal = AbortSignal.any([
      req.signal,
      AbortSignal.timeout(INVOICE_INGEST_REQUEST_BUDGET_MS),
    ]);
    const deadlineAt = Date.now() + INVOICE_INGEST_REQUEST_BUDGET_MS;
    const summary: RunSummary = {
      email: { scanned: 0, ingested: 0, skipped: 0 },
      supplier_link: { scanned: 0, ingested: 0, skipped: 0 },
      created_prs: 0,
      linked: 0,
      needs_review: 0,
      jev: { asked: 0, applied: 0 },
      errors: [],
    };

    try {
      const workerHeader = req.headers.get("x-worker-secret");
      if (workerHeader !== null) {
        const storedSecret = await deps.getWorkerSecret();
        if (storedSecret === null || storedSecret === ""
          || !timingSafeEqual(workerHeader, storedSecret)) {
          throw new InvoiceInboxError("unauthorized", 401);
        }
      } else {
        let auth: { userId: string; owner: boolean };
        try {
          auth = await deps.authenticate(req, signal);
        } catch {
          throw new InvoiceInboxError("unauthorized", 401);
        }
        if (!auth.owner) throw new InvoiceInboxError("forbidden", 403);
      }
      signal.throwIfAborted();

      const input = parseInput(await readBody(req));
      signal.throwIfAborted();

      if (input.source === "all" || input.source === "email") {
        await ingestEmailInbox(deps, input, summary, signal, deadlineAt);
      }
      signal.throwIfAborted();
      if (input.source === "all" || input.source === "supplier_link") {
        await ingestSupplierLinkInbox(deps, input, summary, signal, deadlineAt);
      }

      if (!input.dryRun) {
        try {
          await deps.setSetting("invoice_ingest_last_run", JSON.stringify(summary));
        } catch {
          summary.errors.push("settings_write_failed");
        }
      }

      deps.audit?.({
        event: "invoice_inbox_ingest",
        source: input.source,
        dry_run: input.dryRun,
        email_scanned: summary.email.scanned,
        email_ingested: summary.email.ingested,
        supplier_scanned: summary.supplier_link.scanned,
        supplier_ingested: summary.supplier_link.ingested,
        created_prs: summary.created_prs,
        linked: summary.linked,
        needs_review: summary.needs_review,
        jev_asked: summary.jev.asked,
        jev_applied: summary.jev.applied,
        errors: summary.errors.length,
      });

      return json(summary);
    } catch (error) {
      const code = signal.aborted ? "timeout" : errorCode(error);
      const status = signal.aborted
        ? 504
        : error instanceof InvoiceInboxError
          ? error.status
          : 503;
      deps.audit?.({ event: "invoice_inbox_ingest_error", code, status });
      return json({ error: MESSAGES[code] ?? MESSAGES.scan_failed, code }, status);
    }
  };
}

async function ingestEmailInbox(
  deps: InvoiceInboxIngestDeps,
  input: ParsedInput,
  summary: RunSummary,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<void> {
  const section = summary.email;
  let accessToken: string | null = null;
  try {
    accessToken = await deps.getInvoiceGmailAccessToken();
  } catch {
    accessToken = null;
  }
  if (accessToken === null || accessToken === "") {
    section.reason = "not_connected";
    return;
  }

  let messages: { id: string }[] = [];
  try {
    // List past the per-run budget so already-ingested mail does not hide a backlog.
    messages = await deps.gmail.listMessages(
      accessToken,
      INVOICE_GMAIL_QUERY,
      Math.min(input.max * 3, 100),
    );
  } catch (error) {
    summary.errors.push(`email_list: ${errorMessage(error)}`);
    section.reason = "list_failed";
    return;
  }
  section.scanned = messages.length;

  let processed = 0;
  for (const ref of messages) {
    signal.throwIfAborted();
    const prefix = `gmail:${ref.id}`;
    if (await deps.sourceRefExists(prefix, false)) {
      section.skipped += 1;
      continue;
    }
    if (processed >= input.max) break;
    processed += 1;

    let message: GmailMessage;
    try {
      message = await deps.gmail.getMessage(accessToken, ref.id);
    } catch (error) {
      summary.errors.push(`gmail:${ref.id}: ${errorMessage(error)}`);
      section.skipped += 1;
      continue;
    }

    const attachments = collectGmailAttachments(message.payload)
      .filter((attachment) => {
        if (isSignatureAttachment(attachment.name, attachment.mime)) return false;
        if (attachment.size > INVOICE_INGEST_MAX_FILE_BYTES) return false;
        return true;
      });

    if (attachments.length === 0) {
      const codes = extractMeinvoiceLookupCodes(extractGmailPlainText(message.payload));
      if (codes.length === 0) {
        section.skipped += 1;
        continue;
      }
      for (const code of codes) {
        signal.throwIfAborted();
        const sourceRef = `${prefix}:meinvoice:${code}`;
        if (await deps.sourceRefExists(sourceRef, true)) {
          section.skipped += 1;
          continue;
        }
        try {
          const xml = await deps.fetchMeinvoiceXml(code);
          if (xml === null) {
            summary.errors.push(`gmail:${ref.id}:meinvoice:${code}: not_found`);
            section.skipped += 1;
            continue;
          }
          const invoice = parseVietnamEInvoiceXml(xml);
          if (!invoice) {
            summary.errors.push(`gmail:${ref.id}:meinvoice:${code}: parse_failed`);
            section.skipped += 1;
            continue;
          }
          const bytes = new TextEncoder().encode(xml);
          const fileName = `${invoice.invoice_series ?? "invoice"}_${
            invoice.invoice_number ?? code
          }.xml`;
          const persisted = await persistFile(
            deps,
            bytes,
            fileName,
            "application/xml",
            invoice.invoice_date,
            input.dryRun,
          );
          const result = await ingestOne(deps, {
            source: "email",
            source_ref: sourceRef,
            file_path: persisted.path,
            file_mime: persisted.file_mime,
            file_name: persisted.file_name,
            seller_name: invoice.seller.name,
            seller_tax_code: invoice.seller.tax_code,
            invoice_number: invoice.invoice_number,
            invoice_series: invoice.invoice_series,
            invoice_date: invoice.invoice_date,
            subtotal: invoice.subtotal,
            vat_amount: invoice.vat_amount,
            total_amount: invoice.total_amount,
            raw: { lines: invoice.lines },
          }, summary, section, input.dryRun);
          await maybeAskJev(deps, result, summary, signal, deadlineAt, input.dryRun);
        } catch (error) {
          summary.errors.push(`gmail:${ref.id}:meinvoice:${code}: ${errorMessage(error)}`);
          section.skipped += 1;
        }
      }
      continue;
    }

    const xmls = attachments.filter((attachment) =>
      isXmlAttachment(attachment.name, attachment.mime)
    );
    const pdfs = attachments.filter((attachment) =>
      isPdfAttachment(attachment.name, attachment.mime)
    );
    // Signature logos and inline icons are small; an invoice photo is not.
    const images = attachments.filter((attachment) =>
      isImageAttachment(attachment.name, attachment.mime)
      && attachment.size >= INVOICE_MIN_IMAGE_BYTES
    );

    if (xmls.length > 0) {
      for (const xml of xmls) {
        signal.throwIfAborted();
        try {
          const xmlBytes = await readAttachment(deps, accessToken, ref.id, xml);
          if (xmlBytes.length > INVOICE_INGEST_MAX_FILE_BYTES) {
            section.skipped += 1;
            continue;
          }
          const invoice = parseVietnamEInvoiceXml(new TextDecoder().decode(xmlBytes));
          if (!invoice) {
            section.skipped += 1;
            continue;
          }
          const pdf = sameBasePdf(xml.name, pdfs) ?? (pdfs.length === 1 ? pdfs[0] : null);
          const chosen = pdf ?? xml;
          const chosenBytes = pdf
            ? await readAttachment(deps, accessToken, ref.id, pdf)
            : xmlBytes;
          const persisted = await persistFile(
            deps,
            chosenBytes,
            chosen.name,
            chosen.mime,
            invoice.invoice_date,
            input.dryRun,
          );
          const result = await ingestOne(deps, {
            source: "email",
            source_ref: `${prefix}:${xml.name}`,
            file_path: persisted.path,
            file_mime: persisted.file_mime,
            file_name: persisted.file_name,
            seller_name: invoice.seller.name,
            seller_tax_code: invoice.seller.tax_code,
            invoice_number: invoice.invoice_number,
            invoice_series: invoice.invoice_series,
            invoice_date: invoice.invoice_date,
            subtotal: invoice.subtotal,
            vat_amount: invoice.vat_amount,
            total_amount: invoice.total_amount,
            raw: { lines: invoice.lines },
          }, summary, section, input.dryRun);
          await maybeAskJev(deps, result, summary, signal, deadlineAt, input.dryRun);
        } catch (error) {
          summary.errors.push(`gmail:${ref.id}:${xml.name}: ${errorMessage(error)}`);
          section.skipped += 1;
        }
      }
      continue;
    }

    for (const image of images) {
      signal.throwIfAborted();
      try {
        const bytes = await readAttachment(deps, accessToken, ref.id, image);
        if (bytes.length > INVOICE_INGEST_MAX_FILE_BYTES) {
          section.skipped += 1;
          continue;
        }
        const extracted = extractionToPayload(await deps.extractInvoicePage({
          imageBase64: bytesToBase64(bytes),
          mimeType: image.mime,
          fileName: image.name,
        }));
        const persisted = await persistFile(
          deps,
          bytes,
          image.name,
          image.mime,
          extracted.invoice_date,
          input.dryRun,
        );
        const result = await ingestOne(deps, {
          source: "email",
          source_ref: `${prefix}:${image.name}`,
          file_path: persisted.path,
          file_mime: persisted.file_mime,
          file_name: persisted.file_name,
          ...extracted,
        }, summary, section, input.dryRun);
        await maybeAskJev(deps, result, summary, signal, deadlineAt, input.dryRun);
      } catch (error) {
        summary.errors.push(`gmail:${ref.id}:${image.name}: ${errorMessage(error)}`);
        section.skipped += 1;
      }
    }

    for (const pdf of pdfs) {
      signal.throwIfAborted();
      try {
        const bytes = await readAttachment(deps, accessToken, ref.id, pdf);
        if (bytes.length > INVOICE_INGEST_MAX_FILE_BYTES) {
          section.skipped += 1;
          continue;
        }
        const persisted = await persistFile(
          deps,
          bytes,
          pdf.name,
          pdf.mime,
          null,
          input.dryRun,
        );
        const result = await ingestOne(deps, {
          source: "email",
          source_ref: `${prefix}:${pdf.name}`,
          file_path: persisted.path,
          file_mime: persisted.file_mime,
          file_name: persisted.file_name,
          note: PDF_UNREAD_NOTE,
          raw: { lines: [] },
        }, summary, section, input.dryRun);
        await maybeAskJev(deps, result, summary, signal, deadlineAt, input.dryRun);
      } catch (error) {
        summary.errors.push(`gmail:${ref.id}:${pdf.name}: ${errorMessage(error)}`);
        section.skipped += 1;
      }
    }

    if (images.length === 0 && pdfs.length === 0) section.skipped += 1;
  }
}

async function ingestSupplierLinkInbox(
  deps: InvoiceInboxIngestDeps,
  input: ParsedInput,
  summary: RunSummary,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<void> {
  const section = summary.supplier_link;
  let uploads: SupplierUploadRow[] = [];
  try {
    uploads = await deps.listSupplierUploads(input.max);
  } catch (error) {
    summary.errors.push(`supplier_list: ${errorMessage(error)}`);
    section.reason = "list_failed";
    return;
  }
  section.scanned = uploads.length;

  let processed = 0;
  for (const upload of uploads) {
    signal.throwIfAborted();
    const sourceRef = `supplier_upload:${upload.id}`;
    if (await deps.sourceRefExists(sourceRef, true)) {
      section.skipped += 1;
      continue;
    }
    if (processed >= input.max) break;
    processed += 1;

    try {
      if (upload.size_bytes !== null && upload.size_bytes > INVOICE_INGEST_MAX_FILE_BYTES) {
        section.skipped += 1;
        continue;
      }
      const bytes = await deps.downloadStorage(SUPPLIER_DOCS_BUCKET, upload.storage_path);
      if (bytes.length > INVOICE_INGEST_MAX_FILE_BYTES) {
        section.skipped += 1;
        continue;
      }
      const fileName = upload.file_name ?? upload.storage_path.split("/").pop() ?? `${upload.id}`;
      const mime = upload.mime_type || "application/octet-stream";

      if (isSignatureAttachment(fileName, mime)) {
        section.skipped += 1;
        continue;
      }

      if (isXmlAttachment(fileName, mime)) {
        const invoice = parseVietnamEInvoiceXml(new TextDecoder().decode(bytes));
        if (!invoice) {
          section.skipped += 1;
          continue;
        }
        const persisted = await persistFile(
          deps,
          bytes,
          fileName,
          mime,
          invoice.invoice_date,
          input.dryRun,
        );
        const result = await ingestOne(deps, {
          source: "supplier_link",
          source_ref: sourceRef,
          file_path: persisted.path,
          file_mime: persisted.file_mime,
          file_name: persisted.file_name,
          seller_name: invoice.seller.name,
          seller_tax_code: invoice.seller.tax_code,
          invoice_number: invoice.invoice_number,
          invoice_series: invoice.invoice_series,
          invoice_date: invoice.invoice_date,
          subtotal: invoice.subtotal,
          vat_amount: invoice.vat_amount,
          total_amount: invoice.total_amount,
          raw: { lines: invoice.lines },
          supplier_id: upload.supplier_id,
          purchase_order_id: upload.purchase_order_id,
        }, summary, section, input.dryRun);
        await maybeAskJev(deps, result, summary, signal, deadlineAt, input.dryRun);
      } else if (isImageAttachment(fileName, mime)) {
        const extracted = extractionToPayload(await deps.extractInvoicePage({
          imageBase64: bytesToBase64(bytes),
          mimeType: mime,
          fileName,
        }));
        const persisted = await persistFile(
          deps,
          bytes,
          fileName,
          mime,
          extracted.invoice_date,
          input.dryRun,
        );
        const result = await ingestOne(deps, {
          source: "supplier_link",
          source_ref: sourceRef,
          file_path: persisted.path,
          file_mime: persisted.file_mime,
          file_name: persisted.file_name,
          ...extracted,
          supplier_id: upload.supplier_id,
          purchase_order_id: upload.purchase_order_id,
        }, summary, section, input.dryRun);
        await maybeAskJev(deps, result, summary, signal, deadlineAt, input.dryRun);
      } else if (isPdfAttachment(fileName, mime)) {
        const persisted = await persistFile(
          deps,
          bytes,
          fileName,
          mime,
          null,
          input.dryRun,
        );
        const result = await ingestOne(deps, {
          source: "supplier_link",
          source_ref: sourceRef,
          file_path: persisted.path,
          file_mime: persisted.file_mime,
          file_name: persisted.file_name,
          note: PDF_UNREAD_NOTE,
          raw: { lines: [] },
          supplier_id: upload.supplier_id,
          purchase_order_id: upload.purchase_order_id,
        }, summary, section, input.dryRun);
        await maybeAskJev(deps, result, summary, signal, deadlineAt, input.dryRun);
      } else {
        section.skipped += 1;
      }
    } catch (error) {
      summary.errors.push(`supplier_upload:${upload.id}: ${errorMessage(error)}`);
      section.skipped += 1;
    }
  }
}

async function readAttachment(
  deps: InvoiceInboxIngestDeps,
  accessToken: string,
  messageId: string,
  attachment: GmailAttachment,
): Promise<Uint8Array> {
  if (attachment.attachmentId !== null) {
    return await deps.gmail.getAttachment(accessToken, messageId, attachment.attachmentId);
  }
  if (attachment.data !== null) return decodeBase64Url(attachment.data);
  throw new InvoiceInboxError("attachment_empty", 422);
}

async function persistFile(
  deps: InvoiceInboxIngestDeps,
  bytes: Uint8Array,
  fileName: string,
  mime: string,
  invoiceDate: string | null,
  dryRun: boolean,
): Promise<{ path?: string; file_mime: string; file_name: string }> {
  const now = deps.now?.() ?? new Date();
  const ext = extensionFor(fileName, mime);
  const hash = await sha256Hex16(bytes);
  const path = `incoming/${monthOf(invoiceDate, now)}/${hash}.${ext}`;
  if (dryRun) return { file_mime: mime, file_name: fileName };
  await deps.uploadStorage(INVOICE_INBOX_BUCKET, path, bytes, mime);
  return { path, file_mime: mime, file_name: fileName };
}

async function ingestOne(
  deps: InvoiceInboxIngestDeps,
  payload: IngestPayload,
  summary: RunSummary,
  section: SectionSummary,
  dryRun: boolean,
): Promise<IngestResult | null> {
  if (dryRun) {
    section.ingested += 1;
    return null;
  }
  const result = await deps.ingest(payload);
  if (result.duplicate === true) {
    section.skipped += 1;
    return result;
  }
  section.ingested += 1;
  if (result.payment_request_id !== null) summary.created_prs += 1;
  if (result.linked_payment_request_id !== null) summary.linked += 1;
  if (result.status === "needs_review") summary.needs_review += 1;
  return result;
}

async function maybeAskJev(
  deps: InvoiceInboxIngestDeps,
  result: IngestResult | null,
  summary: RunSummary,
  signal: AbortSignal,
  deadlineAt: number,
  dryRun: boolean,
): Promise<void> {
  if (result === null || result.needs_jev !== true) return;

  let candidates: JevCandidates;
  try {
    candidates = await deps.getJevCandidates(result.id);
  } catch (error) {
    summary.errors.push(`jev_candidates:${result.id}: ${errorMessage(error)}`);
    return;
  }
  const templateIds = (candidates.templates ?? [])
    .map((template) => template.id)
    .filter((id): id is string => hasText(id));
  if (templateIds.length === 0) return;

  const evaluator = deps.evaluator();
  if (!evaluator) {
    summary.errors.push(`jev_unconfigured:${result.id}`);
    return;
  }

  summary.jev.asked += 1;
  let evaluation: InvoiceJevEvaluation | null;
  try {
    evaluation = await evaluator({
      state: candidates,
      allowedTemplateIds: templateIds,
      signal,
      deadlineAt,
    });
  } catch (error) {
    summary.errors.push(`jev:${result.id}: ${errorMessage(error)}`);
    return;
  }

  if (evaluation === null
    || evaluation.template_id === null
    || !templateIds.includes(evaluation.template_id)
    || !(evaluation.confidence >= 0.8)) {
    return;
  }
  if (dryRun) return;

  try {
    const applied = await deps.applyJevTemplate(
      result.id,
      evaluation.template_id,
      evaluation.confidence,
      evaluation.reason,
    );
    summary.jev.applied += 1;
    if (applied.status !== "needs_review") {
      summary.needs_review = Math.max(0, summary.needs_review - 1);
    }
    if (applied.payment_request_id !== null) summary.created_prs += 1;
    if (applied.linked_payment_request_id !== null) summary.linked += 1;
    if (applied.status === "needs_review") summary.needs_review += 1;
  } catch (error) {
    summary.errors.push(`jev_apply:${result.id}: ${errorMessage(error)}`);
  }
}
