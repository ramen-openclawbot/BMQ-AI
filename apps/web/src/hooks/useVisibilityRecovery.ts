import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

interface UseVisibilityRecoveryOptions {
  onSessionLost?: () => void;
}

// Retry delays in ms with exponential backoff
const RETRY_DELAYS = [500, 1000, 1500];

/**
 * Safari/WebKit visibility recovery hook with retry logic
 * 
 * When Safari puts a tab in background, pending network requests get "frozen".
 * This hook listens for visibility changes and:
 * 1. Verifies the session is still valid with retry logic
 * 2. Calls onSessionLost only if session is null after all retries
 * 3. Forces React Query to refetch all active queries on success
 * 
 * The retry logic prevents false positives when getSession() temporarily
 * returns null due to network latency when tab becomes visible.
 */
export function useVisibilityRecovery(options?: UseVisibilityRecoveryOptions) {
  const queryClient = useQueryClient();
  const isCheckingRef = useRef(false);
  const optionsRef = useRef(options);
  
  // Keep options ref updated
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;
      
      // Prevent concurrent checks
      if (isCheckingRef.current) return;
      isCheckingRef.current = true;
      
      try {
        let session = null;
        
        // Retry with exponential backoff
        for (let i = 0; i < RETRY_DELAYS.length; i++) {
          const { data } = await supabase.auth.getSession();
          session = data.session;
          
          if (session) {
            // Session found, break out of retry loop
            break;
          }
          
          // Wait before next retry (skip wait on last attempt)
          if (i < RETRY_DELAYS.length - 1) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[i]));
          }
        }
        
        if (!session) {
          // Session lost after all retries - notify parent
          console.warn("[useVisibilityRecovery] Session lost after retries");
          optionsRef.current?.onSessionLost?.();
          return;
        }
        
        // Session valid - force refetch all active queries
        queryClient.invalidateQueries({ 
          refetchType: 'active' 
        });
      } finally {
        isCheckingRef.current = false;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [queryClient]);
}
