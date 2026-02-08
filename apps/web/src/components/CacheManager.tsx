import { useClearCacheOnUserChange } from "@/hooks/useClearCacheOnUserChange";

/**
 * CacheManager component
 * 
 * This component manages React Query cache lifecycle based on auth state.
 * It clears the cache when user changes to prevent stale data from
 * appearing when logging in as a different user.
 * 
 * Placed inside AuthProvider and QueryClientProvider in AppInner.
 */
export function CacheManager() {
  useClearCacheOnUserChange();
  
  // This component renders nothing - it only manages side effects
  return null;
}
