import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

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
  return diff / max <= tolerance;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { deliveryImage } = await req.json();

    if (!deliveryImage) {
      return new Response(
        JSON.stringify({ error: "Missing delivery image" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get auth token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");

    if (!lovableApiKey) {
      return new Response(
        JSON.stringify({ error: "AI service not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify user token
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Extract base64 image data
    const imageData = deliveryImage.includes(",") 
      ? deliveryImage.split(",")[1] 
      : deliveryImage;

    // Call Lovable AI to extract delivery note info
    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
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
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Query approved payment requests that don't have goods_receipt yet
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
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!paymentRequests || paymentRequests.length === 0) {
      return new Response(
        JSON.stringify({
          isMatched: false,
          matchScore: 0,
          items: extractedItems.map(item => ({
            deliveryName: item.product_name,
            deliveryQty: item.quantity,
            deliveryUnit: item.unit,
            status: "extra" as const,
          })),
          supplierName: supplier_name || "Không xác định",
          error: "Không tìm thấy đề nghị chi nào đang chờ nhận hàng"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Find best matching payment request
    let bestMatch: {
      pr: typeof paymentRequests[0];
      score: number;
      items: MatchItem[];
    } | null = null;

    const normalizedSupplierName = removeDiacritics(supplier_name || "");

    for (const pr of paymentRequests) {
      const prSupplierName = removeDiacritics((pr.suppliers as any)?.name || "");
      const supplierSimilarity = normalizedSupplierName 
        ? similarity(normalizedSupplierName, prSupplierName)
        : 0.5; // Default if supplier not extracted

      if (supplierSimilarity < 0.5) continue; // Skip if supplier doesn't match at all

      const prItems = pr.payment_request_items || [];
      const matchItems: MatchItem[] = [];
      let matchedCount = 0;

      // Match extracted items to PR items
      const usedPrItemIds = new Set<string>();

      for (const extracted of extractedItems) {
        const normalizedExtracted = removeDiacritics(extracted.product_name);
        const normalizedExtractedUnit = normalizeUnit(extracted.unit);

        let bestItemMatch: {
          prItem: typeof prItems[0];
          nameSimilarity: number;
        } | null = null;

        for (const prItem of prItems) {
          if (usedPrItemIds.has(prItem.id)) continue;

          const normalizedPrName = removeDiacritics(prItem.product_name);
          const nameSimilarity = similarity(normalizedExtracted, normalizedPrName);

          if (nameSimilarity > 0.6 && (!bestItemMatch || nameSimilarity > bestItemMatch.nameSimilarity)) {
            bestItemMatch = { prItem, nameSimilarity };
          }
        }

        if (bestItemMatch) {
          usedPrItemIds.add(bestItemMatch.prItem.id);
          const normalizedPrUnit = normalizeUnit(bestItemMatch.prItem.unit || "");
          const unitMatch = normalizedExtractedUnit === normalizedPrUnit;
          const qtyMatch = quantityMatches(extracted.quantity, bestItemMatch.prItem.quantity);

          if (unitMatch && qtyMatch) {
            matchItems.push({
              deliveryName: extracted.product_name,
              deliveryQty: extracted.quantity,
              deliveryUnit: extracted.unit,
              matchedName: bestItemMatch.prItem.product_name,
              matchedQty: bestItemMatch.prItem.quantity,
              matchedUnit: bestItemMatch.prItem.unit || "",
              status: "match",
            });
            matchedCount++;
          } else {
            matchItems.push({
              deliveryName: extracted.product_name,
              deliveryQty: extracted.quantity,
              deliveryUnit: extracted.unit,
              matchedName: bestItemMatch.prItem.product_name,
              matchedQty: bestItemMatch.prItem.quantity,
              matchedUnit: bestItemMatch.prItem.unit || "",
              status: "mismatch",
            });
          }
        } else {
          matchItems.push({
            deliveryName: extracted.product_name,
            deliveryQty: extracted.quantity,
            deliveryUnit: extracted.unit,
            status: "extra",
          });
        }
      }

      // Add missing items from PR
      for (const prItem of prItems) {
        if (!usedPrItemIds.has(prItem.id)) {
          matchItems.push({
            deliveryName: prItem.product_name,
            deliveryQty: prItem.quantity,
            deliveryUnit: prItem.unit || "",
            status: "missing",
          });
        }
      }

      // Calculate match score
      const totalItems = Math.max(extractedItems.length, prItems.length);
      const score = (matchedCount / totalItems) * supplierSimilarity;

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { pr, score, items: matchItems };
      }
    }

    if (!bestMatch) {
      return new Response(
        JSON.stringify({
          isMatched: false,
          matchScore: 0,
          items: extractedItems.map(item => ({
            deliveryName: item.product_name,
            deliveryQty: item.quantity,
            deliveryUnit: item.unit,
            status: "extra" as const,
          })),
          supplierName: supplier_name || "Không xác định",
          error: "Không tìm thấy đề nghị chi phù hợp"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isMatched = bestMatch.score >= 0.8;

    return new Response(
      JSON.stringify({
        isMatched,
        matchScore: bestMatch.score,
        paymentRequestId: bestMatch.pr.id,
        paymentRequestNumber: bestMatch.pr.request_number,
        paymentRequestTitle: bestMatch.pr.title,
        supplierId: bestMatch.pr.supplier_id,
        supplierName: (bestMatch.pr.suppliers as any)?.name || supplier_name,
        items: bestMatch.items,
        extractedItems,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in match-delivery-note:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
