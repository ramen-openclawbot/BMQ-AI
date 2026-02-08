import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// NOTE: Use npm specifier to avoid esm.sh drift/caching issues in edge runtime
import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  const startTime = Date.now();
  console.log("[scan-invoice] Request started");

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authentication check - simplified for prototype (no role check)
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      console.log("[scan-invoice] Missing authorization header");
      return new Response(
        JSON.stringify({ error: "Unauthorized - Missing or invalid authorization header" }),
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
      console.log("[scan-invoice] Invalid JWT:", authError?.message);
      return new Response(
        JSON.stringify({ code: 401, message: "Invalid JWT", details: authError?.message }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("[scan-invoice] User authenticated:", user.id);

    const { imageBase64, mimeType } = await req.json();

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
      console.error("[scan-invoice] LOVABLE_API_KEY not configured");
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const systemPrompt = `You are an expert invoice data extractor. Analyze the provided invoice image and extract all relevant information.

Extract the following data from the invoice:
1. Invoice number (Số hóa đơn, Số HD, No.)
2. Invoice date (Ngày, Date) - format as YYYY-MM-DD
3. Supplier name if visible
4. VAT amount if present (VAT, Thuế GTGT)
5. All line items with:
   - Product code (Mã hàng, Code) if available
   - Product name (Tên hàng, Tên sản phẩm, Description)
   - Unit (Đơn vị tính, ĐVT) - common units: kg, g, con, thùng, chai, lon, gói, hộp
   - Quantity (Số lượng, SL)
   - Unit price (Đơn giá, Giá)

Important notes:
- Vietnamese invoices often use Vietnamese text
- Numbers may use comma as decimal separator (e.g., 1.000,00 = 1000.00)
- Extract ALL line items visible on the invoice
- If a value is not visible, leave it as null or empty string
- For quantities and prices, convert to numbers (remove thousand separators)`;

    console.log("[scan-invoice] Calling AI gateway");
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
                  invoice_number: {
                    type: "string",
                    description: "The invoice number/ID",
                  },
                  invoice_date: {
                    type: "string",
                    description: "Invoice date in YYYY-MM-DD format",
                  },
                  supplier_name: {
                    type: "string",
                    description: "Name of the supplier/vendor",
                  },
                  vat_amount: {
                    type: "number",
                    description: "VAT/tax amount in VND",
                  },
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        product_code: {
                          type: "string",
                          description: "Product code if available",
                        },
                        product_name: {
                          type: "string",
                          description: "Name of the product",
                        },
                        unit: {
                          type: "string",
                          description: "Unit of measurement (kg, g, con, etc.)",
                        },
                        quantity: {
                          type: "number",
                          description: "Quantity ordered",
                        },
                        unit_price: {
                          type: "number",
                          description: "Price per unit in VND",
                        },
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
        console.log("[scan-invoice] Rate limit exceeded");
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        console.log("[scan-invoice] AI credits exhausted");
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Please add more credits." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errorText = await response.text();
      console.error("[scan-invoice] AI gateway error:", response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const aiResponse = await response.json();
    const toolCall = aiResponse.choices?.[0]?.message?.tool_calls?.[0];

    if (!toolCall || toolCall.function.name !== "extract_invoice_data") {
      console.error("[scan-invoice] Failed to extract invoice data from image");
      throw new Error("Failed to extract invoice data from image");
    }

    const extractedData = JSON.parse(toolCall.function.arguments);

    console.log(`[scan-invoice] Completed in ${Date.now() - startTime}ms, extracted ${extractedData.items?.length || 0} items`);
    return new Response(
      JSON.stringify({ success: true, data: extractedData }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[scan-invoice] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
