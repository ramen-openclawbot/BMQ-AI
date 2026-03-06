import { useEffect, useRef } from "react";
import { useTriggerSync } from "./useDriveSync";

/**
 * Hook that automatically syncs Drive folders once when the user logs in.
 * Should be mounted in AppLayout (authenticated area) to trigger on login.
 */
export function useAutoSync() {
  const { mutate: triggerSync } = useTriggerSync({ silent: true });
  const hasSyncedRef = useRef(false);

  useEffect(() => {
    // Hotfix: disable automatic browser-triggered sync by default because
    // intermittent edge gateway preflight 504 can spam CORS errors globally.
    // Manual sync in Settings remains available.
    const autoSyncEnabled = import.meta.env.VITE_ENABLE_AUTO_DRIVE_SYNC === 'true';
    if (!autoSyncEnabled) return;

    // Only sync once per session
    if (hasSyncedRef.current) return;
    hasSyncedRef.current = true;

    // Trigger sync for both folder types
    triggerSync('po');
    triggerSync('bank_slip');
  }, [triggerSync]);
}
