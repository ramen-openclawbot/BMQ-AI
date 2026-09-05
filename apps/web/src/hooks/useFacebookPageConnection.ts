import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

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

export class FacebookPageConnectUiError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("facebook_page_connect_failed");
    this.name = "FacebookPageConnectUiError";
    this.code = code;
  }
}

const SAFE_FACEBOOK_CONNECT_ERROR_CODES = new Set([
  "unauthorized",
  "forbidden",
  "service_not_configured",
  "invalid_json",
  "invalid_action",
  "invalid_candidate_id",
  "candidate_not_found",
  "subscription_failed",
  "provider_storage_failed",
]);

function safeErrorCode(value: unknown): string | null {
  return typeof value === "string" && SAFE_FACEBOOK_CONNECT_ERROR_CODES.has(value) ? value : null;
}

function errorCodeFromPayload(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  return safeErrorCode((value as { error?: unknown }).error);
}

async function extractSafeFacebookErrorCode(error: unknown): Promise<string> {
  if (!error || typeof error !== "object") return "request_failed";
  const context = (error as { context?: unknown }).context;

  if (context instanceof Response) {
    try {
      const payload = await context.clone().json();
      return errorCodeFromPayload(payload) || "request_failed";
    } catch {
      return "request_failed";
    }
  }

  return errorCodeFromPayload(context) || "request_failed";
}

async function invokeFacebookPageConnect<T>(body: Record<string, unknown>): Promise<T> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (sessionError || !accessToken) throw new FacebookPageConnectUiError("session_expired");

  const { data, error } = await supabase.functions.invoke<T>("facebook-page-connect", {
    body,
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (error) throw new FacebookPageConnectUiError(await extractSafeFacebookErrorCode(error));
  const payloadError = errorCodeFromPayload(data);
  if (payloadError) throw new FacebookPageConnectUiError(payloadError);
  return data as T;
}

export function useFacebookPageConnectionStatus() {
  return useQuery({
    queryKey: ["facebook-page-connect", "status"],
    queryFn: () => invokeFacebookPageConnect<FacebookPageConnectionStatus>({ action: "status" }),
    staleTime: 30_000,
    retry: false,
    retryOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
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
