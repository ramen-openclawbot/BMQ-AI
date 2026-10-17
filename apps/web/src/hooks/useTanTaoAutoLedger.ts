import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import {
  parseTanTaoAutoLedgerStatus,
  parseTanTaoCloseBeforeResult,
  parseTanTaoDailyResult,
  type TanTaoAutoLedgerStatus,
  type TanTaoCloseBeforeResult,
  type TanTaoDailyResult,
} from "@/lib/tan-tao-auto-ledger";

export const TAN_TAO_AUTO_LEDGER_STATUS_QUERY_KEY = "tan-tao-auto-ledger-status";

type TanTaoAutoLedgerRpc = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

const rpc = (supabase as unknown as { rpc: TanTaoAutoLedgerRpc }).rpc.bind(supabase);

function invalidateTanTaoWarehouseViews(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({
    queryKey: [TAN_TAO_AUTO_LEDGER_STATUS_QUERY_KEY],
  });
  void queryClient.invalidateQueries({ queryKey: ["tan-tao-warehouse-snapshot"] });
  void queryClient.invalidateQueries({ queryKey: ["stock-ledger-overview"] });
}

/** Latest auto-ledger runs, newest first; owner or warehouse viewers only. */
export function useTanTaoAutoLedgerStatus(limit = 14) {
  return useQuery({
    queryKey: [TAN_TAO_AUTO_LEDGER_STATUS_QUERY_KEY, limit],
    queryFn: async (): Promise<TanTaoAutoLedgerStatus> => {
      const { data, error } = await rpc("get_tan_tao_auto_ledger_status", {
        p_limit: limit,
      });
      if (error) throw error;
      return parseTanTaoAutoLedgerStatus(data);
    },
  });
}

export interface CloseTanTaoOpenBeforeInput {
  before?: string | null;
  dryRun?: boolean;
}

/**
 * Close active reservations and expected supplier orders dated on/before the
 * cutover (or an explicit date) without posting stock. Dry-run by default.
 */
export function useCloseTanTaoOpenBefore() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      input: CloseTanTaoOpenBeforeInput = {},
    ): Promise<TanTaoCloseBeforeResult> => {
      const { data, error } = await rpc("close_tan_tao_open_before", {
        p_before: input.before ?? null,
        p_dry_run: input.dryRun ?? true,
      });
      if (error) throw error;
      return parseTanTaoCloseBeforeResult(data);
    },
    onSuccess: () => {
      invalidateTanTaoWarehouseViews(queryClient);
    },
  });
}

export interface RunTanTaoDailyLedgerInput {
  asOf?: string | null;
  dryRun?: boolean;
}

/**
 * Receive expected Tuyết Anh orders, then dispatch active dealer/kiosk
 * reservations for business dates after the cutover and up to `asOf`.
 */
export function useRunTanTaoDailyLedger() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      input: RunTanTaoDailyLedgerInput = {},
    ): Promise<TanTaoDailyResult> => {
      const { data, error } = await rpc("run_tan_tao_daily_ledger", {
        p_as_of: input.asOf ?? null,
        p_dry_run: input.dryRun ?? false,
      });
      if (error) throw error;
      return parseTanTaoDailyResult(data);
    },
    onSuccess: () => {
      invalidateTanTaoWarehouseViews(queryClient);
    },
  });
}
