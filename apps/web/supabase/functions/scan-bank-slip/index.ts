import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// NOTE: Use npm specifier to avoid esm.sh drift/caching issues in edge runtime
import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";
import { checkAndRecordRateLimit, getRateLimitHeaders } from "../_shared/rate-limiter.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const parseAmountVN = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  const normalized = raw
    .replace(/\s+/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(/,/g, ".")
    .replace(/[^0-9.-]/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
};

serve(async (req) => {
  const startTime = Date.now();
  console.log("[scan-bank-slip] Request started");

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return corsPreflightResponse(req);
  }

  try {
    // Authentication check - simplified for prototype (no role check)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      console.log("[scan-bank-slip] Missing authorization header");
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Use service role client for stable auth verification
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Validate user token using service role key (stable pattern)
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      console.log("[scan-bank-slip] Invalid or expired token:", authError?.message);
      return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
        status: 401,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    console.log("[scan-bank-slip] User authenticated:", user.id);

    // Rate limit: 100 calls/day per user
    const rateLimit = await checkAndRecordRateLimit(user.id, "scan-bank-slip", 100);
    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({ error: "Bạn đã vượt quá giới hạn scan hôm nay. Vui lòng thử lại vào ngày mai.", code: "RATE_LIMIT_EXCEEDED" }), {
        status: 429,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...getRateLimitHeaders(rateLimit) },
      });
    }

    // Parse request body
    const { imageBase64, mimeType } = await req.json();

    if (!imageBase64 || !mimeType) {
      return new Response(JSON.stringify({ error: 'Missing imageBase64 or mimeType' }), {
        status: 400,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // Validate image size (max 10MB)
    const imageSizeBytes = (imageBase64.length * 3) / 4;
    if (imageSizeBytes > 10 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: 'Image too large (max 10MB)' }), {
        status: 400,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // Validate MIME type
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedMimeTypes.includes(mimeType)) {
      return new Response(JSON.stringify({ error: 'Unsupported image format' }), {
        status: 400,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) {
      console.error("[scan-bank-slip] OPENAI_API_KEY not configured");
      return new Response(JSON.stringify({ error: 'AI API key not configured' }), {
        status: 500,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    // System prompt for bank slip extraction
    const systemPrompt = `Bạn là chuyên gia trích xuất dữ liệu từ ảnh UNC/ủy nhiệm chi tiếng Việt.

Hãy trích xuất các trường sau:
1. amount: số tiền chuyển khoản (VND, chỉ lấy số)
2. recipient_name: tên người thụ hưởng
3. recipient_account: số tài khoản thụ hưởng
4. recipient_bank: ngân hàng thụ hưởng
5. transaction_date: ngày giao dịch (YYYY-MM-DD nếu có thể)
6. transaction_id: mã giao dịch/tham chiếu
7. content: nội dung chuyển khoản
8. sender_name: tên người chuyển

Quy tắc quan trọng:
- amount phải là số dương.
- Nếu ảnh mờ, vẫn cố gắng suy luận từ vùng số tiền.
- Nếu không chắc một trường, trả null cho trường đó.

Trả về JSON.`;

    // Call OpenAI Gateway (retry on transient errors)
    console.log("[scan-bank-slip] Calling AI gateway");
    let aiResponse: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${imageBase64}`,
                    detail: 'high',
                  },
                },
                {
                  type: 'text',
                  text: 'Trích xuất thông tin UNC từ ảnh này.',
                },
              ],
            },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'extract_bank_slip_data',
                description: 'Extract structured data from a bank transfer slip image',
                parameters: {
                  type: 'object',
                  properties: {
                    amount: { type: ['number', 'string', 'null'] },
                    recipient_name: { type: ['string', 'null'] },
                    recipient_account: { type: ['string', 'null'] },
                    recipient_bank: { type: ['string', 'null'] },
                    transaction_date: { type: ['string', 'null'] },
                    transaction_id: { type: ['string', 'null'] },
                    content: { type: ['string', 'null'] },
                    sender_name: { type: ['string', 'null'] },
                  },
                },
              },
            },
          ],
          tool_choice: { type: 'function', function: { name: 'extract_bank_slip_data' } },
          max_tokens: 1000,
        }),
      });

      if (aiResponse.ok) break;
      const status = aiResponse.status;
      const errTxt = await aiResponse.text();
      console.error(`[scan-bank-slip] AI API error attempt ${attempt}:`, status, errTxt);
      if ((status === 429 || status >= 500) && attempt < 3) {
        await sleep(400 * attempt);
        continue;
      }

      if (status === 429 || status === 402) {
        return new Response(JSON.stringify({ error: 'AI service temporarily unavailable. Please try again later.' }), {
          status: 429,
          headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'Failed to process image with AI' }), {
        status: 500,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const aiData = await aiResponse!.json();
    
    // Extract the function call result
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.function.name !== 'extract_bank_slip_data') {
      console.error("[scan-bank-slip] Failed to extract data from image");
      return new Response(JSON.stringify({ error: 'Failed to extract data from image' }), {
        status: 500,
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      });
    }

    const extractedData = JSON.parse(toolCall.function.arguments || '{}');
    extractedData.amount = parseAmountVN(extractedData.amount);

    console.log(`[scan-bank-slip] Completed in ${Date.now() - startTime}ms`);
    return new Response(JSON.stringify({ 
      success: true, 
      data: extractedData 
    }), {
      status: 200,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    console.error('[scan-bank-slip] Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    });
  }
});
