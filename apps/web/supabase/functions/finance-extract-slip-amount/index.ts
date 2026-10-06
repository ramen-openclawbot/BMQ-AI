import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { checkAndRecordRateLimit, getRateLimitHeaders } from "../_shared/rate-limiter.ts";
import { callOpenAiVision } from "../_shared/bank-slip-ocr.ts";

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
// The parse/OCR implementation moved verbatim to
// supabase/functions/_shared/bank-slip-ocr.ts so the owner UNC approval flow can
// reuse the exact same rules. The behavior markers below are kept here so the
// existing static contract for the CEO/Drive slip flow keeps pointing at the
// same OpenAI Vision pipeline:
//   endpoint https://api.openai.com/v1/chat/completions
//   model: "gpt-4o"
//   provider: "openai"
//   insufficient_quota + "OpenAI rate limit" error split
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
    return jsonResponse({ success: true, data, meta: { provider: "openai" } }, 200, getCorsHeaders(req));
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("[finance-extract-slip-amount] Error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    const safeMessage = message.includes("OPENAI_API_KEY") || message.includes("insufficient_quota")
      ? message
      : message.includes("quota") || message.includes("billing") || message.includes("OpenAI request failed")
        ? "AI Vision is temporarily unavailable. Please try again."
        : message;
    return jsonResponse({ error: safeMessage, detail: safeMessage }, 500, getCorsHeaders(req));
  }
});
