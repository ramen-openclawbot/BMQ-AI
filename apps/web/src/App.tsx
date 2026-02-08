import { RecoveryScreen } from "@/components/RecoveryScreen";
import AppInner from "./AppInner";

/**
 * SIMPLIFIED: Direct import of AppInner (no lazy loading)
 * 
 * Lazy loading was removed to prevent chunk loading failures that could
 * cause infinite loading spinners. The bundle size increase is minimal
 * since AppInner is just a wrapper component.
 * 
 * RECOVERY ROUTE: /recover allows users to clear session without loading Supabase
 */

// Check if we're on the recovery route BEFORE any React hooks/effects
function isRecoveryRoute(): boolean {
  const path = window.location.pathname;
  const search = window.location.search;
  return path === "/recover" || search.includes("recover=1");
}

function App() {
  // CRITICAL: Check recovery route FIRST before any other logic
  if (isRecoveryRoute()) {
    return <RecoveryScreen />;
  }

  // Direct render without Suspense - no lazy loading
  return <AppInner />;
}

export default App;
