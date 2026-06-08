// Supabase Edge Function: scan-product-label
// Uses OpenAI vision to extract product-label fields, then returns structured data.
// Configure OPENAI_API_KEY in Supabase secrets before deployment.

declare const Deno: { env: { get(key: string): string | undefined }; serve(handler: (req: Request) => Response | Promise<Response>): void };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface BarcodeBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ExtractProductLabelDataRequest {
  image_url?: string;
  image_base64?: string;
  image_mime_type?: string;
  sku_code?: string;
  product_name?: string;
  barcode_value?: string;
  partner_product_code?: string;
  detect_barcode_bbox?: boolean;
  expected_barcode_image_url?: string;
  expected_manufacturing_date?: string;
  expected_expiry_date?: string;
  expected_net_weight_value?: number;
}

function normalizeBox(value: unknown): BarcodeBoundingBox | null {
  const raw = value as Partial<BarcodeBoundingBox> | null | undefined;
  if (!raw) return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.max(0.01, Math.min(1, width)),
    height: Math.max(0.01, Math.min(1, height)),
  };
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

  const allowedImageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  const imageMimeType = payload.image_mime_type && allowedImageMimeTypes.has(payload.image_mime_type) ? payload.image_mime_type : "image/jpeg";
  const imageUrl = payload.image_url || (payload.image_base64 ? `data:${imageMimeType};base64,${payload.image_base64}` : null);
  if (!imageUrl) throw new Error("Missing image_url or image_base64");

  const qaScanOnly = !payload.detect_barcode_bbox && !payload.expected_barcode_image_url;
  const systemPrompt = qaScanOnly
    ? "Extract Vietnamese bakery product label data for QA pass. Return JSON only with keys: product_code, barcode, partner_product_code, product_name, manufacturing_date, expiry_date, net_weight_value, net_weight_unit, barcode_bbox, barcode_crop_confidence, barcode_visual_match, barcode_visual_match_confidence, barcode_visual_match_reason, raw_text. For QA pass, focus only on NSX/manufacturing_date, HSD/expiry_date, and net weight. The NSX/HSD date stamp is often small and near the lower-right corner of the label; inspect that lower-right date stamp carefully before using other label text. Expected dates are hints for reading the image, not values to copy if not visible. Do not compare barcode and leave barcode_bbox, barcode_crop_confidence, barcode_visual_match, barcode_visual_match_confidence, and barcode_visual_match_reason null. Dates must be YYYY-MM-DD when possible."
    : "Extract Vietnamese bakery product label data. Return JSON only with keys: product_code, barcode, partner_product_code, product_name, manufacturing_date, expiry_date, net_weight_value, net_weight_unit, barcode_bbox, barcode_crop_confidence, barcode_visual_match, barcode_visual_match_confidence, barcode_visual_match_reason, raw_text. product_code is the visible product/SKU code on the label if present; barcode is the printed barcode digits/value; partner_product_code is the partner-regulated product code printed below the barcode or near the barcode. Dates must be YYYY-MM-DD when possible. If requested, detect the barcode bounding box as normalized image coordinates: barcode_bbox={x,y,width,height} with values from 0 to 1, tightly around the printed 1D barcode bars only, not the product code text, not the barcode digits, not QR codes, and not the whole label. If a second image is provided as the expected barcode reference, compare only the 1D barcode on the scanned label against that reference image. Set barcode_visual_match=true only when the scanned barcode bars/digits/encoded value match the reference; set false when different or uncertain, and explain briefly in barcode_visual_match_reason.";
  const expectedHints = qaScanOnly
    ? `\nExpected NSX/manufacturing date: ${payload.expected_manufacturing_date || ""}\nExpected HSD/expiry date: ${payload.expected_expiry_date || ""}\nExpected net weight: ${payload.expected_net_weight_value ?? ""}`
    : "";
  const userInstruction = qaScanOnly
    ? `SKU: ${payload.sku_code || ""}\nProduct: ${payload.product_name || ""}${expectedHints}\nRead only NSX, HSD, net weight, and raw OCR text from the scanned label image. Prioritize the printed date stamp, usually near the lower-right corner. Do not test barcode for QA pass.`
    : `SKU: ${payload.sku_code || ""}\nProduct: ${payload.product_name || ""}\nExpected barcode: ${payload.barcode_value || ""}\nExpected partner product code: ${payload.partner_product_code || ""}\nBarcode box requested: ${payload.detect_barcode_bbox ? "yes" : "no"}\nExpected barcode reference image provided: ${payload.expected_barcode_image_url ? "yes" : "no"}\nRead NSX, HSD, weight, barcode, partner product code, product code, and product name from the scanned label image. If Barcode box requested is yes, detect the barcode bounding box for cropping. If an expected barcode reference image is provided, compare the scanned label barcode with that reference and return barcode_visual_match fields.`;

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
          content: systemPrompt,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userInstruction,
            },
            { type: "image_url", image_url: { url: imageUrl } },
            ...(payload.expected_barcode_image_url
              ? [
                  { type: "text", text: "Expected barcode reference image for visual comparison:" },
                  { type: "image_url", image_url: { url: payload.expected_barcode_image_url } },
                ]
              : []),
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
    product_code: parsed.product_code || parsed.partner_product_code || null,
    barcode: parsed.barcode || null,
    partner_product_code: parsed.partner_product_code || parsed.product_code || null,
    product_name: parsed.product_name || null,
    manufacturing_date: normalizeDate(parsed.manufacturing_date),
    expiry_date: normalizeDate(parsed.expiry_date),
    net_weight_value: parsed.net_weight_value == null ? null : Number(parsed.net_weight_value),
    net_weight_unit: parsed.net_weight_unit || null,
    barcode_bbox: normalizeBox(parsed.barcode_bbox),
    barcode_crop_confidence: parsed.barcode_crop_confidence == null ? null : Number(parsed.barcode_crop_confidence),
    barcode_visual_match: payload.expected_barcode_image_url ? parsed.barcode_visual_match === true : null,
    barcode_visual_match_confidence: parsed.barcode_visual_match_confidence == null ? null : Number(parsed.barcode_visual_match_confidence),
    barcode_visual_match_reason: parsed.barcode_visual_match_reason || null,
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
