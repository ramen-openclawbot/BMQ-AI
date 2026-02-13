import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { db } from "@/lib/supabase-helpers";
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

// Confirm goods receipt and sync inventory + create batches
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

      // 2. Get receipt for supplier_id and receipt_number
      const { data: receipt, error: receiptError } = await supabase
        .from("goods_receipts")
        .select("supplier_id, receipt_number")
        .eq("id", receiptId)
        .single();

      if (receiptError) throw receiptError;

      // 3. Sync inventory for each item and prepare batch records
      const batchesToCreate: any[] = [];

      for (let index = 0; index < (items || []).length; index++) {
        const item = items![index];
        let inventoryItemId = item.inventory_item_id;

        if (item.inventory_item_id) {
          // Update existing inventory item
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
          // Try to find existing inventory item by name
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

            inventoryItemId = existingItem.id;
          } else {
            // Create new inventory item
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

              inventoryItemId = newItem.id;
            }
          }
        }

        // Create batch record for this item
        if (inventoryItemId) {
          batchesToCreate.push({
            inventory_item_id: inventoryItemId,
            sku_id: item.sku_id || null,
            goods_receipt_id: receiptId,
            goods_receipt_item_id: item.id,
            batch_number: `${receipt.receipt_number}-${String(index + 1).padStart(3, "0")}`,
            quantity: item.quantity,
            unit: item.unit,
            received_date: new Date().toISOString().split("T")[0],
            manufacture_date: (item as any).manufacture_date || null,
            expiry_date: (item as any).expiry_date || null,
            notes: item.notes,
          } as any);
        }
      }

      // 4. Create all batch records
      if (batchesToCreate.length > 0) {
        const { error: batchError } = await db
          .from("inventory_batches")
          .insert(batchesToCreate);
        
        if (batchError) {
          console.error("Error creating batches:", batchError);
          // Don't throw - batches are supplementary
        }
      }

      // 5. Update receipt status to received
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
      queryClient.invalidateQueries({ queryKey: ["inventory-batches"] });
      queryClient.invalidateQueries({ queryKey: ["expiry-stats"] });
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
