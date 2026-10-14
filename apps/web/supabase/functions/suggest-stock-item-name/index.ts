// suggest-stock-item-name — tên chuẩn đầy đủ cho mặt hàng mới.
//
// The handler authenticates the caller and checks the same stock gate as
// public.get_crate_receipt_lines (owner or Q7 stock admin via
// public.material_alias_can_admin). It resolves one goods receipt line either by
// { goods_receipt_item_id } or by the pending crate key
// { location, supplier_id, normalized_name } (newest line that has an image),
// then:
//   1. returns the cached public.stock_item_name_suggestions row when present;
//   2. downloads the delivery-note / invoice image(s) from the same 'invoices'
//      bucket / path contract the Kho 2D game uses (goods_receipts.image_url,
//      goods_receipts.product_photos);
//   3. asks the vision model (getScanAiConfig) to transcribe the printed lines;
//   4. picks the matching line with pure code (match.ts pickInvoiceLine).
//
// A confident pick is cached (service role upsert) and returned with
// source "invoice_image"; no match returns { suggestion: null, reason } and
// writes nothing. AI failures use the shared classified error body.

import { encode as encodeBase64 } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getScanAiConfig } from "../_shared/ai-vision-provider.ts";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { aiErrorJson, classifyOpenAIError } from "../_shared/openai-errors.ts";
import { buildSuggestion, MAX_LINE_SCORE, pickInvoiceLine, type InvoiceLine } from "./match.ts";

const MAX_IMAGES = 2;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// Mirrors src/lib/storage-url.ts: preferred bucket first, then the legacy
// candidates, plus the legacy "bucket/path" and bare-filename prefixes.
const IMAGE_BUCKETS = ["invoices", "purchase-orders", "payment-slips", "payment-requests"];
const LEGACY_PATH_PREFIXES = ["payment-requests/", "payment-slips/", "purchase-orders/", "invoices/"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface DownloadedImage {
  base64: string;
  mimeType: string;
}

interface ReceiptLine {
  id: string;
  raw_name: string;
  quantity: number | null;
  unit: string | null;
  unit_price: number | null;
  image_url: string | null;
  product_photos: string[];
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseStorageUrl(raw: string): { bucket: string; path: string } | null {
  try {
    const url = new URL(raw);
    const marker = "/storage/v1/object/";
    const idx = url.pathname.indexOf(marker);
    if (idx < 0) return null;
    const parts = url.pathname.slice(idx + marker.length).split("/").filter(Boolean);
    if (parts.length < 3) return null;
    if (!["public", "sign", "authenticated"].includes(parts[0])) return null;
    const bucket = parts[1];
    const path = decodeURIComponent(parts.slice(2).join("/"));
    return bucket && path ? { bucket, path } : null;
  } catch {
    return null;
  }
}

/** Every (bucket, path) the raw value could point at, preferred first. */
function imageSources(rawValue: string): Array<{ bucket: string; path: string }> {
  const input = String(rawValue ?? "").trim();
  if (!input) return [];
  if (/^https?:\/\//i.test(input)) {
    const parsed = parseStorageUrl(input);
    return parsed ? [parsed] : [];
  }
  const cleaned = input.split("?")[0].split("#")[0].replace(/^\/+/, "");
  if (!cleaned) return [];

  const seen = new Set<string>();
  const sources: Array<{ bucket: string; path: string }> = [];
  const add = (bucket: string, path: string) => {
    if (!path) return;
    const key = `${bucket}\u0000${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({ bucket, path });
  };
  for (const bucket of IMAGE_BUCKETS) {
    add(bucket, cleaned);
    const prefix = `${bucket}/`;
    if (cleaned.startsWith(prefix)) add(bucket, cleaned.slice(prefix.length));
    if (!cleaned.includes("/")) {
      for (const legacy of LEGACY_PATH_PREFIXES) add(bucket, `${legacy}${cleaned}`);
    }
  }
  return sources;
}

async function downloadOne(
  supabase: ReturnType<typeof createClient>,
  rawValue: string,
): Promise<DownloadedImage | null> {
  for (const { bucket, path } of imageSources(rawValue)) {
    try {
      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error || !data) continue;
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) continue;
      return { base64: encodeBase64(bytes), mimeType: data.type || "image/jpeg" };
    } catch {
      continue;
    }
  }
  return null;
}

async function downloadReceiptImages(
  supabase: ReturnType<typeof createClient>,
  imageUrl: string | null,
  productPhotos: string[],
): Promise<DownloadedImage[]> {
  const raws = [imageUrl, ...(Array.isArray(productPhotos) ? productPhotos : [])]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
  const unique = [...new Set(raws.map((value) => value.trim()))];
  const images: DownloadedImage[] = [];
  for (const raw of unique) {
    if (images.length >= MAX_IMAGES) break;
    const image = await downloadOne(supabase, raw);
    if (image) images.push(image);
  }
  return images;
}

/** Load one receipt line plus its parent receipt image evidence. */
async function loadReceiptLine(
  supabase: ReturnType<typeof createClient>,
  itemId: string,
): Promise<ReceiptLine | null> {
  const { data: item, error } = await supabase
    .from("goods_receipt_items")
    .select(
      "id, product_name, raw_product_name, quantity, actual_quantity, ordered_quantity, unit, unit_price, goods_receipts(id, status, image_url, product_photos)",
    )
    .eq("id", itemId)
    .maybeSingle();
  if (error || !item) return null;

  const receipt = (item as Record<string, unknown>).goods_receipts as Record<string, unknown> | null;
  if (!receipt) return null;

  const { data: effective } = await supabase.rpc("goods_receipt_effective_quantity", {
    p_actual: toFiniteNumber((item as Record<string, unknown>).actual_quantity),
    p_quantity: toFiniteNumber((item as Record<string, unknown>).quantity),
    p_ordered: toFiniteNumber((item as Record<string, unknown>).ordered_quantity),
    p_status: typeof receipt.status === "string" ? receipt.status : null,
  });

  const rawName = String(
    (item as Record<string, unknown>).raw_product_name ??
      (item as Record<string, unknown>).product_name ??
      "",
  ).trim();
  const productPhotos = Array.isArray(receipt.product_photos)
    ? (receipt.product_photos as unknown[]).filter((value): value is string => typeof value === "string")
    : [];

  return {
    id: String((item as Record<string, unknown>).id),
    raw_name: rawName,
    quantity: toFiniteNumber(effective) ??
      toFiniteNumber((item as Record<string, unknown>).actual_quantity) ??
      toFiniteNumber((item as Record<string, unknown>).quantity) ??
      toFiniteNumber((item as Record<string, unknown>).ordered_quantity),
    unit: typeof (item as Record<string, unknown>).unit === "string"
      ? ((item as Record<string, unknown>).unit as string).trim() || null
      : null,
    unit_price: toFiniteNumber((item as Record<string, unknown>).unit_price),
    image_url: typeof receipt.image_url === "string" ? receipt.image_url : null,
    product_photos: productPhotos,
  };
}

/** Newest crate line that has an image; the RPC raises 'forbidden' for non-admins. */
async function findCrateLineId(
  userSupabase: ReturnType<typeof createClient>,
  location: string,
  supplierId: string | null,
  normalizedName: string,
): Promise<string | null> {
  const { data, error } = await userSupabase.rpc("get_crate_receipt_lines", {
    p_location: location,
    p_supplier_id: supplierId,
    p_normalized_name: normalizedName,
    p_limit: 20,
  });
  if (error) throw error;
  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  for (const row of rows) {
    const imagePath = typeof row.image_path === "string" ? row.image_path.trim() : "";
    const photoPaths = Array.isArray(row.photo_paths)
      ? row.photo_paths.filter((value): value is string => typeof value === "string" && value.trim() !== "")
      : [];
    if (imagePath || photoPaths.length > 0) {
      return typeof row.goods_receipt_item_id === "string" ? row.goods_receipt_item_id : null;
    }
  }
  return null;
}

/** Normalize the printed unit through public.normalize_stock_unit (kg -> g, l -> ml). */
async function resolveStockUnit(
  supabase: ReturnType<typeof createClient>,
  rawUnit: string | null,
): Promise<string | null> {
  const unit = String(rawUnit ?? "").trim();
  if (!unit) return null;
  const { data, error } = await supabase.rpc("normalize_stock_unit", { p_unit: unit });
  if (error || typeof data !== "string" || data.trim() === "") return unit;
  return data;
}

function parseInvoiceLines(items: unknown[]): InvoiceLine[] {
  return items
    .map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      return {
        product_name: typeof item.product_name === "string" ? item.product_name : "",
        quantity: toFiniteNumber(item.quantity),
        unit: typeof item.unit === "string" ? item.unit : null,
        unit_price: toFiniteNumber(item.unit_price),
      };
    })
    .filter((line) => line.product_name.trim() !== "");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json(req, { error: "Invalid JSON body" }, 400);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json(req, { error: "Missing authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const scanAi = getScanAiConfig();
    if (!scanAi.apiKey) {
      return json(req, { error: `AI service not configured (${scanAi.keyName})` }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const userSupabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    }) as unknown as ReturnType<typeof createClient>;

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return json(req, { error: "Invalid token" }, 401);
    }

    // Owner or Q7 stock admin, exactly like get_crate_receipt_lines.
    const { data: canAdmin, error: permissionError } = await userSupabase.rpc(
      "material_alias_can_admin",
      { p_actor_id: user.id },
    );
    if (permissionError) {
      console.error("[suggest-stock-item-name] permission check failed:", permissionError);
      return json(req, { error: "Unable to verify stock permissions" }, 500);
    }
    if (canAdmin !== true) {
      return json(req, { error: "Forbidden: Q7 stock admin permission required" }, 403);
    }

    const itemIdInput = typeof body.goods_receipt_item_id === "string"
      ? body.goods_receipt_item_id.trim()
      : "";
    const location = typeof body.location === "string" ? body.location : "";
    const supplierId = typeof body.supplier_id === "string" ? body.supplier_id : null;
    const normalizedName = typeof body.normalized_name === "string" ? body.normalized_name.trim() : "";

    let itemId: string | null = null;
    if (itemIdInput) {
      if (!UUID_RE.test(itemIdInput)) {
        return json(req, { error: "Invalid goods_receipt_item_id" }, 400);
      }
      itemId = itemIdInput;
    } else if (location && normalizedName) {
      if (!["q7", "tan_tao"].includes(location)) {
        return json(req, { error: "Unsupported location" }, 400);
      }
      if (supplierId !== null && !UUID_RE.test(supplierId)) {
        return json(req, { error: "Invalid supplier_id" }, 400);
      }
      try {
        itemId = await findCrateLineId(userSupabase, location, supplierId, normalizedName);
      } catch (crateError) {
        console.error("[suggest-stock-item-name] crate lookup failed:", crateError);
        return json(req, { error: "Unable to load crate receipt lines" }, 500);
      }
      if (!itemId) {
        return json(req, { suggestion: null, reason: "no_image" });
      }
    } else {
      return json(
        req,
        { error: "goods_receipt_item_id or location + normalized_name is required" },
        400,
      );
    }

    const line = await loadReceiptLine(supabase, itemId);
    if (!line) {
      return json(req, { error: "Goods receipt line not found" }, 404);
    }

    // Cache hit: no AI call, no image download.
    const { data: cached } = await supabase
      .from("stock_item_name_suggestions")
      .select("full_name, unit, confidence")
      .eq("goods_receipt_item_id", line.id)
      .maybeSingle();
    if (cached) {
      return json(req, {
        suggestion: {
          full_name: cached.full_name,
          unit: cached.unit,
          confidence: toFiniteNumber(cached.confidence) ?? 0,
          source: "cache",
        },
      });
    }

    const images = await downloadReceiptImages(supabase, line.image_url, line.product_photos);
    if (images.length === 0) {
      return json(req, { suggestion: null, reason: "no_image" });
    }

    const systemPrompt = `Bạn là chuyên gia đọc hóa đơn / phiếu giao hàng tiếng Việt.
Nhiệm vụ: chép NGUYÊN VĂN tên hàng in trên chứng từ, đầy đủ quy cách (quy cách, thể tích, khối lượng, nồng độ... in kèm tên), kèm số lượng, đơn vị tính và đơn giá của từng dòng.

Trả về DUY NHẤT JSON đúng định dạng:
{
  "items": [
    {"product_name": "string", "quantity": number, "unit": "string", "unit_price": number or null}
  ]
}

Quy tắc:
- product_name: chép y nguyên chữ in trên chứng từ, KHÔNG viết tắt, KHÔNG bỏ quy cách.
- Giữ tên hàng bằng tiếng Việt.
- quantity và unit_price là số; đơn giá theo đơn vị tính của dòng; nếu không thấy đơn giá trả null.
- Đơn vị thường gặp: kg, g, con, cái, hộp, thùng, chai, lon, gói, bịch, túi, lít, ml, bao, cuộn.
- Nếu ảnh không có bảng hàng thì trả {"items": []}.`;

    const aiResponse = await fetch(scanAi.endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${scanAi.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: scanAi.model,
        ...scanAi.extraBody,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: "Đọc chứng từ và trích các dòng hàng:" },
              ...images.map((image) => ({
                type: "image_url",
                image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
              })),
            ],
          },
        ],
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      const info = classifyOpenAIError(aiResponse.status, errorText);
      console.error(
        `[suggest-stock-item-name] AI API error kind=${info.kind}:`,
        aiResponse.status,
        errorText.slice(0, 300),
      );
      return json(req, aiErrorJson(info), info.httpStatus);
    }

    const aiData = await aiResponse.json();
    const aiContent = String(aiData?.choices?.[0]?.message?.content ?? "");
    let extractedItems: unknown[] = [];
    try {
      const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { items?: unknown };
        extractedItems = Array.isArray(parsed.items) ? parsed.items : [];
      }
    } catch (parseError) {
      console.error("[suggest-stock-item-name] failed to parse AI response:", parseError);
    }

    const picked = pickInvoiceLine(
      {
        name: line.raw_name,
        quantity: line.quantity,
        unit: line.unit,
        unit_price: line.unit_price,
      },
      parseInvoiceLines(extractedItems),
    );
    if (!picked) {
      return json(req, { suggestion: null, reason: "no_match" });
    }

    const built = buildSuggestion(picked.line);
    const unit = await resolveStockUnit(supabase, built.unit);
    const confidence = Math.round(Math.min(1, picked.score / MAX_LINE_SCORE) * 10000) / 10000;

    const { error: cacheError } = await supabase
      .from("stock_item_name_suggestions")
      .upsert({
        goods_receipt_item_id: line.id,
        full_name: built.full_name,
        unit,
        confidence,
        model: scanAi.model,
        created_at: new Date().toISOString(),
      }, { onConflict: "goods_receipt_item_id" });
    if (cacheError) {
      console.error("[suggest-stock-item-name] failed to cache suggestion:", cacheError);
    }

    return json(req, {
      suggestion: {
        full_name: built.full_name,
        unit,
        confidence,
        source: "invoice_image",
      },
    });
  } catch (error) {
    console.error("[suggest-stock-item-name] unexpected error:", error);
    return json(req, { error: "Không thể đọc ảnh hóa đơn. Vui lòng thử lại." }, 500);
  }
});
