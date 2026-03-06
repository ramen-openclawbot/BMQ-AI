import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { checkAndRecordRateLimit, getRateLimitHeaders } from "../_shared/rate-limiter.ts";

type SupplierLite = { id: string; name: string };

type SupplierAliasRow = {
  id: string;
  supplier_id: string;
  alias_text: string;
  alias_key: string;
  active: boolean;
};

type ScanTemplateRow = {
  id: string;
  supplier_id: string | null;
  supplier_name_key: string;
  template_json: Record<string, any> | null;
  active: boolean;
};

const normalizeText = (v: string) =>
  String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const acronymOf = (v: string) => {
  const tokens = normalizeText(v)
    .split(" ")
    .filter((x) => x && x.length > 1);

  // Important: support short supplier tokens like "STC", "VPM", ...
  if (tokens.length === 1) {
    const t = tokens[0];
    if (t.length >= 2 && t.length <= 8) return t;
  }

  return tokens.map((x) => x[0]).join("");
};

const parseNumericVN = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const raw = String(v ?? "").trim();
  if (!raw) return null;

  const m = raw.match(/-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const token = m[0];

  const normalized = token
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(/,/g, ".")
    .replace(/[^0-9.-]/g, "");

  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
};

const scoreSupplierMatch = (scanned: string, candidate: string): number => {
  const a = normalizeText(scanned);
  const b = normalizeText(candidate);
  if (!a || !b) return 0;

  const acA = acronymOf(a);
  const acB = acronymOf(b);
  if (a === b) return 100;
  if (acA && (b.includes(acA) || acA === acB)) return 97;
  if (a.includes(b) || b.includes(a)) return 90;

  const at = a.split(" ").filter(Boolean);
  const bt = b.split(" ").filter(Boolean);
  const inter = at.filter((t) => bt.includes(t)).length;
  if (!inter) return 0;

  const coverage = inter / Math.max(at.length, bt.length);
  return Math.round(coverage * 85);
};

serve(async (req) => {
  const startTime = Date.now();
  console.log("[scan-invoice] Request started");

  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  try {
    // Require authentication (was previously optional/anon-allowed)
    const { user } = await requireAuth(req, getCorsHeaders(req));

    // Rate limit: 100 calls/day per user
    const rateLimit = await checkAndRecordRateLimit(user.id, "scan-invoice", 100);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({ error: "Bạn đã vượt quá giới hạn scan hôm nay. Vui lòng thử lại vào ngày mai.", code: "RATE_LIMIT_EXCEEDED" }),
        { status: 429, headers: { ...getCorsHeaders(req), "Content-Type": "application/json", ...getRateLimitHeaders(rateLimit) } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { imageBase64, mimeType, suppliers } = await req.json();

    if (!imageBase64) {
      return new Response(
        JSON.stringify({ error: "No image provided" }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    if (imageBase64.length > 10 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: "Image too large. Maximum size is 10MB." }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (mimeType && !allowedMimeTypes.includes(mimeType)) {
      return new Response(
        JSON.stringify({ error: "Invalid image type. Allowed: JPEG, PNG, WebP, GIF" }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      console.error("[scan-invoice] OPENAI_API_KEY not configured");
      return new Response(
        JSON.stringify({ code: "CONFIG_MISSING_OPENAI_API_KEY", error: "Thiếu cấu hình AI key (OPENAI_API_KEY)" }),
        { status: 503, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const supplierList: SupplierLite[] = Array.isArray(suppliers)
      ? suppliers
          .map((s: any) => ({ id: String(s?.id || ""), name: String(s?.name || "").trim() }))
          .filter((s) => s.id && s.name)
          .slice(0, 300)
      : [];

    const { data: templatesData } = await supabaseAdmin
      .from("supplier_scan_templates")
      .select("id, supplier_id, supplier_name_key, template_json, active")
      .eq("active", true)
      .order("last_used_at", { ascending: false })
      .limit(40);

    const templates = (templatesData || []) as ScanTemplateRow[];

    const { data: aliasesData } = await supabaseAdmin
      .from("supplier_aliases")
      .select("id,supplier_id,alias_text,alias_key,active")
      .eq("active", true)
      .limit(500);
    const aliases = (aliasesData || []) as SupplierAliasRow[];

    const knownSuppliersPrompt = supplierList.length
      ? `Known supplier master data (choose from this list when possible):\n${supplierList
          .slice(0, 120)
          .map((s) => `- ${s.name}`)
          .join("\n")}`
      : "";

    const learnedTemplatePrompt = templates.length
      ? `Learned supplier templates from prior scans:\n${templates
          .slice(0, 20)
          .map((t) => {
            const header = String(t.template_json?.header_hint || "");
            const aliases = Array.isArray(t.template_json?.aliases) ? t.template_json?.aliases.join(", ") : "";
            const preferred = String(t.template_json?.preferred_supplier_name || "");
            return `- key=${t.supplier_name_key}; preferred=${preferred}; header_hint=${header}; aliases=${aliases}`;
          })
          .join("\n")}`
      : "";

    const systemPrompt = `You are an expert invoice/delivery-note data extractor for Vietnamese documents.

Extract the following data:
1. Invoice number (Số hóa đơn, Số HD, No., Số phiếu)
2. Invoice date (Ngày, Date) - format as YYYY-MM-DD
3. Supplier name if visible (seller/exporter company at top of document, not buyer)
4. VAT amount if present (VAT, Thuế GTGT)
5. All line items with:
   - Product code (Mã hàng, Code) if available
   - Product name (Tên hàng, Tên sản phẩm, Description)
   - Unit (Đơn vị tính, ĐVT)
   - Quantity (Số lượng, SL)
   - Unit price (Đơn giá, Giá)

Important notes:
- Prioritize seller/company logo header text for supplier_name.
- Vietnamese numbers may use comma as decimal separator.
- Extract ALL visible line items.
- CHỈ lấy quantity từ cột Số lượng/SL của bảng hàng.\n- KHÔNG lấy số trong tên hàng/quy cách (ví dụ "(25kg)" không phải quantity).\n- For quantities and prices, convert to numbers.
${knownSuppliersPrompt}
${learnedTemplatePrompt}
${aliases.length ? `Known aliases (alias => canonical supplier):\n${aliases.slice(0,150).map((a)=>`- ${a.alias_text} => ${(supplierList.find((x)=>x.id===a.supplier_id)?.name)||a.supplier_id}`).join("\n")}` : ""}`;

    console.log("[scan-invoice] Calling AI gateway");
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}`,
                },
              },
              {
                type: "text",
                text: "Please extract all invoice data from this image.",
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "extract_invoice_data",
              description: "Extract structured invoice data from the image",
              parameters: {
                type: "object",
                properties: {
                  invoice_number: { type: "string" },
                  invoice_date: { type: "string" },
                  supplier_name: { type: "string" },
                  vat_amount: { type: "number" },
                  seller_name_candidates: {
                    type: "array",
                    items: { type: "string" },
                    description: "Danh sách tên ứng viên bên bán nhìn thấy trên phiếu"
                  },
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        product_code: { type: "string" },
                        product_name: { type: "string" },
                        unit: { type: "string" },
                        quantity: { type: "number" },
                        unit_price: { type: "number" },
                      },
                      required: ["product_name", "quantity", "unit_price"],
                    },
                  },
                },
                required: ["items"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "extract_invoice_data" } },
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Please add more credits." }),
          { status: 402, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
        );
      }
      const errorText = await response.text();
      console.error("[scan-invoice] AI gateway error:", response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const aiResponse = await response.json();
    const toolCall = aiResponse.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.function.name !== "extract_invoice_data") {
      throw new Error("Failed to extract invoice data from image");
    }

    const extractedData = JSON.parse(toolCall.function.arguments || "{}");

    // Normalize numeric fields from Vietnamese OCR formats
    if (Array.isArray(extractedData?.items)) {
      extractedData.items = extractedData.items.map((it: any) => ({
        ...it,
        quantity: parseNumericVN(it?.quantity) ?? 0,
        unit_price: parseNumericVN(it?.unit_price) ?? null,
      }));
    }
    extractedData.vat_amount = parseNumericVN(extractedData?.vat_amount) ?? extractedData?.vat_amount ?? null;

    // Canonicalize supplier to master list (alias first on multiple candidates, then scoring fallback)
    let supplierMatch: { id: string; name: string; score: number; source: "alias" | "scoring" } | null = null;
    const scannedSupplierName = String(extractedData?.supplier_name || "").trim();

    const candidateTexts = Array.from(new Set([
      scannedSupplierName,
      ...((Array.isArray((extractedData as any)?.seller_name_candidates) ? (extractedData as any).seller_name_candidates : []) as string[]),
    ].map((x) => String(x || "").trim()).filter(Boolean)));

    if (candidateTexts.length && aliases.length) {
      const resolveSupplier = async (supplierId: string) => {
        const fromPayload = supplierList.find((s) => s.id === supplierId);
        if (fromPayload) return fromPayload;
        const { data } = await supabaseAdmin
          .from("suppliers")
          .select("id,name")
          .eq("id", supplierId)
          .maybeSingle();
        return data ? ({ id: String((data as any).id), name: String((data as any).name || "") }) : null;
      };

      for (const candidate of candidateTexts) {
        const key = normalizeText(candidate);
        if (!key) continue;

        const directAlias = aliases.find((a) => a.alias_key === key);
        if (directAlias) {
          const hit = await resolveSupplier(directAlias.supplier_id);
          if (hit) {
            supplierMatch = { id: hit.id, name: hit.name, score: 100, source: "alias" };
            extractedData.supplier_name = hit.name;
            break;
          }
        }

        const containsAlias = aliases.find((a) => key.includes(a.alias_key) || a.alias_key.includes(key));
        if (containsAlias) {
          const hit = await resolveSupplier(containsAlias.supplier_id);
          if (hit) {
            supplierMatch = { id: hit.id, name: hit.name, score: 95, source: "alias" };
            extractedData.supplier_name = hit.name;
            break;
          }
        }
      }
    }

    if (!supplierMatch && scannedSupplierName && supplierList.length) {
      const ranked = supplierList
        .map((s) => ({ ...s, score: scoreSupplierMatch(scannedSupplierName, s.name) }))
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];
      if (best && best.score >= 90) {
        supplierMatch = { id: best.id, name: best.name, score: best.score, source: "scoring" };
        extractedData.supplier_name = best.name;
      }
    }

    // Learn/update template for future scans
    const supplierKey = normalizeText(String(extractedData?.supplier_name || scannedSupplierName || ""));
    if (supplierKey) {
      const aliasSet = Array.from(new Set([scannedSupplierName, String(extractedData?.supplier_name || "")].filter(Boolean)));
      const templateJson = {
        preferred_supplier_name: String(extractedData?.supplier_name || ""),
        aliases: aliasSet,
        header_hint: String(extractedData?.supplier_name || "").slice(0, 120),
        sample_units: Array.from(
          new Set((Array.isArray(extractedData?.items) ? extractedData.items : []).map((x: any) => String(x?.unit || "")).filter(Boolean))
        ).slice(0, 8),
      };

      await supabaseAdmin
        .from("supplier_scan_templates")
        .upsert(
          {
            supplier_id: supplierMatch?.id || null,
            supplier_name_key: supplierKey,
            template_json: templateJson,
            active: true,
            last_used_at: new Date().toISOString(),
            hit_count: 1,
          },
          { onConflict: "supplier_name_key" }
        );

      try {
        await supabaseAdmin.rpc("increment_supplier_template_hit", { p_supplier_name_key: supplierKey });
      } catch (_e) {
        // non-blocking metrics update
      }
    }

    console.log(`[scan-invoice] Completed in ${Date.now() - startTime}ms, extracted ${extractedData.items?.length || 0} items`);
    return new Response(
      JSON.stringify({ success: true, data: extractedData, supplier_match: supplierMatch, detected_supplier_name: scannedSupplierName || null, template_learning: supplierKey || null }),
      { headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[scan-invoice] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
