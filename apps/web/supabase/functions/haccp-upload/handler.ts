// HTTP shell for the public HACCP staff link.
//
// The link token is a 32-byte value kept by the manager; the database stores
// only its SHA-256. Every request re-resolves the hash, so a wrong, expired or
// revoked link cannot read or write anything. Responses never contain a
// storage path or the token: file entries carry a short-lived signed URL.
//
// The handler is dependency-injected so offline tests can use fake storage and
// database adapters. index.ts wires the Supabase service client.

import { getCorsHeaders } from "../_shared/cors.ts";

export const HACCP_MAX_BYTES = 10 * 1024 * 1024;
export const HACCP_MAX_JSON_BYTES = 256 * 1024;
export const HACCP_SIGNED_URL_SECONDS = 600;
export const HACCP_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export type HaccpErrorCode =
  | "link_invalid"
  | "link_expired"
  | "link_revoked"
  | "rate_limited"
  | "method_not_allowed"
  | "invalid_content_type"
  | "invalid_json"
  | "invalid_request"
  | "unsupported_type"
  | "file_too_large"
  | "empty_file"
  | "invalid_content"
  | "invalid_values"
  | "supplier_read_only"
  | "supplier_papers_in_attp"
  | "body_limit"
  | "not_found"
  | "stale_version"
  | "request_failed";

export class HaccpUploadError extends Error {
  readonly code: HaccpErrorCode;
  readonly status: number;

  constructor(code: HaccpErrorCode, status: number) {
    super(code);
    this.name = "HaccpUploadError";
    this.code = code;
    this.status = status;
  }
}

export const HACCP_MESSAGES: Record<HaccpErrorCode, string> = {
  link_invalid: "Link không hợp lệ.",
  link_expired: "Link đã hết hạn.",
  link_revoked: "Link đã bị thu hồi.",
  rate_limited: "Bạn thao tác quá nhanh. Vui lòng thử lại sau.",
  method_not_allowed: "Phương thức không được hỗ trợ.",
  invalid_content_type: "Nội dung gửi lên không hợp lệ.",
  invalid_json: "Dữ liệu gửi lên không hợp lệ.",
  invalid_request: "Yêu cầu không hợp lệ.",
  unsupported_type: "Chỉ nhận ảnh JPG/PNG/WEBP, PDF, Word hoặc Excel.",
  file_too_large: "File vượt quá 10 MB.",
  empty_file: "File rỗng.",
  invalid_content: "Nội dung file không khớp định dạng.",
  invalid_values: "Thông tin nhập vượt giới hạn cho phép (số điện thoại tối đa 40 ký tự).",
  supplier_read_only: "Link nhân viên không được sửa nhà cung cấp.",
  supplier_papers_in_attp: "Giấy tờ nhà cung cấp được quản lý trong mục ATTP, không thêm vào HACCP.",
  body_limit: "Dữ liệu gửi lên quá lớn.",
  not_found: "Không tìm thấy dữ liệu.",
  stale_version: "Dòng đã được người khác sửa. Vui lòng tải lại.",
  request_failed: "Chưa lưu được. Vui lòng thử lại.",
};

export interface HaccpFileRecord {
  id: string;
  entry_id?: string | null;
  layout?: boolean;
  name: string;
  size: number;
  type: string;
  path?: string;
}

export interface HaccpEntryRecord {
  id: string;
  table_id: string;
  values: Record<string, string>;
  position?: number;
  version: number;
  by?: string;
  files?: HaccpFileRecord[];
}

export interface HaccpSnapshot {
  entries: HaccpEntryRecord[];
  files: HaccpFileRecord[];
  link: { id: string; days: number; expires_at: string; revoked_at?: string | null; active: boolean };
  activity: { id: string; who: string; text: string; at: string }[];
}

export interface HaccpSaveInput {
  id: string | null;
  tableId: string;
  values: Record<string, string>;
  who: string;
  version: number | null;
  requestId: string;
  position?: number | null;
}

export interface HaccpAddFileInput {
  entryId: string | null;
  layout: boolean;
  path: string;
  name: string;
  mime: string;
  size: number;
  who: string;
  requestId: string;
}

export interface HaccpLinkState {
  state: "ok" | "missing" | "expired" | "revoked";
  link?: { id: string; days: number; expires_at: string; revoked_at?: string | null };
}

export interface HaccpUploadDeps {
  resolveLink: (tokenHash: string) => Promise<HaccpLinkState>;
  snapshot: (tokenHash: string) => Promise<HaccpSnapshot>;
  signUrl: (path: string) => Promise<string | null>;
  saveEntry: (tokenHash: string, input: HaccpSaveInput) => Promise<HaccpEntryRecord>;
  deleteEntry: (tokenHash: string, input: { id: string; version: number; requestId: string; who: string }) => Promise<void>;
  addFile: (tokenHash: string, input: HaccpAddFileInput) => Promise<HaccpFileRecord>;
  deleteFile: (tokenHash: string, input: { fileId: string; requestId: string; who: string }) => Promise<void>;
  uploadObject: (path: string, bytes: Uint8Array, mime: string) => Promise<void>;
  removeObject: (path: string) => Promise<void>;
  audit?: (event: Record<string, unknown>) => void;
}

export interface HaccpHandlerOptions {
  now?: () => number;
  writesPerHour?: number;
  readsPer15Minutes?: number;
  signedUrlSeconds?: number;
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

const MAX_ENTRIES_PER_TABLE = 2000;
const MAX_FILE_NAME = 200;

export function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hasPrefix(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((value, index) => bytes[offset + index] === value);
}

function bytesContain(bytes: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  for (let index = 0; index <= bytes.length - needle.length; index += 1) {
    let hit = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/** Detect allowed content from its leading bytes (and ZIP members for Office). */
export function detectFileKind(bytes: Uint8Array): "jpg" | "png" | "webp" | "pdf" | "docx" | "xlsx" | null {
  if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) || hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    if (bytesContain(bytes, "word/document.xml")) return "docx";
    if (bytesContain(bytes, "xl/workbook.xml")) return "xlsx";
    return null;
  }
  return null;
}

export function mimeMatchesKind(mime: string, kind: ReturnType<typeof detectFileKind>): boolean {
  if (!kind) return false;
  const expected = EXTENSIONS[mime];
  return Boolean(expected) && expected === kind;
}

export function safeUploadName(raw: string | null, mime: string): string {
  let decoded = "";
  try {
    decoded = decodeURIComponent(String(raw ?? ""));
  } catch {
    decoded = String(raw ?? "");
  }
  const base = decoded
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_FILE_NAME);
  const extension = EXTENSIONS[mime] ?? "bin";
  if (!base) return `haccp-file.${extension}`;
  return /\.[A-Za-z0-9]{1,8}$/.test(base) ? base : `${base}.${extension}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function asString(value: unknown, max = 1000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

const TABLE_KEYS: Record<string, Set<string>> = {
  suppliers: new Set(["name", "items", "phone", "address", "contact"]),
  team: new Set(["name", "job", "role"]),
  staff: new Set(["name", "position", "department"]),
  measure: new Set(["name", "code", "range", "origin", "qty", "place", "calibrated"]),
  machines: new Set(["name", "symbol", "qty", "origin", "spec", "year", "maintenance", "note"]),
  chemicals: new Set(["name", "place", "purpose", "guide"]),
  process: new Set(["step", "owner", "detail"]),
};

export function parseValues(tableId: string, raw: unknown): Record<string, string> {
  const keys = TABLE_KEYS[tableId];
  if (!keys || !isRecord(raw)) throw new HaccpUploadError("invalid_request", 400);
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const limit = key === "phone" ? 40 : 1000;
    if (!keys.has(key) || typeof value !== "string") {
      throw new HaccpUploadError("invalid_request", 400);
    }
    if (value.length > limit) throw new HaccpUploadError("invalid_values", 400);
    values[key] = value;
  }
  return values;
}

function parseToken(request: Request): string {
  const url = new URL(request.url);
  const raw = url.searchParams.get("t") ?? request.headers.get("x-haccp-token") ?? "";
  const token = raw.trim().toLowerCase();
  if (!HACCP_TOKEN_PATTERN.test(token)) throw new HaccpUploadError("link_invalid", 404);
  return token;
}

function linkError(state: HaccpLinkState["state"]): HaccpUploadError {
  if (state === "expired") return new HaccpUploadError("link_expired", 410);
  if (state === "revoked") return new HaccpUploadError("link_revoked", 410);
  return new HaccpUploadError("link_invalid", 404);
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
  } catch {
    return "";
  }
}

async function readBody(
  request: Request,
  limit: number,
  code: "file_too_large" | "body_limit" = "file_too_large",
): Promise<Uint8Array> {
  if (!request.body) throw new HaccpUploadError("empty_file", 413);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new HaccpUploadError(code, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function createHaccpUploadHandler(deps: HaccpUploadDeps, options: HaccpHandlerOptions = {}) {
  const now = options.now ?? Date.now;
  // One kitchen shares a single link; bulk entry (machines + one photo each)
  // must fit comfortably while still bounding abuse.
  const writesPerHour = options.writesPerHour ?? 600;
  const readsPer15Minutes = options.readsPer15Minutes ?? 240;
  const writes = new Map<string, number[]>();
  const reads = new Map<string, number[]>();

  const allow = (map: Map<string, number[]>, key: string, limit: number, windowMs: number): boolean => {
    const at = now();
    const start = at - windowMs;
    const previous = (map.get(key) ?? []).filter((timestamp) => timestamp > start);
    if (previous.length >= limit) {
      map.set(key, previous);
      return false;
    }
    previous.push(at);
    map.set(key, previous);
    if (map.size > 5000) {
      for (const [bucket, timestamps] of map) {
        if (!timestamps.some((timestamp) => timestamp > start)) map.delete(bucket);
      }
    }
    return true;
  };

  const fail = (error: unknown, headers: Record<string, string>): Response => {
    if (error instanceof HaccpUploadError) {
      return jsonResponse({ ok: false, code: error.code, error: HACCP_MESSAGES[error.code] }, error.status, headers);
    }
    const message = error instanceof Error ? error.message : "";
    if (message.includes("link_expired")) return jsonResponse({ ok: false, code: "link_expired", error: HACCP_MESSAGES.link_expired }, 410, headers);
    if (message.includes("link_revoked")) return jsonResponse({ ok: false, code: "link_revoked", error: HACCP_MESSAGES.link_revoked }, 410, headers);
    if (message.includes("link_invalid")) return jsonResponse({ ok: false, code: "link_invalid", error: HACCP_MESSAGES.link_invalid }, 404, headers);
    if (message.includes("stale_version")) return jsonResponse({ ok: false, code: "stale_version", error: HACCP_MESSAGES.stale_version }, 409, headers);
    if (message.includes("invalid_values")) {
      return jsonResponse({ ok: false, code: "invalid_values", error: HACCP_MESSAGES.invalid_values }, 400, headers);
    }
    if (message.includes("supplier_read_only")) {
      return jsonResponse({ ok: false, code: "supplier_read_only", error: HACCP_MESSAGES.supplier_read_only }, 403, headers);
    }
    if (message.includes("supplier_papers_in_attp")) {
      return jsonResponse({ ok: false, code: "supplier_papers_in_attp", error: HACCP_MESSAGES.supplier_papers_in_attp }, 403, headers);
    }
    if (message.includes("entry_not_found") || message.includes("file_not_found")) {
      return jsonResponse({ ok: false, code: "not_found", error: HACCP_MESSAGES.not_found }, 404, headers);
    }
    deps.audit?.({ fn: "haccp-upload", event: "request_failed", message: message.slice(0, 300) });
    return jsonResponse({ ok: false, code: "request_failed", error: HACCP_MESSAGES.request_failed }, 500, headers);
  };

  const withSignedFiles = async (
    entries: HaccpEntryRecord[],
    layoutFiles: HaccpFileRecord[],
  ): Promise<{ entries: HaccpEntryRecord[]; files: HaccpFileRecord[] }> => {
    const cache = new Map<string, string>();
    const sign = async (file: HaccpFileRecord): Promise<HaccpFileRecord> => {
      const path = file.path ?? "";
      let url = cache.get(path);
      if (url === undefined) {
        url = path ? (await deps.signUrl(path)) ?? "" : "";
        cache.set(path, url);
      }
      return {
        id: file.id,
        entry_id: file.entry_id ?? null,
        layout: Boolean(file.layout),
        name: file.name,
        size: Number(file.size ?? 0),
        type: file.type,
        url,
      } as HaccpFileRecord & { url: string };
    };
    return {
      entries: await Promise.all(entries.map(async (entry) => ({
        // source_key and supplier_id carry internal ids: never send them on the public link.
        ...Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "source_key" && key !== "supplier_id")) as HaccpEntryRecord,
        values: entry.values ?? {},
        files: await Promise.all((entry.files ?? []).map(sign)),
      }))),
      files: await Promise.all(layoutFiles.map(sign)),
    };
  };

  return async (request: Request): Promise<Response> => {
    const headers: Record<string, string> = {
      ...getCorsHeaders(request),
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(request.url);

    try {
      const token = parseToken(request);
      const tokenHash = await sha256Hex(token);
      const access = await deps.resolveLink(tokenHash);
      if (access.state !== "ok" || !access.link) throw linkError(access.state);

      if (request.method === "GET") {
        if (!allow(reads, tokenHash, readsPer15Minutes, 15 * 60 * 1000)) {
          throw new HaccpUploadError("rate_limited", 429);
        }
        const snapshot = await deps.snapshot(tokenHash);
        const visible = await withSignedFiles(snapshot.entries.slice(0, MAX_ENTRIES_PER_TABLE * 7), snapshot.files);
        deps.audit?.({ fn: "haccp-upload", event: "snapshot", link_id: access.link.id });
        return jsonResponse({
          ok: true,
          entries: visible.entries,
          files: visible.files,
          link: {
            url: "",
            days: snapshot.link.days,
            active: true,
            expiresOn: formatDate(snapshot.link.expires_at),
          },
          activity: snapshot.activity,
        }, 200, headers);
      }

      if (request.method !== "POST") throw new HaccpUploadError("method_not_allowed", 405);

      if (!allow(writes, tokenHash, writesPerHour, 60 * 60 * 1000)) {
        throw new HaccpUploadError("rate_limited", 429);
      }

      const action = String(url.searchParams.get("action") ?? "").trim();
      if (action === "upload") {
        if (asString(url.searchParams.get("table_id"), 40) === "suppliers") {
          throw new HaccpUploadError("supplier_read_only", 403);
        }
        const rawMime = String(request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!EXTENSIONS[rawMime]) throw new HaccpUploadError("unsupported_type", 415);
        const declared = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > HACCP_MAX_BYTES) {
          throw new HaccpUploadError("file_too_large", 413);
        }
        const bytes = await readBody(request, HACCP_MAX_BYTES);
        if (bytes.byteLength === 0) throw new HaccpUploadError("empty_file", 413);

        const kind = detectFileKind(bytes);
        if (!mimeMatchesKind(rawMime, kind)) throw new HaccpUploadError("invalid_content", 415);

        const entryId = url.searchParams.get("entry_id");
        const layout = url.searchParams.get("layout") === "1";
        if (layout === Boolean(entryId)) throw new HaccpUploadError("invalid_request", 400);
        if (entryId && !isUuid(entryId)) throw new HaccpUploadError("invalid_request", 400);

        const who = asString(url.searchParams.get("who"), 80);
        const requestId = url.searchParams.get("request_id") ?? crypto.randomUUID();
        if (!isUuid(requestId)) throw new HaccpUploadError("invalid_request", 400);

        const name = safeUploadName(request.headers.get("x-file-name"), rawMime);
        const extension = EXTENSIONS[rawMime];
        const path = `haccp/${access.link.id}/${crypto.randomUUID()}.${extension}`;

        await deps.uploadObject(path, bytes, rawMime);
        let file: HaccpFileRecord;
        try {
          file = await deps.addFile(tokenHash, {
            entryId,
            layout,
            path,
            name,
            mime: rawMime,
            size: bytes.byteLength,
            who,
            requestId,
          });
        } catch (error) {
          await deps.removeObject(path).catch(() => undefined);
          throw error;
        }

        const signed = await deps.signUrl(path);
        deps.audit?.({ fn: "haccp-upload", event: "upload", link_id: access.link.id, size: bytes.byteLength, mime: rawMime });
        return jsonResponse({
          ok: true,
          file: {
            id: file.id,
            name: file.name,
            size: file.size,
            type: file.type,
            url: signed ?? "",
          },
        }, 200, headers);
      }

      if (!String(request.headers.get("content-type") ?? "").includes("application/json")) {
        throw new HaccpUploadError("invalid_content_type", 415);
      }
      const bodyBytes = await readBody(request, HACCP_MAX_JSON_BYTES, "body_limit");
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder().decode(bodyBytes));
      } catch {
        throw new HaccpUploadError("invalid_json", 400);
      }
      if (!isRecord(raw)) throw new HaccpUploadError("invalid_request", 400);
      const body = raw;

      if (body.action === "save_row") {
        const tableId = asString(body.table_id, 40);
        if (!TABLE_KEYS[tableId]) throw new HaccpUploadError("invalid_request", 400);
        if (tableId === "suppliers") throw new HaccpUploadError("supplier_read_only", 403);
        const id = body.id === null || body.id === undefined || body.id === "" ? null : body.id;
        if (id !== null && !isUuid(id)) throw new HaccpUploadError("invalid_request", 400);
        const version = body.version === null || body.version === undefined ? null : Number(body.version);
        if (version !== null && (!Number.isInteger(version) || version < 1)) {
          throw new HaccpUploadError("invalid_request", 400);
        }
        const requestId = isUuid(body.request_id) ? body.request_id : crypto.randomUUID();
        const saved = await deps.saveEntry(tokenHash, {
          id,
          tableId,
          values: parseValues(tableId, body.values),
          who: asString(body.who, 80),
          version,
          requestId,
          position: Number.isInteger(body.position) ? Number(body.position) : null,
        });
        const visible = await withSignedFiles([saved], []);
        deps.audit?.({ fn: "haccp-upload", event: "save_row", link_id: access.link.id, table: tableId });
        return jsonResponse({ ok: true, entry: visible.entries[0] }, 200, headers);
      }

      if (body.action === "delete_row") {
        if (asString(body.table_id, 40) === "suppliers") {
          throw new HaccpUploadError("supplier_read_only", 403);
        }
        const id = body.id;
        const version = Number(body.version);
        if (!isUuid(id) || !Number.isInteger(version) || version < 1) {
          throw new HaccpUploadError("invalid_request", 400);
        }
        await deps.deleteEntry(tokenHash, {
          id,
          version,
          requestId: isUuid(body.request_id) ? body.request_id : crypto.randomUUID(),
          who: asString(body.who, 80),
        });
        return jsonResponse({ ok: true }, 200, headers);
      }

      if (body.action === "delete_file") {
        if (!isUuid(body.file_id)) throw new HaccpUploadError("invalid_request", 400);
        await deps.deleteFile(tokenHash, {
          fileId: body.file_id,
          requestId: isUuid(body.request_id) ? body.request_id : crypto.randomUUID(),
          who: asString(body.who, 80),
        });
        return jsonResponse({ ok: true }, 200, headers);
      }

      throw new HaccpUploadError("invalid_request", 400);
    } catch (error) {
      return fail(error, headers);
    }
  };
}
