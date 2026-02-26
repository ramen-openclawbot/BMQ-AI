import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type OcrProvider = "openai" | "ollama";

const extractJsonFromText = (input: string) => {
  const text = String(input || "").trim();
  if (!text) return null;

  const codeFence = text.match(/```json\s*([\s\S]*?)\s*```/i) || text.match(/```\s*([\s\S]*?)\s*```/i);
  const candidate = codeFence?.[1] || text;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

const buildSchemaTool = () => ({
  type: "function",
  function: {
    name: "extract_purchase_order_data",
    description: "Trích xuất dữ liệu đơn đặt hàng từ ảnh",
    parameters: {
      type: "object",
      properties: {
        po_number: { type: "string", description: "Số đơn đặt hàng/Purchase Order number" },
        order_date: { type: "string", description: "Ngày đặt hàng format YYYY-MM-DD" },
        expected_date: { type: "string", description: "Ngày giao dự kiến format YYYY-MM-DD" },
        supplier_name: { type: "string", description: "Tên nhà cung cấp" },
        vat_amount: { type: "number", description: "Số tiền thuế VAT (VND)" },
        total_amount: { type: "number", description: "Tổng tiền đơn hàng (VND)" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              product_code: { type: "string", description: "Mã sản phẩm" },
              product_name: { type: "string", description: "Tên sản phẩm" },
              unit: { type: "string", description: "Đơn vị tính (kg, g, con, etc.)" },
              quantity: { type: "number", description: "Số lượng đặt" },
              unit_price: { type: "number", description: "Đơn giá (VND)" },
              line_total: { type: "number", description: "Thành tiền (VND)" },
              notes: { type: "string", description: "Ghi chú (NSX, HSD, etc.)" },
            },
            required: ["product_name", "quantity"],
          },
        },
        notes: { type: "string", description: "Ghi chú chung của đơn hàng" },
      },
      required: ["items"],
    },
  },
});

serve(async (req) => {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();
  console.log("[scan-purchase-order] Request started", { traceId });

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized", trace_id: traceId }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid JWT", details: authError?.message, trace_id: traceId }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { imageBase64, mimeType, supplierVatConfig } = await req.json();

    if (!imageBase64) {
      return new Response(JSON.stringify({ error: "No image provided", trace_id: traceId }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (imageBase64.length > 10 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: "Image too large. Maximum size is 10MB.", trace_id: traceId }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (mimeType && !allowedMimeTypes.includes(mimeType)) {
      return new Response(JSON.stringify({ error: "Invalid image type. Allowed: JPEG, PNG, WebP, GIF", trace_id: traceId }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    const OLLAMA_BASE_URL = (Deno.env.get("OLLAMA_BASE_URL") || "http://127.0.0.1:11434").replace(/\/$/, "");
    const OLLAMA_API_KEY = Deno.env.get("OLLAMA_API_KEY");
    const OLLAMA_MODEL = Deno.env.get("OLLAMA_MODEL") || "deepseek-ocr:latest";
    const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

    const configuredProvider = (Deno.env.get("OCR_PROVIDER_DEFAULT") || "openai").toLowerCase();
    const primaryProvider: OcrProvider = configuredProvider === "ollama" ? "ollama" : "openai";
    const fallbackEnabled = (Deno.env.get("OCR_FALLBACK_OPENAI") || "true").toLowerCase() !== "false";

    const vatInstruction = supplierVatConfig?.vat_included_in_price
      ? `LƯU Ý QUAN TRỌNG: NCC này có giá đã bao gồm VAT. KHÔNG trích xuất dòng VAT riêng biệt. Để vat_amount = 0 hoặc null.`
      : `6. Thuế VAT nếu có (VAT, Thuế GTGT) - số tiền riêng`;

    const systemPrompt = `Bạn là chuyên gia trích xuất dữ liệu từ đơn đặt hàng (Purchase Order). Phân tích ảnh đơn đặt hàng và trích xuất tất cả thông tin liên quan.

Trích xuất các thông tin sau từ đơn đặt hàng:
1. Số đơn hàng (Số CT, Số ĐH, PO Number)
2. Ngày đặt hàng (Ngày CT, Order Date) - format YYYY-MM-DD
3. Ngày giao dự kiến nếu có (Ngày giao) - format YYYY-MM-DD
4. Tên nhà cung cấp (Supplier name)
5. ${vatInstruction}
6. Tất cả các dòng sản phẩm với mã hàng, tên hàng, ĐVT, số lượng, đơn giá, thành tiền, ghi chú.

Lưu ý quan trọng:
- Đơn đặt hàng Việt Nam thường có chữ tiếng Việt
- Số có thể dùng dấu chấm/phẩy làm separator
- Trích xuất TẤT CẢ các dòng sản phẩm trong bảng
- Nếu không thấy giá trị, để null hoặc chuỗi rỗng
- Chuyển số lượng và giá về dạng number (bỏ separator)
${supplierVatConfig?.vat_included_in_price ? '- NCC này có giá đã bao gồm VAT trong đơn giá, không có dòng VAT riêng' : ''}`;

    const userMessage = [
      {
        type: "image_url",
        image_url: {
          url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}`,
        },
      },
      {
        type: "text",
        text: "Vui lòng trích xuất tất cả dữ liệu từ đơn đặt hàng này. Trả về đúng cấu trúc JSON theo schema tool.",
      },
    ];

    const callProvider = async (provider: OcrProvider, withTools = true) => {
      const endpoint = provider === "ollama"
        ? `${OLLAMA_BASE_URL}/v1/chat/completions`
        : "https://api.openai.com/v1/chat/completions";

      if (provider === "openai" && !OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is not configured");
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (provider === "openai") headers.Authorization = `Bearer ${OPENAI_API_KEY}`;
      if (provider === "ollama" && OLLAMA_API_KEY) headers.Authorization = `Bearer ${OLLAMA_API_KEY}`;

      const body: Record<string, any> = {
        model: provider === "ollama" ? OLLAMA_MODEL : OPENAI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      };

      if (withTools) {
        body.tools = [buildSchemaTool()];
        body.tool_choice = { type: "function", function: { name: "extract_purchase_order_data" } };
      }

      return await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    };

    const tryParseResponse = async (res: Response) => {
      const aiResponse = await res.json();
      const message = aiResponse?.choices?.[0]?.message;
      const toolCall = message?.tool_calls?.[0];

      if (toolCall?.function?.name === "extract_purchase_order_data") {
        return JSON.parse(toolCall.function.arguments || "{}");
      }

      const contentText = typeof message?.content === "string"
        ? message.content
        : Array.isArray(message?.content)
          ? message.content.map((x: any) => x?.text || "").join("\n")
          : "";

      return extractJsonFromText(contentText);
    };

    let usedProvider: OcrProvider = primaryProvider;
    let response = await callProvider(usedProvider, true);

    if (!response.ok && usedProvider === "ollama" && response.status === 400) {
      console.log("[scan-purchase-order] Ollama may not support tool calling, retry without tools", { traceId });
      response = await callProvider("ollama", false);
    }

    if (!response.ok && usedProvider === "ollama" && fallbackEnabled && OPENAI_API_KEY) {
      console.log("[scan-purchase-order] Ollama failed, fallback to OpenAI", { traceId, status: response.status });
      usedProvider = "openai";
      response = await callProvider("openai", true);
    }

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again later.", provider: usedProvider, trace_id: traceId }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please add more credits.", provider: usedProvider, trace_id: traceId }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      console.error("[scan-purchase-order] OCR provider error", { traceId, provider: usedProvider, status: response.status, errorText });
      throw new Error(`OCR gateway error: ${response.status}`);
    }

    const extractedData = await tryParseResponse(response);
    if (!extractedData || !Array.isArray(extractedData.items)) {
      return new Response(JSON.stringify({
        error: "Không thể trích xuất dữ liệu từ hình ảnh",
        details: "AI không trả về dữ liệu cấu trúc hợp lệ",
        provider: usedProvider,
        trace_id: traceId,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[scan-purchase-order] Completed", {
      traceId,
      provider: usedProvider,
      durationMs: Date.now() - startTime,
      itemCount: extractedData.items?.length || 0,
    });

    return new Response(JSON.stringify({ success: true, data: extractedData, provider: usedProvider, trace_id: traceId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[scan-purchase-order] Error", { traceId, error });
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error", trace_id: traceId }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
