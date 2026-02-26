import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type BatchFile = { id: string; base64: string; mimeType?: string };

type BatchResult = {
  file_id: string;
  success: boolean;
  data?: any;
  error_code?: string;
  error_message?: string;
  trace_id: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errorCodeFrom = (status: number, message = "") => {
  const m = message.toLowerCase();
  if (status === 429 || m.includes("rate limit")) return "RATE_LIMIT";
  if (status === 408 || m.includes("timeout") || m.includes("abort")) return "TIMEOUT";
  if (status === 400 && (m.includes("image") || m.includes("mime"))) return "INVALID_IMAGE";
  if (status >= 500) return "PROVIDER_ERROR";
  return "SCAN_ERROR";
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error_code: "UNAUTHORIZED", error_message: "Unauthorized", trace_id: crypto.randomUUID() }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error_code: "UNAUTHORIZED", error_message: "Invalid JWT", trace_id: crypto.randomUUID() }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const files: BatchFile[] = Array.isArray(body?.files) ? body.files : [];
    if (!files.length) {
      return new Response(
        JSON.stringify({ error_code: "INVALID_INPUT", error_message: "No files provided", trace_id: crypto.randomUUID() }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const endpoint = `${supabaseUrl}/functions/v1/scan-purchase-order`;
    const results: BatchResult[] = [];

    for (const file of files) {
      const traceId = crypto.randomUUID();
      let completed = false;
      let lastStatus = 500;
      let lastMessage = "Không thể đọc thông tin PO";

      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify({
              imageBase64: file.base64,
              mimeType: file.mimeType,
            }),
          });

          let json: any = null;
          try { json = await res.json(); } catch {}

          if (res.ok && json?.success && json?.data) {
            results.push({
              file_id: file.id,
              success: true,
              data: json.data,
              trace_id: traceId,
            });
            completed = true;
            break;
          }

          lastStatus = res.status;
          lastMessage = String(json?.error_message || json?.error || `HTTP ${res.status}`);
          const code = errorCodeFrom(lastStatus, lastMessage);

          if (code !== "RATE_LIMIT" || attempt === 5) {
            results.push({
              file_id: file.id,
              success: false,
              error_code: code,
              error_message: lastMessage,
              trace_id: traceId,
            });
            completed = true;
            break;
          }

          const retryAfter = Number(res.headers.get("retry-after") || "0");
          const waitMs = Math.max(1200 * attempt, retryAfter * 1000);
          await sleep(waitMs);
        } catch (err: any) {
          lastStatus = 500;
          lastMessage = String(err?.message || err || "Unknown error");

          if (attempt === 5) {
            results.push({
              file_id: file.id,
              success: false,
              error_code: errorCodeFrom(lastStatus, lastMessage),
              error_message: lastMessage,
              trace_id: traceId,
            });
            completed = true;
            break;
          }

          await sleep(1000 * attempt);
        }
      }

      if (!completed) {
        results.push({
          file_id: file.id,
          success: false,
          error_code: errorCodeFrom(lastStatus, lastMessage),
          error_message: lastMessage,
          trace_id: traceId,
        });
      }
    }

    return new Response(
      JSON.stringify({ success: true, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const traceId = crypto.randomUUID();
    return new Response(
      JSON.stringify({ error_code: "BATCH_INTERNAL_ERROR", error_message: error instanceof Error ? error.message : "Unknown error", trace_id: traceId }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
