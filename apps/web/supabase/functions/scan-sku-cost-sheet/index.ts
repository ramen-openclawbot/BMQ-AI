import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { checkAndRecordRateLimit, getRateLimitHeaders } from "../_shared/rate-limiter.ts";
import { resolveCanonicalMaterialForLine } from "../_shared/material-controller.ts";

type SkuCogsMaterial = {
  id: string;
  material_code: string;
  canonical_name: string;
  normalized_name: string;
  default_unit: string;
  ingredient_sku_id: string | null;
};

type SkuCogsMaterialAlias = {
  material_id: string;
  alias_name: string;
  normalized_alias: string;
};

const normalizeMaterialName = (value: unknown) => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/đ/g, "d")
  .replace(/Đ/g, "D")
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    // Require authentication (was previously open/public)
    const { user } = await requireAuth(req, getCorsHeaders(req));

    // Rate limit: 50 calls/day per user
    const rateLimit = await checkAndRecordRateLimit(user.id, "scan-sku-cost-sheet", 50);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({ error: "Bạn đã vượt quá giới hạn scan hôm nay. Vui lòng thử lại vào ngày mai.", code: "RATE_LIMIT_EXCEEDED" }),
        { status: 429, headers: { ...getCorsHeaders(req), "Content-Type": "application/json", ...getRateLimitHeaders(rateLimit) } }
      );
    }

    const { imageBase64, mimeType } = await req.json();
    if (!imageBase64) {
      return new Response(JSON.stringify({ error: "No image provided" }), { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } });
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

    const systemPrompt = `Bạn là chuyên gia đọc sheet giá thành sản xuất tiếng Việt.
Trích xuất theo đúng cột cố định (từ trái qua phải) của bảng nguyên vật liệu:
Tên món | Nguyên vật liệu | DVT | Đơn giá | Định lượng | Giá vốn | Đơn giá vốn/cái.

Yêu cầu trích xuất:
1) product_name: tên món/thành phẩm
2) sku_code: nếu ảnh không có thì tạo gợi ý dạng TP-<slug>-001
3) finished_output_qty: SL thành phẩm (cột Thành phẩm SL, thường là 100)
4) finished_output_unit: ĐVT thành phẩm (cột Thành phẩm ĐVT)
5) material_provision_percent: % dự phòng hao hụt/tăng giá
6) packaging_cost, labor_cost, delivery_cost, other_production_cost, sga_cost, selling_price (VND/cái)
7) ingredients: danh sách nguyên vật liệu, mỗi dòng gồm:
   - ingredient_name
   - unit
   - unit_price (Đơn giá)
   - dosage_qty (Định lượng)
   - line_cost (Giá vốn)
   - unit_cost_per_item (Đơn giá vốn/cái)

Quy tắc bắt buộc:
- Không được nhầm cột Đơn giá với Định lượng hoặc Giá vốn.
- Với số kiểu VN: 2,662 => 2662; 47,324 => 47324.
- Chỉ lấy dòng nguyên liệu thật sự (bỏ total/summary).
- Nếu thiếu số thì trả 0.
- Trả số dạng number, không dấu phân cách nghìn.
- Tự kiểm tra: line_cost phải xấp xỉ unit_price * dosage_qty.
- Nếu không thấy product_name, dùng "SKU từ ảnh".`;

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
              { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}` } },
              { type: "text", text: "Hãy đọc ảnh và trích xuất JSON tạo SKU theo schema tool." },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "extract_sku_cost_sheet",
              description: "Extract SKU cost sheet data from image",
              parameters: {
                type: "object",
                properties: {
                  sku_code: { type: "string" },
                  product_name: { type: "string" },
                  finished_output_qty: { type: "number" },
                  finished_output_unit: { type: "string" },
                  material_provision_percent: { type: "number" },
                  packaging_cost: { type: "number" },
                  labor_cost: { type: "number" },
                  delivery_cost: { type: "number" },
                  other_production_cost: { type: "number" },
                  sga_cost: { type: "number" },
                  selling_price: { type: "number" },
                  ingredients: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        ingredient_name: { type: "string" },
                        unit: { type: "string" },
                        unit_price: { type: "number" },
                        dosage_qty: { type: "number" },
                        line_cost: { type: "number" },
                        unit_cost_per_item: { type: "number" },
                      },
                      required: ["ingredient_name"],
                    },
                  },
                },
                required: ["product_name", "ingredients"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "extract_sku_cost_sheet" } },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI gateway error: ${response.status} - ${errorText}`);
    }

    const aiResponse = await response.json();
    const toolCall = aiResponse.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error("Failed to extract SKU data");

    const extracted = JSON.parse(toolCall.function.arguments || "{}");
    const scannedIngredients = Array.isArray(extracted.ingredients) ? extracted.ingredients : [];

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error("SKU COGS material registry is not configured");
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
      auth: { persistSession: false },
    });

    const canonicalIngredients = await Promise.all(scannedIngredients.map(async (ingredient: Record<string, unknown>, index: number) => {
      const rawOcrName = String(ingredient.ingredient_name || "").trim();
      const unit = String(ingredient.unit || "").trim() || null;
      // Shared helper calls the authoritative public.resolve_canonical_material RPC and
      // creates an idempotent resolution request; OCR text is never canonical authority.
      const preview = rawOcrName
        ? await resolveCanonicalMaterialForLine(supabase as any, {
          source_type: "sku_cogs",
          source_table: "sku_formulations",
          source_id: null,
          source_line_id: null,
          raw_name: rawOcrName,
          raw_code: typeof ingredient.material_code === "string" ? ingredient.material_code : null,
          raw_unit: unit,
          effective_date: new Date().toISOString().slice(0, 10),
          payload: { candidate_source: "scan_sku_cost_sheet", confidence: "ocr", field_name: "sku_formulations.canonical_material_id", row_index: index },
        })
        : null;

      if (!preview?.resolved_exact) {
        return {
          ...ingredient,
          raw_ocr_name: rawOcrName,
          canonical_material_id: null,
          canonical_material_name: null,
          canonical_default_unit: preview?.canonical_default_unit || null,
          material_code: null,
          material_resolution_status: preview?.material_resolution_status || "not_found",
          material_resolution_request_id: preview?.material_resolution_request_id || null,
          material_resolution_blockers: preview?.blockers?.length ? preview.blockers : ["material_resolution_required"],
        };
      }

      return {
        ...ingredient,
        raw_ocr_name: rawOcrName,
        ingredient_name: preview.canonical_material_name,
        canonical_material_id: preview.canonical_material_id,
        canonical_material_name: preview.canonical_material_name,
        canonical_default_unit: preview.canonical_default_unit,
        material_code: preview.canonical_material_code,
        ingredient_sku_id: null,
        unit: preview.canonical_default_unit || unit || ingredient.unit,
        material_resolution_status: preview.material_resolution_status,
        material_resolution_request_id: preview.material_resolution_request_id,
        material_resolution_blockers: preview.blockers,
      };
    }));

    const blockedMaterials = canonicalIngredients.filter((ingredient: Record<string, unknown>) => ingredient.material_resolution_status !== "resolved_exact");
    extracted.ingredients = canonicalIngredients;
    return new Response(JSON.stringify({
      success: true,
      data: extracted,
      material_resolution_status: blockedMaterials.length === 0 ? "ready" : "blocked",
      blocked_materials: blockedMaterials,
      error: blockedMaterials.length ? `Có ${blockedMaterials.length} NVL cần chuẩn hóa trước khi lưu COGS.` : undefined,
    }), {
      status: 200,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } });
  }
});
