import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type {
  KhoCountResult,
  KhoCreateItemInput,
  KhoCreateItemResult,
  KhoItemsPayload,
  KhoLocation,
  KhoSaveResult,
} from "@/lib/kho-items";
import { STOCK_LEDGER_OVERVIEW_QUERY_KEY } from "./useStockLedger";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

export const KHO_ITEMS_QUERY_KEY = "kho-items";

/**
 * The generated Supabase RPC union only lists applied migrations. Keep the new
 * note RPC locally typed until the migration is applied and types regenerate.
 */
// Bound to the client: a detached `supabase.rpc` loses `this` and throws before any request.
const rpcUntyped = supabase.rpc.bind(supabase) as unknown as (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

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

/** Create a new item, or copy the catalog settings of an existing one. */
export function useKhoCreateItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: KhoCreateItemInput): Promise<KhoCreateItemResult> => {
      const { data, error } = await supabase.rpc("kho_create_item", {
        p_name: input.name,
        p_unit: input.unit,
        p_class: input.itemClass,
        p_tan_tao: input.inTanTao,
        p_q7: input.inQ7,
        p_note: input.note,
        p_copy_from: input.copyFrom,
        p_request_id: input.requestId,
        p_supplier_ids: input.supplierIds,
      });
      if (error) throw error;
      return data as unknown as KhoCreateItemResult;
    },
    onSuccess: () => invalidateKhoItems(queryClient),
  });
}

export interface KhoSetItemNoteInput {
  itemId: string;
  note: string | null;
  requestId: string;
}

export interface KhoSetItemNoteResult {
  item_id: string;
  note: string | null;
}

/** Set or clear the short editor note on one item. */
export function useKhoSetItemNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: KhoSetItemNoteInput): Promise<KhoSetItemNoteResult> => {
      const { data, error } = await rpcUntyped("kho_set_item_note", {
        p_item_id: input.itemId,
        p_note: input.note,
        p_request_id: input.requestId,
      });
      if (error) throw error;
      return data as KhoSetItemNoteResult;
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
