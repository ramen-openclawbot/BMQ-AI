import { useState, useCallback, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { useAutoSync } from "@/hooks/useAutoSync";
import { useVisibilityRecovery } from "@/hooks/useVisibilityRecovery";
import { SessionRecoveryOverlay } from "@/components/SessionRecoveryOverlay";
import { GlobalAgentChatWidget } from "@/components/agent/GlobalAgentChatWidget";
import { ZoneSubnav } from "./ZoneSubnav";
import "@/styles/bmq-shell.css";

// Demo 3 theme is scoped to the internal app: dealer, kiosk report, data admin,
// auth and public trace pages never mount AppLayout, so they keep their look.
const SHELL_THEME_CLASS = "bmq-d3";

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

  useEffect(() => {
    // On <html> so Radix portals (dialogs, menus, toasts) inherit the theme too.
    const root = document.documentElement;
    root.classList.add(SHELL_THEME_CLASS);
    return () => root.classList.remove(SHELL_THEME_CLASS);
  }, []);

  return (
    <>
      {showRecoveryOverlay && (
        <SessionRecoveryOverlay onRetry={handleRetry} />
      )}
      <div className="d3-app">
        <Header />
        <main className="d3-main">
          <div className="d3-screen">
            <ZoneSubnav />
            <Outlet />
          </div>
        </main>
        <Sidebar />
        <GlobalAgentChatWidget />
      </div>
    </>
  );
}
