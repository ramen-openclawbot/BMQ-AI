import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { checkAndRecordRateLimit, getRateLimitHeaders } from "../_shared/rate-limiter.ts";

interface ExtractedItem {
  product_name: string;
  quantity: number;
  unit: string;
  unit_price?: number;
}

interface MatchItem {
  deliveryName: string;
  deliveryQty: number;
  deliveryUnit: string;
  matchedName?: string;
  matchedQty?: number;
  matchedUnit?: string;
  status: "match" | "mismatch" | "extra" | "missing";
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
  purchase_order_id: string;
  supplier_id: string | null;
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

interface PaymentRequestCandidate {
  id: string;
  request_number: string;
  title: string;
  supplier_id: string | null;
  suppliers?: { id: string; name: string } | null;
  payment_request_items?: CandidateLine[];
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
      const qtyMatch = quantityMatches(extracted.quantity, Number(bestItemMatch.item.quantity || 0));

      matchItems.push({
        deliveryName: extracted.product_name,
        deliveryQty: extracted.quantity,
        deliveryUnit: extracted.unit,
        matchedName: bestItemMatch.item.product_name,
        matchedQty: Number(bestItemMatch.item.quantity || 0),
        matchedUnit: bestItemMatch.item.unit || "",
        status: unitMatch && qtyMatch ? "match" : "mismatch",
      });

      if (unitMatch && qtyMatch) matchedCount++;
    } else {
      matchItems.push({
        deliveryName: extracted.product_name,
        deliveryQty: extracted.quantity,
        deliveryUnit: extracted.unit,
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

function findBestPaymentRequestMatch(
  paymentRequests: PaymentRequestCandidate[],
  supplierName: string,
  extractedItems: ExtractedItem[],
): CandidateMatch<PaymentRequestCandidate> | null {
  let bestMatch: CandidateMatch<PaymentRequestCandidate> | null = null;

  for (const pr of paymentRequests) {
    const prItems = pr.payment_request_items || [];
    const candidateSupplierName = (pr.suppliers as any)?.name || "";
    const scored = scoreCandidate(pr, supplierName, candidateSupplierName, prItems, extractedItems);
    if (scored && (!bestMatch || scored.score > bestMatch.score)) {
      bestMatch = scored;
    }
  }

  return bestMatch;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  try {
    const { deliveryImage } = await req.json();

    if (!deliveryImage) {
      return new Response(
        JSON.stringify({ error: "Missing delivery image" }),
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
    const openaiApiKey = Deno.env.get("OPENAI_API_KEY");

    if (!openaiApiKey) {
      return new Response(
        JSON.stringify({ error: "AI service not configured" }),
        { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify user token
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
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
2. List of items with: product name, quantity, unit, unit price (if visible)

Return ONLY valid JSON in this exact format:
{
  "supplier_name": "string",
  "items": [
    {"product_name": "string", "quantity": number, "unit": "string", "unit_price": number or null}
  ]
}

Important:
- Keep product names in Vietnamese
- Convert all quantities to numbers
- Common units: kg, g, con, cái, hộp, thùng, chai, lon, gói, bịch, túi, lít, ml
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

    // Prefer pending PO receipt queue so warehouse starts from PO/receipt, not payable.
    const { data: pendingReceipts, error: receiptError } = await supabase
      .from("goods_receipts")
      .select(`
        id,
        receipt_number,
        purchase_order_id,
        supplier_id,
        suppliers(id, name),
        purchase_orders(id, po_number, title),
        goods_receipt_items(id, product_name, ordered_quantity, quantity, unit, unit_price, purchase_order_item_id)
      `)
      .not("purchase_order_id", "is", null)
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
      (pendingReceipts || []) as PendingReceiptCandidate[],
      supplier_name,
      extractedItems,
    );

    if (bestReceiptMatch) {
      const receipt = bestReceiptMatch.candidate;
      const isMatched = bestReceiptMatch.score >= 0.8;

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
          items: bestReceiptMatch.items,
          extractedItems,
        }),
        { headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // Legacy fallback: approved payment requests that don't have goods_receipt yet.
    const { data: paymentRequests, error: prError } = await supabase
      .from("payment_requests")
      .select(`
        id,
        request_number,
        title,
        supplier_id,
        suppliers!inner(id, name),
        payment_request_items(id, product_name, quantity, unit, unit_price)
      `)
      .eq("status", "approved")
      .is("goods_receipt_id", null)
      .eq("delivery_status", "pending");

    if (prError) {
      console.error("Error fetching payment requests:", prError);
      return new Response(
        JSON.stringify({ error: "Failed to fetch payment requests" }),
        { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const bestPaymentRequestMatch = findBestPaymentRequestMatch(
      (paymentRequests || []) as PaymentRequestCandidate[],
      supplier_name,
      extractedItems,
    );

    if (!bestPaymentRequestMatch) {
      return new Response(
        JSON.stringify({
          isMatched: false,
          matchScore: 0,
          matchSource: "none",
          items: extractedItems.map(item => ({
            deliveryName: item.product_name,
            deliveryQty: item.quantity,
            deliveryUnit: item.unit,
            status: "extra" as const,
          })),
          supplierName: supplier_name || "Không xác định",
          error: "Không tìm thấy phiếu chờ nhập kho hoặc đề nghị chi phù hợp"
        }),
        { headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const pr = bestPaymentRequestMatch.candidate;
    const isMatched = bestPaymentRequestMatch.score >= 0.8;

    return new Response(
      JSON.stringify({
        isMatched,
        matchScore: bestPaymentRequestMatch.score,
        matchSource: "payment_request",
        paymentRequestId: pr.id,
        paymentRequestNumber: pr.request_number,
        paymentRequestTitle: pr.title,
        supplierId: pr.supplier_id,
        supplierName: (pr.suppliers as any)?.name || supplier_name,
        items: bestPaymentRequestMatch.items,
        extractedItems,
      }),
      { headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in match-delivery-note:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
