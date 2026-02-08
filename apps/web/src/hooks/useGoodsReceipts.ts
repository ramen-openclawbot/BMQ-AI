import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";

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

// Confirm goods receipt and sync inventory
export function useConfirmGoodsReceipt() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (receiptId: string) => {
      // 1. Get receipt items
      const { data: items, error: itemsError } = await supabase
        .from("goods_receipt_items")
        .select("*")
        .eq("goods_receipt_id", receiptId);

      if (itemsError) throw itemsError;

      // 2. Get receipt for supplier_id
      const { data: receipt, error: receiptError } = await supabase
        .from("goods_receipts")
        .select("supplier_id")
        .eq("id", receiptId)
        .single();

      if (receiptError) throw receiptError;

      // 3. Sync inventory for each item
      for (const item of items || []) {
        if (item.inventory_item_id) {
          const { data: inventoryItem } = await supabase
            .from("inventory_items")
            .select("quantity")
            .eq("id", item.inventory_item_id)
            .single();

          if (inventoryItem) {
            await supabase
              .from("inventory_items")
              .update({ quantity: inventoryItem.quantity + item.quantity })
              .eq("id", item.inventory_item_id);
          }
        } else {
          const { data: existingItem } = await supabase
            .from("inventory_items")
            .select("id, quantity")
            .ilike("name", item.product_name)
            .maybeSingle();

          if (existingItem) {
            await supabase
              .from("inventory_items")
              .update({ quantity: existingItem.quantity + item.quantity })
              .eq("id", existingItem.id);

            await supabase
              .from("goods_receipt_items")
              .update({ inventory_item_id: existingItem.id })
              .eq("id", item.id);
          } else {
            const { data: newItem } = await supabase
              .from("inventory_items")
              .insert({
                name: item.product_name,
                quantity: item.quantity,
                unit: item.unit,
                category: "Từ phiếu nhập",
                supplier_id: receipt.supplier_id,
              })
              .select()
              .single();

            if (newItem) {
              await supabase
                .from("goods_receipt_items")
                .update({ inventory_item_id: newItem.id })
                .eq("id", item.id);
            }
          }
        }
      }

      // 4. Update receipt status to received
      const { error: updateError } = await supabase
        .from("goods_receipts")
        .update({ status: "received" })
        .eq("id", receiptId);

      if (updateError) throw updateError;

      return { success: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["goods-receipts"] });
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["low-stock"] });
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
