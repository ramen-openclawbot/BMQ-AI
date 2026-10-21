import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseKhoAddUnitResult,
  parseKhoConversionPreview,
  parseKhoItemConversions,
  parseKhoSetConversionResult,
  parseKhoUnits,
  type KhoAddUnitResult,
  type KhoConversionPreview,
  type KhoItemConversions,
  type KhoSetConversionResult,
  type KhoUnit,
} from "@/lib/kho-units";
import { KHO_ITEMS_QUERY_KEY } from "./useKhoItems";
import { STOCK_LEDGER_OVERVIEW_QUERY_KEY } from "./useStockLedger";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

export const KHO_UNITS_QUERY_KEY = "kho-units";
export const KHO_ITEM_CONVERSIONS_QUERY_KEY = "kho-item-conversions";

/** A saved factor moves the item list, its conversions, the game snapshot and both ledgers. */
function invalidateKhoConversions(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [KHO_ITEMS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [KHO_ITEM_CONVERSIONS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [STOCK_LEDGER_OVERVIEW_QUERY_KEY] });
}

/** The item units (base weight, base volume and every count unit). */
export function useKhoUnits() {
  return useQuery({
    queryKey: [KHO_UNITS_QUERY_KEY],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<KhoUnit[]> => {
      const { data, error } = await supabase.rpc("kho_get_units" as never, {} as never);
      if (error) throw error;
      return parseKhoUnits(data);
    },
  });
}

export interface AddKhoUnitInput {
  label: string;
  /** Idempotency key; defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Add a new count unit; idempotent by requestId. */
export function useAddKhoUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddKhoUnitInput): Promise<KhoAddUnitResult> => {
      const { data, error } = await supabase.rpc(
        "kho_add_stock_unit" as never,
        {
          p_label: input.label,
          p_request_id: input.requestId ?? crypto.randomUUID(),
        } as never,
      );
      if (error) throw error;
      return parseKhoAddUnitResult(data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [KHO_UNITS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [KHO_ITEMS_QUERY_KEY] });
    },
  });
}

/** Every stock alias of one item grouped by receipt unit, plus its saved factors. */
export function useKhoItemConversions(itemId: string | null) {
  return useQuery({
    queryKey: [KHO_ITEM_CONVERSIONS_QUERY_KEY, itemId],
    enabled: itemId !== null,
    queryFn: async (): Promise<KhoItemConversions> => {
      const { data, error } = await supabase.rpc(
        "kho_get_item_conversions" as never,
        { p_item_id: itemId } as never,
      );
      if (error) throw error;
      return parseKhoItemConversions(data);
    },
  });
}

export interface KhoConversionInput {
  itemId: string;
  /** The receipt unit shown in the dialog (its normalized form is matched). */
  unit: string;
  /** Stock units per 1 receipt unit. */
  factor: number;
}

/** Dry run: the lines and ledger impact of one factor, writing nothing. */
export function useKhoConversionPreview() {
  return useMutation({
    mutationFn: async (input: KhoConversionInput): Promise<KhoConversionPreview> => {
      const { data, error } = await supabase.rpc(
        "kho_set_item_conversion" as never,
        {
          p_item_id: input.itemId,
          p_unit: input.unit,
          p_factor: input.factor,
          p_dry_run: true,
          p_request_id: null,
        } as never,
      );
      if (error) throw error;
      return parseKhoConversionPreview(data);
    },
  });
}

export interface SetKhoItemConversionInput extends KhoConversionInput {
  /** Idempotency key; defaults to a fresh crypto.randomUUID(). */
  requestId?: string;
}

/** Save one factor, correct the matching aliases and post the ledger deltas. */
export function useSetKhoItemConversion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: SetKhoItemConversionInput,
    ): Promise<KhoSetConversionResult> => {
      const { data, error } = await supabase.rpc(
        "kho_set_item_conversion" as never,
        {
          p_item_id: input.itemId,
          p_unit: input.unit,
          p_factor: input.factor,
          p_dry_run: false,
          p_request_id: input.requestId ?? crypto.randomUUID(),
        } as never,
      );
      if (error) throw error;
      return parseKhoSetConversionResult(data);
    },
    onSuccess: () => invalidateKhoConversions(queryClient),
  });
}
