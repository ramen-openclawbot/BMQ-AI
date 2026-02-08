import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Hook to clear React Query cache when user changes
 * 
 * This prevents stale data from appearing when:
 * - User logs out and logs in as a different user
 * - Session changes due to token refresh with different user
 * 
 * The cache is only cleared on actual user changes, not on initial load.
 */
export function useClearCacheOnUserChange() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    // Skip initial mount (undefined -> value)
    if (prevUserIdRef.current === undefined) {
      prevUserIdRef.current = user?.id ?? null;
      return;
    }

    const currentUserId = user?.id ?? null;
    
    // User changed (not initial load)
    if (currentUserId !== prevUserIdRef.current) {
      console.log("[useClearCacheOnUserChange] User changed, clearing cache");
      queryClient.clear();
      prevUserIdRef.current = currentUserId;
    }
  }, [user?.id, queryClient]);
}
