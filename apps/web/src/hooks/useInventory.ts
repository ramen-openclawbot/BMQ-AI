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
