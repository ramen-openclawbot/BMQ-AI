import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { callEdgeFunction } from "@/lib/fetch-with-timeout";

export type GoodsReceipt = Tables<"goods_receipts"> & {
  suppliers?: { id: string; name: string } | null;
};

export type GoodsReceiptItem = Tables<"goods_receipt_items"> & {
  product_skus?: { id: string; sku_code: string; product_name: string } | null;
  inventory_items?: { id: string; name: string; quantity: number } | null;
};

export type GoodsReceiptInsert = TablesInsert<"goods_receipts">;
export type GoodsReceiptItemInsert = TablesInsert<"goods_receipt_items">;

// Fetch all goods receipts
export function useGoodsReceipts() {
  return useQuery({
    queryKey: ["goods-receipts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("goods_receipts")
        .select("*, suppliers(id, name)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as GoodsReceipt[];
    },
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
    retry: 1,
  });
}

// Fetch single goods receipt
export function useGoodsReceipt(id: string | null) {
  return useQuery({
    queryKey: ["goods-receipt", id],
    queryFn: async () => {
      if (!id) throw new Error("No ID provided");
      const { data, error } = await supabase
        .from("goods_receipts")
        .select("*, suppliers(id, name)")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data as GoodsReceipt;
    },
    enabled: !!id,
    staleTime: 30000,
  });
}

// Fetch goods receipt items
export function useGoodsReceiptItems(receiptId: string | null) {
  return useQuery({
    queryKey: ["goods-receipt-items", receiptId],
    queryFn: async () => {
      if (!receiptId) throw new Error("No receipt ID provided");
      const { data, error } = await supabase
        .from("goods_receipt_items")
        .select("*, product_skus(id, sku_code, product_name), inventory_items(id, name, quantity)")
        .eq("goods_receipt_id", receiptId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as GoodsReceiptItem[];
    },
    enabled: !!receiptId,
    staleTime: 30000,
  });
}

// Generate receipt number
export async function generateReceiptNumber(): Promise<string> {
  const { data, error } = await supabase.rpc("generate_receipt_number");
  if (error) {
    const timestamp = Date.now().toString().slice(-6);
    return `GRN-${timestamp}`;
  }
  return data;
}

// Create goods receipt
export function useCreateGoodsReceipt() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (receipt: Omit<GoodsReceiptInsert, "receipt_number">) => {
      const receipt_number = await generateReceiptNumber();
      const { data, error } = await supabase
        .from("goods_receipts")
        .insert({ ...receipt, receipt_number })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["goods-receipts"] });
    },
  });
}

// Create goods receipt item
export function useCreateGoodsReceiptItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (item: GoodsReceiptItemInsert) => {
      const { data, error } = await supabase
        .from("goods_receipt_items")
        .insert(item)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["goods-receipt-items", variables.goods_receipt_id] });
    },
  });
}

// Update goods receipt
export function useUpdateGoodsReceipt() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }: { id: string } & Partial<TablesUpdate<"goods_receipts">>) => {
      const { data, error } = await supabase
        .from("goods_receipts")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["goods-receipts"] });
      queryClient.invalidateQueries({ queryKey: ["goods-receipt", data.id] });
    },
  });
}

// Delete goods receipt
export function useDeleteGoodsReceipt() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("goods_receipts")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["goods-receipts"] });
    },
  });
}

// Confirm goods receipt and sync inventory + create payable from actual received quantities
export function useConfirmGoodsReceipt() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (receiptId: string) => {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await callEdgeFunction<{
        success: boolean;
        receiptId: string;
        payableId: string;
        totalAmount: number;
        vatAmount: number;
        varianceSummary: Record<string, number>;
      }>(
        "finalize-goods-receipt",
        { receiptId },
        session?.access_token,
        120000
      );

      if (response.error || !response.data) {
        throw new Error(response.error || "Không thể chốt phiếu nhập kho");
      }

      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["goods-receipts"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["low-stock"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-batches"] });
      queryClient.invalidateQueries({ queryKey: ["expiry-stats"] });
      queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
      queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
  });
}

// Upload goods receipt image
export async function uploadGoodsReceiptImage(file: File): Promise<string> {
  const fileExt = file.name.split(".").pop();
  const fileName = `grn-${Date.now()}.${fileExt}`;
  const filePath = `goods-receipts/${fileName}`;

  const { error } = await supabase.storage
    .from("invoices")
    .upload(filePath, file);

  if (error) throw error;
  return filePath;
}

// Get signed URL for goods receipt image
export async function getGoodsReceiptImageUrl(path: string): Promise<string> {
  const { data } = await supabase.storage
    .from("invoices")
    .createSignedUrl(path, 60 * 60);

  return data?.signedUrl || "";
}
