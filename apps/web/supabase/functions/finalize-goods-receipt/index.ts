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
    const {
      receiptId,
      historicalPaymentRequestId,
      historicalStockNotIncludedConfirmed,
      historicalReconciliationReason,
    } = await req.json();

    if (!receiptId) {
      return jsonResponse(req, { error: "Missing receipt ID" }, 400);
    }

    if (historicalPaymentRequestId !== undefined && !historicalPaymentRequestId) {
      return jsonResponse(req, { error: "Missing historical payment request ID" }, 400);
    }

    if (historicalPaymentRequestId && historicalStockNotIncludedConfirmed !== true) {
      return jsonResponse(req, { error: "Historical stock-not-included confirmation is required" }, 400);
    }

    if (
      historicalPaymentRequestId &&
      (typeof historicalReconciliationReason !== "string" ||
        historicalReconciliationReason.trim().length < 3 ||
        historicalReconciliationReason.trim().length > 500)
    ) {
      return jsonResponse(req, { error: "Historical reconciliation reason must be 3-500 characters" }, 400);
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

    if (historicalPaymentRequestId) {
      const [{ data: roleRows, error: roleError }, { data: permissionRows, error: permissionError }] = await Promise.all([
        supabase.from("user_roles").select("role").eq("user_id", user.id),
        supabase
          .from("user_module_permissions")
          .select("module_key, can_edit")
          .eq("user_id", user.id)
          .in("module_key", ["payment_requests", "purchase_orders"]),
      ]);

      if (roleError || permissionError) {
        console.error("Failed to verify historical receipt permissions:", roleError || permissionError);
        return jsonResponse(req, { error: "Unable to verify permissions" }, 500);
      }

      const roles = (roleRows || []) as Array<{ role: string }>;
      const permissions = (permissionRows || []) as Array<{ module_key: string; can_edit: boolean }>;
      const isOwner = roles.some((row) => row.role === "owner");
      const editableModules = new Set(
        permissions.filter((row) => row.can_edit).map((row) => row.module_key),
      );
      if (!isOwner) {
        const canLinkHistoricalPayment =
          editableModules.has("payment_requests") && editableModules.has("purchase_orders");
        if (!canLinkHistoricalPayment) {
          return jsonResponse(
            req,
            { error: "Forbidden: payment_requests and purchase_orders edit permissions required" },
            403,
          );
        }
      }
    }

    const rpcResult = historicalPaymentRequestId
      ? await supabase.rpc("finalize_historical_paid_goods_receipt", {
          p_receipt_id: receiptId,
          p_payment_request_id: historicalPaymentRequestId,
          p_stock_not_included_confirmed: historicalStockNotIncludedConfirmed,
          p_reconciliation_reason: historicalReconciliationReason.trim(),
          p_user_id: user.id,
        })
      : await supabase.rpc("finalize_goods_receipt", {
          p_receipt_id: receiptId,
          p_user_id: user.id,
        });
    const { data, error } = rpcResult;

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
