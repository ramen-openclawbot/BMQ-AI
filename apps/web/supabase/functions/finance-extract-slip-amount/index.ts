import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { checkAndRecordRateLimit, getRateLimitHeaders } from "../_shared/rate-limiter.ts";

const jsonResponse = (body: unknown, status = 200, corsHeaders?: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/** Parse common VN/EN bank-slip amount strings to number.
 *  Examples:
 *  - "41.006.300,00" -> 41006300
 *  - "41.006.300" -> 41006300
 *  - "2,700,000 VND" -> 2700000
 *  - "2.700.000 VND" -> 2700000
 */
const parseAmountVN = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const raw = String(v ?? "").trim();
  if (!raw) return null;

  const cleaned = raw.replace(/\s+/g, "").replace(/[^0-9,.-]/g, "");
  if (!cleaned) return null;

  const commaCount = (cleaned.match(/,/g) || []).length;
  const dotCount = (cleaned.match(/\./g) || []).length;

  let normalized = cleaned;

  if (commaCount > 0 && dotCount > 0) {
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, "").replace(/,(?=\d{2}$)/, ".").replace(/,/g, "");
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (commaCount > 0) {
    const parts = cleaned.split(",");
    const tail = parts[parts.length - 1] || "";
    if (parts.length > 2 || (parts.length > 1 && tail.length === 3)) {
      normalized = cleaned.replace(/,/g, "");
    } else if (tail.length === 2) {
      normalized = cleaned.replace(/,/g, ".");
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (dotCount > 0) {
    const parts = cleaned.split(".");
    const tail = parts[parts.length - 1] || "";
    if (parts.length > 2 || (parts.length > 1 && tail.length === 3)) {
      normalized = cleaned.replace(/\./g, "");
    } else if (tail.length === 2) {
      normalized = cleaned;
    } else {
      normalized = cleaned.replace(/\./g, "");
    }
  }

  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

const SLIP_EXTRACTION_SYSTEM_PROMPT = `You extract transfer amount from Vietnamese bank slips.
Return only JSON with fields:
- amount: STRING — the exact amount as shown on the slip, preserving dots and commas. Example: "41.006.300,00" or "41.006.300". Do NOT convert to a plain number. In Vietnamese format, dots (.) are thousands separators and commas (,) are decimal separators.
- transfer_date: string | null (YYYY-MM-DD if found)
- reference: string | null
- confidence: number (0..1)
- notes: string | null

Rules:
- Read the actual transferred amount / paid amount from the slip.
- Prioritize fields such as: "Số tiền", "Số tiền chuyển", "Giá trị giao dịch", "Amount", "Credit amount", "Debit amount", "Số tiền ghi nợ", "Số tiền ghi có".
- For Vietcombank / VCB / DigiBiz debit advice layouts, prioritize the amount shown next to "Số tiền nợ / Debit Amount" or "Số tiền có / Credit Amount".
- NEVER return account number, transaction id, document number, reference code, phone number, OTP, date, timestamp, or balance as amount.
- amount MUST be a string preserving the original formatting from the image. Do NOT reorder digits or remove separators.
- Cross-check amount with the "Bằng chữ / In Words" line if visible on the slip.
- If there are multiple numbers, choose the payment amount from the debit/credit amount field, not identifiers elsewhere on the slip.
- If uncertain, still return best guess and lower confidence with notes.`;

const slipUserPrompt = (slipType?: string) => `Slip type: ${slipType || "unknown"}. Extract the transferred amount from this Vietnamese bank slip. Focus on the actual payment value. If the slip is a Vietcombank/VCB debit advice, prefer the number next to Debit Amount / Credit Amount and cross-check with the In Words line. Return valid JSON only.`;

const normalizeExtractedSlip = (data: any, provider: "openai" | "gemini_fallback") => {
  if (!data || !data.amount) {
    throw new Error("Model did not return amount field");
  }

  const parsedAmount = parseAmountVN(data.amount);
  if (!parsedAmount) {
    throw new Error(`Failed to parse amount string: ${data.amount}`);
  }

  return {
    ...data,
    amount: parsedAmount,
    amount_raw: data.amount,
    provider,
  };
};

class OpenAiQuotaError extends Error {
  constructor(message = "OpenAI quota exceeded") {
    super(message);
    this.name = "OpenAiQuotaError";
  }
}

const isOpenAiQuotaStatus = (status: number) => status === 402 || status === 429;

const isOpenAiQuotaPayload = (raw: string) => {
  const lower = raw.toLowerCase();
  return lower.includes("insufficient_quota") || lower.includes("exceeded your current quota") || lower.includes("billing details");
};

const parseJsonFromText = (text: string) => {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const jsonText = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  return JSON.parse(jsonText);
};

const callOpenAiVision = async (imageBase64: string, mimeType: string, slipType?: string) => {
  const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY missing");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const ai = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini",
      messages: [
        { role: "system", content: SLIP_EXTRACTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: slipUserPrompt(slipType) },
            { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}` } },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "extract_slip",
            description: "Extract amount and key metadata from bank slip",
            parameters: {
              type: "object",
              properties: {
                amount: { type: "string", description: "Exact amount string as shown on slip, preserving dots and commas. E.g. '41.006.300,00'" },
                transfer_date: { type: ["string", "null"] },
                reference: { type: ["string", "null"] },
                confidence: { type: "number" },
                notes: { type: ["string", "null"] },
              },
              required: ["amount", "confidence"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "extract_slip" } },
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!ai.ok) {
    const errText = await ai.text().catch(() => "");
    if (isOpenAiQuotaStatus(ai.status) || isOpenAiQuotaPayload(errText)) {
      throw new OpenAiQuotaError();
    }
    console.error("[finance-extract-slip-amount] OpenAI request failed", { status: ai.status, bodyPreview: errText.slice(0, 240) });
    throw new Error("OpenAI Vision is temporarily unavailable. Please try again.");
  }

  const raw = await ai.json();
  const args = raw?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  let data: any = null;
  try {
    data = args ? JSON.parse(args) : null;
  } catch {
    data = null;
  }

  return normalizeExtractedSlip(data, "openai");
};

const callGeminiVisionFallback = async (imageBase64: string, mimeType: string, slipType?: string) => {
  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiApiKey) {
    throw new Error("AI Vision quota exceeded and fallback provider is not configured");
  }

  const prompt = `${SLIP_EXTRACTION_SYSTEM_PROMPT}\n\n${slipUserPrompt(slipType)}\nReturn JSON only. Do not wrap in markdown.`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: mimeType || "image/jpeg", data: imageBase64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
      },
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    console.error("[finance-extract-slip-amount] Gemini fallback failed", { status: response.status, bodyPreview: errText.slice(0, 240) });
    throw new Error("AI Vision is temporarily unavailable. Please try again.");
  }

  const raw = await response.json();
  const text = raw?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join("\n") || "";
  const data = parseJsonFromText(text);
  return normalizeExtractedSlip(data, "gemini_fallback");
};

const extractSlipWithVision = async (imageBase64: string, mimeType: string, slipType?: string) => {
  try {
    return await callOpenAiVision(imageBase64, mimeType, slipType);
  } catch (error) {
    if (error instanceof OpenAiQuotaError) {
      console.warn("[finance-extract-slip-amount] OpenAI quota exceeded; using Gemini Vision fallback");
      return await callGeminiVisionFallback(imageBase64, mimeType, slipType);
    }
    throw error;
  }
};

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const { user } = await requireAuth(req, getCorsHeaders(req));

    const rateLimit = await checkAndRecordRateLimit(user.id, "finance-extract-slip-amount", 200);
    if (!rateLimit.allowed) {
      return jsonResponse({ error: "Bạn đã vượt quá giới hạn scan hôm nay. Vui lòng thử lại vào ngày mai.", code: "RATE_LIMIT_EXCEEDED" }, 429, { ...getCorsHeaders(req), ...getRateLimitHeaders(rateLimit) });
    }

    const { imageBase64, mimeType, slipType } = await req.json();
    if (!imageBase64) {
      return jsonResponse({ error: "No image provided" }, 400, getCorsHeaders(req));
    }

    const data = await extractSlipWithVision(imageBase64, mimeType || "image/jpeg", slipType);
    return jsonResponse({
      success: true,
      data,
      meta: {
        provider: data.provider || "openai",
      },
    }, 200, getCorsHeaders(req));
  } catch (e) {
    if (e instanceof Response) return e;
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : "Unknown error";
    console.error("[finance-extract-slip-amount] Unhandled error:", detail);
    const message = e instanceof Error ? e.message : "Unknown error";
    const safeMessage = message.includes("quota") || message.includes("billing") || message.includes("OpenAI request failed")
      ? "AI Vision is temporarily unavailable. Please try again."
      : message;
    return jsonResponse({ error: safeMessage, detail: safeMessage }, 500, getCorsHeaders(req));
  }
});
