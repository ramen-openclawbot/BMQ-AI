import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface CreateInvoiceRequest {
  payment_request_id: string;
  invoice_number: string;
  invoice_date: string;
  vat_amount: number;
  notes?: string;
  payment_slip_url?: string;
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Get user token from header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create client with service role for transaction capability
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Validate user token
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body: CreateInvoiceRequest = await req.json();
    const { payment_request_id, invoice_number, invoice_date, vat_amount, notes, payment_slip_url } = body;

    if (!payment_request_id || !invoice_number || !invoice_date) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: payment_request_id, invoice_number, invoice_date" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Fetch payment request with items
    const { data: paymentRequest, error: prError } = await supabase
      .from("payment_requests")
      .select("id, supplier_id, total_amount, vat_amount, image_url, invoice_created")
      .eq("id", payment_request_id)
      .single();

    if (prError || !paymentRequest) {
      return new Response(
        JSON.stringify({ error: "Payment request not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (paymentRequest.invoice_created) {
      return new Response(
        JSON.stringify({ error: "Invoice already created for this payment request" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Fetch payment request items
    const { data: prItems, error: itemsError } = await supabase
      .from("payment_request_items")
      .select("product_code, product_name, unit, quantity, unit_price, inventory_item_id, notes")
      .eq("payment_request_id", payment_request_id);

    if (itemsError) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch payment request items" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!prItems || prItems.length === 0) {
      return new Response(
        JSON.stringify({ error: "Payment request has no items" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Calculate subtotal from items
    const subtotal = prItems.reduce((sum, item) => {
      return sum + (Number(item.quantity) || 0) * (Number(item.unit_price) || 0);
    }, 0);
    const totalAmount = subtotal + (vat_amount || 0);

    // 3. Create invoice
    const { data: newInvoice, error: invoiceError } = await supabase
      .from("invoices")
      .insert({
        invoice_number,
        invoice_date,
        supplier_id: paymentRequest.supplier_id,
        subtotal,
        vat_amount: vat_amount || 0,
        total_amount: totalAmount,
        notes: notes || `Tạo từ đề nghị chi`,
        image_url: paymentRequest.image_url,
        payment_slip_url: payment_slip_url || null,
        payment_request_id,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (invoiceError || !newInvoice) {
      console.error("Invoice creation error:", invoiceError);
      return new Response(
        JSON.stringify({ error: `Failed to create invoice: ${invoiceError?.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Bulk insert invoice items (DO NOT include line_total - it's GENERATED ALWAYS)
    const invoiceItems = prItems.map((item) => ({
      invoice_id: newInvoice.id,
      product_code: item.product_code,
      product_name: item.product_name,
      unit: item.unit || "kg",
      quantity: item.quantity,
      unit_price: item.unit_price,
      inventory_item_id: item.inventory_item_id,
      notes: item.notes,
    }));

    const { error: itemsInsertError } = await supabase
      .from("invoice_items")
      .insert(invoiceItems);

    if (itemsInsertError) {
      console.error("Invoice items insert error:", itemsInsertError);
      // Rollback: delete the invoice we just created
      await supabase.from("invoices").delete().eq("id", newInvoice.id);
      return new Response(
        JSON.stringify({ error: `Failed to create invoice items: ${itemsInsertError.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Update payment request
    const { error: updateError } = await supabase
      .from("payment_requests")
      .update({
        invoice_id: newInvoice.id,
        invoice_created: true,
      })
      .eq("id", payment_request_id);

    if (updateError) {
      console.error("Payment request update error:", updateError);
      // Don't rollback here - invoice and items are already created successfully
      // Just log the error and continue
    }

    return new Response(
      JSON.stringify({
        success: true,
        invoice_id: newInvoice.id,
        items_count: invoiceItems.length,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Unexpected error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
