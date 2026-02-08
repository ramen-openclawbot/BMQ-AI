import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ExtractedItem {
  product_name: string;
  quantity: number;
  unit: string;
  unit_price?: number;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { 
      paymentRequestId, 
      deliveryImage, 
      productPhotos = [], 
      items = [],
      supplierId 
    } = await req.json();

    if (!paymentRequestId) {
      return new Response(
        JSON.stringify({ error: "Missing payment request ID" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get auth token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify user token
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify payment request exists and is approved
    const { data: pr, error: prError } = await supabase
      .from("payment_requests")
      .select("id, status, goods_receipt_id, supplier_id")
      .eq("id", paymentRequestId)
      .single();

    if (prError || !pr) {
      return new Response(
        JSON.stringify({ error: "Payment request not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (pr.status !== "approved") {
      return new Response(
        JSON.stringify({ error: "Payment request is not approved" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (pr.goods_receipt_id) {
      return new Response(
        JSON.stringify({ error: "Goods receipt already exists for this payment request" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate receipt number
    const { data: receiptNumber, error: genError } = await supabase
      .rpc("generate_receipt_number");

    if (genError || !receiptNumber) {
      console.error("Error generating receipt number:", genError);
      return new Response(
        JSON.stringify({ error: "Failed to generate receipt number" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Upload delivery image to storage
    let deliveryImageUrl: string | null = null;
    if (deliveryImage) {
      try {
        const imageData = deliveryImage.includes(",") 
          ? deliveryImage.split(",")[1] 
          : deliveryImage;
        
        const fileName = `delivery/${receiptNumber}_${Date.now()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from("warehouse-photos")
          .upload(fileName, Uint8Array.from(atob(imageData), c => c.charCodeAt(0)), {
            contentType: "image/jpeg",
            upsert: true,
          });

        if (uploadError) {
          console.error("Error uploading delivery image:", uploadError);
        } else {
          const { data: urlData } = supabase.storage
            .from("warehouse-photos")
            .getPublicUrl(fileName);
          deliveryImageUrl = urlData.publicUrl;
        }
      } catch (uploadErr) {
        console.error("Error processing delivery image:", uploadErr);
      }
    }

    // Upload product photos
    const productPhotoUrls: string[] = [];
    for (let i = 0; i < productPhotos.length; i++) {
      try {
        const photo = productPhotos[i];
        const imageData = photo.includes(",") ? photo.split(",")[1] : photo;
        
        const fileName = `products/${receiptNumber}_${i + 1}_${Date.now()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from("warehouse-photos")
          .upload(fileName, Uint8Array.from(atob(imageData), c => c.charCodeAt(0)), {
            contentType: "image/jpeg",
            upsert: true,
          });

        if (!uploadError) {
          const { data: urlData } = supabase.storage
            .from("warehouse-photos")
            .getPublicUrl(fileName);
          productPhotoUrls.push(urlData.publicUrl);
        }
      } catch (uploadErr) {
        console.error("Error processing product photo:", uploadErr);
      }
    }

    // Calculate total quantity
    const totalQuantity = (items as ExtractedItem[]).reduce(
      (sum, item) => sum + (item.quantity || 0), 
      0
    );

    // Create goods receipt
    const { data: receipt, error: receiptError } = await supabase
      .from("goods_receipts")
      .insert({
        receipt_number: receiptNumber,
        receipt_date: new Date().toISOString().split("T")[0],
        supplier_id: supplierId || pr.supplier_id,
        image_url: deliveryImageUrl,
        product_photos: productPhotoUrls.length > 0 ? productPhotoUrls : null,
        payment_request_id: paymentRequestId,
        status: "confirmed",
        total_quantity: totalQuantity,
        created_by: user.id,
        notes: `Tạo từ app kho - PR: ${paymentRequestId}`,
      })
      .select("id, receipt_number")
      .single();

    if (receiptError || !receipt) {
      console.error("Error creating goods receipt:", receiptError);
      return new Response(
        JSON.stringify({ error: "Failed to create goods receipt" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create goods receipt items
    if (items.length > 0) {
      const receiptItems = (items as ExtractedItem[]).map(item => ({
        goods_receipt_id: receipt.id,
        product_name: item.product_name,
        quantity: item.quantity,
        unit: item.unit,
        notes: item.unit_price ? `Đơn giá: ${item.unit_price}` : null,
      }));

      const { error: itemsError } = await supabase
        .from("goods_receipt_items")
        .insert(receiptItems);

      if (itemsError) {
        console.error("Error creating goods receipt items:", itemsError);
        // Don't fail the whole operation, items are optional
      }
    }

    // Update payment request
    const { error: updateError } = await supabase
      .from("payment_requests")
      .update({
        goods_receipt_id: receipt.id,
        delivery_status: "delivered",
        updated_at: new Date().toISOString(),
      })
      .eq("id", paymentRequestId);

    if (updateError) {
      console.error("Error updating payment request:", updateError);
      // Don't fail, receipt is already created
    }

    return new Response(
      JSON.stringify({
        success: true,
        receiptId: receipt.id,
        receiptNumber: receipt.receipt_number,
        deliveryImageUrl,
        productPhotoUrls,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in create-warehouse-receipt:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
