import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { db } from "@/lib/supabase-helpers";

export interface InventoryItem {
  id: string;
  name: string;
  category: string | null;
  quantity: number;
  unit: string | null;
  min_stock: number | null;
  supplier_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function useInventory() {
  return useQuery({
    queryKey: ["inventory"],
    queryFn: async () => {
      const { data, error } = await db
        .from("inventory_items")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as InventoryItem[];
    },
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useLowStockItems() {
  return useQuery({
    queryKey: ["low-stock"],
    queryFn: async () => {
      const { data, error } = await db
        .from("inventory_items")
        .select("*")
        .order("quantity", { ascending: true });
      if (error) throw error;
      return (data as InventoryItem[]).filter(
        (item) => item.quantity <= (item.min_stock || 0),
      );
    },
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useCreateInventoryItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (item: Omit<InventoryItem, "id" | "created_at" | "updated_at">) => {
      const { data, error } = await db
        .from("inventory_items")
        .insert(item)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["low-stock"] });
    },
  });
}

export function useUpdateInventoryItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<InventoryItem> & { id: string }) => {
      const { data, error } = await db
        .from("inventory_items")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["low-stock"] });
    },
  });
}

export function useDeleteInventoryItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db
        .from("inventory_items")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      queryClient.invalidateQueries({ queryKey: ["low-stock"] });
    },
  });
}

export interface ExpiryStats {
  expired: number;
  due7: number;
  due30: number;
  safe: number;
  totalBatches: number;
}

export function useExpiryStats() {
  return useQuery({
    queryKey: ["expiry-stats"],
    queryFn: async () => {
      const { data, error } = await db
        .from("inventory_batches")
        .select("id, expiry_date");
      if (error) throw error;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const stats: ExpiryStats = {
        expired: 0,
        due7: 0,
        due30: 0,
        safe: 0,
        totalBatches: data?.length || 0,
      };

      for (const row of data || []) {
        if (!row.expiry_date) {
          stats.safe += 1;
          continue;
        }
        const d = new Date(row.expiry_date);
        d.setHours(0, 0, 0, 0);
        const diffDays = Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays < 0) stats.expired += 1;
        else if (diffDays <= 7) stats.due7 += 1;
        else if (diffDays <= 30) stats.due30 += 1;
        else stats.safe += 1;
      }

      return stats;
    },
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useInventoryBatches() {
  return useQuery({
    queryKey: ["inventory-batches"],
    queryFn: async () => {
      const { data, error } = await db
        .from("inventory_batches")
        .select("id, quantity, unit, expiry_date, expiry_edit_count, inventory_items(name)")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data || [];
    },
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
    retry: 1,
  });
}

export function useUpdateBatchExpiryOnce() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ batchId, expiryDate }: { batchId: string; expiryDate: string }) => {
      const { data, error } = await db.rpc("update_batch_expiry_once", {
        p_batch_id: batchId,
        p_expiry_date: expiryDate,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expiry-stats"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-batches"] });
    },
  });
}
