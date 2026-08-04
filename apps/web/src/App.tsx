import { RecoveryScreen } from "@/components/RecoveryScreen";
import KioskReportPortal from "@/pages/KioskReportPortal";
import AppInner from "./AppInner";

const DEALER_ORDERING_HOST = "dathang.banhmique.vn";
const KIOSK_REPORT_HOST = "baocao.banhmique.vn";
const ADMIN_APP_TITLE = "BMQ AI Quản Trị";
const DEALER_APP_TITLE = "BMQ Đặt Hàng";

function applyHostDocumentTitle(): void {
  if (window.location.hostname === DEALER_ORDERING_HOST) {
    document.title = DEALER_APP_TITLE;
    return;
  }

  if (window.location.hostname === KIOSK_REPORT_HOST) {
    document.title = "BMQ Báo Cáo Điểm Bán";
    return;
  }

  document.title = ADMIN_APP_TITLE;
}

/**
 * RECOVERY ROUTE: /recover allows users to clear session without loading Supabase.
 *
 * REPORT HOST: baocao.banhmique.vn renders the kiosk report portal without
 * mounting the internal router or internal authentication providers.
 */

// Check if we're on the recovery route BEFORE any React hooks/effects
function isRecoveryRoute(): boolean {
  const path = window.location.pathname;
  const search = window.location.search;
  return path === "/recover" || search.includes("recover=1");
}

function isKioskReportHost(): boolean {
  return window.location.hostname === KIOSK_REPORT_HOST;
}

function App() {
  applyHostDocumentTitle();

  // CRITICAL: Check recovery route FIRST before any other logic
  if (isRecoveryRoute()) {
    return <RecoveryScreen />;
  }

  if (isKioskReportHost()) {
    return <KioskReportPortal />;
  }

  return <AppInner />;
}

export default App;
