import { RecoveryScreen } from "@/components/RecoveryScreen";
import AppInner from "./AppInner";

const DEALER_ORDERING_HOST = "dathang.banhmique.vn";
const ADMIN_APP_TITLE = "BMQ AI Quản Trị";
const DEALER_APP_TITLE = "BMQ Đặt Hàng";

function applyHostDocumentTitle(): void {
  document.title = window.location.hostname === DEALER_ORDERING_HOST
    ? DEALER_APP_TITLE
    : ADMIN_APP_TITLE;
}

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
  applyHostDocumentTitle();

  // CRITICAL: Check recovery route FIRST before any other logic
  if (isRecoveryRoute()) {
    return <RecoveryScreen />;
  }

  // Direct render without Suspense - no lazy loading
  return <AppInner />;
}

export default App;
