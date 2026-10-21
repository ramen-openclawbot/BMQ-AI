import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseDiscontinuedStockItems,
  type DiscontinuedStockItem,
  type DiscontinueResult,
} from "@/lib/stock-item-discontinue";
import {
  MATERIAL_LINK_PENDING_FACTORS_QUERY_KEY,
  MATERIAL_LINK_REVIEW_QUERY_KEY,
} from "./useMaterialLinkQuest";
import { MISSIONS_QUERY_KEY } from "./useMissions";
import { STOCK_LEDGER_OVERVIEW_QUERY_KEY } from "./useStockLedger";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

export const DISCONTINUED_ITEMS_QUERY_KEY = "discontinued-stock-items";

/** The new RPC names are not in the generated Database type yet. */
const rpcClient = supabase as any;

/** Discontinuing an item moves the shelf, the link deck, the counts and missions. */
function invalidateDiscontinuedItems(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [DISCONTINUED_ITEMS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_LINK_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_LINK_PENDING_FACTORS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MISSIONS_QUERY_KEY] });
}

/** Inactive kitchen items that still have a discontinuation row. */
export function useDiscontinuedStockItems(enabled = true) {
  return useQuery({
    queryKey: [DISCONTINUED_ITEMS_QUERY_KEY],
    enabled,
    queryFn: async (): Promise<DiscontinuedStockItem[]> => {
      const { data, error } = await rpcClient.rpc("get_discontinued_stock_items");
      if (error) throw error;
      return parseDiscontinuedStockItems(data);
    },
  });
}

export interface DiscontinueStockItemInput {
  itemId: string;
  reason?: string | null;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Discontinue one live item that no longer has stock (idempotent). */
export function useDiscontinueStockItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DiscontinueStockItemInput): Promise<DiscontinueResult> => {
      const { data, error } = await rpcClient.rpc("discontinue_stock_item", {
        p_item_id: input.itemId,
        p_reason: input.reason ?? null,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return data as DiscontinueResult;
    },
    onSuccess: () => invalidateDiscontinuedItems(queryClient),
  });
}

export interface ReactivateStockItemInput {
  itemId: string;
}

/** Bring a discontinued item back to the shelves. */
export function useReactivateStockItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReactivateStockItemInput): Promise<DiscontinueResult> => {
      const { data, error } = await rpcClient.rpc("reactivate_stock_item", {
        p_item_id: input.itemId,
      });
      if (error) throw error;
      return data as DiscontinueResult;
    },
    onSuccess: () => invalidateDiscontinuedItems(queryClient),
  });
}

export interface SetStockItemInUseInput {
  itemId: string;
  /** false turns the item OFF (discontinue); true turns it back ON. */
  inUse: boolean;
  reason?: string;
}

/**
 * The ON/OFF switch on one item. Stopping is allowed while stock is left: the
 * server records the on-hand at stop time, so the stopped item still shows on
 * the right shelf/warehouse.
 */
export function useSetStockItemInUse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetStockItemInUseInput): Promise<DiscontinueResult> => {
      const { data, error } = input.inUse
        ? await rpcClient.rpc("reactivate_stock_item", { p_item_id: input.itemId })
        : await rpcClient.rpc("discontinue_stock_item", {
            p_item_id: input.itemId,
            p_reason: input.reason ?? null,
            p_request_id: crypto.randomUUID(),
          });
      if (error) throw error;
      return data as DiscontinueResult;
    },
    onSuccess: () => {
      // Same refresh as the old Ngưng dùng button (shelf, link deck, counts, missions) plus the robot's ledger.
      invalidateDiscontinuedItems(queryClient);
      void queryClient.invalidateQueries({ queryKey: [STOCK_LEDGER_OVERVIEW_QUERY_KEY] });
    },
  });
}
