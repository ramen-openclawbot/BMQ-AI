import { useEffect, useRef } from "react";
import { useTriggerSync } from "./useDriveSync";

/**
 * Hook that automatically syncs Drive folders once when the user logs in.
 * Should be mounted in AppLayout (authenticated area) to trigger on login.
 */
export function useAutoSync() {
  const { mutate: triggerSync } = useTriggerSync();
  const hasSyncedRef = useRef(false);

  useEffect(() => {
    // Only sync once per session
    if (hasSyncedRef.current) return;
    hasSyncedRef.current = true;

    // Trigger sync for both folder types
    triggerSync('po');
    triggerSync('bank_slip');
  }, [triggerSync]);
}
