import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

const normalizeViText = (value: string) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const scoreNameMatch = (query: string, target: string) => {
  const q = normalizeViText(query);
  const t = normalizeViText(target);
  if (!q || !t) return 0;
  if (q === t) return 120;
  if (t.startsWith(q) || q.startsWith(t)) return 100;
  if (t.includes(q) || q.includes(t)) return 80;

  const qTokens = q.split(" ").filter(Boolean);
  const tTokens = t.split(" ").filter(Boolean);
  const overlap = qTokens.filter((token) => tTokens.includes(token)).length;
  if (!overlap) return 0;

  const coverage = overlap / Math.max(qTokens.length, tTokens.length);
  return Math.round(coverage * 70);
};

export interface ProductSKU {
  id: string;
  sku_code: string;
  product_name: string;
  unit: string | null;
  unit_price: number | null;
  supplier_id: string | null;
  category: string | null;
  sku_type?: "raw_material" | "finished_good" | null;
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
  sku_type?: "raw_material" | "finished_good";
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
    const normalizedCode = normalizeViText(productCode || "").replace(/\s+/g, "");

    if (normalizedCode) {
      const { data, error } = await supabase
        .from("product_skus")
        .select("*, suppliers(id, name)")
        .eq("sku_code", productCode || "")
        .maybeSingle();

      if (!error && data) return data as ProductSKU;

      const { data: codeCandidates } = await supabase
        .from("product_skus")
        .select("*, suppliers(id, name)")
        .ilike("sku_code", `%${productCode}%`)
        .limit(20);

      if (codeCandidates?.length) {
        const bestByCode = codeCandidates
          .map((sku) => {
            const skuCode = normalizeViText((sku as any).sku_code || "").replace(/\s+/g, "");
            const score = skuCode === normalizedCode ? 120 : skuCode.includes(normalizedCode) ? 95 : 0;
            return { sku, score };
          })
          .sort((a, b) => b.score - a.score)[0];

        if (bestByCode && bestByCode.score >= 90) return bestByCode.sku as ProductSKU;
      }
    }

    if (productName) {
      const { data: candidates } = await supabase
        .from("product_skus")
        .select("*, suppliers(id, name)")
        .limit(500);

      if (candidates?.length) {
        const best = candidates
          .map((sku) => {
            const nameScore = scoreNameMatch(productName, (sku as any).product_name || "");
            const codeScore = normalizedCode
              ? normalizeViText((sku as any).sku_code || "").replace(/\s+/g, "").includes(normalizedCode)
                ? 15
                : 0
              : 0;
            return { sku, score: nameScore + codeScore };
          })
          .sort((a, b) => b.score - a.score)[0];

        if (best && best.score >= 65) return best.sku as ProductSKU;
      }
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
      .select("unit_price, product_name, created_at")
      .order("created_at", { ascending: false })
      .limit(300);

    const best = (data || [])
      .map((row: any) => ({ row, score: scoreNameMatch(productName, row.product_name || "") }))
      .sort((a, b) => b.score - a.score)[0];

    return {
      lastPrice: best && best.score >= 65 ? best.row.unit_price || null : null,
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
      .select("id, name, quantity")
      .limit(500);

    const best = (data || [])
      .map((row: any) => ({ row, score: scoreNameMatch(productName, row.name || "") }))
      .sort((a, b) => b.score - a.score)[0];

    return {
      exists: !!best && best.score >= 65,
      currentQuantity: best && best.score >= 65 ? best.row.quantity || 0 : 0,
      inventoryItemId: best && best.score >= 65 ? best.row.id || null : null,
    };
  } catch (err) {
    console.warn("checkInventory error:", err);
    return { exists: false, currentQuantity: 0, inventoryItemId: null };
  }
}
