// Invoice inbox ingest endpoint (owner user or the 'invoice-ingest' worker).
//
// The handler authenticates the caller itself. A valid x-worker-secret is
// matched against public.robot_worker_config; otherwise the Bearer token is
// validated with auth.getUser and the caller must be an owner. Reads use a
// service-role client with fixed SELECTs/RPCs; the only writes are
// public.ingest_incoming_invoice, public.apply_incoming_invoice_template, the
// private invoices bucket and app_settings.invoice_ingest_last_run.
//
// The Gmail refresh token, access token, Google client secret and AI Gateway key
// stay in the server environment / app_settings and are never returned.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { extractText, getDocumentProxy } from "npm:unpdf@1.9.1";
import {
  createInvoiceInboxIngestHandler,
  InvoiceInboxError,
  PDF_UNREAD_NOTE,
  type GmailMessage,
  type IngestPayload,
  type IngestResult,
  type InvoiceInboxIngestDeps,
  type JevCandidates,
  type PdfReextractPayload,
  type SupplierUploadRow,
  type UnreadPdfInvoice,
} from "./handler.ts";
import {
  createInvoiceJevEvaluator,
  JEV_TIMEOUT_MS,
  type InvoiceJevEvaluator,
} from "./jev.ts";
import { extractInvoiceFromText, extractInvoicePage } from "../scan-invoice/extract.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MEINVOICE_LOOKUP_URL =
  "https://www.meinvoice.vn/tra-cuu/GetInvoiceDataByTransactionID";
const MEINVOICE_TIMEOUT_MS = 15_000;
const MEINVOICE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let evaluatorCache: InvoiceJevEvaluator | null | undefined;
function invoiceEvaluator(): InvoiceJevEvaluator | null {
  if (evaluatorCache !== undefined) return evaluatorCache;
  const key = Deno.env.get("AI_GATEWAY_API_KEY") ?? "";
  try {
    evaluatorCache = key
      ? createInvoiceJevEvaluator({ apiKey: key, timeoutMs: JEV_TIMEOUT_MS })
      : null;
  } catch {
    evaluatorCache = null;
  }
  return evaluatorCache;
}

function adminClient() {
  if (!serviceRole) throw new InvoiceInboxError("unconfigured", 503);
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function isOwner(
  admin: ReturnType<typeof adminClient>,
  userId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) return false;
  return ((data ?? []) as { role: string }[]).some((row) => row.role === "owner");
}

async function getSetting(key: string): Promise<string | null> {
  const { data, error } = await adminClient()
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) return null;
  return typeof data?.value === "string" ? data.value : null;
}

async function setSetting(key: string, value: string): Promise<void> {
  const { error } = await adminClient()
    .from("app_settings")
    .upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) throw new Error(error.message);
}

async function getInvoiceGmailAccessToken(): Promise<string | null> {
  const refreshToken = await getSetting("invoice_gmail_refresh_token");
  if (!refreshToken) return null;
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) return null;
  const body = await response.json() as { access_token?: unknown };
  return typeof body.access_token === "string" && body.access_token !== ""
    ? body.access_token
    : null;
}

async function gmailJson(
  accessToken: string,
  path: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${GMAIL_API}/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`gmail_http_${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function listMessages(
  accessToken: string,
  query: string,
  max: number,
): Promise<{ id: string }[]> {
  const body = await gmailJson(
    accessToken,
    `messages?q=${encodeURIComponent(query)}&maxResults=${max}`,
  );
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages
    .filter((row): row is { id: string } =>
      typeof row === "object" && row !== null
      && typeof (row as { id?: unknown }).id === "string"
    )
    .map((row) => ({ id: row.id }));
}

async function getMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  return await gmailJson(
    accessToken,
    `messages/${encodeURIComponent(messageId)}?format=full`,
  ) as unknown as GmailMessage;
}

async function getAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const body = await gmailJson(
    accessToken,
    `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  if (typeof body.data !== "string") throw new Error("gmail_attachment_empty");
  return decodeBase64Url(body.data);
}

async function fetchMeinvoiceXml(code: string): Promise<string | null> {
  try {
    const response = await fetch(MEINVOICE_LOOKUP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": MEINVOICE_USER_AGENT,
      },
      body: `transactionID=${encodeURIComponent(code)}`,
      signal: AbortSignal.timeout(MEINVOICE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json() as { success?: unknown; data?: unknown };
    if (body.success !== true) return null;
    return typeof body.data === "string" && body.data.startsWith("<") ? body.data : null;
  } catch {
    return null;
  }
}

async function listSupplierUploads(max: number): Promise<SupplierUploadRow[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await adminClient()
    .from("supplier_order_uploads")
    .select(
      "id, storage_path, file_name, mime_type, size_bytes, created_at, supplier_order_requests!inner(supplier_id, purchase_order_id)",
    )
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(max * 3, max), 120));
  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown[]).map((raw) => {
    const row = raw as Record<string, unknown>;
    const joined = row.supplier_order_requests;
    const request = (Array.isArray(joined) ? joined[0] : joined) as
      | Record<string, unknown>
      | null
      | undefined;
    return {
      id: String(row.id ?? ""),
      storage_path: String(row.storage_path ?? ""),
      file_name: typeof row.file_name === "string" ? row.file_name : null,
      mime_type: typeof row.mime_type === "string" ? row.mime_type : "application/octet-stream",
      size_bytes: typeof row.size_bytes === "number" ? row.size_bytes : null,
      supplier_id: typeof request?.supplier_id === "string" ? request.supplier_id : null,
      purchase_order_id: typeof request?.purchase_order_id === "string"
        ? request.purchase_order_id
        : null,
    };
  });
}

async function sourceRefExists(value: string, exact: boolean): Promise<boolean> {
  let query = adminClient()
    .from("incoming_invoices")
    .select("id")
    .limit(1);
  query = exact ? query.eq("source_ref", value) : query.like("source_ref", `${value}%`);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

async function ingest(payload: IngestPayload): Promise<IngestResult> {
  const { data, error } = await adminClient()
    .rpc("ingest_incoming_invoice", { p: payload });
  if (error) throw new Error(error.message);
  return data as IngestResult;
}

async function getJevCandidates(invoiceId: string): Promise<JevCandidates> {
  const { data, error } = await adminClient()
    .rpc("get_incoming_invoice_jev_candidates", { p_invoice_id: invoiceId });
  if (error) throw new Error(error.message);
  return data as JevCandidates;
}

async function applyJevTemplate(
  invoiceId: string,
  templateId: string,
  confidence: number,
  reason: string,
): Promise<IngestResult> {
  const { data, error } = await adminClient()
    .rpc("apply_incoming_invoice_template", {
      p_invoice_id: invoiceId,
      p_template_id: templateId,
      p_confidence: confidence,
      p_reason: reason,
    });
  if (error) throw new Error(error.message);
  return data as IngestResult;
}

/** Text layer of a PDF. A scanned/image-only PDF simply returns "". */
async function extractPdfText(bytes: Uint8Array): Promise<string> {
  try {
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return typeof text === "string" ? text : (text as string[]).join("\n");
  } catch {
    return "";
  }
}

async function listUnreadPdfInvoices(max: number): Promise<UnreadPdfInvoice[]> {
  const { data, error } = await adminClient()
    .from("incoming_invoices")
    .select("id, file_path, file_name, file_mime")
    .eq("note", PDF_UNREAD_NOTE)
    .is("total_amount", null)
    .or("file_mime.eq.application/pdf,file_name.ilike.%.pdf")
    .order("created_at", { ascending: true })
    .limit(max);
  if (error) throw new Error(error.message);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id ?? ""),
    file_path: typeof row.file_path === "string" ? row.file_path : null,
    file_name: typeof row.file_name === "string" ? row.file_name : null,
    file_mime: typeof row.file_mime === "string" ? row.file_mime : null,
  }));
}

async function reextractInvoice(
  id: string,
  payload: PdfReextractPayload,
): Promise<unknown> {
  const { data, error } = await adminClient()
    .rpc("reextract_incoming_invoice", { p_id: id, p: payload });
  if (error) throw new Error(error.message);
  return data;
}

async function setInvoiceNote(id: string, note: string): Promise<void> {
  const { error } = await adminClient()
    .rpc("set_incoming_invoice_note", { p_id: id, p_note: note });
  if (error) throw new Error(error.message);
}

async function downloadStorage(bucket: string, path: string): Promise<Uint8Array> {
  const { data, error } = await adminClient().storage.from(bucket).download(path);
  if (error || !data) throw new Error(error?.message ?? "storage_download_failed");
  return new Uint8Array(await data.arrayBuffer());
}

async function uploadStorage(
  bucket: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ reused: boolean }> {
  const { error } = await adminClient().storage
    .from(bucket)
    .upload(path, new Blob([bytes as unknown as BlobPart], { type: contentType }), {
      contentType,
      upsert: false,
      cacheControl: "3600",
    });
  if (!error) return { reused: false };
  const message = String(error.message ?? "").toLowerCase();
  const status = Number((error as { statusCode?: unknown }).statusCode);
  if (status === 409 || message.includes("already exists") || message.includes("duplicate")) {
    return { reused: true };
  }
  throw new Error(error.message);
}

Deno.serve(createInvoiceInboxIngestHandler({
  getWorkerSecret: async () => {
    const { data, error } = await adminClient()
      .from("robot_worker_config")
      .select("worker_secret")
      .eq("id", "invoice-ingest")
      .maybeSingle();
    if (error) return null;
    return typeof data?.worker_secret === "string" ? data.worker_secret : null;
  },
  authenticate: async (request, signal) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      throw new InvoiceInboxError("unauthorized", 401);
    }
    const db = createClient(url, anon, {
      global: {
        headers: { Authorization: authorization },
        fetch: (input, init) => fetch(input, { ...init, signal }),
      },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new InvoiceInboxError("unauthorized", 401);
    const owner = await isOwner(adminClient(), user.id);
    if (!owner) throw new InvoiceInboxError("forbidden", 403);
    return { userId: user.id, owner: true };
  },
  getSetting,
  setSetting,
  getInvoiceGmailAccessToken,
  gmail: { listMessages, getMessage, getAttachment },
  listSupplierUploads,
  downloadStorage,
  uploadStorage,
  sourceRefExists,
  fetchMeinvoiceXml,
  ingest,
  getJevCandidates,
  applyJevTemplate,
  extractInvoicePage: async (input) => {
    const result = await extractInvoicePage({
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
      supplierList: [],
      templates: [],
      aliases: [],
    });
    return result.data;
  },
  extractPdfText,
  extractInvoiceFromText: async (text) => await extractInvoiceFromText({ text }),
  listUnreadPdfInvoices,
  reextractInvoice,
  setInvoiceNote,
  evaluator: invoiceEvaluator,
  audit: (event) => console.info(JSON.stringify(event)),
} satisfies InvoiceInboxIngestDeps));
