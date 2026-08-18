import { createClient } from "npm:@supabase/supabase-js@2.90.1";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

interface CreateInvoiceRequest {
  payment_request_id: string;
  invoice_number: string;
  invoice_date: string;
  vat_amount?: number;
  notes?: string;
  payment_slip_url?: string;
}

type RpcInvoiceResult = {
  status?: string;
  invoice_id?: string;
  items_count?: number;
  copied_material_items_count?: number;
  pending_material_items_count?: number;
  material_master?: unknown;
};

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflightResponse(req);
  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !anonKey) return json(req, 503, { error: "Invoice service is not configured" });

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(req, 401, { error: "Missing Authorization header" });

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json(req, 401, { error: "Unauthorized" });

    const body = (await req.json()) as Partial<CreateInvoiceRequest>;
    const payment_request_id = typeof body.payment_request_id === "string" ? body.payment_request_id.trim() : "";
    const invoice_number = typeof body.invoice_number === "string" ? body.invoice_number.trim() : "";
    const invoice_date = typeof body.invoice_date === "string" ? body.invoice_date.trim() : "";
    const vat_amount = Number.isFinite(Number(body.vat_amount)) ? Number(body.vat_amount) : 0;

    if (!payment_request_id || !invoice_number || !invoice_date) {
      return json(req, 400, { error: "Missing required fields: payment_request_id, invoice_number, invoice_date" });
    }

    const { data: paymentRequest, error: paymentRequestError } = await userClient
      .from("payment_requests")
      .select("id, purchase_order_id, goods_receipt_id")
      .eq("id", payment_request_id)
      .single();
    if (paymentRequestError || !paymentRequest) {
      return json(req, 404, { error: "Payment request not found" });
    }

    const { data: invoiceResult, error: invoiceRpcError } = await userClient.rpc("create_invoice_from_payment_request", {
      p_payment_request_id: payment_request_id,
      p_invoice_number: invoice_number,
      p_invoice_date: invoice_date,
      p_vat_amount: vat_amount,
      p_notes: typeof body.notes === "string" ? body.notes : null,
      p_payment_slip_url: typeof body.payment_slip_url === "string" ? body.payment_slip_url : null,
      p_created_by: user.id,
    });

    if (invoiceRpcError) {
      const code = invoiceRpcError.code === "42501" ? 403 : invoiceRpcError.code === "23514" ? 422 : invoiceRpcError.code === "23505" ? 409 : 500;
      console.error("create_invoice_from_payment_request failed", { code: invoiceRpcError.code, message: invoiceRpcError.message });
      return json(req, code, { error: code === 500 ? "Failed to create invoice" : invoiceRpcError.message });
    }

    if (!invoiceResult || typeof invoiceResult !== "object" || Array.isArray(invoiceResult)) {
      return json(req, 500, { error: "Invalid invoice creation response" });
    }

    const result = invoiceResult as RpcInvoiceResult;
    if (result.status !== "created" || !result.invoice_id || typeof result.items_count !== "number" || result.items_count <= 0) {
      return json(req, 500, { error: "Invalid invoice creation status" });
    }

    const { data: createdInvoice, error: createdInvoiceError } = await userClient
      .from("invoices")
      .select("purchase_order_id, goods_receipt_id")
      .eq("id", result.invoice_id)
      .single();
    if (
      createdInvoiceError || !createdInvoice ||
      createdInvoice.purchase_order_id !== paymentRequest.purchase_order_id ||
      createdInvoice.goods_receipt_id !== paymentRequest.goods_receipt_id
    ) {
      console.error("create_invoice_from_payment_request context validation failed", {
        paymentRequestId: payment_request_id,
        invoiceId: result.invoice_id,
      });
      return json(req, 500, { error: "Invoice procurement context validation failed" });
    }

    return json(req, 200, {
      success: true,
      status: result.status,
      invoice_id: result.invoice_id,
      items_count: result.items_count,
      copied_material_items_count: result.copied_material_items_count ?? 0,
      pending_material_items_count: result.pending_material_items_count ?? 0,
      material_master: result.material_master ?? null,
    });
  } catch (error) {
    console.error("create-invoice-from-pr unexpected error", error);
    return json(req, 500, { error: "Unexpected invoice creation error" });
  }
});
