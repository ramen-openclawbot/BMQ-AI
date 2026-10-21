import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  KhoCountResult,
  KhoItemsPayload,
  KhoLocation,
  KhoSaveResult,
} from "@/lib/kho-items";
import { STOCK_LEDGER_OVERVIEW_QUERY_KEY } from "./useStockLedger";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

export const KHO_ITEMS_QUERY_KEY = "kho-items";

/** A save/count moves the list, the game snapshot and both stock ledgers. */
function invalidateKhoItems(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [KHO_ITEMS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [STOCK_LEDGER_OVERVIEW_QUERY_KEY] });
}

/** The whole two-job list in one RPC. */
export function useKhoItems() {
  return useQuery({
    queryKey: [KHO_ITEMS_QUERY_KEY],
    queryFn: async (): Promise<KhoItemsPayload> => {
      const { data, error } = await supabase.rpc("kho_get_items");
      if (error) throw error;
      return data as unknown as KhoItemsPayload;
    },
  });
}

export interface KhoSaveItemInput {
  itemId: string;
  name: string;
  unit: string;
  active: boolean;
  unitFactor?: number | null;
  merge?: boolean;
  requestId: string;
}

/** Save name / unit / on-off (or merge a duplicate) in one transaction. */
export function useKhoSaveItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: KhoSaveItemInput): Promise<KhoSaveResult> => {
      const { data, error } = await supabase.rpc("kho_save_item", {
        p_item_id: input.itemId,
        p_name: input.name,
        p_unit: input.unit,
        p_active: input.active,
        p_unit_factor: input.unitFactor ?? null,
        p_merge: input.merge ?? false,
        p_request_id: input.requestId,
      });
      if (error) throw error;
      return data as unknown as KhoSaveResult;
    },
    onSuccess: () => invalidateKhoItems(queryClient),
  });
}

export interface KhoCountItemInput {
  location: KhoLocation;
  itemId: string;
  countedQty: number;
  requestId: string;
}

/** Count one item through the same per-line RPCs submit_stock_count uses. */
export function useKhoCountItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: KhoCountItemInput): Promise<KhoCountResult> => {
      const { data, error } = await supabase.rpc("kho_count_item", {
        p_location: input.location,
        p_item_id: input.itemId,
        p_counted_qty: input.countedQty,
        p_request_id: input.requestId,
      });
      if (error) throw error;
      return data as unknown as KhoCountResult;
    },
    onSuccess: () => invalidateKhoItems(queryClient),
  });
}
