import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { checkAndRecordRateLimit, getRateLimitHeaders } from "../_shared/rate-limiter.ts";
import { classifyFinanceOcrBackendFailure } from "../../../src/lib/finance-ocr.js";

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

const parseBackendAmount = (data: any) => {
  const rawAmount = data?.amount_raw ?? data?.amount;
  const parsedAmount = parseAmountVN(rawAmount);
  if (!parsedAmount) {
    return null;
  }

  return {
    ...data,
    amount: parsedAmount,
    amount_raw: rawAmount,
  };
};

const callBackendGpuOcr = async (imageBase64: string, mimeType: string, slipType?: string) => {
  const backendUrl = (Deno.env.get("BACKEND_PADDLE_OCR_URL") || Deno.env.get("BACKEND_GPU_OCR_URL") || "").trim();
  if (!backendUrl) return null;

  const backendApiKey = (Deno.env.get("BACKEND_PADDLE_OCR_API_KEY") || Deno.env.get("BACKEND_GPU_OCR_API_KEY") || "").trim();
  const timeoutMs = Number(Deno.env.get("BACKEND_PADDLE_OCR_TIMEOUT_MS") || Deno.env.get("BACKEND_GPU_OCR_TIMEOUT_MS") || "45000");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(backendUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(backendApiKey ? { "X-OCR-Api-Key": backendApiKey } : {}),
    },
    body: JSON.stringify({ imageBase64, mimeType, slipType }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error || payload?.detail || `HTTP ${response.status}`;
    throw new Error(`GPU OCR backend failed: ${detail}`);
  }

  const data = parseBackendAmount(payload?.data);
  if (!data) {
    throw new Error("GPU OCR backend returned invalid amount");
  }

  return data;
};

const callOpenAiFallback = async (imageBase64: string, mimeType: string, slipType?: string) => {
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  const system = `You extract transfer amount from Vietnamese bank slips.
Return only JSON via tool with fields:
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

  const userText = `Slip type: ${slipType || "unknown"}. Extract the transferred amount from this Vietnamese bank slip. Focus on the actual payment value. If the slip is a Vietcombank/VCB debit advice, prefer the number next to Debit Amount / Credit Amount and cross-check with the In Words line.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const ai = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
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
    throw new Error(`OpenAI request failed: ${errText || `HTTP ${ai.status}`}`);
  }

  const raw = await ai.json();
  const args = raw?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  let data: any = null;
  try {
    data = args ? JSON.parse(args) : null;
  } catch {
    data = null;
  }

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
    provider: "openai-fallback",
  };
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

    let backendFailure: ReturnType<typeof classifyFinanceOcrBackendFailure> | null = null;

    try {
      const backendData = await callBackendGpuOcr(imageBase64, mimeType || "image/jpeg", slipType);
      if (backendData) {
        return jsonResponse({
          success: true,
          data: backendData,
          meta: {
            provider: backendData.provider || "paddleocr",
            backendStatus: "ok",
            fallbackUsed: false,
          },
        }, 200, getCorsHeaders(req));
      }
    } catch (backendError) {
      backendFailure = classifyFinanceOcrBackendFailure(backendError);
      console.error(
        "[finance-extract-slip-amount] PaddleOCR backend failed, fallback to OpenAI:",
        backendFailure.detail,
      );
    }

    try {
      const fallbackData = await callOpenAiFallback(imageBase64, mimeType || "image/jpeg", slipType);
      return jsonResponse({
        success: true,
        data: fallbackData,
        meta: {
          provider: fallbackData.provider || "openai-fallback",
          backendStatus: backendFailure?.backendStatus || (fallbackData.provider ? "ok" : undefined),
          fallbackUsed: !!backendFailure,
          warningCode: backendFailure?.warningCode,
          warningMessage: null,
        },
      }, 200, getCorsHeaders(req));
    } catch (fallbackError) {
      if (backendFailure) {
        const fallbackDetail = fallbackError instanceof Error ? `${fallbackError.name}: ${fallbackError.message}` : String(fallbackError || "Unknown fallback error");
        return jsonResponse({
          error: backendFailure.warningMessage,
          code: backendFailure.warningCode,
          detail: `PaddleOCR backend failed: ${backendFailure.detail}. OpenAI fallback failed: ${fallbackDetail}`,
        }, 503, getCorsHeaders(req));
      }
      throw fallbackError;
    }
  } catch (e) {
    if (e instanceof Response) return e;
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : "Unknown error";
    console.error("[finance-extract-slip-amount] Unhandled error:", detail);
    return jsonResponse({ error: e instanceof Error ? e.message : "Unknown error", detail }, 500, getCorsHeaders(req));
  }
});
