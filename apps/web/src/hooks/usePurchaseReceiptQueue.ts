import { supabase } from "@/integrations/supabase/client";

export async function ensureReceiptForPurchaseOrder(purchaseOrderId: string): Promise<string> {
  const { data, error } = await supabase.rpc("ensure_purchase_order_receipt_queue", {
    p_purchase_order_id: purchaseOrderId,
  });

  if (error) throw error;
  return data;
}
