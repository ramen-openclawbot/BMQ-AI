// scan-lot-label — read NSX / HSD / lot / manufacturer from a package label.
//
// The caller's JWT only authenticates them.  The image is downloaded with the
// service client from the private warehouse-photos or invoices bucket (or sent
// inline as base64).  This function never writes a receipt line, an item or a
// ledger movement; the UI saves the result through kho_set_receipt_line_lot.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  ScanLotLabelError,
  createScanLotLabelHandler,
  imageMimeFromPath,
  parseScanImagePath,
  type ScanLotLabelImage,
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
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function adminClient() {
  if (!serviceRole) throw new ScanLotLabelError("request_failed", 503);
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function indraConfig(): IndraOcrConfig {
  return readIndraOcrConfig();
}

Deno.serve(createScanLotLabelHandler({
  authenticate: async (request, signal) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      throw new ScanLotLabelError("unauthorized", 401);
    }
    const db = createClient(url, anon, {
      global: {
        headers: { Authorization: authorization },
        fetch: (input, init) => fetch(input, { ...init, signal }),
      },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new ScanLotLabelError("unauthorized", 401);
    return { userId: user.id };
  },
  loadImageFromPath: async (path, signal): Promise<ScanLotLabelImage | null> => {
    const parsed = parseScanImagePath(path);
    if (!parsed) return null;

    const admin = adminClient();
    const fallbackBucket = parsed.bucket === "warehouse-photos" ? "invoices" : "warehouse-photos";
    for (const bucket of [parsed.bucket, fallbackBucket] as const) {
      if (signal.aborted) return null;
      try {
        const { data, error } = await admin.storage.from(bucket).download(parsed.path);
        if (error || !data) continue;
        const bytes = new Uint8Array(await data.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) continue;
        return {
          base64: encodeBase64(bytes),
          mimeType: data.type || imageMimeFromPath(parsed.path),
        };
      } catch {
        continue;
      }
    }
    return null;
  },
  indraConfig,
  callIndraOcr,
  audit: (event) => console.info(JSON.stringify(event)),
}));
