import { RecoveryScreen } from "@/components/RecoveryScreen";
import KioskReportPortal from "@/pages/KioskReportPortal";
import { isEnglishAdminSurface, isVnagentAdminHostname } from "@/lib/adminHostLanguage";
import AppInner from "./AppInner";

const DEALER_ORDERING_HOST = "dathang.banhmique.vn";
const KIOSK_REPORT_HOST = "baocao.banhmique.vn";
const ADMIN_APP_TITLE = "BMQ AI Quản Trị";
const DEALER_APP_TITLE = "BMQ Đặt Hàng";
const VNAGENT_ADMIN_TITLE = "VNAgent · Data Admin";

function applyHostDocumentTitle(): void {
  if (window.location.hostname === DEALER_ORDERING_HOST) {
    document.title = DEALER_APP_TITLE;
    return;
  }

  if (window.location.hostname === KIOSK_REPORT_HOST) {
    document.title = "BMQ Báo Cáo Điểm Bán";
    return;
  }

  // Owner-only data-assets admin host (admin.banhmique.vn, alias
  // admin.vnagent.ai). The host renders the same SPA; the route tree in
  // AppRoutes forces the owner-only data admin for this hostname.
  if (isVnagentAdminHostname(window.location.hostname)) {
    document.title = VNAGENT_ADMIN_TITLE;
    return;
  }

  document.title = ADMIN_APP_TITLE;
}

// The owner-only admin surface (admin.banhmique.vn / alias admin.vnagent.ai, or
// the /data-admin route) is English; every other BMQ host keeps the document's
// default Vietnamese lang.
function applyHostDocumentLanguage(): void {
  if (isEnglishAdminSurface()) {
    document.documentElement.lang = "en";
  }
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
  applyHostDocumentLanguage();

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
