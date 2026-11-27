/**
 * Two data sources for the HACCP dossier, both returning an HaccpStore:
 *   - manager: SECURITY DEFINER RPCs using the signed-in owner/inventory user;
 *   - staff link: the haccp-upload Edge Function with the 32-byte URL token.
 *
 * This file is UI-free. It signs manager file URLs, groups raw rows into the
 * seven tables and keeps the optimistic version needed by the write RPCs.
 */

import { supabase } from "@/integrations/supabase/client";
import type { HaccpStore } from "@/components/haccp/store";
import { HACCP_SECTIONS, type HaccpData, type HaccpFile, type HaccpRow, type HaccpTableId } from "./haccp-schema";

export interface HaccpRawFile {
  id: string;
  entry_id?: string | null;
  layout?: boolean;
  name: string;
  size: number | string;
  type: string;
  path?: string;
  url?: string;
}

export interface HaccpRawEntry {
  id: string;
  table_id: HaccpTableId;
  values: Record<string, string>;
  position?: number;
  version?: number;
  by?: string;
  source_key?: string | null;
  linked?: boolean;
  supplier_id?: string | null;
  files?: HaccpRawFile[];
}

export interface HaccpRawSnapshot {
  entries: HaccpRawEntry[];
  files: HaccpRawFile[];
  link: { id?: string; days?: number; expires_at?: string; revoked_at?: string | null; active?: boolean } | null;
  activity: { id: string; who: string; text: string; at: string }[];
}

/** A row may carry the linked catalogue supplier flag for read-only UI. */
export type HaccpLinkedRow = HaccpRow & { linked?: boolean; supplierId?: string };

export interface HaccpSupplierCert {
  id: string;
  certType: string;
  certNo: string | null;
  expiresOn: string | null;
  filePath: string | null;
  fileName: string | null;
  mimeType: string | null;
  url: string | null;
}

export interface HaccpSupplierPapers {
  entryId: string;
  supplierId: string;
  supplierName: string;
  done: number;
  total: number;
  pct: number;
  papers: HaccpSupplierCert[];
}

export class HaccpApiError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message || code);
    this.name = "HaccpApiError";
    this.code = code;
  }
}

/** A real failure code: SectionBody must keep the dialog open, not treat it as saved. */
function supplierReadOnlyError(message: string): HaccpApiError {
  return new HaccpApiError("supplier_read_only", message);
}

const BUCKET = "haccp-docs";
const CERT_BUCKET = "food-safety-docs";
const TOKEN_KEY = "bmq-haccp-link-token";
const TOKEN_ID_KEY = "bmq-haccp-link-id";
const SIGNED_URL_SECONDS = 3600;
const TABLE_IDS: HaccpTableId[] = ["suppliers", "team", "staff", "measure", "machines", "chemicals", "process"];

type LooseClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

const db = supabase as unknown as LooseClient;

export function haccpEmptyData(): HaccpData {
  return {
    suppliers: [],
    team: [],
    staff: [],
    measure: [],
    machines: [],
    chemicals: [],
    process: [],
  };
}

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "00000000-0000-4000-8000-" + String(Date.now()).padStart(12, "0").slice(-12);
}

/** Keep the client error specific before Postgres returns a generic RPC error. */
function validateValues(table: HaccpTableId, values: Record<string, string>): void {
  if (table === "suppliers" && (values.phone ?? "").length > 40) {
    throw new HaccpApiError("invalid_values", "Số điện thoại tối đa 40 ký tự.");
  }
  if (table === "suppliers" && (values.contact ?? "").trim().length > 120) {
    throw new HaccpApiError("invalid_values", "Người liên hệ tối đa 120 ký tự.");
  }
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && value.length > 1000) {
      throw new HaccpApiError("invalid_values", `Trường ${key} tối đa 1000 ký tự.`);
    }
  }
}

function errorText(error: { message?: string } | null): string {
  return error?.message || "request_failed";
}

function numberOrZero(value: number | string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapFile(raw: HaccpRawFile): HaccpFile {
  return {
    id: raw.id,
    name: raw.name,
    size: numberOrZero(raw.size),
    type: raw.type,
    url: raw.url || undefined,
  };
}

function managerLinkUrl(token: string | null): string {
  if (!token) return "";
  if (typeof window === "undefined") return `/nop-ho-so?t=${encodeURIComponent(token)}`;
  return `${window.location.origin}/nop-ho-so?t=${encodeURIComponent(token)}`;
}

function readStoredToken(): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** The staff page persists the typed name under this key. */
function readStaffName(): string {
  try {
    return typeof window === "undefined" ? "" : (window.localStorage.getItem("bmq-haccp-staff-name") ?? "").trim();
  } catch {
    return "";
  }
}

function storeToken(token: string | null, linkId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
    if (linkId) window.localStorage.setItem(TOKEN_ID_KEY, linkId);
    else window.localStorage.removeItem(TOKEN_ID_KEY);
  } catch {
    // Storage may be blocked; the link can then only be copied once.
  }
}

function readStoredLinkId(): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(TOKEN_ID_KEY);
  } catch {
    return null;
  }
}

export function haccpExpiry(iso: string | undefined): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
  } catch {
    return "";
  }
}

function activityTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
}

function normalizeSnapshot(raw: HaccpRawSnapshot, linkUrl: string): {
  data: HaccpData;
  layoutFiles: HaccpFile[];
  link: HaccpStore["link"];
  activity: HaccpStore["activity"];
} {
  const data = haccpEmptyData();
  for (const entry of raw.entries ?? []) {
    if (!TABLE_IDS.includes(entry.table_id)) continue;
    const row: HaccpLinkedRow = {
      id: entry.id,
      values: entry.values ?? {},
      files: (entry.files ?? []).map(mapFile),
      by: entry.by || "Quản lý",
      version: Number(entry.version ?? 1),
    };
    if (entry.linked === true) {
      row.linked = true;
      if (entry.supplier_id) row.supplierId = entry.supplier_id;
    }
    data[entry.table_id].push(row);
  }
  const rawLink = raw.link ?? {};
  const active = Boolean(rawLink.active) && !rawLink.revoked_at && (!rawLink.expires_at || Date.parse(rawLink.expires_at) > Date.now());
  return {
    data,
    layoutFiles: (raw.files ?? []).map(mapFile),
    link: {
      url: linkUrl,
      days: Number(rawLink.days ?? 30),
      active,
      expiresOn: haccpExpiry(rawLink.expires_at),
    },
    activity: (raw.activity ?? []).slice(0, 5).map((event) => ({
      id: event.id,
      who: event.who,
      text: event.text,
      at: activityTime(event.at),
    })),
  };
}

async function signSnapshotFiles(raw: HaccpRawSnapshot): Promise<HaccpRawSnapshot> {
  const sign = async (file: HaccpRawFile): Promise<HaccpRawFile> => {
    if (file.url || !file.path) return { ...file, path: undefined };
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(file.path, SIGNED_URL_SECONDS);
    return { ...file, path: undefined, url: error ? undefined : data?.signedUrl };
  };
  return {
    ...raw,
    entries: await Promise.all((raw.entries ?? []).map(async (entry) => ({
      ...entry,
      files: await Promise.all((entry.files ?? []).map(sign)),
    }))),
    files: await Promise.all((raw.files ?? []).map(sign)),
  };
}

function safeStorageName(name: string): string {
  const clean = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(-100);
  return clean || "tep";
}

function fileMime(file: HaccpFile): string {
  if (file.type) return file.type;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "image/jpeg";
}

async function uploadManagerFile(
  entryId: string | null,
  file: HaccpFile,
  who: string,
): Promise<void> {
  if (!file.file) return;
  if (file.file.size > 10 * 1024 * 1024) throw new HaccpApiError("file_too_large", "File vượt quá 10 MB");
  const path = `haccp/${entryId ?? "layout"}/${crypto.randomUUID()}-${safeStorageName(file.name)}`;
  const uploaded = await supabase.storage.from(BUCKET).upload(path, file.file, {
    contentType: fileMime(file),
    upsert: false,
  });
  if (uploaded.error) throw new HaccpApiError("storage_failed", uploaded.error.message);
  const recorded = await db.rpc("haccp_add_file", {
    p_entry_id: entryId,
    p_layout: entryId === null,
    p_storage_path: path,
    p_file_name: file.name,
    p_mime_type: fileMime(file),
    p_size_bytes: file.file.size,
    p_uploaded_by_name: who,
    p_request_id: newRequestId(),
  });
  if (recorded.error) {
    await supabase.storage.from(BUCKET).remove([path]);
    throw new HaccpApiError("record_failed", errorText(recorded.error));
  }
}

async function managerSnapshot(): Promise<HaccpRawSnapshot> {
  const { data, error } = await db.rpc("haccp_manager_snapshot");
  if (error) throw new HaccpApiError("snapshot_failed", errorText(error));
  return signSnapshotFiles((data ?? { entries: [], files: [], link: null, activity: [] }) as HaccpRawSnapshot);
}

function apiBase(): string {
  const url = import.meta.env.VITE_SUPABASE_URL;
  if (!url) throw new HaccpApiError("missing_config", "VITE_SUPABASE_URL is missing");
  return String(url).replace(/\/+$/, "");
}

function apiHeaders(): Record<string, string> {
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

async function edgeJson<T>(token: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${apiBase()}/functions/v1/haccp-upload?t=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { ...apiHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || parsed.ok === false) {
    throw new HaccpApiError(String(parsed.code ?? "request_failed"), String(parsed.error ?? ""));
  }
  return parsed as T;
}

async function linkSnapshot(token: string): Promise<HaccpRawSnapshot> {
  const response = await fetch(`${apiBase()}/functions/v1/haccp-upload?t=${encodeURIComponent(token)}`, {
    headers: apiHeaders(),
    cache: "no-store",
  });
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || parsed.ok === false) {
    throw new HaccpApiError(String(parsed.code ?? "link_invalid"), String(parsed.error ?? ""));
  }
  return parsed as unknown as HaccpRawSnapshot;
}

async function uploadLinkFile(
  token: string,
  entryId: string | null,
  file: HaccpFile,
  who: string,
  tableId?: HaccpTableId,
): Promise<void> {
  if (!file.file) return;
  const query = new URLSearchParams({
    t: token,
    action: "upload",
    who,
    request_id: newRequestId(),
  });
  if (tableId) query.set("table_id", tableId);
  if (entryId) query.set("entry_id", entryId);
  else query.set("layout", "1");
  const response = await fetch(`${apiBase()}/functions/v1/haccp-upload?${query}`, {
    method: "POST",
    headers: {
      ...apiHeaders(),
      "Content-Type": fileMime(file),
      "x-file-name": encodeURIComponent(file.name),
    },
    body: file.file,
    cache: "no-store",
  });
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || parsed.ok === false) {
    throw new HaccpApiError(String(parsed.code ?? "upload_failed"), String(parsed.error ?? ""));
  }
}

function managerLink(snapshot: HaccpRawSnapshot): { token: string | null; linkId: string | null } {
  const linkId = snapshot.link?.id ?? null;
  if (!linkId) return { token: null, linkId: null };
  const storedId = readStoredLinkId();
  const storedToken = readStoredToken();
  if (storedToken && (!storedId || storedId === linkId)) {
    return { token: storedToken, linkId };
  }
  return { token: null, linkId };
}

function rowById(data: HaccpData, id: string | null): HaccpRow | undefined {
  if (!id) return undefined;
  for (const table of TABLE_IDS) {
    const row = data[table].find((item) => item.id === id);
    if (row) return row;
  }
  return undefined;
}

/** Files the user removed from an existing row must be soft-deleted too. */
function removedFileIds(original: HaccpRow | undefined, saved: HaccpRow): string[] {
  if (!original) return [];
  const kept = new Set(saved.files.map((file) => file.id));
  return original.files
    .filter((file) => isUuid(file.id) && !kept.has(file.id))
    .map((file) => file.id);
}

async function attemptUploads(
  files: HaccpFile[],
  upload: (file: HaccpFile) => Promise<void>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const file of files) {
    if (!file.file) continue;
    try {
      await upload(file);
    } catch (error) {
      failed.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failed;
}

function attachmentError(failed: string[], entryId?: string | null): HaccpApiError | null {
  if (!failed.length) return null;
  const row = entryId ? `Dòng ${entryId.slice(0, 8)} đã lưu` : "Dòng đã lưu";
  return new HaccpApiError(
    "attachment_failed",
    `${row} nhưng ${failed.length} file chưa lên được: ${failed.join("; ")}`,
  );
}

/** Build the store used by the manager screens. */
export function createManagerStore(
  snapshot: HaccpRawSnapshot,
  refresh: () => Promise<void>,
): HaccpStore {
  const stored = managerLink(snapshot);
  const normalized = normalizeSnapshot(snapshot, managerLinkUrl(stored.token));
  const linkedEntryIds = new Set(
    (snapshot.entries ?? [])
      .filter((entry) => entry.linked === true)
      .map((entry) => entry.id),
  );

  return {
    ...normalized,
    saveRow: async (table, row, who) => {
      const id = isUuid(row.id) ? row.id : null;
      const original = rowById(normalized.data, id);
      const supplierLinked = table === "suppliers" && id !== null && linkedEntryIds.has(id);
      // Send only contact fields the manager changed from the displayed
      // catalogue values. An items-only save then cannot overwrite a newer
      // supplier-page edit, and clearing a displayed value is still explicit.
      const saveValues = { ...row.values };
      if (supplierLinked && original) {
        for (const field of ["phone", "address", "contact"] as const) {
          if (saveValues[field] === original.values[field]) delete saveValues[field];
        }
      }
      validateValues(table, saveValues);
      if (supplierLinked && original && row.values.name !== original.values.name) {
        throw supplierReadOnlyError(
          "Tên nhà cung cấp lấy từ danh mục Nhà cung cấp. Sửa tên tại danh mục, không sửa trong HACCP.",
        );
      }
      if (supplierLinked && row.files.some((file) => file.file)) {
        throw supplierReadOnlyError(
          "Không thêm file mới cho nhà cung cấp tại HACCP. Giấy tờ hiện hành nằm trong mục ATTP.",
        );
      }
      const failed: string[] = [];
      try {
        const saved = await db.rpc("haccp_save_entry", {
          p_id: id,
          p_table_id: table,
          p_values: saveValues,
          p_entered_by_name: who,
          p_version: id ? row.version ?? null : null,
          p_request_id: newRequestId(),
          p_position: null,
          p_source_key: null,
        });
        if (saved.error) throw new HaccpApiError("save_failed", errorText(saved.error));
        const entryId = String((saved.data as { id?: string } | null)?.id ?? id ?? "");

        // Managers may remove an old HACCP file from a linked supplier row,
        // but new supplier papers live in ATTP. A manually added, unlinked
        // supplier row may still attach its own evidence.
        for (const fileId of removedFileIds(original, row)) {
          const deleted = await db.rpc("haccp_delete_file", {
            p_file_id: fileId,
            p_request_id: newRequestId(),
            p_who: who,
          });
          if (deleted.error) failed.push(`xoá file ${fileId}: ${errorText(deleted.error)}`);
        }

        if (!supplierLinked && entryId) {
          failed.push(...await attemptUploads(row.files, (file) => uploadManagerFile(entryId, file, who)));
        }
        const attachmentFailure = attachmentError(failed, entryId);
        if (attachmentFailure) throw attachmentFailure;
      } finally {
        await refresh();
      }
    },
    removeRow: async (_table, rowId, who, version) => {
      if (!isUuid(rowId)) return;
      const row = rowById(normalized.data, rowId);
      try {
        const removed = await db.rpc("haccp_delete_entry", {
          p_id: rowId,
          p_version: version ?? row?.version ?? null,
          p_request_id: newRequestId(),
          p_who: who ?? null,
        });
        if (removed.error) throw new HaccpApiError("delete_failed", errorText(removed.error));
      } finally {
        await refresh();
      }
    },
    addLayoutFiles: async (files, who) => {
      try {
        const attachmentFailure = attachmentError(await attemptUploads(files, (file) => uploadManagerFile(null, file, who)));
        if (attachmentFailure) throw attachmentFailure;
      } finally {
        await refresh();
      }
    },
    removeLayoutFile: async (fileId, who) => {
      try {
        const removed = await db.rpc("haccp_delete_file", {
          p_file_id: fileId,
          p_request_id: newRequestId(),
          p_who: who ?? null,
        });
        if (removed.error) throw new HaccpApiError("delete_failed", errorText(removed.error));
      } finally {
        await refresh();
      }
    },
    pullFromApp: async (table) => {
      try {
        const pulled = await db.rpc("haccp_prefill", { p_table_id: table });
        if (pulled.error) throw new HaccpApiError("prefill_failed", errorText(pulled.error));
        const added = Number(pulled.data ?? 0);
        return Number.isFinite(added) ? added : 0;
      } finally {
        await refresh();
      }
    },
    createLink: async (days) => {
      try {
        const created = await db.rpc("haccp_create_upload_link", {
          p_days: days,
          p_request_id: newRequestId(),
        });
        if (created.error) throw new HaccpApiError("create_link_failed", errorText(created.error));
        const data = (created.data ?? {}) as { token?: string | null; link_id?: string | null };
        if (data.token) storeToken(data.token, data.link_id ?? null);
      } finally {
        await refresh();
      }
    },
    revokeLink: async () => {
      try {
        const revoked = await db.rpc("haccp_revoke_upload_link", {
          p_request_id: newRequestId(),
        });
        if (revoked.error) throw new HaccpApiError("revoke_link_failed", errorText(revoked.error));
        storeToken(null, null);
      } finally {
        await refresh();
      }
    },
  };
}

/** Build the store used by the staff link page. */
export function createLinkStore(
  token: string,
  snapshot: HaccpRawSnapshot,
  refresh: () => Promise<void>,
): HaccpStore {
  const normalized = normalizeSnapshot(snapshot, "");
  let lastWho = readStaffName();

  return {
    ...normalized,
    saveRow: async (table, row, who) => {
      if (table === "suppliers") throw supplierReadOnlyError("Link nhân viên không được sửa nhà cung cấp.");
      validateValues(table, row.values);
      lastWho = who;
      const id = isUuid(row.id) ? row.id : null;
      const original = rowById(normalized.data, id);
      const failed: string[] = [];
      try {
        const saved = await edgeJson<{ entry?: { id?: string } }>(token, {
          action: "save_row",
          table_id: table,
          id,
          values: row.values,
          who,
          version: id ? row.version ?? null : null,
          request_id: newRequestId(),
        });
        const entryId = saved.entry?.id ?? id;

        for (const fileId of removedFileIds(original, row)) {
          try {
            await edgeJson(token, {
              action: "delete_file",
              file_id: fileId,
              request_id: newRequestId(),
              who,
            });
          } catch (error) {
            failed.push(`xoá file ${fileId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        if (entryId) {
          failed.push(...await attemptUploads(row.files, (file) => uploadLinkFile(token, entryId, file, who, table)));
        }
        const attachmentFailure = attachmentError(failed, entryId);
        if (attachmentFailure) throw attachmentFailure;
      } finally {
        await refresh();
      }
    },
    removeRow: async (table, rowId, who, version) => {
      if (table === "suppliers") throw supplierReadOnlyError("Link nhân viên không được xoá nhà cung cấp.");
      if (!isUuid(rowId)) return;
      const row = rowById(normalized.data, rowId);
      try {
        await edgeJson(token, {
          action: "delete_row",
          table_id: table,
          id: rowId,
          version: version ?? row?.version ?? null,
          request_id: newRequestId(),
          who: who ?? lastWho,
        });
      } finally {
        await refresh();
      }
    },
    addLayoutFiles: async (files, who) => {
      lastWho = who;
      try {
        const attachmentFailure = attachmentError(await attemptUploads(files, (file) => uploadLinkFile(token, null, file, who)));
        if (attachmentFailure) throw attachmentFailure;
      } finally {
        await refresh();
      }
    },
    removeLayoutFile: async (fileId, who) => {
      try {
        await edgeJson(token, {
          action: "delete_file",
          file_id: fileId,
          request_id: newRequestId(),
          who: who ?? lastWho,
        });
      } finally {
        await refresh();
      }
    },
    pullFromApp: () => 0,
    createLink: () => undefined,
    revokeLink: () => undefined,
  };
}

/** Current ATTP papers, keyed later by the HACCP supplier entry id. */
export async function loadSupplierPapers(): Promise<HaccpSupplierPapers[]> {
  const { data, error } = await db.rpc("haccp_supplier_papers");
  if (error) throw new HaccpApiError("supplier_papers_failed", errorText(error));
  const rows = Array.isArray(data) ? data : [];
  return Promise.all(rows.map(async (raw) => {
    const row = raw as Record<string, unknown>;
    const rawPapers = Array.isArray(row.papers) ? row.papers : [];
    const papers = await Promise.all(rawPapers.map(async (rawPaper): Promise<HaccpSupplierCert> => {
      const paper = rawPaper as Record<string, unknown>;
      const filePath = paper.file_path ? String(paper.file_path) : null;
      let url: string | null = null;
      if (filePath) {
        const signed = await supabase.storage.from(CERT_BUCKET).createSignedUrl(filePath, SIGNED_URL_SECONDS);
        url = signed.error ? null : signed.data?.signedUrl ?? null;
      }
      return {
        id: String(paper.id ?? ""),
        certType: String(paper.cert_type ?? ""),
        certNo: paper.cert_no ? String(paper.cert_no) : null,
        expiresOn: paper.expires_on ? String(paper.expires_on) : null,
        filePath,
        fileName: paper.file_name ? String(paper.file_name) : null,
        mimeType: paper.mime_type ? String(paper.mime_type) : null,
        url,
      };
    }));
    return {
      entryId: String(row.entry_id ?? ""),
      supplierId: String(row.supplier_id ?? ""),
      supplierName: String(row.supplier_name ?? ""),
      done: numberOrZero(row.done as number | string | undefined),
      total: numberOrZero(row.total as number | string | undefined),
      pct: numberOrZero(row.pct as number | string | undefined),
      papers,
    };
  }));
}

export async function loadManagerSnapshot(): Promise<{ snapshot: HaccpRawSnapshot; store: (refresh: () => Promise<void>) => HaccpStore }> {
  const snapshot = await managerSnapshot();
  return {
    snapshot,
    store: (refresh) => createManagerStore(snapshot, refresh),
  };
}

export async function loadLinkSnapshot(token: string): Promise<HaccpRawSnapshot> {
  if (!token) throw new HaccpApiError("link_invalid", "Missing link token");
  return linkSnapshot(token);
}

/** Table id -> export section, used when collecting attachment bytes. */
export const HACCP_TABLE_SECTION: Record<HaccpTableId, (typeof HACCP_SECTIONS)[number]["id"]> = {
  suppliers: "suppliers",
  team: "people",
  staff: "people",
  measure: "measure",
  machines: "machines",
  chemicals: "chemicals",
  process: "process",
};
