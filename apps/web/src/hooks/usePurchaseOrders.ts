import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

// Helper function to get signed URL for PO images
export async function getPurchaseOrderImageUrl(path: string): Promise<string | null> {
  if (!path) return null;
  
  if (path.startsWith("http")) {
    const match = path.match(/\/purchase-orders\/(.+?)(?:\?|$)/);
    if (match) {
      const extractedPath = decodeURIComponent(match[1]);
      const { data } = await supabase.storage
        .from("purchase-orders")
        .createSignedUrl(extractedPath, 3600);
      return data?.signedUrl || null;
    }
    return null;
  }
  
  const { data } = await supabase.storage
    .from("purchase-orders")
    .createSignedUrl(path, 3600);
  
  return data?.signedUrl || null;
}

export type PurchaseOrder = Tables<"purchase_orders"> & {
  suppliers?: { id: string; name: string } | null;
};

export type PurchaseOrderItem = Tables<"purchase_order_items"> & {
  productSkus?: { id: string; sku_code: string; product_name: string } | null;
};

export type PurchaseOrderInsert = TablesInsert<"purchase_orders">;
export type PurchaseOrderItemInsert = TablesInsert<"purchase_order_items">;

export function usePurchaseOrders() {
  return useQuery({
    queryKey: ["purchase-orders"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("*, suppliers(id, name)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as PurchaseOrder[];
    },
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });
}

export function usePurchaseOrder(id: string | null) {
  return useQuery({
    queryKey: ["purchase-order", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await supabase
        .from("purchase_orders")
        .select("*, suppliers(id, name)")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data as PurchaseOrder | null;
    },
    enabled: !!id,
    staleTime: 30000,
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });
}

export function usePurchaseOrderItems(orderId: string | null) {
  return useQuery({
    queryKey: ["purchase-order-items", orderId],
    queryFn: async () => {
      if (!orderId) return [];
      const { data, error } = await supabase
        .from("purchase_order_items")
        .select("*, productSkus:product_skus(id, sku_code, product_name)")
        .eq("purchase_order_id", orderId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as PurchaseOrderItem[];
    },
    enabled: !!orderId,
    staleTime: 30000,
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });
}

export async function generatePONumber(): Promise<string> {
  const { data, error } = await supabase.rpc("generate_po_number");
  if (error) throw error;
  return data;
}

export function useCreatePurchaseOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (order: PurchaseOrderInsert) => {
      const { data, error } = await supabase
        .from("purchase_orders")
        .insert(order)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
  });
}

export function useCreatePurchaseOrderItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (item: PurchaseOrderItemInsert) => {
      const { data, error } = await supabase
        .from("purchase_order_items")
        .insert(item)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["purchase-order-items"] });
    },
  });
}

export function useUpdatePurchaseOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<Tables<"purchase_orders">> & { id: string }) => {
      const { data, error } = await supabase
        .from("purchase_orders")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["purchase-order"] });
    },
  });
}

export function useDeletePurchaseOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data: linkedPR } = await supabase
        .from("payment_requests")
        .select("id")
        .eq("purchase_order_id", id)
        .maybeSingle();

      if (linkedPR) {
        await supabase
          .from("payment_request_items")
          .delete()
          .eq("payment_request_id", linkedPR.id);

        await supabase
          .from("payment_requests")
          .delete()
          .eq("id", linkedPR.id);
      }

      await supabase
        .from("purchase_order_items")
        .delete()
        .eq("purchase_order_id", id);

      const { error } = await supabase
        .from("purchase_orders")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["drive-file-index"] });
    },
  });
}

export function useSendPurchaseOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("purchase_orders")
        .update({ status: "sent" })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["purchase-order"] });
    },
  });
}

export function useMarkPOCompleted() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, goodsReceiptId }: { id: string; goodsReceiptId?: string }) => {
      const { error } = await supabase
        .from("purchase_orders")
        .update({ status: "completed" })
        .eq("id", id);
      if (error) throw error;

      if (goodsReceiptId) {
        await supabase
          .from("goods_receipts")
          .update({ purchase_order_id: id })
          .eq("id", goodsReceiptId);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["purchase-order"] });
      queryClient.invalidateQueries({ queryKey: ["goods-receipts"] });
    },
  });
}

export function useCancelPurchaseOrder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data: linkedPR } = await supabase
        .from("payment_requests")
        .select("id")
        .eq("purchase_order_id", id)
        .maybeSingle();

      if (linkedPR) {
        await supabase
          .from("payment_request_items")
          .delete()
          .eq("payment_request_id", linkedPR.id);

        await supabase
          .from("payment_requests")
          .delete()
          .eq("id", linkedPR.id);
      }

      const { error } = await supabase
        .from("purchase_orders")
        .update({ status: "cancelled" })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["purchase-order"] });
      queryClient.invalidateQueries({ queryKey: ["draft-po-count"] });
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["drive-file-index"] });
    },
  });
}

export function useDraftPOCount() {
  return useQuery({
    queryKey: ["draft-po-count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("purchase_orders")
        .select("*", { count: "exact", head: true })
        .eq("status", "draft");
      if (error) throw error;
      return count || 0;
    },
    staleTime: 30000,
  });
}
