import { useState, useCallback } from "react";
import { Outlet } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { useAutoSync } from "@/hooks/useAutoSync";
import { useVisibilityRecovery } from "@/hooks/useVisibilityRecovery";
import { SessionRecoveryOverlay } from "@/components/SessionRecoveryOverlay";
import { GlobalAgentChatWidget } from "@/components/agent/GlobalAgentChatWidget";

export function AppLayout() {
  const queryClient = useQueryClient();
  const [showRecoveryOverlay, setShowRecoveryOverlay] = useState(false);

  // Auto-sync Drive folders once on login
  useAutoSync();
  
  const handleSessionLost = useCallback(() => {
    setShowRecoveryOverlay(true);
  }, []);
  
  const handleRetry = useCallback(() => {
    setShowRecoveryOverlay(false);
    // Trigger re-check by invalidating queries
    queryClient.invalidateQueries({ refetchType: 'active' });
  }, [queryClient]);
  
  // Safari/WebKit: auto-recover when tab becomes visible
  useVisibilityRecovery({ onSessionLost: handleSessionLost });

  return (
    <>
      {showRecoveryOverlay && (
        <SessionRecoveryOverlay onRetry={handleRetry} />
      )}
      <div className="min-h-dvh bg-background/80">
        <Sidebar />
        <div className="flex h-dvh flex-col md:pl-[var(--sidebar-width)]">
          <Header />
          <main className="flex-1 overflow-auto px-3 py-3 pb-[max(6rem,env(safe-area-inset-bottom))] sm:p-6">
            <Outlet />
          </main>
        </div>
        <GlobalAgentChatWidget />
      </div>
    </>
  );
}
