import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { MISSIONS_QUERY_KEY } from "./useMissions";
import { WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY } from "./useWarehouseGame";

/** The new RPC is not in the generated Database type yet. */
const rpcClient = supabase as any;

export interface RecordMissionSkuCountInput {
  missionId: string;
  countedQty: number;
  note?: string | null;
  /** Generated per click when omitted; the server replays the same key. */
  requestId?: string;
}

export interface RecordMissionSkuCountResult {
  mission_id: string;
  sku_code: string;
  counted_qty: number;
  result: unknown;
}

function newRequestId(): string {
  return crypto.randomUUID();
}

/** A mission count moves the mission board and both warehouse snapshots. */
function invalidateMissionSkuCount(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: [MISSIONS_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: [WAREHOUSE_GAME_SNAPSHOT_QUERY_KEY] });
  void queryClient.invalidateQueries({ queryKey: ["tan-tao-warehouse-snapshot"] });
}

/**
 * Record the counted BMQ quantity for the owner or the mission assignee.
 * The server delegates to record_tan_tao_stock_count once per request id.
 */
export function useMissionSkuCount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: RecordMissionSkuCountInput,
    ): Promise<RecordMissionSkuCountResult> => {
      const { data, error } = await rpcClient.rpc("record_mission_sku_count", {
        p_mission_id: input.missionId,
        p_counted_qty: input.countedQty,
        p_note: input.note ?? null,
        p_request_id: input.requestId ?? newRequestId(),
      });
      if (error) throw error;
      return data as RecordMissionSkuCountResult;
    },
    onSuccess: () => invalidateMissionSkuCount(queryClient),
  });
}
