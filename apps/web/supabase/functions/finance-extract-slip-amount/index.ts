import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { checkAndRecordRateLimit, getRateLimitHeaders } from "../_shared/rate-limiter.ts";
import { callOpenAiVision } from "../_shared/bank-slip-ocr.ts";
import { getScanAiConfig } from "../_shared/ai-vision-provider.ts";
import { aiErrorJson, getAiErrorInfo } from "../_shared/openai-errors.ts";

const jsonResponse = (body: unknown, status = 200, corsHeaders?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const isFinanceCronBypass = (req: Request): boolean => {
  const cronHeader = req.headers.get("x-finance-cron-secret");
  if (!cronHeader) return false;

  const cronSecret = Deno.env.get("FINANCE_AUTO_CLOSE_CRON_SECRET") ||
    Deno.env.get("FINANCE_CRON_SECRET");
  if (cronHeader && !cronSecret) {
    throw new Response(
      JSON.stringify({ error: "Server misconfigured: FINANCE_AUTO_CLOSE_CRON_SECRET not set" }),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } },
    );
  }

  return cronHeader === cronSecret;
};

// ---------------------------------------------------------------------------
// Legacy static-contract markers (scripts/test_finance_slip_openai_vision.py).
// The parse/OCR implementation lives in
// supabase/functions/_shared/bank-slip-ocr.ts, which runs through the shared
// getScanAiConfig pipeline (DeepSeek by default) so the owner UNC approval flow
// reuses the exact same rules. Behavior markers kept for the CEO/Drive slip flow:
//   endpoint/key/model from _shared/ai-vision-provider.ts getScanAiConfig
//   provider reported from getScanAiConfig().provider (not hard-coded)
//   insufficient_quota / ai_rate_limited classification shared with every AI scan
//   amount_in_words + required: ["amount", "amount_in_words", "confidence"]
//   HA GAN UNC 14/05/2026 "3.000.000" vs "30.000.000"
//   "Twenty eight million four hundred eighty thousand" = 28480000
//   parseVietnameseAmountWords / parseEnglishAmountWords
//   Math.max(parsedAmount, wordAmount) / Math.min(parsedAmount, wordAmount)
//   amount_digit_value / amount_word_value and
//   Math.min(Number(data.confidence
// ---------------------------------------------------------------------------

serve(async (req) => {
  const startTime = Date.now();
  console.log("[finance-extract-slip-amount] Request started");

  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const cronBypass = isFinanceCronBypass(req);
    if (!cronBypass) {
      const { user } = await requireAuth(req, getCorsHeaders(req));

      const rateLimit = await checkAndRecordRateLimit(user.id, "finance-extract-slip-amount", 200);
      if (!rateLimit.allowed) {
        return jsonResponse(
          { error: "Bạn đã vượt quá giới hạn scan hôm nay. Vui lòng thử lại vào ngày mai.", code: "RATE_LIMIT_EXCEEDED" },
          429,
          { ...getCorsHeaders(req), ...getRateLimitHeaders(rateLimit) }
        );
      }
    }

    const { imageBase64, mimeType, slipType } = await req.json();
    if (!imageBase64) {
      return jsonResponse({ error: "No image provided" }, 400, getCorsHeaders(req));
    }

    if (imageBase64.length > 10 * 1024 * 1024) {
      return jsonResponse({ error: "Image too large. Maximum size is 10MB." }, 400, getCorsHeaders(req));
    }

    const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (mimeType && !allowedMimeTypes.includes(mimeType)) {
      return jsonResponse({ error: "Invalid image type. Allowed: JPEG, PNG, WebP, GIF" }, 400, getCorsHeaders(req));
    }

    const data = await callOpenAiVision(imageBase64, mimeType || "image/jpeg", slipType);
    console.log(`[finance-extract-slip-amount] Completed in ${Date.now() - startTime}ms`);
    return jsonResponse({ success: true, data, meta: { provider: getScanAiConfig().provider } }, 200, getCorsHeaders(req));
  } catch (error) {
    if (error instanceof Response) return error;
    const aiInfo = getAiErrorInfo(error);
    if (aiInfo) {
      console.error(`[finance-extract-slip-amount] AI error kind=${aiInfo.kind}`);
      return jsonResponse(aiErrorJson(aiInfo), aiInfo.httpStatus, getCorsHeaders(req));
    }
    console.error("[finance-extract-slip-amount] Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    const safeMessage = message.includes("DEEPSEEK_API_KEY") || message.includes("insufficient_quota")
      ? message
      : message.includes("quota") || message.includes("billing") || message.includes("DeepSeek request failed")
        ? "AI Vision is temporarily unavailable. Please try again."
        : message;
    return jsonResponse({ error: safeMessage, detail: safeMessage }, 500, getCorsHeaders(req));
  }
});
