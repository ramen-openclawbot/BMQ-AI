import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseStockRoutingJevResponse,
  parseStockRoutingReview,
  type StockRoutingJevMode,
  type StockRoutingJevResponse,
  type StockRoutingReview,
} from "@/lib/stock-routing";

export const STOCK_ROUTING_REVIEW_QUERY_KEY = "stock-routing-review";

export type StockRoutingLocation = "q7" | "tan_tao" | "non_stock";

/** Read the reviewer payload: pending suggestions, counts, categories and Jev quota. */
export function useStockRoutingReview() {
  return useQuery({
    queryKey: [STOCK_ROUTING_REVIEW_QUERY_KEY],
    queryFn: async (): Promise<StockRoutingReview> => {
      const { data, error } = await supabase.rpc("get_stock_routing_review");
      if (error) throw error;
      return parseStockRoutingReview(data);
    },
  });
}

/**
 * Ask Jev for supplier-route or material-category suggestions. The edge function
 * writes only its own suggestions and auto-applies the confident ones.
 */
export function useRunStockRoutingJev(mode: StockRoutingJevMode) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (limit?: number): Promise<StockRoutingJevResponse> => {
      const { data, error } = await supabase.functions.invoke("stock-routing-jev", {
        body: limit === undefined ? { mode } : { mode, limit },
      });
      if (error) throw error;
      return parseStockRoutingJevResponse(data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [STOCK_ROUTING_REVIEW_QUERY_KEY] });
    },
  });
}

export interface DecideSupplierRoutingInput {
  suggestionId: string;
  action: "approve" | "reject";
  /** Reviewer override; sets receiving_location_source 'manual'. */
  location?: StockRoutingLocation | null;
}

/** Approve or reject one supplier routing suggestion; approving applies it. */
export function useDecideSupplierRouting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: DecideSupplierRoutingInput): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("decide_supplier_routing", {
        p_id: input.suggestionId,
        p_action: input.action,
        p_location: input.location ?? null,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [STOCK_ROUTING_REVIEW_QUERY_KEY] });
    },
  });
}

export interface RevertSupplierRoutingInput {
  suggestionId: string;
}

/** Restore the supplier's previous warehouse; filled receipts are never unset. */
export function useRevertSupplierRouting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RevertSupplierRoutingInput): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("revert_supplier_routing", {
        p_suggestion: input.suggestionId,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [STOCK_ROUTING_REVIEW_QUERY_KEY] });
    },
  });
}

export interface DecideMaterialCategoryInput {
  suggestionId: string;
  action: "approve" | "reject";
  /** Reviewer override for the category code. */
  category?: string | null;
}

/** Approve or reject one material category suggestion; approving writes category. */
export function useDecideMaterialCategory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: DecideMaterialCategoryInput): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("decide_material_category", {
        p_id: input.suggestionId,
        p_action: input.action,
        p_category: input.category ?? null,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [STOCK_ROUTING_REVIEW_QUERY_KEY] });
    },
  });
}

export interface RevertMaterialCategoryInput {
  suggestionId: string;
}

/** Restore the material's previous category. */
export function useRevertMaterialCategory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RevertMaterialCategoryInput): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("revert_material_category", {
        p_suggestion: input.suggestionId,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [STOCK_ROUTING_REVIEW_QUERY_KEY] });
    },
  });
}
