import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import {
  parseCreateStockMaterialItem,
  parseMaterialAliasBacklogReview,
  parseMaterialAliasReview,
  parseNewItemDecisionResult,
  parseNewItemSuggestions,
  parseStockAliasJevResponse,
  parseSuggestMaterialAliases,
  type CreateStockMaterialItemResult,
  type MaterialAliasBacklogReviewRow,
  type MaterialAliasReview,
  type MaterialAliasSuggestion,
  type NewItemDecisionResult,
  type NewItemSuggestion,
  type NewItemSuggestionClass,
  type StockAliasJevLinesResponse,
} from "@/lib/material-alias";

export const MATERIAL_ALIAS_REVIEW_QUERY_KEY = "material-alias-review";
export const MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY = "material-alias-backlog-review";
export const MATERIAL_ALIAS_NEW_ITEM_QUERY_KEY = "material-alias-new-item-suggestions";

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
          suggestion.needs_prompt &&
          suggestion.auto_non_stock === null &&
          suggestion.candidates.length > 0 &&
          suggestion.jev === null,
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
              reason: candidate.reason,
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
  /** Names per edge call: default 10, capped at 15 by the edge function. */
  batchSize?: number;
  /** Progress: names processed so far out of processed + remaining. */
  onProgress?: (processed: number, total: number) => void;
}

/**
 * Rank the confirmed receipt names that still have no alias (Q7 editor only).
 * Runs batch by batch: it keeps calling while the edge reports `remaining > 0`
 * and no stop, so a big backlog no longer needs one huge request.
 */
export function useRunAliasBacklog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RunAliasBacklogInput): Promise<Record<string, unknown>> => {
      let processedTotal = 0;
      let last: Record<string, unknown> = {};
      while (true) {
        const { data, error } = await supabase.functions.invoke("stock-alias-jev", {
          body: { mode: "backlog", location: input.location, batch_size: input.batchSize ?? 10 },
        });
        if (error) throw error;
        const parsed = parseStockAliasJevResponse(data);
        if (parsed.mode !== "backlog") throw new Error("stock-alias-jev tra ve sai che do");
        last = parsed as unknown as Record<string, unknown>;
        processedTotal += parsed.processed;
        input.onProgress?.(processedTotal, processedTotal + parsed.remaining);
        if (parsed.stopped !== null) break;
        if (parsed.remaining <= 0) break;
        // Safety: a call that made no progress must not loop forever.
        if (parsed.processed === 0) break;
      }
      return last;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY] });
    },
  });
}

/**
 * Pending backlog names with their top candidate and the latest Jev suggestion
 * (owner / Q7 admin only; the RPC raises 'forbidden' for anyone else).
 */
export function useMaterialAliasBacklogReview(location: MaterialAliasLocation, limit = 100) {
  return useQuery({
    queryKey: [MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY, location, limit],
    queryFn: async (): Promise<MaterialAliasBacklogReviewRow[]> => {
      const { data, error } = await supabase.rpc("get_material_alias_backlog_review", {
        p_location: location,
        p_limit: limit,
      });
      if (error) throw error;
      return parseMaterialAliasBacklogReview(data);
    },
  });
}

export interface CreateStockMaterialItemInput {
  name: string;
  unit: string;
  location: MaterialAliasLocation;
  requestId: string;
}

/** Create (or reuse) a kitchen stock item; idempotent by requestId. */
export function useCreateStockMaterialItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateStockMaterialItemInput): Promise<CreateStockMaterialItemResult> => {
      const { data, error } = await supabase.rpc("create_stock_material_item", {
        p_name: input.name,
        p_unit: input.unit,
        p_location: input.location,
        p_request_id: input.requestId,
      });
      if (error) throw error;
      return parseCreateStockMaterialItem(data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY] });
    },
  });
}

/** Pending "mua 60 ngày chưa có mã kho" groups (owner / Q7 admin only). */
export function useNewItemSuggestions(location: MaterialAliasLocation) {
  return useQuery({
    queryKey: [MATERIAL_ALIAS_NEW_ITEM_QUERY_KEY, location],
    queryFn: async (): Promise<NewItemSuggestion[]> => {
      const { data, error } = await supabase.rpc("get_new_item_suggestions", {
        p_location: location,
      });
      if (error) throw error;
      return parseNewItemSuggestions(data);
    },
  });
}

export interface RunNewItemScanInput {
  location: MaterialAliasLocation;
  /** Receipt window: default 60 days, capped at 365 by the edge function. */
  days?: number;
  /** Questions per edge call: default 10, capped at 20 by the edge function. */
  batchSize?: number;
  /** Progress: groups processed so far out of processed + remaining. */
  onProgress?: (processed: number, total: number) => void;
}

/**
 * Group and classify the 60-day purchased names that still have no stock item
 * (Q7 editor only). Runs the edge function batch by batch until it reports no
 * remaining work or the shared daily quota stops it, then refreshes both review
 * lists.
 */
export function useRunNewItemScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: RunNewItemScanInput): Promise<Record<string, unknown>> => {
      let processedTotal = 0;
      let last: Record<string, unknown> = {};
      while (true) {
        const { data, error } = await supabase.functions.invoke("stock-alias-jev", {
          body: {
            mode: "new_items",
            location: input.location,
            days: input.days ?? 60,
            batch_size: input.batchSize ?? 10,
          },
        });
        if (error) throw error;
        const parsed = parseStockAliasJevResponse(data);
        if (parsed.mode !== "new_items") throw new Error("stock-alias-jev tra ve sai che do");
        last = parsed as unknown as Record<string, unknown>;
        processedTotal += parsed.processed;
        input.onProgress?.(processedTotal, processedTotal + parsed.remaining);
        if (parsed.stopped !== null) break;
        if (parsed.remaining <= 0) break;
        // Safety: a call that made no progress must not loop forever.
        if (parsed.processed === 0) break;
      }
      return last;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_NEW_ITEM_QUERY_KEY] });
    },
  });
}

export interface ApplyNewItemSuggestionMemberInput {
  supplier_id: string | null;
  normalized_name: string;
  raw_name: string;
  entered_unit_label: string | null;
  conversion_factor: number;
}

export interface ApplyNewItemSuggestionInput {
  suggestionId: string;
  name: string;
  unit: string;
  itemClass: NewItemSuggestionClass;
  members: ApplyNewItemSuggestionMemberInput[];
  requestId: string;
}

/** Accept one suggestion: create / reuse the item and confirm every member alias. */
export function useApplyNewItemSuggestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ApplyNewItemSuggestionInput): Promise<NewItemDecisionResult> => {
      const { data, error } = await supabase.rpc("apply_new_item_suggestion", {
        p_suggestion_id: input.suggestionId,
        p_name: input.name,
        p_unit: input.unit,
        p_item_class: input.itemClass,
        p_members: input.members as unknown as Json,
        p_request_id: input.requestId,
      });
      if (error) throw error;
      return parseNewItemDecisionResult(data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_NEW_ITEM_QUERY_KEY] });
    },
  });
}

export interface DismissNewItemSuggestionInput {
  suggestionId: string;
}

/** Dismiss one suggestion group. */
export function useDismissNewItemSuggestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DismissNewItemSuggestionInput): Promise<NewItemDecisionResult> => {
      const { data, error } = await supabase.rpc("dismiss_new_item_suggestion", {
        p_suggestion_id: input.suggestionId,
      });
      if (error) throw error;
      return parseNewItemDecisionResult(data);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_NEW_ITEM_QUERY_KEY] });
    },
  });
}
