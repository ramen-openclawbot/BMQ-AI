// kho-review-read-line — read one candidate receipt line from its photo.
//
// The caller's JWT is used only to authenticate and to call
// public.kho_review_line_context(receipt_item_id) as that user, so the database
// gate decides who may review.  Images are downloaded with the service client;
// the OCR cache is read/written with the service client.  This function never
// links a receipt line, creates an item or writes a ledger movement.

import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import {
  KHO_REVIEW_READ_LINE_MAX_IMAGES,
  KhoReviewReadLineError,
  createKhoReviewReadLineHandler,
  type KhoReviewLineContext,
  type KhoReviewLineReadCacheRow,
  type KhoReviewReadImage,
} from "./handler.ts";
import {
  downloadReceiptImages,
  type ReceiptStorageClient,
} from "../_shared/receipt-images.ts";
import {
  callIndraOcr,
  readIndraOcrConfig,
  type IndraOcrConfig,
} from "../_shared/indra-ocr.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function adminClient() {
  if (!serviceRole) throw new KhoReviewReadLineError("request_failed", 503);
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "";
  const record = error as { message?: unknown; details?: unknown; hint?: unknown };
  return [record.message, record.details, record.hint]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ");
}

function indraConfig(): IndraOcrConfig {
  return readIndraOcrConfig();
}

Deno.serve(createKhoReviewReadLineHandler({
  authenticate: async (request, signal) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) {
      throw new KhoReviewReadLineError("unauthorized", 401);
    }
    const db = createClient(url, anon, {
      global: {
        headers: { Authorization: authorization },
        fetch: (input, init) => fetch(input, { ...init, signal }),
      },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error } = await db.auth.getUser(authorization.slice(7));
    if (error || !user) throw new KhoReviewReadLineError("unauthorized", 401);

    return {
      userId: user.id,
      loadContext: async (receiptItemId: string): Promise<KhoReviewLineContext> => {
        const { data, error: rpcError } = await db
          .rpc("kho_review_line_context", { p_receipt_item_id: receiptItemId })
          .abortSignal(signal);
        if (rpcError) {
          const text = errorText(rpcError);
          if (text.includes("kho_review_forbidden")) {
            throw new KhoReviewReadLineError("forbidden", 403);
          }
          if (text.includes("goods_receipt_item_not_found")) {
            throw new KhoReviewReadLineError("not_found", 404);
          }
          throw new KhoReviewReadLineError("request_failed", 503);
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw new KhoReviewReadLineError("not_found", 404);
        }
        return data as KhoReviewLineContext;
      },
    };
  },
  loadImages: async (context): Promise<KhoReviewReadImage[]> => {
    const admin = adminClient();
    const photos = Array.isArray(context.product_photos)
      ? context.product_photos.filter((value): value is string => typeof value === "string")
      : [];
    const images = await downloadReceiptImages(
      admin as unknown as ReceiptStorageClient,
      typeof context.image_url === "string" ? context.image_url : null,
      photos,
      KHO_REVIEW_READ_LINE_MAX_IMAGES,
    );
    return images.map((image) => ({ base64: image.base64, mimeType: image.mime }));
  },
  loadCached: async ({ receiptItemId, imagesSha, promptVersion }) => {
    const { data, error } = await adminClient()
      .from("kho_review_line_reads")
      .select("result, ocr_engine")
      .eq("receipt_item_id", receiptItemId)
      .eq("images_sha", imagesSha)
      .eq("prompt_version", promptVersion)
      .maybeSingle();
    if (error) throw new KhoReviewReadLineError("request_failed", 503);
    if (!data) return null;
    const row = data as { result?: unknown; ocr_engine?: unknown };
    if (!row.result || typeof row.result !== "object" || Array.isArray(row.result)) {
      return null;
    }
    const cached: KhoReviewLineReadCacheRow = {
      result: row.result as Record<string, unknown>,
      ocr_engine: typeof row.ocr_engine === "string" ? row.ocr_engine : null,
    };
    return cached;
  },
  saveCached: async ({
    receiptItemId,
    imagesSha,
    promptVersion,
    result,
    ocrEngine,
    userId,
  }) => {
    const { error } = await adminClient()
      .from("kho_review_line_reads")
      .upsert({
        receipt_item_id: receiptItemId,
        images_sha: imagesSha,
        prompt_version: promptVersion,
        result,
        ocr_engine: ocrEngine,
        created_by: userId,
      }, { onConflict: "receipt_item_id,images_sha,prompt_version" });
    if (error) throw new KhoReviewReadLineError("request_failed", 503);
  },
  indraConfig,
  callIndraOcr,
  audit: (event) => console.info(JSON.stringify(event)),
}));
