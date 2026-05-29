import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, corsPreflightResponse } from "../_shared/cors.ts";

type ReceiptLineStatus = "du" | "thieu" | "du_thua";

interface ReceiptItemRow {
  id: string;
  goods_receipt_id: string;
  sku_id: string | null;
  product_name: string;
  quantity: number | null;
  unit: string | null;
  inventory_item_id: string | null;
  notes: string | null;
  expiry_date: string | null;
  purchase_order_item_id: string | null;
  ordered_quantity: number | null;
  actual_quantity: number | null;
  unit_price: number | null;
  line_status: ReceiptLineStatus | null;
  variance_reason: string | null;
}

function jsonResponse(req: Request, body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

function payableLineTotal(actualQty: number, unitPrice?: number | null): number {
  return Math.max(0, Number(actualQty || 0)) * Math.max(0, Number(unitPrice || 0));
}

function createPayableRequestNumber(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes)
    .map((byte) => byte.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 8)
    .toUpperCase();
  return `PR-${suffix}`;
}

function buildVarianceSummary(items: ReceiptItemRow[]) {
  return items.reduce((summary, item) => {
    const orderedQty = Number(item.ordered_quantity ?? item.quantity ?? 0);
    const actualQty = Number(item.actual_quantity ?? item.quantity ?? 0);
    const status = item.line_status || (actualQty < orderedQty ? "thieu" : actualQty > orderedQty ? "du_thua" : "du");
    summary[status] = (summary[status] || 0) + 1;
    return summary;
  }, {} as Record<string, number>);
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

    const { data: receipt, error: receiptError } = await supabase
      .from("goods_receipts")
      .select("id, receipt_number, supplier_id, status, purchase_order_id, payment_request_id, payable_status, variance_summary, image_url, purchase_orders(id, po_number, total_amount, vat_amount, status)")
      .eq("id", receiptId)
      .single();

    if (receiptError || !receipt) {
      return jsonResponse(req, { error: "Goods receipt not found" }, 404);
    }

    if (receipt.status === "received" || receipt.payable_status === "generated") {
      return jsonResponse(req, { error: "Goods receipt already finalized or already received" }, 400);
    }

    if (receipt.payable_status !== "not_generated") {
      return jsonResponse(req, { error: "Goods receipt payable is already in progress" }, 400);
    }

    const { data: items, error: itemsError } = await supabase
      .from("goods_receipt_items")
      .select("*")
      .eq("goods_receipt_id", receiptId)
      .order("created_at", { ascending: true });

    if (itemsError) {
      console.error("Error loading receipt items:", itemsError);
      return jsonResponse(req, { error: "Failed to load receipt items" }, 500);
    }

    const receiptItems = (items || []) as ReceiptItemRow[];
    const payableItems = receiptItems
      .map((item) => {
        const actualQuantity = Number(item.actual_quantity ?? item.quantity ?? 0);
        const orderedQuantity = Number(item.ordered_quantity ?? item.quantity ?? 0);
        const unitPrice = Number(item.unit_price ?? 0);
        return { item, actualQuantity, orderedQuantity, unitPrice, lineTotal: payableLineTotal(actualQuantity, unitPrice) };
      })
      .filter(({ actualQuantity }) => actualQuantity > 0);

    if (payableItems.length === 0) {
      return jsonResponse(req, { error: "Cannot finalize receipt without positive actual received quantities" }, 400);
    }

    const batchesToCreate: Record<string, unknown>[] = [];
    const finalizedInventoryItemIds = new Map<string, string>();

    for (let index = 0; index < payableItems.length; index++) {
      const { item, actualQuantity } = payableItems[index];
      let inventoryItemId = item.inventory_item_id;

      if (inventoryItemId) {
        const { data: inventoryItem, error: inventoryLookupError } = await supabase
          .from("inventory_items")
          .select("id, quantity")
          .eq("id", inventoryItemId)
          .maybeSingle();

        if (inventoryLookupError) {
          console.error("Error loading inventory item:", inventoryLookupError);
          return jsonResponse(req, { error: "Failed to load inventory item" }, 500);
        }

        if (inventoryItem) {
          const { error: inventoryUpdateError } = await supabase
            .from("inventory_items")
            .update({
              quantity: Number(inventoryItem.quantity || 0) + actualQuantity,
              updated_at: new Date().toISOString(),
            })
            .eq("id", inventoryItemId);
          if (inventoryUpdateError) {
            console.error("Error updating inventory item:", inventoryUpdateError);
            return jsonResponse(req, { error: "Failed to update inventory item" }, 500);
          }
        }
      } else {
        const { data: existingItem, error: existingItemError } = await supabase
          .from("inventory_items")
          .select("id, quantity")
          .ilike("name", item.product_name)
          .maybeSingle();

        if (existingItemError) {
          console.error("Error finding inventory item:", existingItemError);
          return jsonResponse(req, { error: "Failed to find inventory item" }, 500);
        }

        if (existingItem) {
          inventoryItemId = existingItem.id;
          const { error: inventoryUpdateError } = await supabase
            .from("inventory_items")
            .update({
              quantity: Number(existingItem.quantity || 0) + actualQuantity,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingItem.id);
          if (inventoryUpdateError) {
            console.error("Error updating matched inventory item:", inventoryUpdateError);
            return jsonResponse(req, { error: "Failed to update inventory item" }, 500);
          }
        } else {
          const { data: newItem, error: newItemError } = await supabase
            .from("inventory_items")
            .insert({
              name: item.product_name,
              quantity: actualQuantity,
              unit: item.unit,
              category: "Từ phiếu nhập",
              supplier_id: receipt.supplier_id,
              created_by: user.id,
            })
            .select("id")
            .single();

          if (newItemError || !newItem) {
            console.error("Error creating inventory item:", newItemError);
            return jsonResponse(req, { error: "Failed to create inventory item" }, 500);
          }
          inventoryItemId = newItem.id;
        }

        const { error: linkItemError } = await supabase
          .from("goods_receipt_items")
          .update({ inventory_item_id: inventoryItemId })
          .eq("id", item.id);
        if (linkItemError) console.error("Error linking receipt item to inventory item:", linkItemError);
      }

      if (inventoryItemId) {
        finalizedInventoryItemIds.set(item.id, inventoryItemId);
        batchesToCreate.push({
          inventory_item_id: inventoryItemId,
          sku_id: item.sku_id || null,
          goods_receipt_id: receiptId,
          goods_receipt_item_id: item.id,
          batch_number: `${receipt.receipt_number}-${String(index + 1).padStart(3, "0")}`,
          quantity: actualQuantity,
          unit: item.unit,
          received_date: new Date().toISOString().split("T")[0],
          expiry_date: item.expiry_date || null,
          notes: item.variance_reason || item.notes || null,
        });
      }
    }

    if (batchesToCreate.length > 0) {
      const { error: batchError } = await supabase
        .from("inventory_batches")
        .insert(batchesToCreate);
      if (batchError) {
        console.error("Error creating inventory batches:", batchError);
        return jsonResponse(req, { error: "Failed to create inventory batches" }, 500);
      }
    }

    const subtotal = payableItems.reduce((sum, { lineTotal }) => sum + lineTotal, 0);
    const plannedSubtotal = payableItems.reduce((sum, { orderedQuantity, unitPrice }) => sum + payableLineTotal(orderedQuantity, unitPrice), 0);
    const purchaseOrder = Array.isArray(receipt.purchase_orders) ? receipt.purchase_orders[0] : receipt.purchase_orders;
    const poVatAmount = Number(purchaseOrder?.vat_amount || 0);
    const vatAmount = plannedSubtotal > 0 && poVatAmount > 0
      ? Math.round((poVatAmount * subtotal / plannedSubtotal) * 100) / 100
      : 0;
    const totalAmount = subtotal + vatAmount;
    const varianceSummary = buildVarianceSummary(receiptItems);

    let payableId = receipt.payment_request_id as string | null;

    if (!payableId) {
      const { data: existingPayable, error: existingPayableError } = await supabase
        .from("payment_requests")
        .select("id")
        .eq("goods_receipt_id", receiptId)
        .maybeSingle();
      if (existingPayableError) {
        console.error("Error checking existing payable:", existingPayableError);
        return jsonResponse(req, { error: "Failed to check existing payable" }, 500);
      }
      payableId = existingPayable?.id || null;
    }

    if (payableId) {
      const { error: payableUpdateError } = await supabase
        .from("payment_requests")
        .update({
          supplier_id: receipt.supplier_id,
          purchase_order_id: receipt.purchase_order_id,
          goods_receipt_id: receiptId,
          title: `Công nợ nhập kho ${receipt.receipt_number}`,
          description: `Tạo từ phiếu nhập kho ${receipt.receipt_number}`,
          total_amount: totalAmount,
          vat_amount: vatAmount,
          status: "pending",
          delivery_status: "delivered",
          payment_status: "unpaid",
          payment_type: "old_order",
          updated_at: new Date().toISOString(),
          notes: `Tự động tạo/cập nhật từ phiếu nhập kho. Chênh lệch: ${JSON.stringify(varianceSummary)}`,
        })
        .eq("id", payableId);
      if (payableUpdateError) {
        console.error("Error updating payable request:", payableUpdateError);
        return jsonResponse(req, { error: "Failed to update payable request" }, 500);
      }

      const { error: deleteItemsError } = await supabase
        .from("payment_request_items")
        .delete()
        .eq("payment_request_id", payableId);
      if (deleteItemsError) {
        console.error("Error deleting stale payable items:", deleteItemsError);
        return jsonResponse(req, { error: "Failed to refresh payable items" }, 500);
      }
    } else {
      const { data: createdPayable, error: payableInsertError } = await supabase
        .from("payment_requests")
        .insert({
          request_number: createPayableRequestNumber(),
          supplier_id: receipt.supplier_id,
          purchase_order_id: receipt.purchase_order_id,
          goods_receipt_id: receiptId,
          title: `Công nợ nhập kho ${receipt.receipt_number}`,
          description: `Tạo từ phiếu nhập kho ${receipt.receipt_number}`,
          total_amount: totalAmount,
          vat_amount: vatAmount,
          status: "pending",
          delivery_status: "delivered",
          payment_status: "unpaid",
          payment_type: "old_order",
          payment_method: "bank_transfer",
          image_url: receipt.image_url || null,
          created_by: user.id,
          notes: `Tự động tạo từ phiếu nhập kho. Chênh lệch: ${JSON.stringify(varianceSummary)}`,
        })
        .select("id, request_number")
        .single();

      if (payableInsertError || !createdPayable) {
        console.error("Error creating payable request:", payableInsertError);
        return jsonResponse(req, { error: "Failed to create payable request" }, 500);
      }
      payableId = createdPayable.id;
    }

    const requestItems = payableItems.map(({ item, actualQuantity, unitPrice, lineTotal }) => ({
      payment_request_id: payableId,
      product_name: item.product_name,
      quantity: actualQuantity,
      unit: item.unit,
      unit_price: unitPrice,
      line_total: payableLineTotal(actualQuantity, unitPrice),
      inventory_item_id: finalizedInventoryItemIds.get(item.id) || item.inventory_item_id || null,
      sku_id: item.sku_id || null,
      notes: [
        item.line_status ? `Tình trạng: ${item.line_status}` : null,
        item.variance_reason ? `Lý do lệch: ${item.variance_reason}` : null,
        item.purchase_order_item_id ? `PO item: ${item.purchase_order_item_id}` : null,
      ].filter(Boolean).join("; ") || null,
    }));

    const { error: itemInsertError } = await supabase
      .from("payment_request_items")
      .insert(requestItems);
    if (itemInsertError) {
      console.error("Error creating payable items:", itemInsertError);
      return jsonResponse(req, { error: "Failed to create payable items" }, 500);
    }

    const { error: receiptUpdateError } = await supabase
      .from("goods_receipts")
      .update({
        status: "received",
        payable_status: "generated",
        payment_request_id: payableId,
        finalized_at: new Date().toISOString(),
        finalized_by: user.id,
        variance_summary: varianceSummary,
        total_quantity: payableItems.reduce((sum, { actualQuantity }) => sum + actualQuantity, 0),
        updated_at: new Date().toISOString(),
      })
      .eq("id", receiptId);

    if (receiptUpdateError) {
      console.error("Error finalizing goods receipt:", receiptUpdateError);
      return jsonResponse(req, { error: "Failed to finalize goods receipt" }, 500);
    }

    const hasShortage = receiptItems.some((item) => {
      const actualQuantity = Number(item.actual_quantity ?? item.quantity ?? 0);
      const orderedQuantity = Number(item.ordered_quantity ?? item.quantity ?? 0);
      return item.line_status === "thieu" || actualQuantity < orderedQuantity;
    });

    if (receipt.purchase_order_id) {
      const { error: poUpdateError } = await supabase
        .from("purchase_orders")
        .update({
          status: hasShortage ? "in_transit" : "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", receipt.purchase_order_id);
      if (poUpdateError) console.error("Error updating purchase order status:", poUpdateError);
    }

    return jsonResponse(req, {
      success: true,
      receiptId,
      payableId,
      totalAmount,
      vatAmount,
      varianceSummary,
    });
  } catch (error) {
    console.error("Error in finalize-goods-receipt:", error);
    return jsonResponse(req, { error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});
