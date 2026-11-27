// haccp-upload — public staff link for the HACCP dossier.
//
// verify_jwt is false because staff open the link on a phone without an account.
// The URL token is hashed in the handler; the database stores only that hash and
// re-checks expiry/revocation on every call. All database access uses the
// service role through the haccp_link_* RPCs, which are service_role-only.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  HACCP_SIGNED_URL_SECONDS,
  createHaccpUploadHandler,
  type HaccpEntryRecord,
  type HaccpFileRecord,
  type HaccpLinkState,
  type HaccpSnapshot,
} from "./handler.ts";

const BUCKET = "haccp-docs";
const url = Deno.env.get("SUPABASE_URL")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// No generated database types here: the RPC arguments are checked by Postgres.
// deno-lint-ignore no-explicit-any
let adminClient: ReturnType<typeof createClient<any>> | null = null;

function admin() {
  if (!serviceRole) throw new Error("missing_service_role");
  if (!adminClient) {
    // deno-lint-ignore no-explicit-any
    adminClient = createClient<any>(url, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return adminClient;
}

function rpcError(error: { message?: string } | null): never {
  throw new Error(error?.message || "request_failed");
}

async function resolveLink(tokenHash: string): Promise<HaccpLinkState> {
  const { data, error } = await admin().rpc("haccp_link_access", {
    p_token_hash: tokenHash,
  });
  if (error) rpcError(error);
  const row = (data ?? {}) as Record<string, unknown>;
  const state = String(row.state ?? "missing") as HaccpLinkState["state"];
  if (state !== "ok") return { state };
  return {
    state: "ok",
    link: {
      id: String(row.link_id ?? ""),
      days: Number(row.days ?? 0),
      expires_at: String(row.expires_at ?? ""),
      revoked_at: null,
    },
  };
}

async function snapshot(tokenHash: string): Promise<HaccpSnapshot> {
  const { data, error } = await admin().rpc("haccp_link_snapshot", {
    p_token_hash: tokenHash,
  });
  if (error) rpcError(error);
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    entries: Array.isArray(row.entries) ? (row.entries as HaccpEntryRecord[]) : [],
    files: Array.isArray(row.files) ? (row.files as HaccpFileRecord[]) : [],
    link: (row.link ?? {}) as HaccpSnapshot["link"],
    activity: Array.isArray(row.activity) ? (row.activity as HaccpSnapshot["activity"]) : [],
  };
}

async function signUrl(path: string): Promise<string | null> {
  const { data, error } = await admin().storage.from(BUCKET).createSignedUrl(path, HACCP_SIGNED_URL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

Deno.serve(createHaccpUploadHandler({
  resolveLink,
  snapshot,
  signUrl,
  saveEntry: async (tokenHash, input) => {
    const { data, error } = await admin().rpc("haccp_link_save_entry", {
      p_token_hash: tokenHash,
      p_id: input.id,
      p_table_id: input.tableId,
      p_values: input.values,
      p_who: input.who,
      p_version: input.version,
      p_request_id: input.requestId,
      p_position: input.position ?? null,
    });
    if (error) rpcError(error);
    return data as HaccpEntryRecord;
  },
  deleteEntry: async (tokenHash, input) => {
    const { error } = await admin().rpc("haccp_link_delete_entry", {
      p_token_hash: tokenHash,
      p_id: input.id,
      p_version: input.version,
      p_request_id: input.requestId,
      p_who: input.who,
    });
    if (error) rpcError(error);
  },
  addFile: async (tokenHash, input) => {
    const { data, error } = await admin().rpc("haccp_link_add_file", {
      p_token_hash: tokenHash,
      p_entry_id: input.entryId,
      p_layout: input.layout,
      p_storage_path: input.path,
      p_file_name: input.name,
      p_mime_type: input.mime,
      p_size_bytes: input.size,
      p_who: input.who,
      p_request_id: input.requestId,
    });
    if (error) rpcError(error);
    return data as HaccpFileRecord;
  },
  deleteFile: async (tokenHash, input) => {
    const { error } = await admin().rpc("haccp_link_delete_file", {
      p_token_hash: tokenHash,
      p_file_id: input.fileId,
      p_request_id: input.requestId,
      p_who: input.who,
    });
    if (error) rpcError(error);
  },
  uploadObject: async (path, bytes, mime) => {
    const { error } = await admin().storage.from(BUCKET).upload(path, bytes, {
      contentType: mime,
      upsert: false,
    });
    if (error) throw new Error(error.message || "storage_failed");
  },
  removeObject: async (path) => {
    await admin().storage.from(BUCKET).remove([path]);
  },
  audit: (event) => console.info(JSON.stringify(event)),
}));
