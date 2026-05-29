import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

function jsonResponse(req: Request, body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  try {
    const { receiptId } = await req.json();

    if (!receiptId) {
      return jsonResponse(req, { error: "Missing receipt ID" }, 400);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse(req, { error: "Missing authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return jsonResponse(req, { error: "Invalid token" }, 401);
    }

    const { data, error } = await supabase.rpc("finalize_goods_receipt", {
      p_receipt_id: receiptId,
      p_user_id: user.id,
    });

    if (error) {
      console.error("Failed to finalize goods receipt:", error);
      const message = error.message || "Failed to finalize goods receipt";
      const status = message.includes("not found") ? 404 : message.includes("already") || message.includes("Cannot finalize") ? 400 : 500;
      return jsonResponse(req, { error: message }, status);
    }

    return jsonResponse(req, (data || { success: true }) as Record<string, unknown>);
  } catch (error) {
    console.error("Error in finalize-goods-receipt:", error);
    return jsonResponse(req, { error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
