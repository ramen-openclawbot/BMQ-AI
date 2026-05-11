import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { checkAndRecordRateLimit, getRateLimitHeaders } from "../_shared/rate-limiter.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
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
    normalized = lastComma > lastDot
      ? cleaned.replace(/\./g, "").replace(/,(?=\d{2}$)/, ".").replace(/,/g, "")
      : cleaned.replace(/,/g, "");
  } else if (commaCount > 0) {
    const parts = cleaned.split(",");
    const tail = parts[parts.length - 1] || "";
    normalized = parts.length > 2 || tail.length === 3
      ? cleaned.replace(/,/g, "")
      : tail.length === 2
        ? cleaned.replace(/,/g, ".")
        : cleaned.replace(/,/g, "");
  } else if (dotCount > 0) {
    const parts = cleaned.split(".");
    const tail = parts[parts.length - 1] || "";
    normalized = parts.length > 2 || tail.length === 3
      ? cleaned.replace(/\./g, "")
      : tail.length === 2
        ? cleaned
        : cleaned.replace(/\./g, "");
  }

  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

const stripVietnamese = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();

const WORD_DIGITS: Record<string, number> = {
  khong: 0,
  mot: 1,
  motj: 1,
  hai: 2,
  ba: 3,
  bon: 4,
  tu: 4,
  nam: 5,
  lam: 5,
  sau: 6,
  bay: 7,
  tam: 8,
  chin: 9,
};

const parseVietnameseAmountGroup = (tokens: string[]): number => {
  const compact = tokens.filter((token) => token && token !== "linh" && token !== "le" && token !== "va");
  let value = 0;
  let i = 0;

  const digitAt = (index: number) => WORD_DIGITS[compact[index] || ""];

  const hundredIndex = compact.indexOf("tram");
  if (hundredIndex > 0) {
    value += (digitAt(hundredIndex - 1) ?? 0) * 100;
    i = hundredIndex + 1;
  }

  if (compact[i] === "muoi") {
    value += 10;
    i += 1;
  } else if (compact[i + 1] === "muoi") {
    value += (digitAt(i) ?? 0) * 10;
    i += 2;
  }

  const ones = digitAt(i);
  if (ones !== undefined) value += ones;

  return value;
};

const parseVietnameseAmountWords = (value: unknown): number | null => {
  const raw = stripVietnamese(String(value ?? ""));
  if (!raw || !(raw.includes("dong") || raw.includes("nghin") || raw.includes("ngan") || raw.includes("trieu"))) return null;

  const tokens = raw
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !["bang", "chu", "so", "tien", "vnd"].includes(token));

  let total = 0;
  let group: string[] = [];

  for (const token of tokens) {
    if (token === "ty" || token === "trieu" || token === "nghin" || token === "ngan" || token === "dong") {
      const groupValue = parseVietnameseAmountGroup(group);
      if (token === "ty") total += groupValue * 1_000_000_000;
      else if (token === "trieu") total += groupValue * 1_000_000;
      else if (token === "nghin" || token === "ngan") total += groupValue * 1_000;
      else total += groupValue;
      group = [];
      if (token === "dong") break;
    } else {
      group.push(token);
    }
  }

  if (group.length > 0) total += parseVietnameseAmountGroup(group);
  return Number.isFinite(total) && total > 0 ? total : null;
};

const SLIP_EXTRACTION_SYSTEM_PROMPT = `Bạn là chuyên gia trích xuất số tiền từ ảnh UNC/QTM/bank slip tiếng Việt.

Hãy trích xuất các trường sau:
1. amount: số tiền thực chuyển/thực chi — trả về dạng CHUỖI chính xác như hiển thị trên ảnh (VD: "41.006.300" hoặc "41.006.300,00"). KHÔNG tự tính toán, KHÔNG đổi thứ tự chữ số, KHÔNG bỏ dấu chấm/phẩy.
2. amount_in_words: dòng số tiền bằng chữ nếu ảnh có hiển thị, giữ nguyên tiếng Việt/English trên ảnh; nếu không có thì null.
3. transfer_date: ngày giao dịch (YYYY-MM-DD nếu có thể)
4. reference: mã giao dịch/tham chiếu nếu có
5. confidence: độ tin cậy từ 0 đến 1
6. notes: ghi chú ngắn nếu ảnh mờ hoặc có nhiều số tiền

Quy tắc quan trọng:
- amount PHẢI là string, giữ nguyên định dạng gốc trên ảnh.
- Trong tiếng Việt, dấu chấm (.) là phân cách hàng nghìn, dấu phẩy (,) là phân cách thập phân. VD: "41.006.300,00" = bốn mươi mốt triệu không trăm linh sáu nghìn ba trăm đồng.
- Ưu tiên các nhãn: "Số tiền", "Số tiền chuyển", "Giá trị giao dịch", "Amount", "Debit Amount", "Credit Amount", "Số tiền nợ", "Số tiền có".
- Với Vietcombank / VCB / DigiBiz debit advice, ưu tiên số cạnh "Debit Amount" hoặc "Credit Amount" và đối chiếu dòng "In Words / Bằng chữ" nếu thấy.
- Luôn trích xuất amount_in_words từ dòng "In Words", "Bằng chữ", "Số tiền bằng chữ" nếu có. Nếu amount dạng số và bằng chữ không cùng bậc giá trị, amount_in_words sẽ được dùng để phát hiện lỗi OCR.
- KHÔNG lấy số tài khoản, số chứng từ, mã giao dịch, số điện thoại, ngày giờ, OTP, số dư làm amount.
- Nếu có nhiều số, chọn số tiền thanh toán/chuyển khoản thực tế.
- Nếu không chắc, vẫn trả best guess và giảm confidence.

Trả về JSON.`;

const slipUserPrompt = (slipType?: string) =>
  `Slip type: ${slipType || "unknown"}. Trích xuất số tiền thực chuyển/thực chi từ ảnh UNC/QTM/bank slip này. Trả về đúng schema JSON.`;

type ExtractedSlipData = {
  amount?: unknown;
  amount_in_words?: unknown;
  confidence?: unknown;
  notes?: unknown;
  [key: string]: unknown;
};

const normalizeExtractedSlip = (data: ExtractedSlipData) => {
  if (!data || !data.amount) {
    throw new Error("AI did not return amount field");
  }

  const parsedAmount = parseAmountVN(data.amount);
  if (!parsedAmount) {
    throw new Error(`Failed to parse amount string: ${data.amount}`);
  }

  const wordAmount = parseVietnameseAmountWords(data.amount_in_words || data.notes);
  const ratio = wordAmount ? parsedAmount / wordAmount : 1;
  const shouldTrustWords = Boolean(
    wordAmount
      && wordAmount > 0
      && parsedAmount !== wordAmount
      && Number.isInteger(ratio)
      && [10, 100, 1000].includes(ratio)
  );
  const amount = shouldTrustWords ? wordAmount : parsedAmount;
  const confidence = shouldTrustWords
    ? Math.min(Number(data.confidence || 0.6), 0.68)
    : data.confidence;

  return {
    ...data,
    amount_raw: data.amount,
    amount_in_words: data.amount_in_words ?? null,
    amount,
    confidence,
    amount_corrected_from_words: shouldTrustWords,
    provider: "openai",
  };
};

const isOpenAiInsufficientQuotaPayload = (raw: string) => {
  const lower = String(raw || "").toLowerCase();
  return lower.includes("insufficient_quota") || lower.includes("exceeded your current quota") || lower.includes("billing details");
};

const sanitizeAiErrorMessage = (status?: number, rawError = "") => {
  if (status === 402 || isOpenAiInsufficientQuotaPayload(rawError)) {
    return "OpenAI insufficient_quota: tài khoản/API key đã hết quota hoặc chưa bật billing.";
  }
  if (status === 429) return "OpenAI rate limit: hệ thống AI đang bị giới hạn tạm thời. Vui lòng thử lại sau ít phút.";
  return "AI Vision is temporarily unavailable. Please try again.";
};

const callOpenAiVision = async (imageBase64: string, mimeType: string, slipType?: string) => {
  const openaiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiApiKey) {
    console.error("[finance-extract-slip-amount] OPENAI_API_KEY not configured");
    throw new Error("Thiếu cấu hình AI key (OPENAI_API_KEY)");
  }

  let aiResponse: Response | null = null;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    try {
      console.log(`[finance-extract-slip-amount] Calling OpenAI gateway attempt ${attempt}`);
      aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: SLIP_EXTRACTION_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}`,
                    detail: "high",
                  },
                },
                { type: "text", text: slipUserPrompt(slipType) },
              ],
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "extract_slip_amount",
                description: "Extract transferred amount and key metadata from a Vietnamese bank slip image",
                parameters: {
                  type: "object",
                  properties: {
                    amount: {
                      type: "string",
                      description: "Exact amount string as shown on slip, preserving dots and commas. E.g. '41.006.300,00'",
                    },
                    amount_in_words: {
                      type: ["string", "null"],
                      description: "Exact amount-in-words line if present, e.g. 'Bảy trăm ba mươi bốn nghìn ba trăm chín mươi tám đồng'",
                    },
                    transfer_date: { type: ["string", "null"] },
                    reference: { type: ["string", "null"] },
                    confidence: { type: "number" },
                    notes: { type: ["string", "null"] },
                  },
                  required: ["amount", "amount_in_words", "confidence"],
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "extract_slip_amount" } },
          max_tokens: 1000,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (aiResponse.ok) break;

    lastStatus = aiResponse.status;
    const errText = await aiResponse.text().catch(() => "");
    console.error("[finance-extract-slip-amount] OpenAI API error", {
      attempt,
      status: lastStatus,
      bodyPreview: errText.slice(0, 240),
    });

    if (isOpenAiInsufficientQuotaPayload(errText)) {
      throw new Error(sanitizeAiErrorMessage(lastStatus, errText));
    }

    if ((lastStatus === 429 || lastStatus >= 500) && attempt < 3) {
      await sleep(400 * attempt);
      continue;
    }

    throw new Error(sanitizeAiErrorMessage(lastStatus, errText));
  }

  if (!aiResponse?.ok) {
    throw new Error(sanitizeAiErrorMessage(lastStatus));
  }

  const aiData = await aiResponse.json();
  const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.function?.name !== "extract_slip_amount") {
    console.error("[finance-extract-slip-amount] Failed to extract structured data from image");
    throw new Error("Failed to extract amount from image");
  }

  const extractedData = JSON.parse(toolCall.function.arguments || "{}");
  const normalized = normalizeExtractedSlip(extractedData);
  console.log(`[finance-extract-slip-amount] Amount: raw="${normalized.amount_raw}" → parsed=${normalized.amount}`);
  return normalized;
};

serve(async (req) => {
  const startTime = Date.now();
  console.log("[finance-extract-slip-amount] Request started");

  if (req.method === "OPTIONS") return corsPreflightResponse(req);

  try {
    const { user } = await requireAuth(req, getCorsHeaders(req));

    const rateLimit = await checkAndRecordRateLimit(user.id, "finance-extract-slip-amount", 200);
    if (!rateLimit.allowed) {
      return jsonResponse(
        { error: "Bạn đã vượt quá giới hạn scan hôm nay. Vui lòng thử lại vào ngày mai.", code: "RATE_LIMIT_EXCEEDED" },
        429,
        { ...getCorsHeaders(req), ...getRateLimitHeaders(rateLimit) }
      );
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
