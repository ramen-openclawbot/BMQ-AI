import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// NOTE: Use npm specifier to avoid esm.sh drift/caching issues in edge runtime
import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  const startTime = Date.now();
  console.log("[scan-purchase-order] Request started");

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authentication check - simplified for prototype (no role check)
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      console.log("[scan-purchase-order] Missing authorization header");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // Use service role client for stable auth verification
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Validate user token using service role key (stable pattern)
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      console.log("[scan-purchase-order] Invalid JWT:", authError?.message);
      return new Response(
        JSON.stringify({ code: 401, message: "Invalid JWT", details: authError?.message }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("[scan-purchase-order] User authenticated:", user.id);

    const { imageBase64, mimeType, supplierVatConfig } = await req.json();

    if (!imageBase64) {
      return new Response(
        JSON.stringify({ error: "No image provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate image size (max 10MB base64 ~ 7.5MB raw)
    if (imageBase64.length > 10 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: "Image too large. Maximum size is 10MB." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate MIME type
    const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (mimeType && !allowedMimeTypes.includes(mimeType)) {
      return new Response(
        JSON.stringify({ error: "Invalid image type. Allowed: JPEG, PNG, WebP, GIF" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      console.error("[scan-purchase-order] LOVABLE_API_KEY not configured");
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    // Conditional VAT instruction based on supplier's learned preference
    const vatInstruction = supplierVatConfig?.vat_included_in_price
      ? `LƯU Ý QUAN TRỌNG: NCC này có giá đã bao gồm VAT. KHÔNG trích xuất dòng VAT riêng biệt. Để vat_amount = 0 hoặc null.`
      : `6. Thuế VAT nếu có (VAT, Thuế GTGT) - số tiền riêng`;

    const systemPrompt = `Bạn là chuyên gia trích xuất dữ liệu từ đơn đặt hàng (Purchase Order). Phân tích ảnh đơn đặt hàng và trích xuất tất cả thông tin liên quan.

Trích xuất các thông tin sau từ đơn đặt hàng:
1. Số đơn hàng (Số CT, Số ĐH, PO Number) - VD: "nh/9SO-006551/01-26"
2. Ngày đặt hàng (Ngày CT, Order Date) - format YYYY-MM-DD
3. Ngày giao dự kiến nếu có (Ngày giao) - format YYYY-MM-DD
4. Tên nhà cung cấp (Supplier name) - thường ở header đơn hàng
5. ${vatInstruction}
6. Tất cả các dòng sản phẩm với:
   - Mã hàng (Mã SP, Product Code)
   - Tên hàng (Tên sản phẩm, Product Name)
   - Đơn vị tính (ĐVT, Unit) - kg, g, con, thùng, chai, lon, gói, hộp, etc.
   - Số lượng (SL, Quantity)
   - Đơn giá (Unit Price)
   - Thành tiền (Line Total) nếu có
   - Ghi chú (Notes) nếu có - VD: NSX, HSD, thông tin thêm

Lưu ý quan trọng:
- Đơn đặt hàng Việt Nam thường có chữ tiếng Việt
- Số có thể dùng dấu chấm/phẩy làm separator (VD: 1.000.000 = 1000000)
- Trích xuất TẤT CẢ các dòng sản phẩm trong bảng
- Nếu không thấy giá trị, để null hoặc chuỗi rỗng
- Chuyển số lượng và giá về dạng number (bỏ separator)
${supplierVatConfig?.vat_included_in_price ? '- NCC này có giá đã bao gồm VAT trong đơn giá, không có dòng VAT riêng' : ''}`;

    console.log("[scan-purchase-order] Calling AI gateway");
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
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
                text: "Vui lòng trích xuất tất cả dữ liệu từ đơn đặt hàng này.",
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "extract_purchase_order_data",
              description: "Trích xuất dữ liệu đơn đặt hàng từ ảnh",
              parameters: {
                type: "object",
                properties: {
                  po_number: {
                    type: "string",
                    description: "Số đơn đặt hàng/Purchase Order number",
                  },
                  order_date: {
                    type: "string",
                    description: "Ngày đặt hàng format YYYY-MM-DD",
                  },
                  expected_date: {
                    type: "string",
                    description: "Ngày giao dự kiến format YYYY-MM-DD",
                  },
                  supplier_name: {
                    type: "string",
                    description: "Tên nhà cung cấp",
                  },
                  vat_amount: {
                    type: "number",
                    description: "Số tiền thuế VAT (VND)",
                  },
                  total_amount: {
                    type: "number",
                    description: "Tổng tiền đơn hàng (VND)",
                  },
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        product_code: {
                          type: "string",
                          description: "Mã sản phẩm",
                        },
                        product_name: {
                          type: "string",
                          description: "Tên sản phẩm",
                        },
                        unit: {
                          type: "string",
                          description: "Đơn vị tính (kg, g, con, etc.)",
                        },
                        quantity: {
                          type: "number",
                          description: "Số lượng đặt",
                        },
                        unit_price: {
                          type: "number",
                          description: "Đơn giá (VND)",
                        },
                        line_total: {
                          type: "number",
                          description: "Thành tiền (VND)",
                        },
                        notes: {
                          type: "string",
                          description: "Ghi chú (NSX, HSD, etc.)",
                        },
                      },
                      required: ["product_name", "quantity"],
                    },
                  },
                  notes: {
                    type: "string",
                    description: "Ghi chú chung của đơn hàng",
                  },
                },
                required: ["items"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "extract_purchase_order_data" } },
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.log("[scan-purchase-order] Rate limit exceeded");
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        console.log("[scan-purchase-order] AI credits exhausted");
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Please add more credits." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errorText = await response.text();
      console.error("[scan-purchase-order] AI gateway error:", response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const aiResponse = await response.json();
    const message = aiResponse.choices?.[0]?.message;
    const toolCall = message?.tool_calls?.[0];

    // If AI didn't return a tool call, it might have returned text explaining why
    if (!toolCall || toolCall.function.name !== "extract_purchase_order_data") {
      const textContent = message?.content || "";
      console.error("[scan-purchase-order] AI did not return tool call. Response:", JSON.stringify(message));
      
      // Check if it's likely not a PO document
      if (textContent.toLowerCase().includes("not a purchase order") || 
          textContent.toLowerCase().includes("không phải") ||
          textContent.toLowerCase().includes("refund") ||
          textContent.toLowerCase().includes("receipt")) {
        return new Response(
          JSON.stringify({ 
            error: "Hình ảnh không phải là đơn đặt hàng (PO)", 
            details: textContent || "AI không thể nhận dạng đây là PO"
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      return new Response(
        JSON.stringify({ 
          error: "Không thể trích xuất dữ liệu từ hình ảnh",
          details: textContent || "AI không trả về dữ liệu cấu trúc"
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const extractedData = JSON.parse(toolCall.function.arguments);

    console.log(`[scan-purchase-order] Completed in ${Date.now() - startTime}ms, extracted ${extractedData.items?.length || 0} items`);
    return new Response(
      JSON.stringify({ success: true, data: extractedData }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[scan-purchase-order] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
