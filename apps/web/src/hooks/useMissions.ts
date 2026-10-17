import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseAssignMissionResult,
  parseCompleteMissionResult,
  parseMarkItemsDistinctResult,
  parseMissionAssignments,
  parseMissionStaff,
  parseMyMissions,
  parseResolveUnknownUnitResult,
  parseUpdateAliasFactorResult,
  type AssignMissionResult,
  type CompleteMissionResult,
  type MarkItemsDistinctResult,
  type MissionAssignment,
  type MissionStaffMember,
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
export const MISSION_ASSIGNMENTS_QUERY_KEY = "mission-assignments";
export const MISSION_STAFF_QUERY_KEY = "mission-staff";

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

/** A new assignment changes the boards and the staff counters. */
function invalidateMissionAssignments(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [MISSIONS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MISSION_ASSIGNMENTS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [MISSION_STAFF_QUERY_KEY] });
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

/** Staff members the owner may assign a warehouse mission to. */
export function useMissionStaff(enabled = true) {
  return useQuery({
    queryKey: [MISSION_STAFF_QUERY_KEY],
    enabled,
    queryFn: async (): Promise<MissionStaffMember[]> => {
      const { data, error } = await supabase.rpc("get_mission_staff" as never);
      if (error) throw error;
      return parseMissionStaff(data);
    },
  });
}

/** Open and completed assigned copies, grouped by the UI with assignmentsByParent. */
export function useMissionAssignments(enabled = true) {
  return useQuery({
    queryKey: [MISSION_ASSIGNMENTS_QUERY_KEY],
    enabled,
    queryFn: async (): Promise<MissionAssignment[]> => {
      const { data, error } = await supabase.rpc("get_mission_assignments" as never);
      if (error) throw error;
      return parseMissionAssignments(data);
    },
  });
}

export interface AssignMissionInput {
  missionId: string;
  userId: string;
}

/** Assign an open mission to a staff member (owner only). */
export function useAssignMission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AssignMissionInput): Promise<AssignMissionResult> => {
      const { data, error } = await supabase.rpc("assign_mission" as never, {
        p_mission_id: input.missionId,
        p_user_id: input.userId,
      } as never);
      if (error) throw error;
      return parseAssignMissionResult(data);
    },
    onSuccess: () => invalidateMissionAssignments(queryClient),
  });
}

export interface UnassignMissionInput {
  missionId: string;
}

/** Withdraw an open assigned copy (owner only; the root mission is untouched). */
export function useUnassignMission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UnassignMissionInput) => {
      const { data, error } = await supabase.rpc("unassign_mission" as never, {
        p_mission_id: input.missionId,
      } as never);
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidateMissionAssignments(queryClient),
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
