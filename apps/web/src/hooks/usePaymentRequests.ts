import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { processPaymentRequestSKUs } from "@/lib/sku-generator";

type PaymentRequest = Database["public"]["Tables"]["payment_requests"]["Row"];
type PaymentRequestItem = Database["public"]["Tables"]["payment_request_items"]["Row"];
type PaymentRequestInsert = Database["public"]["Tables"]["payment_requests"]["Insert"];
type PaymentRequestItemInsert = Database["public"]["Tables"]["payment_request_items"]["Insert"];

export interface PaymentRequestWithSupplier extends PaymentRequest {
  suppliers?: { id: string; name: string } | null;
}

export interface PaymentRequestItemWithInventory extends PaymentRequestItem {
  inventory_items?: { id: string; name: string; quantity: number } | null;
}

export function usePaymentRequests() {
  return useQuery({
    queryKey: ["payment-requests"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_requests")
        .select("*, suppliers(id, name)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as PaymentRequestWithSupplier[];
    },
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
  });
}

export function usePaymentRequest(id: string | null) {
  return useQuery({
    queryKey: ["payment-request", id],
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await supabase
        .from("payment_requests")
        .select("*, suppliers(id, name)")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data as PaymentRequestWithSupplier;
    },
    enabled: !!id,
    staleTime: 30000,
  });
}

export function usePaymentRequestItems(paymentRequestId: string | null) {
  return useQuery({
    queryKey: ["payment-request-items", paymentRequestId],
    queryFn: async () => {
      if (!paymentRequestId) return [];
      const { data, error } = await supabase
        .from("payment_request_items")
        .select("*, inventory_items(id, name, quantity)")
        .eq("payment_request_id", paymentRequestId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as PaymentRequestItemWithInventory[];
    },
    enabled: !!paymentRequestId,
    staleTime: 30000,
  });
}

export function useCreatePaymentRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: PaymentRequestInsert) => {
      const { data, error } = await supabase
        .from("payment_requests")
        .insert(request)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
    },
    onError: (error) => {
      console.error("Error creating payment request:", error);
    },
  });
}

export function useUpdatePaymentRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<PaymentRequest> & { id: string }) => {
      const { data, error } = await supabase
        .from("payment_requests")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-request"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
    },
    onError: (error) => {
      console.error("Error updating payment request:", error);
    },
  });
}

export function useDeletePaymentRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("payment_requests")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
    },
    onError: (error) => {
      console.error("Error deleting payment request:", error);
    },
  });
}

export function useCreatePaymentRequestItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (item: PaymentRequestItemInsert) => {
      const { data, error } = await supabase
        .from("payment_request_items")
        .insert(item)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-request-items"] });
    },
    onError: (error) => {
      console.error("Error creating payment request item:", error);
    },
  });
}

export function useApprovePaymentRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, paymentMethod }: { id: string; paymentMethod: "bank_transfer" | "cash" }) => {
      // Get payment request items
      const { data: items, error: itemsError } = await supabase
        .from("payment_request_items")
        .select("*, inventory_items(id, name, quantity)")
        .eq("payment_request_id", id);
      
      if (itemsError) throw itemsError;

      // Update payment request status with payment method
      const { error: updateError } = await supabase
        .from("payment_requests")
        .update({
          status: "approved",
          payment_method: paymentMethod,
          approved_by: null,
          approved_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (updateError) throw updateError;

      // Auto-create SKUs for items that don't have one
      const skuResult = await processPaymentRequestSKUs(id);
      console.log("SKU processing result:", skuResult);

      return { items, skuResult };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-request"] });
      queryClient.invalidateQueries({ queryKey: ["product-skus"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
    },
    onError: (error) => {
      console.error("Error approving payment request:", error);
    },
  });
}

export function useRejectPaymentRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const { error } = await supabase
        .from("payment_requests")
        .update({
          status: "rejected",
          rejection_reason: reason,
          approved_by: null,
          approved_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-request"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
    },
    onError: (error) => {
      console.error("Error rejecting payment request:", error);
    },
  });
}

export function useMarkDelivered() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("payment_requests")
        .update({ delivery_status: "delivered" })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-request"] });
    },
    onError: (error) => {
      console.error("Error marking as delivered:", error);
    },
  });
}

export function useMarkPaid() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("payment_requests")
        .update({ payment_status: "paid" })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-request"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
    },
    onError: (error) => {
      console.error("Error marking as paid:", error);
    },
  });
}

// Bulk mark multiple requests as paid
export function useBulkMarkPaid() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase
        .from("payment_requests")
        .update({ payment_status: "paid" })
        .in("id", ids);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
    },
    onError: (error) => {
      console.error("Error bulk marking as paid:", error);
    },
  });
}

// Bulk approve multiple pending payment requests
export function useBulkApprovePaymentRequest() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (ids: string[]) => {
      const { error: updateError } = await supabase
        .from("payment_requests")
        .update({
          status: "approved",
          approved_at: new Date().toISOString(),
        })
        .in("id", ids);

      if (updateError) throw updateError;

      // Process SKUs in parallel
      const skuResults = await Promise.all(
        ids.map(id => processPaymentRequestSKUs(id))
      );

      return { 
        count: ids.length, 
        skusCreated: skuResults.reduce((sum, r) => sum + r.created, 0),
        skusLinked: skuResults.reduce((sum, r) => sum + r.linked, 0),
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-request"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["product-skus"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
    },
    onError: (error) => {
      console.error("Error bulk approving payment requests:", error);
    },
  });
}

// Helper to get last price for a product
export async function getLastPrice(productName: string): Promise<{ lastPrice: number | null; priceChangePercent: number | null }> {
  const { data } = await supabase
    .from("invoice_items")
    .select("unit_price, created_at")
    .ilike("product_name", productName)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    lastPrice: data?.unit_price || null,
    priceChangePercent: null,
  };
}

// Helper to check inventory status
export async function checkInventoryStatus(productName: string): Promise<{ exists: boolean; currentQuantity: number; inventoryItemId: string | null }> {
  const { data } = await supabase
    .from("inventory_items")
    .select("id, quantity")
    .ilike("name", productName)
    .maybeSingle();

  return {
    exists: !!data,
    currentQuantity: data?.quantity || 0,
    inventoryItemId: data?.id || null,
  };
}

export async function uploadPaymentRequestImage(file: File): Promise<string> {
  const fileExt = file.name.split(".").pop();
  const fileName = `${crypto.randomUUID()}.${fileExt}`;
  const filePath = `payment-requests/${fileName}`;

  const { error } = await supabase.storage
    .from("invoices")
    .upload(filePath, file);

  if (error) throw error;

  return filePath;
}

export async function getPaymentRequestImageUrl(path: string): Promise<string> {
  const { data } = await supabase.storage
    .from("invoices")
    .createSignedUrl(path, 3600);

  return data?.signedUrl || "";
}
