import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getFreshAccessToken } from "@/lib/supabase-helpers";

export type FacebookPageConnectionStatus = {
  connected: boolean;
  featureEnabled: boolean;
  pageName?: string | null;
  pageIdSuffix?: string | null;
  connectedAt?: string | null;
  connectionStatus?: string | null;
  pendingPageCandidates?: FacebookPageCandidate[];
};

export type FacebookPageConnectStartResult = {
  authUrl: string;
  expiresAt?: string;
};

export type FacebookPageCandidate = {
  candidateId: string;
  pageName: string;
  pageIdSuffix: string;
  permissions?: string[];
  expiresAt?: string;
};

export type FacebookPageFinalizeResult = {
  connected: boolean;
  pageName?: string | null;
  pageIdSuffix?: string | null;
};

async function invokeFacebookPageConnect<T>(body: Record<string, unknown>): Promise<T> {
  let accessToken: string;
  try {
    accessToken = await getFreshAccessToken();
  } catch {
    throw new Error("session_expired");
  }

  const { data, error } = await supabase.functions.invoke<T>("facebook-page-connect", {
    body,
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (error) throw new Error("request_failed");
  return data as T;
}

export function useFacebookPageConnectionStatus() {
  return useQuery({
    queryKey: ["facebook-page-connect", "status"],
    queryFn: () => invokeFacebookPageConnect<FacebookPageConnectionStatus>({ action: "status" }),
    staleTime: 30_000,
  });
}

export function useFacebookPageConnect() {
  return useMutation({
    mutationFn: async () => {
      return invokeFacebookPageConnect<FacebookPageConnectStartResult>({
        action: "start",
        redirect: `${window.location.origin}/marketing-sales/facebook-page`,
      });
    },
  });
}

export function useFacebookPageCandidateFinalize() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ candidateId }: { candidateId: string }) => {
      return invokeFacebookPageConnect<FacebookPageFinalizeResult>({
        action: "finalize_candidate",
        candidate_id: candidateId,
      });
    },
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ["facebook-messenger-inbox"] });
      await queryClient.invalidateQueries({ queryKey: ["facebook-page-connect", "status"] });
    },
  });
}
