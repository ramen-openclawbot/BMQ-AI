import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { parseKhoHold, parseKhoHolds, type KhoHoldDecision, type KhoHoldStatus } from "@/lib/kho-holds";

export const KHO_HOLDS_QUERY_KEY = "kho-holds";

const rpc = supabase.rpc.bind(supabase) as unknown as (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

async function listHolds(status: KhoHoldStatus) {
  const { data, error } = await rpc("cogs_backflush_list_holds", { p_status: status });
  if (error) throw error;
  return parseKhoHolds(data);
}

/** Held / approved / rejected days of the revenue-based deduction. Owner-only: others never call it. */
export function useKhoHolds(status: KhoHoldStatus) {
  const { isOwner } = useAuth();
  return useQuery({
    queryKey: [KHO_HOLDS_QUERY_KEY, status],
    queryFn: () => listHolds(status),
    enabled: isOwner,
    staleTime: 30_000,
  });
}

/** Count for the Kho menu chip; shares the cache with the page's "Đang chờ" list. */
export function useKhoHoldCount() {
  const { isOwner } = useAuth();
  const query = useQuery({
    queryKey: [KHO_HOLDS_QUERY_KEY, "held"],
    queryFn: () => listHolds("held"),
    enabled: isOwner,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  return isOwner ? query.data?.length ?? 0 : 0;
}

export function useDecideKhoHold() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, decision }: { id: string; decision: KhoHoldDecision }) => {
      const { data, error } = await rpc("cogs_backflush_decide_hold", { p_hold_id: id, p_decision: decision });
      if (error) throw error;
      return parseKhoHold(data);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [KHO_HOLDS_QUERY_KEY] }),
  });
}
