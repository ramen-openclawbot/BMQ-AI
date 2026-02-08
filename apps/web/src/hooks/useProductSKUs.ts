import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface ProductSKU {
  id: string;
  sku_code: string;
  product_name: string;
  unit: string | null;
  unit_price: number | null;
  supplier_id: string | null;
  category: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  suppliers?: { id: string; name: string } | null;
}

export interface ProductSKUInsert {
  sku_code: string;
  product_name: string;
  unit?: string;
  unit_price?: number;
  supplier_id?: string | null;
  category?: string;
  notes?: string;
  created_by?: string;
}

export function useProductSKUs() {
  return useQuery({
    queryKey: ["product-skus"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_skus")
        .select("*, suppliers(id, name)")
        .order("sku_code", { ascending: true });
      if (error) throw error;
      return data as ProductSKU[];
    },
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
  });
}

export function useCreateProductSKU() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sku: ProductSKUInsert) => {
      const { data, error } = await supabase
        .from("product_skus")
        .insert(sku)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product-skus"] });
    },
    onError: (error: any) => {
      console.error("Error creating SKU:", error);
    },
  });
}

export function useUpdateProductSKU() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<ProductSKU> & { id: string }) => {
      const { data, error } = await supabase
        .from("product_skus")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product-skus"] });
    },
    onError: (error) => {
      console.error("Error updating SKU:", error);
    },
  });
}

export function useDeleteProductSKU() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("product_skus")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["product-skus"] });
    },
    onError: (error) => {
      console.error("Error deleting SKU:", error);
    },
  });
}

// Helper to find SKU by product code or name
export async function findSKUByCodeOrName(
  productCode?: string,
  productName?: string
): Promise<ProductSKU | null> {
  try {
    if (productCode) {
      const { data, error } = await supabase
        .from("product_skus")
        .select("*, suppliers(id, name)")
        .eq("sku_code", productCode)
        .limit(1)
        .single();
      if (!error && data) return data as ProductSKU;
    }

    if (productName) {
      const { data, error } = await supabase
        .from("product_skus")
        .select("*, suppliers(id, name)")
        .ilike("product_name", `%${productName}%`)
        .limit(1);
      if (!error && data && data.length > 0) return data[0] as ProductSKU;
    }
  } catch (err) {
    console.warn("Error finding SKU:", err);
  }

  return null;
}

// Helper to get last price from invoice_items
export async function getLastPrice(
  productName: string
): Promise<{ lastPrice: number | null; priceChangePercent: number | null }> {
  try {
    const { data } = await supabase
      .from("invoice_items")
      .select("unit_price, created_at")
      .ilike("product_name", `%${productName}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      lastPrice: data?.unit_price || null,
      priceChangePercent: null,
    };
  } catch (err) {
    console.warn("getLastPrice error:", err);
    return { lastPrice: null, priceChangePercent: null };
  }
}

// Helper to check inventory status
export async function checkInventory(
  productName: string
): Promise<{ exists: boolean; currentQuantity: number; inventoryItemId: string | null }> {
  try {
    const { data } = await supabase
      .from("inventory_items")
      .select("id, quantity")
      .ilike("name", `%${productName}%`)
      .maybeSingle();

    return {
      exists: !!data,
      currentQuantity: data?.quantity || 0,
      inventoryItemId: data?.id || null,
    };
  } catch (err) {
    console.warn("checkInventory error:", err);
    return { exists: false, currentQuantity: 0, inventoryItemId: null };
  }
}
