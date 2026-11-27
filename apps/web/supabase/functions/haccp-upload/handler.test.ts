// Offline tests for the public HACCP upload handler.
// Storage and database adapters are fakes; no network, no real BMQ data.

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  HACCP_MAX_BYTES,
  HaccpUploadError,
  createHaccpUploadHandler,
  detectFileKind,
  mimeMatchesKind,
  safeUploadName,
  sha256Hex,
  type HaccpEntryRecord,
  type HaccpFileRecord,
  type HaccpLinkState,
  type HaccpSnapshot,
  type HaccpUploadDeps,
} from "./handler.ts";

const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);
const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const EXPIRES = "2030-01-01T00:00:00.000Z";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

async function officeBytes(kind: "docx" | "xlsx"): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file(kind === "docx" ? "word/document.xml" : "xl/workbook.xml", "<root/>");
  return zip.generateAsync({ type: "uint8array" });
}

function jsonRequest(token: string, body: unknown, action?: string): Request {
  const query = new URLSearchParams({ t: token });
  if (action) query.set("action", action);
  return new Request(`https://example.test/functions/v1/haccp-upload?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://ai.banhmique.vn" },
    body: JSON.stringify(body),
  });
}

function getRequest(token: string): Request {
  return new Request(`https://example.test/functions/v1/haccp-upload?t=${token}`, {
    headers: { origin: "https://ai.banhmique.vn" },
  });
}

interface FakeState {
  linkState: HaccpLinkState["state"];
  snapshotCalls: number;
  saveCalls: number;
  deleteCalls: number;
  addFileCalls: number;
  deleteFileCalls: number;
  uploads: { path: string; bytes: number; mime: string }[];
  removed: string[];
  signedPaths: string[];
  lastSave: Record<string, unknown> | null;
  deleteWhos: string[];
  deleteFileWhos: string[];
}

const ENTRY: HaccpEntryRecord = {
  id: ENTRY_ID,
  table_id: "suppliers",
  values: { name: "Bột mì", items: "Bột", phone: "0900", address: "Q7", contact: "Lan" },
  version: 2,
  by: "Chị Lan",
  files: [],
};

const FILE: HaccpFileRecord = {
  id: "33333333-3333-4333-8333-333333333333",
  entry_id: ENTRY_ID,
  layout: false,
  name: "anh.jpg",
  size: 10,
  type: "image/jpeg",
  path: "haccp/link/secret-file.jpg",
};

function fakeDeps(state: FakeState): HaccpUploadDeps {
  const link = { id: "44444444-4444-4444-8444-444444444444", days: 30, expires_at: EXPIRES, revoked_at: null };
  const snapshot: HaccpSnapshot = {
    entries: [{ ...ENTRY, files: [{ ...FILE }] }],
    files: [{
      id: "55555555-5555-4555-8555-555555555555",
      layout: true,
      name: "layout.pdf",
      size: 12,
      type: "application/pdf",
      path: "haccp/link/secret-layout.pdf",
    }],
    link: { ...link, active: true },
    activity: [{ id: "a1", who: "Lan", text: "lưu", at: "2026-11-28T03:00:00.000Z" }],
  };

  return {
    resolveLink: async (hash) => {
      if (hash === await sha256Hex(OTHER_TOKEN)) return { state: "missing" };
      if (state.linkState === "ok") return { state: "ok", link };
      return { state: state.linkState };
    },
    snapshot: async () => {
      state.snapshotCalls += 1;
      return snapshot;
    },
    signUrl: async (path) => {
      state.signedPaths.push(path);
      return `https://signed.test/object?signature=short`;
    },
    saveEntry: async (_hash, input) => {
      state.saveCalls += 1;
      state.lastSave = input as unknown as Record<string, unknown>;
      return { ...ENTRY, values: input.values };
    },
    deleteEntry: async (_hash, input) => {
      state.deleteCalls += 1;
      state.deleteWhos.push(input.who);
    },
    addFile: async (_hash, input) => {
      state.addFileCalls += 1;
      return {
        id: FILE.id,
        entry_id: input.entryId,
        layout: input.layout,
        name: input.name,
        size: input.size,
        type: input.mime,
        path: input.path,
      };
    },
    deleteFile: async (_hash, input) => {
      state.deleteFileCalls += 1;
      state.deleteFileWhos.push(input.who);
    },
    uploadObject: async (path, bytes, mime) => {
      state.uploads.push({ path, bytes: bytes.byteLength, mime });
    },
    removeObject: async (path) => { state.removed.push(path); },
  };
}

function fresh(): { state: FakeState; deps: HaccpUploadDeps } {
  const state: FakeState = {
    linkState: "ok",
    snapshotCalls: 0,
    saveCalls: 0,
    deleteCalls: 0,
    addFileCalls: 0,
    deleteFileCalls: 0,
    uploads: [],
    removed: [],
    signedPaths: [],
    lastSave: null,
    deleteWhos: [],
    deleteFileWhos: [],
  };
  return { state, deps: fakeDeps(state) };
}

test("wrong, expired and revoked links cannot read anything", async () => {
  for (const [token, linkState, status, code] of [
    [OTHER_TOKEN, "missing", 404, "link_invalid"],
    [TOKEN, "expired", 410, "link_expired"],
    [TOKEN, "revoked", 410, "link_revoked"],
  ] as const) {
    const { state, deps } = fresh();
    state.linkState = linkState;
    const handler = createHaccpUploadHandler(deps);
    const response = await handler(getRequest(token));
    assert.equal(response.status, status);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.code, code);
    assert.equal(state.snapshotCalls, 0);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("a malformed token is rejected before any database access", async () => {
  const { state, deps } = fresh();
  const handler = createHaccpUploadHandler(deps);
  const response = await handler(getRequest("short"));
  assert.equal(response.status, 404);
  assert.equal(state.snapshotCalls, 0);
});

test("GET returns signed URLs, never the storage path or token", async () => {
  const { state, deps } = fresh();
  const handler = createHaccpUploadHandler(deps);
  const response = await handler(getRequest(TOKEN));
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.ok(!text.includes("secret-file.jpg"));
  assert.ok(!text.includes("secret-layout.pdf"));
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes("haccp/"));
  const entries = body.entries as HaccpEntryRecord[];
  assert.equal(entries[0].files?.[0].name, "anh.jpg");
  assert.match(String((entries[0].files?.[0] as unknown as { url: string }).url), /^https:\/\/signed\.test\//);
  assert.equal(state.signedPaths.length, 2);
});

test("an expired or revoked link cannot save or delete", async () => {
  for (const linkState of ["expired", "revoked"] as const) {
    const { state, deps } = fresh();
    state.linkState = linkState;
    const handler = createHaccpUploadHandler(deps);
    const save = await handler(jsonRequest(TOKEN, {
      action: "save_row",
      table_id: "suppliers",
      id: null,
      values: { name: "A" },
      who: "Lan",
      version: null,
      request_id: REQUEST_ID,
    }));
    assert.equal(save.status, 410);
    assert.equal(state.saveCalls, 0);
    assert.equal(state.uploads.length, 0);
  }
});

test("save_row whitelists schema keys and keeps the version", async () => {
  const { state, deps } = fresh();
  const handler = createHaccpUploadHandler(deps);
  const response = await handler(jsonRequest(TOKEN, {
    action: "save_row",
    table_id: "suppliers",
    id: ENTRY_ID,
    values: { name: "Bột mì", items: "Bột", phone: "0900", address: "Q7", contact: "Lan" },
    who: "Lan",
    version: 2,
    request_id: REQUEST_ID,
  }));
  assert.equal(response.status, 200);
  assert.equal(state.saveCalls, 1);
  assert.equal(state.lastSave?.version, 2);

  const bad = await handler(jsonRequest(TOKEN, {
    action: "save_row",
    table_id: "suppliers",
    id: null,
    values: { salary: "10000000" },
    who: "Lan",
    request_id: REQUEST_ID,
  }));
  assert.equal(bad.status, 400);
  assert.equal(state.saveCalls, 1);
});

test("a supplier phone over 40 characters gets a clear invalid_values error", async () => {
  const { state, deps } = fresh();
  const handler = createHaccpUploadHandler(deps);
  const response = await handler(jsonRequest(TOKEN, {
    action: "save_row",
    table_id: "suppliers",
    id: null,
    values: { name: "Bột mì", phone: "0900 000 101 / 0900 000 102 / gặp chị Lan" },
    who: "Lan",
    request_id: REQUEST_ID,
  }));
  assert.equal(response.status, 400);
  const body = await response.json() as { code: string; error: string };
  assert.equal(body.code, "invalid_values");
  assert.match(body.error, /40 ký tự/);
  assert.equal(state.saveCalls, 0);
});

test("upload accepts jpeg/png/webp/pdf/docx/xlsx with matching magic bytes", async () => {
  const files: [string, Uint8Array][] = [
    ["image/jpeg", JPEG],
    ["image/png", PNG],
    ["image/webp", WEBP],
    ["application/pdf", PDF],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", await officeBytes("docx")],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", await officeBytes("xlsx")],
  ];
  for (const [mime, bytes] of files) {
    const { state, deps } = fresh();
    const handler = createHaccpUploadHandler(deps);
    const params = new URLSearchParams({
      t: TOKEN,
      action: "upload",
      entry_id: ENTRY_ID,
      who: "Lan",
      request_id: REQUEST_ID,
    });
    const response = await handler(new Request(`https://example.test/functions/v1/haccp-upload?${params}`, {
      method: "POST",
      headers: { "content-type": mime, "x-file-name": "bang-chung", origin: "https://ai.banhmique.vn" },
      body: bytes,
    }));
    assert.equal(response.status, 200, mime);
    const body = await response.json() as { file: { name: string; version?: number } };
    assert.equal(state.uploads.length, 1);
    assert.equal(state.addFileCalls, 1);
    assert.ok(state.uploads[0].path.startsWith("haccp/"));
    assert.match(body.file.name, /^bang-chung\.(jpg|png|webp|pdf|docx|xlsx)$/);
  }
});

test("upload rejects a mismatched type, an unknown type and an oversized file", async () => {
  const { state, deps } = fresh();
  const handler = createHaccpUploadHandler(deps);
  const params = new URLSearchParams({ t: TOKEN, action: "upload", layout: "1", who: "Lan", request_id: REQUEST_ID });

  const mismatched = await handler(new Request(`https://example.test/functions/v1/haccp-upload?${params}`, {
    method: "POST",
    headers: { "content-type": "image/png", "x-file-name": "a.png" },
    body: JPEG,
  }));
  assert.equal(mismatched.status, 415);
  assert.equal((await mismatched.json() as { code: string }).code, "invalid_content");

  const unknown = await handler(new Request(`https://example.test/functions/v1/haccp-upload?${params}`, {
    method: "POST",
    headers: { "content-type": "text/plain", "x-file-name": "a.txt" },
    body: "hello",
  }));
  assert.equal(unknown.status, 415);
  assert.equal((await unknown.json() as { code: string }).code, "unsupported_type");

  const oversized = await handler(new Request(`https://example.test/functions/v1/haccp-upload?${params}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg", "x-file-name": "big.jpg", "content-length": String(HACCP_MAX_BYTES + 1) },
    body: JPEG,
  }));
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json() as { code: string }).code, "file_too_large");
  assert.equal(state.uploads.length, 0);
});

test("storage is cleaned up when recording the file fails", async () => {
  const { state, deps } = fresh();
  deps.addFile = async () => { throw new HaccpUploadError("request_failed", 500); };
  const handler = createHaccpUploadHandler(deps);
  const params = new URLSearchParams({ t: TOKEN, action: "upload", layout: "1", who: "Lan", request_id: REQUEST_ID });
  const response = await handler(new Request(`https://example.test/functions/v1/haccp-upload?${params}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg", "x-file-name": "a.jpg" },
    body: JPEG,
  }));
  assert.equal(response.status, 500);
  assert.equal(state.removed.length, 1);
});

test("writes are rate limited per link", async () => {
  const { state, deps } = fresh();
  const handler = createHaccpUploadHandler(deps, { writesPerHour: 2 });
  const send = () => handler(jsonRequest(TOKEN, { action: "delete_file", file_id: FILE.id, request_id: REQUEST_ID }));
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  const third = await send();
  assert.equal(third.status, 429);
  assert.equal((await third.json() as { code: string }).code, "rate_limited");
  assert.equal(state.deleteFileCalls, 2);
});

test("the default limit fits a full kitchen bulk-entry session", async () => {
  const { state, deps } = fresh();
  const handler = createHaccpUploadHandler(deps);
  for (let index = 0; index < 70; index += 1) {
    const response = await handler(jsonRequest(TOKEN, {
      action: "delete_file",
      file_id: FILE.id,
      request_id: REQUEST_ID,
    }));
    assert.equal(response.status, 200, `write ${index + 1}`);
  }
  assert.equal(state.deleteFileCalls, 70);
});

test("delete_row and delete_file carry the acting staff name", async () => {
  const { state, deps } = fresh();
  const handler = createHaccpUploadHandler(deps);
  assert.equal((await handler(jsonRequest(TOKEN, {
    action: "delete_row",
    id: ENTRY_ID,
    version: 2,
    request_id: REQUEST_ID,
    who: "Minh",
  }))).status, 200);
  assert.equal((await handler(jsonRequest(TOKEN, {
    action: "delete_file",
    file_id: FILE.id,
    request_id: REQUEST_ID,
    who: "Minh",
  }))).status, 200);
  assert.deepEqual(state.deleteWhos, ["Minh"]);
  assert.deepEqual(state.deleteFileWhos, ["Minh"]);
});

test("office content is distinguished by its ZIP members and names stay safe", async () => {
  assert.equal(detectFileKind(await officeBytes("docx")), "docx");
  assert.equal(detectFileKind(await officeBytes("xlsx")), "xlsx");
  assert.equal(detectFileKind(JPEG), "jpg");
  assert.equal(mimeMatchesKind("application/pdf", "pdf"), true);
  assert.equal(mimeMatchesKind("image/png", "jpg"), false);
  assert.equal(safeUploadName("../../giay ATTP.pdf", "application/pdf"), "giay ATTP.pdf");
  assert.equal(safeUploadName("", "image/jpeg"), "haccp-file.jpg");
});

test("OPTIONS is a CORS preflight and unknown methods are refused", async () => {
  const { deps } = fresh();
  const handler = createHaccpUploadHandler(deps);
  const options = await handler(new Request("https://example.test/functions/v1/haccp-upload?t=" + TOKEN, {
    method: "OPTIONS",
    headers: { origin: "https://ai.banhmique.vn" },
  }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-origin"), "https://ai.banhmique.vn");

  const put = await handler(new Request("https://example.test/functions/v1/haccp-upload?t=" + TOKEN, {
    method: "PUT",
    headers: { origin: "https://ai.banhmique.vn" },
  }));
  assert.equal(put.status, 405);
});
