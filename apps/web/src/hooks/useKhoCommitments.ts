import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { parseKhoCommitments, type KhoCommitments } from "@/lib/kho-commitments";

export const KHO_COMMITMENTS_QUERY_KEY = "kho-commitments";

/** What open orders already hold, refreshed while the Kho page is open. */
export function useKhoCommitments() {
  return useQuery({
    queryKey: [KHO_COMMITMENTS_QUERY_KEY],
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<KhoCommitments> => {
      const { data, error } = await supabase.rpc(
        "kho_get_commitments" as never,
        {} as never,
      );
      if (error) throw error;
      return parseKhoCommitments(data);
    },
  });
}
