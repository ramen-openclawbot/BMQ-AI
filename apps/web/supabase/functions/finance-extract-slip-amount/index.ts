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
      // 41.006.300,00 -> decimal comma, thousand dots
      normalized = cleaned.replace(/\./g, "").replace(/,/g, ".");
    } else {
      // 41,006,300.00 -> decimal dot, thousand commas
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (commaCount > 0) {
    if (/^\d{1,3}(,\d{3})+(,\d{2})?$/.test(cleaned)) {
      // 2,700,000 or 2,700,000,00 -> treat commas as thousands separators
      const parts = cleaned.split(",");
      const maybeDecimal = parts[parts.length - 1];
      if (maybeDecimal.length === 2 && parts.length > 1) {
        normalized = parts.slice(0, -1).join("") + "." + maybeDecimal;
      } else {
        normalized = cleaned.replace(/,/g, "");
      }
    } else {
      // 2700000,00 -> decimal comma
      normalized = cleaned.replace(/,/g, ".");
    }
  } else if (dotCount > 0) {
    if (/^\d{1,3}(\.\d{3})+(\.\d{2})?$/.test(cleaned)) {
      const parts = cleaned.split(".");
      const maybeDecimal = parts[parts.length - 1];
      if (maybeDecimal.length === 2 && parts.length > 1) {
        normalized = parts.slice(0, -1).join("") + "." + maybeDecimal;
      } else {
        normalized = cleaned.replace(/\./g, "");
      }
    }
  }

  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    // Require authentication (was previously open to anyone)
    const { user } = await requireAuth(req, getCorsHeaders(req));

    // Rate limit: 200 calls/day per user
    const rateLimit = await checkAndRecordRateLimit(user.id, "finance-extract-slip-amount", 200);
    if (!rateLimit.allowed) {
      return jsonResponse({ error: "Bạn đã vượt quá giới hạn scan hôm nay. Vui lòng thử lại vào ngày mai.", code: "RATE_LIMIT_EXCEEDED" }, 429, { ...getCorsHeaders(req), ...getRateLimitHeaders(rateLimit) });
    }

    const { imageBase64, mimeType, slipType } = await req.json();
    if (!imageBase64) {
      return jsonResponse({ error: "No image provided" }, 400, getCorsHeaders(req));
    }

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      return jsonResponse({ error: "OPENAI_API_KEY missing" }, 503, getCorsHeaders(req));
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
- NEVER return account number, transaction id, phone number, OTP, timestamp, or balance as amount.
- amount MUST be a string preserving the original formatting from the image. Do NOT reorder digits or remove separators.
- Cross-check amount with the "Bằng chữ / In Words" line if visible on the slip.
- If there are multiple numbers, choose the final transfer amount that matches the payment transaction itself.
- If uncertain, still return best guess and lower confidence with notes.`;

    const userText = `Slip type: ${slipType || "unknown"}. Extract the transferred amount from this Vietnamese bank slip. Focus on the actual payment value, not account number or running balance.`;

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
      console.error("[finance-extract-slip-amount] OpenAI request failed:", errText || `HTTP ${ai.status}`);
      return jsonResponse({ error: "OpenAI request failed", detail: errText || `HTTP ${ai.status}` }, 502, getCorsHeaders(req));
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
      console.error("[finance-extract-slip-amount] Unable to extract amount", JSON.stringify(raw)?.slice(0, 2000));
      return jsonResponse({ error: "Unable to extract amount", detail: "Model did not return amount field", raw }, 422, getCorsHeaders(req));
    }

    // Parse Vietnamese-formatted amount string → number
    const rawAmount = data.amount;
    const parsedAmount = parseAmountVN(rawAmount);
    if (!parsedAmount) {
      console.error("[finance-extract-slip-amount] Failed to parse amount string", rawAmount);
      return jsonResponse({ error: "Failed to parse amount string", detail: `rawAmount=${rawAmount}`, rawAmount, raw }, 422, getCorsHeaders(req));
    }
    data.amount = parsedAmount;
    data.amount_raw = rawAmount; // Keep original string for audit

    return jsonResponse({ success: true, data }, 200, getCorsHeaders(req));
  } catch (e) {
    // requireAuth throws Response objects for 401 — re-throw them directly
    if (e instanceof Response) return e;
    const detail = e instanceof Error ? `${e.name}: ${e.message}` : "Unknown error";
    console.error("[finance-extract-slip-amount] Unhandled error:", detail);
    return jsonResponse({ error: e instanceof Error ? e.message : "Unknown error", detail }, 500, getCorsHeaders(req));
  }
});
