import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import {
  parseMaterialAliasReview,
  parseStockAliasJevResponse,
  parseSuggestMaterialAliases,
  type MaterialAliasReview,
  type MaterialAliasSuggestion,
  type StockAliasJevLinesResponse,
} from "@/lib/material-alias";

export const MATERIAL_ALIAS_REVIEW_QUERY_KEY = "material-alias-review";

export type MaterialAliasLocation = "q7" | "tan_tao";

export interface MaterialAliasLineInput {
  line_key: string;
  raw_name: string;
  raw_unit: string | null;
}

export interface SuggestMaterialAliasesInput {
  supplierId: string | null;
  location: MaterialAliasLocation;
  lines: MaterialAliasLineInput[];
}

/**
 * Suggest aliases for a batch of receipt lines, then rank the lines without a
 * cached Jev answer through the stock-alias-jev edge function. The RPC never
 * calls Jev; the edge function only reads/caches its own answers.
 */
export function useSuggestMaterialAliases() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SuggestMaterialAliasesInput): Promise<MaterialAliasSuggestion[]> => {
      const { data, error } = await supabase.rpc("suggest_material_aliases", {
        p_supplier_id: input.supplierId,
        p_location: input.location,
        p_lines: input.lines as unknown as Json,
      });
      if (error) throw error;
      const suggestions = parseSuggestMaterialAliases(data);

      const pending = suggestions.filter(
        (suggestion) =>
          suggestion.needs_prompt && suggestion.candidates.length > 0 && suggestion.jev === null,
      );
      if (pending.length === 0) return suggestions;

      const { data: jevData, error: jevError } = await supabase.functions.invoke("stock-alias-jev", {
        body: {
          mode: "lines",
          supplier_id: input.supplierId,
          location: input.location,
          lines: pending.map((suggestion) => ({
            line_key: suggestion.line_key,
            raw_name: input.lines.find((line) => line.line_key === suggestion.line_key)?.raw_name ?? "",
            raw_unit: input.lines.find((line) => line.line_key === suggestion.line_key)?.raw_unit ?? null,
            candidates: suggestion.candidates.map((candidate) => ({
              id: candidate.id,
              name: candidate.name,
              unit: candidate.unit,
            })),
          })),
        },
      });
      if (jevError) throw jevError;
      const ranked = parseStockAliasJevResponse(jevData);
      if (ranked.mode !== "lines") throw new Error("stock-alias-jev tra ve sai che do");

      const answers = new Map<string, StockAliasJevLinesResponse["results"][number]["answer"]>();
      for (const result of ranked.results) answers.set(result.line_key, result.answer);

      return suggestions.map((suggestion) => {
        const answer = answers.get(suggestion.line_key);
        if (!answer) return suggestion;
        return { ...suggestion, jev: { ...answer } };
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
    },
  });
}

export interface ConfirmMaterialAliasInput {
  supplierId: string | null;
  location: MaterialAliasLocation;
  rawName: string;
  rawUnit: string | null;
  kitchenInventoryItemId: string | null;
  tanTaoSkuId: string | null;
  enteredUnitLabel: string | null;
  conversionFactor: number;
  jevItemId: string | null;
  jevProbability: number | null;
  sourceTable: string | null;
  sourceId: string | null;
  /** Giai đoạn 3: 'non_stock' needs no item / SKU and never posts. */
  lineClass?: "stock" | "non_stock";
}

/** Confirm the human alias choice and apply it to the matching receipt lines. */
export function useConfirmMaterialAlias() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConfirmMaterialAliasInput): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("confirm_material_alias", {
        p_supplier_id: input.supplierId,
        p_location: input.location,
        p_raw_name: input.rawName,
        p_raw_unit: input.rawUnit,
        p_kitchen_inventory_item_id: input.kitchenInventoryItemId,
        p_tan_tao_sku_id: input.tanTaoSkuId,
        p_entered_unit_label: input.enteredUnitLabel,
        p_conversion_factor: input.conversionFactor,
        p_jev_item_id: input.jevItemId,
        p_jev_probability: input.jevProbability,
        p_source_table: input.sourceTable,
        p_source_id: input.sourceId,
        p_line_class: input.lineClass ?? "stock",
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
    },
  });
}

export interface UndoMaterialAliasEventInput {
  eventId: string;
}

/** Undo one learning event; posted stock movements are never deleted. */
export function useUndoMaterialAliasEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UndoMaterialAliasEventInput): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("undo_material_alias_event", {
        p_event_id: input.eventId,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
    },
  });
}

export interface SetMaterialAliasStatusInput {
  aliasId: string;
  status: "auto" | "disabled";
}

/** Explicitly move an alias to auto or disabled (owner / Q7 editor). */
export function useSetMaterialAliasStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetMaterialAliasStatusInput): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.rpc("set_material_alias_status", {
        p_alias_id: input.aliasId,
        p_status: input.status,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
    },
  });
}

/** Review aliases that learned something in the last N days. */
export function useMaterialAliasReview(days = 7) {
  return useQuery({
    queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY, days],
    queryFn: async (): Promise<MaterialAliasReview> => {
      const { data, error } = await supabase.rpc("get_material_alias_review", { p_days: days });
      if (error) throw error;
      return parseMaterialAliasReview(data);
    },
  });
}

export interface RunAliasBacklogInput {
  location: MaterialAliasLocation;
}

/** Rank the confirmed receipt names that still have no alias (Q7 editor only). */
export function useRunAliasBacklog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RunAliasBacklogInput): Promise<Record<string, unknown>> => {
      const { data, error } = await supabase.functions.invoke("stock-alias-jev", {
        body: { mode: "backlog", location: input.location },
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
    },
  });
}
