import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { db } from "@/lib/supabase-helpers";
import { KHO_ITEMS_QUERY_KEY } from "./useKhoItems";

export const KHO_SUPPLIER_OPTIONS_KEY = "kho-supplier-options";
export const KHO_ITEM_SUPPLIERS_KEY = "kho-item-suppliers";

export interface KhoSupplierOption {
  id: string;
  name: string;
}

// kho_set_item_suppliers / kitchen_item_suppliers are not in the generated types until the migration is applied.
const rpcUntyped = supabase.rpc.bind(supabase) as unknown as (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

/** Every supplier the picker can offer, by name. */
export function useKhoSupplierOptions() {
  return useQuery({
    queryKey: [KHO_SUPPLIER_OPTIONS_KEY],
    queryFn: async (): Promise<KhoSupplierOption[]> => {
      const { data, error } = await db.from("suppliers").select("id,name").order("name", { ascending: true }).limit(1000);
      if (error) throw error;
      return ((data ?? []) as KhoSupplierOption[]).filter((row) => row.name && row.name.trim());
    },
    staleTime: 60_000,
  });
}

/** The suppliers explicitly linked to one item. */
export function useKhoItemSuppliers(itemId: string) {
  return useQuery({
    queryKey: [KHO_ITEM_SUPPLIERS_KEY, itemId],
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await db.from("kitchen_item_suppliers").select("supplier_id").eq("item_id", itemId);
      if (error) throw error;
      return ((data ?? []) as Array<{ supplier_id: string }>).map((row) => row.supplier_id);
    },
  });
}

export interface KhoSetItemSuppliersInput {
  itemId: string;
  supplierIds: string[];
  requestId: string;
}

export interface KhoSetItemSuppliersResult {
  status: "updated";
  item_id: string;
  supplier_ids: string[];
  added: string[];
  removed: string[];
}

/** Replace the item's supplier links in one transaction (at least one for an active item). */
export function useKhoSetItemSuppliers() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: KhoSetItemSuppliersInput): Promise<KhoSetItemSuppliersResult> => {
      const { data, error } = await rpcUntyped("kho_set_item_suppliers", {
        p_item_id: input.itemId,
        p_supplier_ids: input.supplierIds,
        p_request_id: input.requestId,
      });
      if (error) throw error;
      return data as KhoSetItemSuppliersResult;
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: [KHO_ITEM_SUPPLIERS_KEY, input.itemId] });
      void queryClient.invalidateQueries({ queryKey: [KHO_ITEMS_QUERY_KEY] });
    },
  });
}
