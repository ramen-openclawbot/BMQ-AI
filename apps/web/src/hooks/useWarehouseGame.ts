import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseChangeStockItemUnitResult,
  parseRenameStockItemResult,
  parseSetItemPastryQ7Result,
  parseWarehouseGameSnapshot,
  parseWarehouseGameTransfers,
  type ChangeStockItemUnitResult,
  type RenameStockItemResult,
  type SetItemPastryQ7Result,
  type WarehouseGameLocation,
  type WarehouseGameSnapshot,
  type WarehouseGameTransfer,
} from "@/lib/warehouse-game";
import {
  MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY,
  MATERIAL_ALIAS_NEW_ITEM_QUERY_KEY,
  MATERIAL_ALIAS_NEW_ITEM_RUN_QUERY_KEY,
  MATERIAL_ALIAS_REVIEW_QUERY_KEY,
  STOCK_UNITS_QUERY_KEY,
  UNKNOWN_PURCHASE_UNITS_QUERY_KEY,
} from "./useMaterialAlias";
import { STOCK_CATALOG_REVIEW_QUERY_KEY } from "./useStockCatalog";

export const WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY = "warehouse-game-snapshot";

/** Both RPCs change the item name / unit, alias factors and the ledger view. */
function invalidateWarehouseGame(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_NEW_ITEM_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_NEW_ITEM_RUN_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [STOCK_CATALOG_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [STOCK_UNITS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [UNKNOWN_PURCHASE_UNITS_QUERY_KEY] });
}

/** One call for the whole warehouse view of a location. */
export function useWarehouseGameSnapshot(location: WarehouseGameLocation) {
  return useQuery({
    queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY, location],
    queryFn: async (): Promise<WarehouseGameSnapshot> => {
      const { data, error } = await supabase.rpc("get_warehouse_game_snapshot", {
        p_location: location,
      });
      if (error) throw error;
      return parseWarehouseGameSnapshot(data);
    },
  });
}

export interface RenameStockItemInput {
  itemId: string;
  newName: string;
  requestId: string;
}

/** Rename one live item; idempotent by requestId. */
export function useRenameStockItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RenameStockItemInput): Promise<RenameStockItemResult> => {
      const { data, error } = await supabase.rpc("rename_stock_item", {
        p_item_id: input.itemId,
        p_new_name: input.newName,
        p_request_id: input.requestId,
      });
      if (error) throw error;
      return parseRenameStockItemResult(data);
    },
    onSuccess: () => invalidateWarehouseGame(queryClient),
  });
}

export interface ChangeStockItemUnitInput {
  itemId: string;
  newUnit: string;
  /** 1 old unit = factor new units; required for a pack / count change. */
  factor?: number | null;
  requestId: string;
}

/** Move one item to another standard unit; idempotent by requestId. */
export function useChangeStockItemUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ChangeStockItemUnitInput): Promise<ChangeStockItemUnitResult> => {
      const { data, error } = await supabase.rpc("change_stock_item_unit", {
        p_item_id: input.itemId,
        p_new_unit: input.newUnit,
        p_factor: input.factor ?? null,
        p_request_id: input.requestId,
      });
      if (error) throw error;
      return parseChangeStockItemUnitResult(data);
    },
    onSuccess: () => invalidateWarehouseGame(queryClient),
  });
}

export interface SetItemPastryQ7Input {
  itemId: string;
  value: boolean;
  /** Defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Flag / unflag one item as pastry; idempotent by requestId. */
export function useSetItemPastryQ7() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetItemPastryQ7Input): Promise<SetItemPastryQ7Result> => {
      const { data, error } = await supabase.rpc("set_item_pastry_q7", {
        p_item_id: input.itemId,
        p_value: input.value,
        p_request_id: input.requestId ?? crypto.randomUUID(),
      });
      if (error) throw error;
      return parseSetItemPastryQ7Result(data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
    },
  });
}

export const STOCK_TRANSFERS_QUERY_KEY = "stock-transfers";

/** The newest automatic Tân Tạo -> Q7 transfers for the warehouse game. */
export function useStockTransfers(limit = 30) {
  return useQuery({
    queryKey: [STOCK_TRANSFERS_QUERY_KEY, limit],
    queryFn: async (): Promise<WarehouseGameTransfer[]> => {
      const { data, error } = await supabase.rpc("get_stock_transfers", { p_limit: limit });
      if (error) throw error;
      return parseWarehouseGameTransfers(data);
    },
  });
}
