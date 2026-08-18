import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { checkAndRecordRateLimit, getRateLimitHeaders } from "../_shared/rate-limiter.ts";
import { resolveCanonicalMaterialForLine, MaterialControllerResult } from "../_shared/material-controller.ts";
// Task 5 contract marker: match-delivery-note keeps nameSimilarity for PO quantity assistance,
// but canonical_material_id/resolved_exact must come from resolve_canonical_material only.

interface ExtractedItem {
  product_name: string;
  product_code?: string | null;
  quantity: number;
  unit: string;
  package_quantity?: number | null;
  package_unit?: string | null;
  unit_price?: number;
}

interface MatchItem {
  deliveryName: string;
  raw_product_name?: string;
  raw_product_code?: string | null;
  deliveryQty: number;
  deliveryUnit: string;
  raw_package_quantity?: number | null;
  raw_package_unit?: string | null;
  matchedItemId?: string;
  matchedName?: string;
  matchedQty?: number;
  matchedUnit?: string;
  lineIdentityExact?: boolean;
  status: "match" | "mismatch" | "extra" | "missing";
  canonical_material_id?: string | null;
  canonical_material_code?: string | null;
  canonical_material_name?: string | null;
  canonical_default_unit?: string | null;
  material_resolution_status?: string | null;
  material_resolution_request_id?: string | null;
  resolved_exact?: boolean;
  blockers?: string[];
  candidate_names?: string[];
}

interface CandidateLine {
  id: string;
  product_name: string;
  quantity: number;
  unit?: string | null;
  unit_price?: number | null;
  purchase_order_item_id?: string | null;
}

interface PendingReceiptCandidate {
  id: string;
  receipt_number: string;
  purchase_order_id: string | null;
  supplier_id: string | null;
  image_url: string | null;
  suppliers?: { id: string; name: string } | null;
  purchase_orders?: { id: string; po_number: string; title?: string | null } | null;
  goods_receipt_items?: Array<{
    id: string;
    product_name: string;
    ordered_quantity: number | null;
    quantity: number | null;
    unit: string | null;
    unit_price: number | null;
    purchase_order_item_id: string | null;
  }>;
}

interface CandidateMatch<T> {
  candidate: T;
  score: number;
  items: MatchItem[];
}

// Remove Vietnamese diacritics for fuzzy matching
function removeDiacritics(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Normalize unit for comparison
function normalizeUnit(unit: string): string {
  const normalized = removeDiacritics(unit);
  const unitMap: Record<string, string> = {
    "kg": "kg",
    "kilo": "kg",
    "kilogram": "kg",
    "g": "g",
    "gram": "g",
    "lit": "l",
    "liter": "l",
    "litre": "l",
    "l": "l",
    "ml": "ml",
    "con": "con",
    "cai": "cai",
    "qua": "cai",
    "hop": "hop",
    "thung": "thung",
    "chai": "chai",
    "lon": "lon",
    "goi": "goi",
    "bich": "bich",
    "tui": "tui",
    "bo": "bo",
    "pcs": "cai",
    "pc": "cai",
  };
  return unitMap[normalized] || normalized;
}

// Calculate string similarity (Levenshtein distance based)
function similarity(s1: string, s2: string): number {
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  
  if (longer.length === 0) return 1.0;
  
  const costs: number[] = [];
  for (let i = 0; i <= shorter.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= longer.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (shorter.charAt(i - 1) !== longer.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[longer.length] = lastValue;
  }
  
  return (longer.length - costs[longer.length]) / longer.length;
}

// Check if quantities match within tolerance
function quantityMatches(q1: number, q2: number, tolerance = 0.05): boolean {
  const diff = Math.abs(q1 - q2);
  const max = Math.max(q1, q2);
  if (max === 0) return true;
  return diff / max <= tolerance;
}

function toReceiptCandidateLines(receipt: PendingReceiptCandidate): CandidateLine[] {
  return (receipt.goods_receipt_items || []).map((item) => ({
    id: item.id,
    product_name: item.product_name,
    quantity: Number(item.ordered_quantity ?? item.quantity ?? 0),
    unit: item.unit,
    unit_price: item.unit_price,
    purchase_order_item_id: item.purchase_order_item_id,
  }));
}

function matchExtractedItemsToCandidateLines(
  extractedItems: ExtractedItem[],
  candidateItems: CandidateLine[],
): { matchedCount: number; matchItems: MatchItem[] } {
  const matchItems: MatchItem[] = [];
  let matchedCount = 0;
  const usedCandidateItemIds = new Set<string>();

  for (const extracted of extractedItems) {
    const normalizedExtracted = removeDiacritics(extracted.product_name);
    const normalizedExtractedUnit = normalizeUnit(extracted.unit);

    let bestItemMatch: {
      item: CandidateLine;
      nameSimilarity: number;
    } | null = null;

    for (const candidateItem of candidateItems) {
      if (usedCandidateItemIds.has(candidateItem.id)) continue;

      const normalizedCandidateName = removeDiacritics(candidateItem.product_name);
      const nameSimilarity = similarity(normalizedExtracted, normalizedCandidateName);

      if (nameSimilarity > 0.6 && (!bestItemMatch || nameSimilarity > bestItemMatch.nameSimilarity)) {
        bestItemMatch = { item: candidateItem, nameSimilarity };
      }
    }

    if (bestItemMatch) {
      usedCandidateItemIds.add(bestItemMatch.item.id);
      const normalizedCandidateUnit = normalizeUnit(bestItemMatch.item.unit || "");
      const unitMatch = normalizedExtractedUnit === normalizedCandidateUnit;
      const lineIdentityExact = normalizedExtracted === removeDiacritics(bestItemMatch.item.product_name) && unitMatch;
      const qtyMatch = quantityMatches(extracted.quantity, Number(bestItemMatch.item.quantity || 0));

      matchItems.push({
        deliveryName: extracted.product_name.trim(),
        raw_product_name: extracted.product_name.trim(),
        raw_product_code: extracted.product_code || null,
        deliveryQty: extracted.quantity,
        deliveryUnit: extracted.unit,
        raw_package_quantity: extracted.package_quantity ?? null,
        raw_package_unit: extracted.package_unit ?? null,
        matchedItemId: bestItemMatch.item.id,
        matchedName: bestItemMatch.item.product_name,
        matchedQty: Number(bestItemMatch.item.quantity || 0),
        matchedUnit: bestItemMatch.item.unit || "",
        lineIdentityExact,
        status: unitMatch && qtyMatch ? "match" : "mismatch",
      });

      if (unitMatch && qtyMatch) matchedCount++;
    } else {
      matchItems.push({
        deliveryName: extracted.product_name.trim(),
        raw_product_name: extracted.product_name.trim(),
        raw_product_code: extracted.product_code || null,
        deliveryQty: extracted.quantity,
        deliveryUnit: extracted.unit,
        raw_package_quantity: extracted.package_quantity ?? null,
        raw_package_unit: extracted.package_unit ?? null,
        status: "extra",
      });
    }
  }

  for (const candidateItem of candidateItems) {
    if (!usedCandidateItemIds.has(candidateItem.id)) {
      matchItems.push({
        deliveryName: candidateItem.product_name,
        deliveryQty: Number(candidateItem.quantity || 0),
        deliveryUnit: candidateItem.unit || "",
        status: "missing",
      });
    }
  }

  return { matchedCount, matchItems };
}

function scoreCandidate<T>(
  candidate: T,
  supplierName: string,
  candidateSupplierName: string,
  candidateItems: CandidateLine[],
  extractedItems: ExtractedItem[],
): CandidateMatch<T> | null {
  const normalizedSupplierName = removeDiacritics(supplierName || "");
  const normalizedCandidateSupplierName = removeDiacritics(candidateSupplierName || "");
  const supplierSimilarity = normalizedSupplierName
    ? similarity(normalizedSupplierName, normalizedCandidateSupplierName)
    : 0.5;

  if (supplierSimilarity < 0.5) return null;

  const { matchedCount, matchItems } = matchExtractedItemsToCandidateLines(extractedItems, candidateItems);
  const totalItems = Math.max(extractedItems.length, candidateItems.length, 1);
  const score = (matchedCount / totalItems) * supplierSimilarity;
  return { candidate, score, items: matchItems };
}

function findBestPendingReceiptMatch(
  receipts: PendingReceiptCandidate[],
  supplierName: string,
  extractedItems: ExtractedItem[],
): CandidateMatch<PendingReceiptCandidate> | null {
  let bestMatch: CandidateMatch<PendingReceiptCandidate> | null = null;

  for (const receipt of receipts) {
    const candidateItems = toReceiptCandidateLines(receipt);
    const candidateSupplierName = (receipt.suppliers as any)?.name || "";
    const scored = scoreCandidate(receipt, supplierName, candidateSupplierName, candidateItems, extractedItems);
    if (scored && (!bestMatch || scored.score > bestMatch.score)) {
      bestMatch = scored;
    }
  }

  return bestMatch;
}

async function attachMaterialResolutionToReceiptMatch(
  controllerClient: ReturnType<typeof createClient>,
  receipt: PendingReceiptCandidate,
  items: MatchItem[],
): Promise<MatchItem[]> {
  return Promise.all(items.map(async (item) => {
    if (!item.matchedItemId || item.status === "missing") return item;
    // Fuzzy delivery-note line matching is quantity assistance only. Never bind
    // canonical identity or create a source-line request until name+unit identity
    // is deterministic against the persisted GR item.
    if (!item.lineIdentityExact) {
      return {
        ...item,
        canonical_material_id: null,
        canonical_material_code: null,
        canonical_material_name: null,
        canonical_default_unit: null,
        material_resolution_status: "confirmation_needed",
        material_resolution_request_id: null,
        resolved_exact: false,
        blockers: ["delivery_note_line_identity_not_exact"],
        candidate_names: [],
      };
    }
    const resolution: MaterialControllerResult = await resolveCanonicalMaterialForLine(controllerClient, {
      source_type: "match_delivery_note",
      source_table: "goods_receipt_items",
      source_id: receipt.id,
      source_line_id: item.matchedItemId,
      supplier_id: receipt.supplier_id,
      raw_name: item.raw_product_name || item.deliveryName,
      raw_code: item.raw_product_code || null,
      raw_unit: item.deliveryUnit,
      payload: { candidate_source: "delivery_note_ocr", confidence: "pending", field_name: "goods_receipt_item_material" },
      applyExactToGoodsReceiptItem: true,
    });
    return {
      ...item,
      canonical_material_id: resolution.canonical_material_id,
      canonical_material_code: resolution.canonical_material_code,
      canonical_material_name: resolution.canonical_material_name,
      canonical_default_unit: resolution.canonical_default_unit,
      material_resolution_status: resolution.material_resolution_status,
      material_resolution_request_id: resolution.material_resolution_request_id,
      resolved_exact: resolution.resolved_exact,
      blockers: resolution.blockers,
      candidate_names: resolution.candidate_names,
    };
  }));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  try {
    const { deliveryImage, deliveryNotePath, receiptId } = await req.json();

    if (!deliveryImage) {
      return new Response(
        JSON.stringify({ error: "Missing delivery image" }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }
    if (!receiptId || !deliveryNotePath) {
      return new Response(
        JSON.stringify({ error: "Receipt and persisted delivery-note path are required" }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // Get auth token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");

    if (!openaiApiKey) {
      return new Response(
        JSON.stringify({ error: "AI service not configured" }),
        { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const userSupabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    }) as unknown as ReturnType<typeof createClient>;

    // Verify user token
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const [{ data: roleRows, error: roleError }, { data: permissionRows, error: permissionError }] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", user.id),
      supabase.from("user_module_permissions").select("module_key, can_edit").eq("user_id", user.id).eq("module_key", "goods_receipts"),
    ]);

    if (roleError || permissionError) {
      return new Response(
        JSON.stringify({ error: "Unable to verify goods receipt permissions" }),
        { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }
    const isOwner = ((roleRows || []) as Array<{ role: string }>).some((row) => row.role === "owner");
    const hasGoodsReceiptEdit = ((permissionRows || []) as Array<{ module_key: string; can_edit: boolean }>).some((row) => row.module_key === "goods_receipts" && row.can_edit);
    if (!isOwner && !hasGoodsReceiptEdit) {
      return new Response(
        JSON.stringify({ error: "Forbidden: goods_receipts edit permission required" }),
        { status: 403, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // Rate limit: 150 calls/day per user
    const rateLimit = await checkAndRecordRateLimit(user.id, "match-delivery-note", 150);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({ error: "Bạn đã vượt quá giới hạn scan hôm nay. Vui lòng thử lại vào ngày mai.", code: "RATE_LIMIT_EXCEEDED" }),
        { status: 429, headers: { ...getCorsHeaders(req), "Content-Type": "application/json", ...getRateLimitHeaders(rateLimit) } }
      );
    }

    // Extract base64 image data
    const imageData = deliveryImage.includes(",") 
      ? deliveryImage.split(",")[1] 
      : deliveryImage;

    // Call OpenAI to extract delivery note info
    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are an expert at extracting information from Vietnamese delivery notes and invoices.
Extract the following information from the image:
1. Supplier name (nhà cung cấp)
2. List of items with: product name, quantity, purchase unit, package size printed on the document, and unit price (if visible)

Return ONLY valid JSON in this exact format:
{
  "supplier_name": "string",
  "items": [
    {"product_name": "string", "quantity": number, "unit": "string", "package_quantity": number or null, "package_unit": "string or null", "unit_price": number or null}
  ]
}

Important:
- Keep product names in Vietnamese
- Convert all quantities to numbers
- Common units: kg, g, con, cái, hộp, thùng, chai, lon, gói, bịch, túi, lít, ml
- unit is the purchase unit printed for the line (for example Bao, Thùng, kg)
- package_quantity/package_unit are only the explicitly visible size per one purchase unit (for example 25 and kg for "25kg/bao" or a product explicitly named "(25kg)")
- Never infer a package size that is not visibly printed; return null for both package fields when unclear
- If unit price is not visible, set to null
- If supplier name is not clear, set to empty string`
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extract delivery note information from this image:"
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${imageData}`
                }
              }
            ]
          }
        ],
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI API error:", errorText);
      return new Response(
        JSON.stringify({ error: "Failed to process image" }),
        { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const aiData = await aiResponse.json();
    const aiContent = aiData.choices?.[0]?.message?.content || "";
    
    // Parse AI response
    let extractedData: { supplier_name: string; items: ExtractedItem[] };
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }
      extractedData = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error("Failed to parse AI response:", aiContent);
      return new Response(
        JSON.stringify({ error: "Failed to extract information from image" }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const { supplier_name, items: extractedItems } = extractedData;

    if (!extractedItems || extractedItems.length === 0) {
      return new Response(
        JSON.stringify({ 
          isMatched: false,
          matchScore: 0,
          items: [],
          supplierName: supplier_name || "Không xác định",
          error: "Không tìm thấy sản phẩm trong phiếu giao hàng"
        }),
        { headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // The caller selects the receipt explicitly. Never let OCR choose another receipt.
    const { data: pendingReceipts, error: receiptError } = await supabase
      .from("goods_receipts")
      .select(`
        id,
        receipt_number,
        purchase_order_id,
        supplier_id,
        image_url,
        suppliers(id, name),
        purchase_orders(id, po_number, title),
        goods_receipt_items(id, product_name, ordered_quantity, quantity, unit, unit_price, purchase_order_item_id)
      `)
      .eq("id", receiptId)
      .in("status", ["draft", "confirmed"])
      .order("created_at", { ascending: true });

    if (receiptError) {
      console.error("Error fetching pending PO receipt queue:", receiptError);
      return new Response(
        JSON.stringify({ error: "Failed to fetch pending warehouse receipt queue" }),
        { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const bestReceiptMatch = findBestPendingReceiptMatch(
      (pendingReceipts || []) as unknown as PendingReceiptCandidate[],
      supplier_name,
      extractedItems,
    );

    if (bestReceiptMatch) {
      const receipt = bestReceiptMatch.candidate;
      const isMatched = bestReceiptMatch.score >= 0.8;
      if (receiptId && receipt.id !== receiptId) {
        return new Response(
          JSON.stringify({ error: "Matched receipt does not match requested receipt" }),
          { status: 409, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
        );
      }
      if (receipt.image_url !== deliveryNotePath) {
        return new Response(
          JSON.stringify({ error: "Persisted delivery-note evidence does not match requested receipt" }),
          { status: 409, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
        );
      }
      const resolvedItems = await attachMaterialResolutionToReceiptMatch(userSupabase, receipt, bestReceiptMatch.items);
      const documentChecksum = await sha256Hex(deliveryImage);
      const evidenceLines = resolvedItems
        .filter((item) => item.matchedItemId && item.status !== "missing" && item.lineIdentityExact)
        .map((item) => ({
          goods_receipt_item_id: item.matchedItemId,
          raw_product_name: item.raw_product_name || item.deliveryName,
          raw_product_code: item.raw_product_code || null,
          raw_purchase_unit: item.deliveryUnit,
          raw_quantity: item.deliveryQty,
          package_quantity: item.raw_package_quantity ?? null,
          package_unit: item.raw_package_unit ?? null,
        }));
      if (evidenceLines.length > 0) {
        const { error: evidenceError } = await supabase.rpc("record_material_supplier_unit_scan_evidence", {
          p_receipt_id: receipt.id,
          p_document_path: deliveryNotePath,
          p_document_checksum: documentChecksum,
          p_actor_id: user.id,
          p_lines: evidenceLines,
        });
        if (evidenceError) {
          console.error("Failed to persist delivery-note unit evidence", evidenceError);
          return new Response(
            JSON.stringify({ error: "Failed to persist delivery-note unit evidence" }),
            { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
          );
        }
      }

      return new Response(
        JSON.stringify({
          isMatched,
          matchScore: bestReceiptMatch.score,
          matchSource: "purchase_order_receipt",
          goodsReceiptId: receipt.id,
          receiptNumber: receipt.receipt_number,
          purchaseOrderId: receipt.purchase_order_id,
          poNumber: (receipt.purchase_orders as any)?.po_number,
          poTitle: (receipt.purchase_orders as any)?.title,
          supplierId: receipt.supplier_id,
          supplierName: (receipt.suppliers as any)?.name || supplier_name,
          items: resolvedItems,
          extractedItems: resolvedItems
            .filter((item) => item.status !== "missing")
            .map((item) => ({
              product_name: item.raw_product_name || item.deliveryName,
              product_code: item.raw_product_code || null,
              quantity: item.deliveryQty,
              unit: item.deliveryUnit,
              package_quantity: item.raw_package_quantity ?? null,
              package_unit: item.raw_package_unit ?? null,
              matchedItemId: item.matchedItemId,
              canonical_material_id: item.canonical_material_id,
              material_resolution_status: item.material_resolution_status,
              material_resolution_request_id: item.material_resolution_request_id,
              resolved_exact: item.resolved_exact,
              canonical_material_name: item.canonical_material_name,
              canonical_material_code: item.canonical_material_code,
              blockers: item.blockers,
              candidate_names: item.candidate_names,
            })),
        }),
        { headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        isMatched: false,
        matchScore: 0,
        matchSource: "none",
        error: "Không tìm thấy dòng phù hợp trong phiếu nhập đã chọn.",
      }),
      { status: 422, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in match-delivery-note:", error);
    return new Response(
      JSON.stringify({ error: "Không thể xử lý phiếu giao hàng. Vui lòng thử lại." }),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
