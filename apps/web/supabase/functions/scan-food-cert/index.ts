// scan-food-cert — read a Vietnamese food-safety certificate photo/PDF.
//
// The caller's JWT only authenticates them and the kho_item_can_edit gate is
// checked through the RPC.  The file may be inline base64 or an object in the
// private food-safety-docs bucket, downloaded with the service client.  This
// function never inserts a certificate; the UI saves the result as 'pending'
// through food_cert_upload_pending.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  ScanFoodCertError,
  certMimeFromPath,
  createScanFoodCertHandler,
  type ScanFoodCertFile,
  type ScanFoodCertMatch,
  type ScanFoodCertParty,
} from "./handler.ts";
import { encodeBase64 } from "../_shared/receipt-images.ts";
import {
  callIndraOcr,
  readIndraOcrConfig,
  type IndraOcrConfig,
} from "../_shared/indra-ocr.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function adminClient() {
  if (!serviceRole) throw new ScanFoodCertError("request_failed", 503);
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function indraConfig(): IndraOcrConfig {
  return readIndraOcrConfig();
}

/**
 * Resolve a storage path to the private food-safety-docs bucket.  Accepts a
 * bare certs/... path, food-safety-docs/certs/..., or a Supabase object URL.
 */
export function parseFoodCertPath(raw: string): string | null {
  const input = String(raw ?? "").trim();
  if (!input) return null;

  let candidate = input;
  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      const marker = "/storage/v1/object/";
      const index = parsed.pathname.indexOf(marker);
      if (index < 0) return null;
      const parts = parsed.pathname.slice(index + marker.length).split("/").filter(Boolean);
      if (parts.length < 3 || !["public", "sign", "authenticated"].includes(parts[0])) {
        return null;
      }
      if (parts[1] !== "food-safety-docs") return null;
      candidate = `food-safety-docs/${decodeURIComponent(parts.slice(2).join("/"))}`;
    } catch {
      return null;
    }
  }

  candidate = candidate.split("?")[0].split("#")[0].replace(/^\/+/, "");
  if (!candidate || candidate.includes("..")) return null;

  if (candidate.startsWith("food-safety-docs/")) {
    const path = candidate.slice("food-safety-docs/".length);
    return path.startsWith("certs/") ? path : null;
  }
  return candidate.startsWith("certs/") ? candidate : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function partyList(value: unknown): ScanFoodCertParty[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((row) => ({ id: String(row.id ?? ""), name: String(row.name ?? "") }))
    .filter((row) => row.id !== "" && row.name !== "");
}

Deno.serve(createScanFoodCertHandler({
  authenticate: async (request, signal) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      throw new ScanFoodCertError("unauthorized", 401);
    }
    const db = createClient(url, anon, {
      global: {
        headers: { Authorization: authorization },
        fetch: (input, init) => fetch(input, { ...init, signal }),
      },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new ScanFoodCertError("unauthorized", 401);
    return { userId: user.id };
  },
  checkGate: async (userId) => {
    const admin = adminClient();
    const { data, error } = await admin.rpc("kho_item_can_edit", { p_actor: userId });
    if (error) return false;
    return data === true;
  },
  loadFileFromPath: async (path, signal): Promise<ScanFoodCertFile | null> => {
    const storagePath = parseFoodCertPath(path);
    if (!storagePath) return null;
    if (signal.aborted) return null;

    try {
      const admin = adminClient();
      const { data, error } = await admin.storage.from("food-safety-docs").download(storagePath);
      if (error || !data) return null;
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) return null;
      return {
        base64: encodeBase64(bytes),
        mimeType: data.type || certMimeFromPath(storagePath),
      };
    } catch {
      return null;
    }
  },
  loadParties: async () => {
    const admin = adminClient();
    const [manufacturers, suppliers] = await Promise.all([
      admin.from("food_manufacturers").select("id,name").limit(5000),
      admin.from("suppliers").select("id,name").limit(5000),
    ]);
    return {
      manufacturers: partyList(manufacturers.data),
      suppliers: partyList(suppliers.data),
    };
  },
  loadSuggestedItems: async (match: ScanFoodCertMatch) => {
    const admin = adminClient();
    const { data, error } = await admin.rpc("kho_attp_checklist", { p_days: 180 });
    if (error || !isRecord(data)) return [];

    const ids = new Set<string>();
    if (match.kind === "supplier") {
      const rows = Array.isArray(data.suppliers) ? data.suppliers : [];
      for (const supplier of rows) {
        if (!isRecord(supplier) || String(supplier.supplier_id ?? "") !== match.id) continue;
        const items = Array.isArray(supplier.items) ? supplier.items : [];
        for (const item of items) {
          if (isRecord(item) && item.item_id) ids.add(String(item.item_id));
        }
      }
    } else {
      const rows = Array.isArray(data.items_by_item) ? data.items_by_item : [];
      for (const item of rows) {
        if (!isRecord(item) || String(item.manufacturer_id ?? "") !== match.id) continue;
        if (item.item_id) ids.add(String(item.item_id));
      }
    }
    return [...ids];
  },
  indraConfig,
  callIndraOcr,
  audit: (event) => console.info(JSON.stringify(event)),
}));
