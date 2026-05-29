import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

interface ExtractedItem {
  product_name: string;
  quantity: number;
  ordered_quantity?: number | null;
  actual_quantity?: number | null;
  unit: string;
  expiry_date?: string;
  unit_price?: number;
  line_status?: "du" | "thieu" | "du_thua";
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return corsPreflightResponse(req);
  }

  try {
    const { 
      goodsReceiptId,
      paymentRequestId, 
      deliveryImage, 
      productPhotos = [], 
      items = [],
      supplierId 
    } = await req.json();

    if (!goodsReceiptId && !paymentRequestId) {
      return new Response(
        JSON.stringify({ error: "Missing goods receipt ID or payment request ID" }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // Get auth token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
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
        { status: 401, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    if (goodsReceiptId) {
      const { data: existingReceipt, error: receiptLookupError } = await supabase
        .from("goods_receipts")
        .select("id, receipt_number, status, supplier_id, purchase_order_id")
        .eq("id", goodsReceiptId)
        .single();

      if (receiptLookupError || !existingReceipt) {
        return new Response(
          JSON.stringify({ error: "Goods receipt not found" }),
          { status: 404, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
        );
      }

      if (!["draft", "confirmed"].includes(existingReceipt.status)) {
        return new Response(
          JSON.stringify({ error: "Goods receipt is not pending warehouse confirmation" }),
          { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
        );
      }

      const receiptNumber = existingReceipt.receipt_number;
      let deliveryImageUrl: string | null = null;
      if (deliveryImage) {
        try {
          const imageData = deliveryImage.includes(",") ? deliveryImage.split(",")[1] : deliveryImage;
          const fileName = `delivery/${receiptNumber}_${Date.now()}.jpg`;
          const { error: uploadError } = await supabase.storage
            .from("warehouse-photos")
            .upload(fileName, Uint8Array.from(atob(imageData), c => c.charCodeAt(0)), {
              contentType: "image/jpeg",
              upsert: true,
            });
          if (!uploadError) {
            const { data: urlData } = supabase.storage.from("warehouse-photos").getPublicUrl(fileName);
            deliveryImageUrl = urlData.publicUrl;
          }
        } catch (uploadErr) {
          console.error("Error processing delivery image:", uploadErr);
        }
      }

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
            const { data: urlData } = supabase.storage.from("warehouse-photos").getPublicUrl(fileName);
            productPhotoUrls.push(urlData.publicUrl);
          }
        } catch (uploadErr) {
          console.error("Error processing product photo:", uploadErr);
        }
      }

      const incomingItems = items as ExtractedItem[];
      const totalQuantity = incomingItems.reduce((sum, item) => sum + Number(item.actual_quantity ?? item.quantity ?? 0), 0);
      const varianceSummary = incomingItems.reduce((summary, item) => {
        const key = item.line_status || "du";
        summary[key] = (summary[key] || 0) + 1;
        return summary;
      }, {} as Record<string, number>);

      const { data: existingItems } = await supabase
        .from("goods_receipt_items")
        .select("id, product_name")
        .eq("goods_receipt_id", goodsReceiptId);

      const usedExistingIds = new Set<string>();
      for (const item of incomingItems) {
        const actualQuantity = Number(item.actual_quantity ?? item.quantity ?? 0);
        const existingItem = (existingItems || []).find((candidate: any) =>
          !usedExistingIds.has(candidate.id) &&
          String(candidate.product_name || "").trim().toLowerCase() === String(item.product_name || "").trim().toLowerCase()
        );

        if (existingItem) {
          usedExistingIds.add(existingItem.id);
          const { error: itemUpdateError } = await supabase
            .from("goods_receipt_items")
            .update({
              product_name: item.product_name,
              quantity: actualQuantity,
              ordered_quantity: item.ordered_quantity ?? null,
              actual_quantity: actualQuantity,
              unit: item.unit,
              unit_price: item.unit_price ?? null,
              line_status: item.line_status || null,
              expiry_date: item.expiry_date || null,
            })
            .eq("id", existingItem.id);
          if (itemUpdateError) console.error("Error updating receipt item:", itemUpdateError);
        } else {
          const { error: itemInsertError } = await supabase
            .from("goods_receipt_items")
            .insert({
              goods_receipt_id: goodsReceiptId,
              product_name: item.product_name,
              quantity: actualQuantity,
              ordered_quantity: item.ordered_quantity ?? null,
              actual_quantity: actualQuantity,
              unit: item.unit,
              unit_price: item.unit_price ?? null,
              line_status: item.line_status || null,
              expiry_date: item.expiry_date || null,
            });
          if (itemInsertError) console.error("Error inserting receipt item:", itemInsertError);
        }
      }

      const { error: receiptUpdateError } = await supabase
        .from("goods_receipts")
        .update({
          supplier_id: supplierId || existingReceipt.supplier_id,
          image_url: deliveryImageUrl,
          product_photos: productPhotoUrls.length > 0 ? productPhotoUrls : null,
          status: "confirmed",
          total_quantity: totalQuantity,
          variance_summary: varianceSummary,
          notes: `Kho xác nhận phiếu chờ nhập từ PO: ${existingReceipt.purchase_order_id || "không rõ PO"}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", goodsReceiptId);

      if (receiptUpdateError) {
        console.error("Error updating pending goods receipt:", receiptUpdateError);
        return new Response(
          JSON.stringify({ error: "Failed to update pending goods receipt" }),
          { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          receiptId: goodsReceiptId,
          receiptNumber,
          deliveryImageUrl,
          productPhotoUrls,
          varianceSummary,
        }),
        { headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
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
        { status: 404, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    if (pr.status !== "approved") {
      return new Response(
        JSON.stringify({ error: "Payment request is not approved" }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    if (pr.goods_receipt_id) {
      return new Response(
        JSON.stringify({ error: "Goods receipt already exists for this payment request" }),
        { status: 400, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // Generate receipt number
    const { data: receiptNumber, error: genError } = await supabase
      .rpc("generate_receipt_number");

    if (genError || !receiptNumber) {
      console.error("Error generating receipt number:", genError);
      return new Response(
        JSON.stringify({ error: "Failed to generate receipt number" }),
        { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
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
        { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
      );
    }

    // Create goods receipt items
    if (items.length > 0) {
      const receiptItems = (items as ExtractedItem[]).map(item => ({
        goods_receipt_id: receipt.id,
        product_name: item.product_name,
        quantity: item.quantity,
        unit: item.unit,
        expiry_date: item.expiry_date || null,
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
      { headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in create-warehouse-receipt:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } }
    );
  }
});
