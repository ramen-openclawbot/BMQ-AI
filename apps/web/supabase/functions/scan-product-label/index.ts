// Supabase Edge Function: scan-product-label
// Uses OpenAI vision to extract product-label fields, then returns structured data.
// Configure OPENAI_API_KEY in Supabase secrets before deployment.

declare const Deno: { env: { get(key: string): string | undefined }; serve(handler: (req: Request) => Response | Promise<Response>): void };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ExtractProductLabelDataRequest {
  image_url?: string;
  image_base64?: string;
  sku_code?: string;
  product_name?: string;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeDate(value?: string | null) {
  if (!value) return null;
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const vn = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (vn) {
    const year = vn[3].length === 2 ? `20${vn[3]}` : vn[3];
    return `${year}-${vn[2].padStart(2, "0")}-${vn[1].padStart(2, "0")}`;
  }
  return text;
}

async function extract_product_label_data(payload: ExtractProductLabelDataRequest) {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const imageUrl = payload.image_url || (payload.image_base64 ? `data:image/jpeg;base64,${payload.image_base64}` : null);
  if (!imageUrl) throw new Error("Missing image_url or image_base64");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extract Vietnamese bakery product label data. Return JSON only with keys: product_code, product_name, manufacturing_date, expiry_date, net_weight_value, net_weight_unit, raw_text. Dates must be YYYY-MM-DD when possible.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `SKU: ${payload.sku_code || ""}\nProduct: ${payload.product_name || ""}\nRead NSX, HSD, weight, code, product name from this label.`,
            },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI label OCR failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  const parsed = JSON.parse(body.choices?.[0]?.message?.content || "{}");
  return {
    product_code: parsed.product_code || null,
    product_name: parsed.product_name || null,
    manufacturing_date: normalizeDate(parsed.manufacturing_date),
    expiry_date: normalizeDate(parsed.expiry_date),
    net_weight_value: parsed.net_weight_value == null ? null : Number(parsed.net_weight_value),
    net_weight_unit: parsed.net_weight_unit || null,
    raw_text: parsed.raw_text || null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const payload = (await req.json()) as ExtractProductLabelDataRequest;
    const data = await extract_product_label_data(payload);
    return jsonResponse({ data });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
