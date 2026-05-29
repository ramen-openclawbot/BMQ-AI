import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { resolveImageUrl } from "@/lib/storage-url";
import type { Database } from "@/integrations/supabase/types";
import { processPaymentRequestSKUs } from "@/lib/sku-generator";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";

type PaymentRequest = Database["public"]["Tables"]["payment_requests"]["Row"];
type PaymentRequestItem = Database["public"]["Tables"]["payment_request_items"]["Row"];
type PaymentAllocation = Database["public"]["Tables"]["payment_allocations"]["Row"];
type PaymentRequestInsert = Database["public"]["Tables"]["payment_requests"]["Insert"];
type PaymentRequestItemInsert = Database["public"]["Tables"]["payment_request_items"]["Insert"];

export interface PaymentRequestWithSupplier extends PaymentRequest {
  suppliers?: { id: string; name: string } | null;
  payment_request_items?: Array<Pick<PaymentRequestItem, "id" | "product_name" | "raw_product_name">> | null;
  payment_allocations?: Array<Pick<PaymentAllocation, "id" | "amount" | "payment_id" | "created_at">> | null;
  goods_receipts?: { id: string; receipt_number: string | null; receipt_date: string | null; payable_status: string | null } | null;
  purchase_orders?: { id: string; po_number: string | null; status: string | null } | null;
}

export interface PaymentRequestItemWithInventory extends PaymentRequestItem {
  inventory_items?: { id: string; name: string; quantity: number } | null;
}

export const getAllocatedAmount = (request: Pick<PaymentRequestWithSupplier, "payment_allocations">) =>
  (request.payment_allocations || []).reduce((sum, allocation) => sum + (Number(allocation.amount) || 0), 0);

export const getRemainingPaymentAmount = (request: Pick<PaymentRequestWithSupplier, "total_amount" | "payment_allocations">) =>
  Math.max((Number(request.total_amount) || 0) - getAllocatedAmount(request), 0);

export const hasOutstandingPayment = (request: Pick<PaymentRequestWithSupplier, "payment_status" | "total_amount" | "payment_allocations">) =>
  request.payment_status === "unpaid" || request.payment_status === "partial" || getRemainingPaymentAmount(request) > 0;

export function usePaymentRequests() {
  return useQuery({
    queryKey: ["payment-requests"],
    queryFn: async () => {
      const relationSelect = "*, suppliers(id, name), payment_request_items(id, product_name, raw_product_name), payment_allocations(id, amount, payment_id, created_at), goods_receipts(id, receipt_number, receipt_date, payable_status), purchase_orders(id, po_number, status)";
      const fallbackSelect = "*, suppliers(id, name), payment_request_items(id, product_name, raw_product_name), payment_allocations(id, amount, payment_id, created_at)";

      const { data, error } = await supabase
        .from("payment_requests")
        .select(relationSelect)
        .order("created_at", { ascending: false });

      if (!error) return data as PaymentRequestWithSupplier[];

      console.warn("[usePaymentRequests] Falling back without receipt/PO relations", error);
      const { data: fallbackData, error: fallbackError } = await supabase
        .from("payment_requests")
        .select(fallbackSelect)
        .order("created_at", { ascending: false });
      if (fallbackError) throw fallbackError;
      return fallbackData as PaymentRequestWithSupplier[];
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
        .select("*, suppliers(id, name), payment_allocations(id, amount, payment_id, created_at), goods_receipts(id, receipt_number, receipt_date, payable_status), purchase_orders(id, po_number, status)")
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
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
      }

      const result = await callEdgeFunction<{ success: boolean; id: string; unlinked_invoice_count: number }>(
        "delete-payment-request",
        { id },
        session.access_token,
        30000
      );

      if (result.error || !result.data?.success) {
        throw new Error(result.error || "Không xoá được duyệt chi");
      }

      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-request"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
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
    mutationFn: async (input: string | { id: string; amount?: number }) => {
      const id = typeof input === "string" ? input : input.id;
      let amount = typeof input === "string" ? undefined : input.amount;

      if (amount === undefined) {
        const { data: request, error: requestError } = await supabase
          .from("payment_requests")
          .select("id, total_amount, payment_allocations(amount)")
          .eq("id", id)
          .single();

        if (requestError) throw requestError;
        amount = getRemainingPaymentAmount(request as PaymentRequestWithSupplier);
      }

      if (!amount || amount <= 0) {
        throw new Error("Số tiền thanh toán phải lớn hơn 0.");
      }

      const { error } = await supabase.rpc("record_payment_allocations", {
        p_allocations: [{ payment_request_id: id, amount }],
        p_payment_method: null,
        p_payment_date: new Date().toISOString().slice(0, 10),
        p_reference_number: null,
        p_notes: null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-request"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
      queryClient.invalidateQueries({ queryKey: ["cost-classification-monthly-summary"] });
      queryClient.invalidateQueries({ queryKey: ["cost-classification-category-summary"] });
      queryClient.invalidateQueries({ queryKey: ["cost-classification-review-queue"] });
      queryClient.invalidateQueries({ queryKey: ["cost-classification-line-details"] });
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
      const { data: requests, error: requestError } = await supabase
        .from("payment_requests")
        .select("id, total_amount, payment_method, payment_allocations(amount)")
        .in("id", ids);

      if (requestError) throw requestError;

      const allocations = (requests || [])
        .map((request) => ({
          payment_request_id: request.id,
          amount: getRemainingPaymentAmount(request as PaymentRequestWithSupplier),
        }))
        .filter((allocation) => allocation.amount > 0);

      if (allocations.length === 0) {
        throw new Error("Không còn số tiền cần thanh toán.");
      }

      const paymentMethods = new Set((requests || []).map((request) => request.payment_method).filter(Boolean));
      const paymentMethod = paymentMethods.size === 1 ? Array.from(paymentMethods)[0] : null;

      const { error } = await supabase.rpc("record_payment_allocations", {
        p_allocations: allocations,
        p_payment_method: paymentMethod,
        p_payment_date: new Date().toISOString().slice(0, 10),
        p_reference_number: null,
        p_notes: allocations.length > 1 ? "Thanh toán gộp nhiều đề nghị chi" : null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
      queryClient.invalidateQueries({ queryKey: ["pending-invoice-count"] });
      queryClient.invalidateQueries({ queryKey: ["cost-classification-monthly-summary"] });
      queryClient.invalidateQueries({ queryKey: ["cost-classification-category-summary"] });
      queryClient.invalidateQueries({ queryKey: ["cost-classification-review-queue"] });
      queryClient.invalidateQueries({ queryKey: ["cost-classification-line-details"] });
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
  const resolved = await resolveImageUrl(path, { preferredBucket: "invoices" });
  return resolved || "";
}
