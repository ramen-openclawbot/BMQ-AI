import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseCogsOverview,
  parseCogsTrace,
  type CogsLocation,
  type CogsOverview,
  type CogsTrace,
} from "@/lib/cogs-backflush";

export const COGS_OVERVIEW_QUERY_KEY = "cogs-overview";
export const COGS_ITEM_TRACE_QUERY_KEY = "cogs-item-trace";

export interface CogsDecideRevenueProductInput {
  mapId: string;
  skuId: string | null;
  unitsPerRevenueUnit: number;
  reject: boolean;
  requestId: string;
}

export interface CogsDecideIngredientInput {
  canonicalMaterialId: string;
  recipeUnit: string;
  action: "deduct" | "not_tracked" | "finished_goods_ledger";
  location: CogsLocation | null;
  itemId: string | null;
  factor: number | null;
  requestId: string;
}

export interface CogsSetBackflushInput {
  location: CogsLocation;
  enabled: boolean;
  startDate: string | null;
  requestId: string;
}

/** Learned-map coverage, trace totals and gaps for a date window. */
export function useCogsOverview(from: string, to: string) {
  return useQuery({
    queryKey: [COGS_OVERVIEW_QUERY_KEY, from, to],
    staleTime: 60_000,
    queryFn: async (): Promise<CogsOverview> => {
      const { data, error } = await supabase.rpc(
        "cogs_backflush_overview" as never,
        { p_from: from, p_to: to } as never,
      );
      if (error) throw error;
      return parseCogsOverview(data);
    },
  });
}

/** Per revenue-line recipe/stock trace of one item. */
export function useCogsItemTrace(
  location: CogsLocation,
  itemId: string | null,
  from: string,
  to: string,
) {
  return useQuery({
    queryKey: [COGS_ITEM_TRACE_QUERY_KEY, location, itemId, from, to],
    staleTime: 60_000,
    enabled: Boolean(itemId),
    queryFn: async (): Promise<CogsTrace> => {
      const { data, error } = await supabase.rpc(
        "cogs_item_usage_trace" as never,
        {
          p_location: location,
          p_item_id: itemId,
          p_from: from,
          p_to: to,
        } as never,
      );
      if (error) throw error;
      return parseCogsTrace(data);
    },
  });
}

function useInvalidateCogsReads() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [COGS_OVERVIEW_QUERY_KEY] }),
      queryClient.invalidateQueries({ queryKey: ["kho-commitments"] }),
    ]);
  };
}

/** Confirm/reject one learned revenue-product map row. */
export function useCogsDecideRevenueProduct() {
  const invalidate = useInvalidateCogsReads();
  return useMutation({
    mutationFn: async (input: CogsDecideRevenueProductInput) => {
      const { data, error } = await supabase.rpc(
        "cogs_decide_revenue_product" as never,
        {
          p_map_id: input.mapId,
          p_sku_id: input.skuId,
          p_units_per_revenue_unit: input.unitsPerRevenueUnit,
          p_reject: input.reject,
          p_request_id: input.requestId,
        } as never,
      );
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}

/** Confirm one ingredient -> kho item/factor decision. */
export function useCogsDecideIngredient() {
  const invalidate = useInvalidateCogsReads();
  return useMutation({
    mutationFn: async (input: CogsDecideIngredientInput) => {
      const { data, error } = await supabase.rpc(
        "cogs_decide_ingredient" as never,
        {
          p_canonical_material_id: input.canonicalMaterialId,
          p_recipe_unit: input.recipeUnit,
          p_action: input.action,
          p_location: input.location,
          p_item_id: input.itemId,
          p_factor: input.factor,
          p_request_id: input.requestId,
        } as never,
      );
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}

/** Owner-only enable/disable. Disabling keeps every already posted row. */
export function useCogsSetBackflush() {
  const invalidate = useInvalidateCogsReads();
  return useMutation({
    mutationFn: async (input: CogsSetBackflushInput) => {
      const { data, error } = await supabase.rpc(
        "cogs_set_backflush" as never,
        {
          p_location: input.location,
          p_enabled: input.enabled,
          p_start_date: input.startDate,
          p_request_id: input.requestId,
        } as never,
      );
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}

/** Owner / kho admin: re-run the window now so a decision shows at once. */
export function useCogsRefreshNow() {
  const invalidate = useInvalidateCogsReads();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("cogs_refresh_now" as never);
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}
