import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseQ7FgAutoLedgerStatus,
  parseQ7FgDailyResult,
  type Q7FgAutoLedgerStatus,
  type Q7FgDailyResult,
} from "@/lib/q7-fg-auto-ledger";
import {
  Q7_FINISHED_GOODS_PLANNED_QUERY_KEY,
  WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY,
} from "./useWarehouseGame";

export const Q7_FG_AUTO_LEDGER_STATUS_QUERY_KEY = "q7-fg-auto-ledger-status";

type Q7FgAutoLedgerRpc = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

const rpc = (supabase as unknown as { rpc: Q7FgAutoLedgerRpc }).rpc.bind(supabase);

function invalidateQ7FgViews(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({
    queryKey: [Q7_FG_AUTO_LEDGER_STATUS_QUERY_KEY],
  });
  void queryClient.invalidateQueries({
    queryKey: [Q7_FINISHED_GOODS_PLANNED_QUERY_KEY],
  });
  void queryClient.invalidateQueries({
    queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY],
  });
}

/** Latest Q7 finished-goods auto-ledger runs, newest first. */
export function useQ7FgAutoLedgerStatus(limit = 14) {
  return useQuery({
    queryKey: [Q7_FG_AUTO_LEDGER_STATUS_QUERY_KEY, limit],
    queryFn: async (): Promise<Q7FgAutoLedgerStatus> => {
      const { data, error } = await rpc("get_q7_fg_auto_status", {
        p_limit: limit,
      });
      if (error) throw error;
      return parseQ7FgAutoLedgerStatus(data);
    },
  });
}

export interface RunQ7FgDailyLedgerInput {
  asOf?: string | null;
  dryRun?: boolean;
}

/**
 * Receive each Q7 production-order line from the plan, then dispatch the
 * customer PO quantity capped to on-hand. Dry-run by default so the owner can
 * preview a run before committing it.
 */
export function useRunQ7FgDailyLedger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      input: RunQ7FgDailyLedgerInput = {},
    ): Promise<Q7FgDailyResult> => {
      const { data, error } = await rpc("run_q7_fg_daily_ledger", {
        p_as_of: input.asOf ?? null,
        p_dry_run: input.dryRun ?? true,
      });
      if (error) throw error;
      return parseQ7FgDailyResult(data);
    },
    onSuccess: () => {
      invalidateQ7FgViews(queryClient);
    },
  });
}
