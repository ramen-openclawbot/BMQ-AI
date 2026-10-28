import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { buildRevenueDay, type RevenueDay } from "@/lib/kho-revenue-demo";

/**
 * The day payload is read-only and gated by kho_revenue_day. Keep the RPC name
 * locally typed until the migration is applied and the generated types refresh.
 */
// Bound to the client: a detached `supabase.rpc` loses `this` and throws before any request.
const rpcUntyped = supabase.rpc.bind(supabase) as unknown as (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

export function useKhoRevenueDay(day: string) {
  return useQuery({
    queryKey: ["kho-revenue-day", day],
    queryFn: async (): Promise<RevenueDay> => {
      const { data, error } = await rpcUntyped("kho_revenue_day", { p_day: day });
      if (error) throw error;
      return buildRevenueDay(data);
    },
    staleTime: 60_000,
    enabled: Boolean(day),
  });
}
