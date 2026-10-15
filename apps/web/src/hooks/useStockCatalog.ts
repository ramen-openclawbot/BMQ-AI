import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { parseStockCatalogReview, type StockCatalogReview } from "@/lib/stock-catalog";

export const STOCK_CATALOG_REVIEW_QUERY_KEY = "stock-catalog-review";

/** Read the reviewer payload: pending suggestions, merges, class counts and Jev quota. */
export function useStockCatalogReview() {
  return useQuery({
    queryKey: [STOCK_CATALOG_REVIEW_QUERY_KEY],
    queryFn: async (): Promise<StockCatalogReview> => {
      const { data, error } = await supabase.rpc("get_stock_catalog_review");
      if (error) throw error;
      return parseStockCatalogReview(data);
    },
  });
}

export interface RunStockCatalogJevInput {
  mode: "dedupe" | "classify";
  limit?: number;
}

export interface StockCatalogJevSummary {
  mode: "dedupe" | "classify";
  candidates: number;
  suggestions: number;
  skipped_existing: number;
  failed: number;
  calls: number;
  cost: number;
  usage: { date: string; calls: number; limit: number };
  stopped: "daily_limit" | null;
}

/** Ask Jev for merge / classification suggestions; never applies a merge. */
export function useRunStockCatalogJev() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RunStockCatalogJevInput): Promise<StockCatalogJevSummary> => {
      const { data, error } = await supabase.functions.invoke("stock-catalog-jev", {
        body: input.limit === undefined ? { mode: input.mode } : { mode: input.mode, limit: input.limit },
      });
      if (error) throw error;
      return data as StockCatalogJevSummary;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [STOCK_CATALOG_REVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: ["robot-auto-actions"] });
    },
  });
}

export interface DecideStockCatalogSuggestionInput {
  suggestionId: string;
  action: "approve" | "reject";
  /** Merge factor, required when the suggestion has no unit-rule factor. */
  factor?: number | null;
  /** Reviewer override for a classify suggestion; sets item_class_source 'manual'. */
  itemClass?: string | null;
}

/** Approve or reject one suggestion; approving a merge applies it. */
export function useDecideStockCatalogSuggestion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: DecideStockCatalogSuggestionInput): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("decide_stock_catalog_suggestion", {
        p_id: input.suggestionId,
        p_action: input.action,
        p_factor: input.factor ?? null,
        p_class: input.itemClass ?? null,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [STOCK_CATALOG_REVIEW_QUERY_KEY] });
    },
  });
}

export interface RevertStockItemMergeInput {
  mergeId: string;
}

/** Restore every row of an applied merge and reactivate the source item. */
export function useRevertStockItemMerge() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: RevertStockItemMergeInput): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("revert_stock_item_merge", {
        p_merge_id: input.mergeId,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [STOCK_CATALOG_REVIEW_QUERY_KEY] });
    },
  });
}

/** Link active kitchen items to a single approved canonical material mapping. */
export function useLinkKitchenItemsToCanonical() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("link_kitchen_items_to_canonical_materials");
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [STOCK_CATALOG_REVIEW_QUERY_KEY] });
    },
  });
}
