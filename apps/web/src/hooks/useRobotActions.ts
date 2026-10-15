import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseRobotAutoActions,
  parseRobotSettings,
  type RobotAutoAction,
  type RobotSettings,
  type SetRobotSettingsInput,
} from "@/lib/robot-actions";
import {
  MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY,
  MATERIAL_ALIAS_REVIEW_QUERY_KEY,
} from "./useMaterialAlias";
import { STOCK_CATALOG_REVIEW_QUERY_KEY } from "./useStockCatalog";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

// No UI here: the hooks only call the robot RPCs. The server owns every
// permission gate (owner / q7 editor) and every write.
export const ROBOT_AUTO_ACTIONS_QUERY_KEY = "robot-auto-actions";
export const ROBOT_SETTINGS_QUERY_KEY = "robot-settings";

// The generated database types do not know the new RPCs yet.
const db = supabase as unknown as {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
};

/** Today's (or the last N days') robot auto-actions, with readable labels. */
export function useRobotAutoActions(days = 1) {
  const window = Number.isInteger(days) && days > 0 ? days : 1;
  return useQuery({
    queryKey: [ROBOT_AUTO_ACTIONS_QUERY_KEY, window],
    staleTime: 15 * 1000,
    queryFn: async (): Promise<RobotAutoAction[]> => {
      const { data, error } = await db.rpc("get_robot_auto_actions", { p_days: window });
      if (error) throw error;
      return parseRobotAutoActions(data);
    },
  });
}

/**
 * Undo one automatic action through the server RPC. Invalidates the robot list
 * and every list an undo can change (alias backlog/review, catalog review and the
 * warehouse game snapshot).
 */
export function useUndoRobotAutoAction() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string): Promise<unknown> => {
      const { data, error } = await db.rpc("undo_robot_auto_action", { p_id: id });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [ROBOT_AUTO_ACTIONS_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_REVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [MATERIAL_ALIAS_BACKLOG_REVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [STOCK_CATALOG_REVIEW_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
    },
  });
}

/** The single robot_settings row (off switch, thresholds, daily cap). */
export function useRobotSettings() {
  return useQuery({
    queryKey: [ROBOT_SETTINGS_QUERY_KEY],
    staleTime: 60 * 1000,
    queryFn: async (): Promise<RobotSettings> => {
      const { data, error } = await db.rpc("get_robot_settings");
      if (error) throw error;
      return parseRobotSettings(data);
    },
  });
}

/** Update robot_settings; only the owner RPC succeeds. */
export function useSetRobotSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: SetRobotSettingsInput): Promise<RobotSettings> => {
      const { data, error } = await db.rpc("set_robot_settings", {
        p_auto_apply_enabled: input.autoApplyEnabled ?? null,
        p_alias_threshold: input.aliasThreshold ?? null,
        p_class_threshold: input.classThreshold ?? null,
        p_daily_cap: input.dailyCap ?? null,
      });
      if (error) throw error;
      return parseRobotSettings(data);
    },
    onSuccess: (settings) => {
      queryClient.setQueryData([ROBOT_SETTINGS_QUERY_KEY], settings);
      void queryClient.invalidateQueries({ queryKey: [ROBOT_SETTINGS_QUERY_KEY] });
    },
  });
}
