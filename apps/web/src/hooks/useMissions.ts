import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseCompleteMissionResult,
  parseMarkItemsDistinctResult,
  parseMyMissions,
  parseResolveUnknownUnitResult,
  parseUpdateAliasFactorResult,
  type CompleteMissionResult,
  type MarkItemsDistinctResult,
  type MyMissions,
  type ResolveUnknownUnitAction,
  type ResolveUnknownUnitResult,
  type UpdateAliasFactorResult,
} from "@/lib/missions";
import {
  MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY,
  MATERIAL_ALIAS_REVIEW_QUERY_KEY,
} from "./useMaterialAlias";
import { STOCK_CATALOG_REVIEW_QUERY_KEY } from "./useStockCatalog";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

export const MISSIONS_QUERY_KEY = "missions";

/** One request id per click so the server can ignore a replay. */
function newRequestId(): string {
  return crypto.randomUUID();
}

/** A mission change moves the snapshot, the catalog review and the alias tables. */
function invalidateMissions(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [MISSIONS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [STOCK_CATALOG_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY] });
}

/** My missions, badges, level and recent awards. */
export function useMyMissions() {
  return useQuery({
    queryKey: [MISSIONS_QUERY_KEY],
    queryFn: async (): Promise<MyMissions> => {
      const { data, error } = await supabase.rpc("get_my_missions", { p_user: null });
      if (error) throw error;
      return parseMyMissions(data);
    },
  });
}

export interface CompleteMissionInput {
  missionId: string;
  /** Generated per click when omitted. */
  requestId?: string;
}

/** Complete one mission; the server re-checks and awards at most once. */
export function useCompleteMission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CompleteMissionInput): Promise<CompleteMissionResult> => {
      const { data, error } = await supabase.rpc("complete_mission", {
        p_mission_id: input.missionId,
        p_request_id: input.requestId ?? newRequestId(),
      });
      if (error) throw error;
      return parseCompleteMissionResult(data);
    },
    onSuccess: () => invalidateMissions(queryClient),
  });
}

export interface UpdateAliasFactorInput {
  aliasId: string;
  factor: number;
  /** Generated per click when omitted. */
  requestId?: string;
}

/** Fix the conversion factor of one alias (owner / Q7 stock editor). */
export function useUpdateAliasFactor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateAliasFactorInput): Promise<UpdateAliasFactorResult> => {
      const { data, error } = await supabase.rpc("update_stock_material_alias_factor", {
        p_alias_id: input.aliasId,
        p_factor: input.factor,
        p_request_id: input.requestId ?? newRequestId(),
      });
      if (error) throw error;
      return parseUpdateAliasFactorResult(data);
    },
    onSuccess: () => invalidateMissions(queryClient),
  });
}

export interface MarkItemsDistinctInput {
  itemA: string;
  itemB: string;
  /** Generated per click when omitted. */
  requestId?: string;
}

/** Mark two catalog items as two different items (no merge). */
export function useMarkItemsDistinct() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: MarkItemsDistinctInput): Promise<MarkItemsDistinctResult> => {
      const { data, error } = await supabase.rpc("mark_stock_items_distinct", {
        p_item_a: input.itemA,
        p_item_b: input.itemB,
        p_request_id: input.requestId ?? newRequestId(),
      });
      if (error) throw error;
      return parseMarkItemsDistinctResult(data);
    },
    onSuccess: () => invalidateMissions(queryClient),
  });
}

export interface ResolveUnknownUnitInput {
  variant: string;
  action: ResolveUnknownUnitAction;
  /** Required for action 'map': a public.stock_units code. */
  code?: string | null;
  /** Generated per click when omitted. */
  requestId?: string;
}

/** Map an unknown document unit to a standard code, or mark it as not stock. */
export function useResolveUnknownUnit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ResolveUnknownUnitInput): Promise<ResolveUnknownUnitResult> => {
      const { data, error } = await supabase.rpc("resolve_unknown_purchase_unit", {
        p_variant: input.variant,
        p_action: input.action,
        p_code: input.code ?? null,
        p_request_id: input.requestId ?? newRequestId(),
      });
      if (error) throw error;
      return parseResolveUnknownUnitResult(data);
    },
    onSuccess: () => invalidateMissions(queryClient),
  });
}
