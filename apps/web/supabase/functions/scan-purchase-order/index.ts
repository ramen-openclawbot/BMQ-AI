import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// NOTE: Use npm specifier to avoid esm.sh drift/caching issues in edge runtime
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { checkAndRecordRateLimit, getRateLimitHeaders } from "../_shared/rate-limiter.ts";
import { applyNameSuffixUnits } from "../_shared/po-line-unit.ts";
import { checkScanTotals } from "../_shared/scan-total-check.ts";
import { aiErrorJson, getAiErrorInfo } from "../_shared/openai-errors.ts";
import { getScanAiConfig } from "../_shared/ai-vision-provider.ts";
import { extractPurchaseOrder, PurchaseOrderExtractError } from "./extract.ts";

serve(async (req) => {
  const startTime = Date.now();
  console.log("[scan-purchase-order] Request started");

  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  try {
    // Authentication check - simplified for prototype (no role check)
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      console.log("[scan-purchase-order] Missing authorization header");
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
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
        { status: 401, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    console.log("[scan-purchase-order] User authenticated:", user.id);

    // Rate limit: 100 calls/day per user
    const rateLimit = await checkAndRecordRateLimit(user.id, "scan-purchase-order", 100);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({ error: "Bạn đã vượt quá giới hạn scan hôm nay. Vui lòng thử lại vào ngày mai.", code: "RATE_LIMIT_EXCEEDED" }),
        { status: 429, headers: { ...getCorsHeaders(req), "Content-Type": "application/json", ...getRateLimitHeaders(rateLimit) } }
      );
    }

    const { imageBase64, mimeType, supplierVatConfig } = await req.json();

    if (!imageBase64) {
      return new Response(
        JSON.stringify({ error: "No image provided" }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // Validate image size (max 10MB base64 ~ 7.5MB raw)
    if (imageBase64.length > 10 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: "Image too large. Maximum size is 10MB." }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // Validate MIME type
    const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (mimeType && !allowedMimeTypes.includes(mimeType)) {
      return new Response(
        JSON.stringify({ error: "Invalid image type. Allowed: JPEG, PNG, WebP, GIF" }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    const scanAi = getScanAiConfig();
    if (!scanAi.apiKey) {
      console.error(`[scan-purchase-order] ${scanAi.keyName} not configured`);
      throw new Error(`${scanAi.keyName} is not configured`);
    }

    const {
      data: extractedData,
      engine: ocrEngine,
      fallbackReason: ocrFallbackReason,
    } = await extractPurchaseOrder({
      imageBase64,
      mimeType,
      promptInputs: { supplierVatConfig },
    });

    // The AI often keeps the unit inside the trailing "(...)" of the product
    // name; recover it deterministically instead of trusting the model's unit.
    if (Array.isArray(extractedData.items)) {
      extractedData.items = applyNameSuffixUnits(extractedData.items);
    }

    // Re-compute every line and the printed subtotal so the UI can warn on
    // OCR drift instead of trusting the model's arithmetic.
    const totalCheck = checkScanTotals(extractedData);
    extractedData.subtotal_amount = totalCheck.subtotal_amount;
    extractedData.warnings = totalCheck.warnings;
    console.log(`[scan-purchase-order] Total check: ${totalCheck.warnings.length} warning(s)`);

    console.log(`[scan-purchase-order] Completed in ${Date.now() - startTime}ms, extracted ${(extractedData.items as unknown[] | undefined)?.length || 0} items`);
    return new Response(
      JSON.stringify({
        success: true,
        data: extractedData,
        ocr_engine: ocrEngine,
        ocr_fallback_reason: ocrFallbackReason,
      }),
      { headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[scan-purchase-order] Error:", error);
    if (error instanceof PurchaseOrderExtractError) {
      return new Response(
        JSON.stringify({ error: error.message, details: error.details }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }
    const aiInfo = getAiErrorInfo(error);
    if (aiInfo) {
      return new Response(JSON.stringify(aiErrorJson(aiInfo)), {
        status: aiInfo.httpStatus,
        headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
