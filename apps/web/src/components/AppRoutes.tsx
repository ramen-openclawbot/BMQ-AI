import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { AppLayout } from "@/components/layout/AppLayout";
import { OwnerRoute } from "@/components/OwnerRoute";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageLoader } from "@/components/ui/loading";
import { clearSessionAndReload } from "@/lib/session-utils";
import { adminHostCopy, isVnagentAdminHostname } from "@/lib/adminHostLanguage";

// Eager load: pages nhẹ, core navigation
import Index from "@/pages/Index";
import Suppliers from "@/pages/Suppliers";
import Invoices from "@/pages/Invoices";
import PaymentRequests from "@/pages/PaymentRequests";
import PaymentSubmission from "@/pages/PaymentSubmission";
import CashSettlement from "@/pages/CashSettlement";
import SalaryPayout from "@/pages/SalaryPayout";
import PayablesManagement from "@/pages/PayablesManagement";
import GoodsReceipts from "@/pages/GoodsReceipts";
import PurchaseOrders from "@/pages/PurchaseOrders";
import Settings from "@/pages/Settings";
import Auth from "@/pages/Auth";
import NotFound from "@/pages/NotFound";
import DealerPortal from "@/pages/DealerPortal";
import DealerPromotionDetail from "@/pages/DealerPromotionDetail";
import UserManagement from "@/pages/UserManagement";
import SystemManagement from "@/pages/SystemManagement";

// Lazy load: pages nặng — chỉ tải khi user vào trang đó
const MiniCrm = lazy(() => import("@/pages/MiniCrm"));
const FinanceControl = lazy(() => import("@/pages/FinanceControl"));
const FinanceReports = lazy(() => import("@/pages/FinanceReports"));
const FinanceRevenueControl = lazy(() => import("@/pages/FinanceRevenueControl"));
const RevenueManagementDashboard = lazy(() => import("@/pages/RevenueManagementDashboard"));
const RevenueSourceDetail = lazy(() => import("@/pages/RevenueSourceDetail"));
const NppDebtManagement = lazy(() => import("@/pages/NppDebtManagement"));
const PointRevenueManagement = lazy(() => import("@/pages/PointRevenueManagement"));
const SkuCostsManagement = lazy(() => import("@/pages/SkuCostsManagement"));
const SkuCostsAnalysis = lazy(() => import("@/pages/SkuCostsAnalysis"));
const SkuCostsDjango = lazy(() => import("@/pages/SkuCostsDjango"));
const KfmPrintToday = lazy(() => import("@/pages/KfmPrintToday"));
const ProductionPlanning = lazy(() => import("@/pages/ProductionPlanning"));
const Q7MaterialInventory = lazy(() => import("@/pages/Q7MaterialInventory"));
const MaterialMasterAdmin = lazy(() => import("@/pages/material-master/MaterialMasterAdmin"));
const MaterialMasterSystemStatus = lazy(() => import("@/pages/material-master/MaterialMasterSystemStatus"));
const ProductionProducts = lazy(() => import("@/pages/ProductionProducts"));
const QAInspection = lazy(() => import("@/pages/QAInspection"));
const TanTaoWarehouse = lazy(() => import("@/pages/TanTaoWarehouse"));
const StockLedger = lazy(() => import("@/pages/StockLedger"));
const StockCatalogCleanup = lazy(() => import("@/pages/StockCatalogCleanup"));
/** Kho pages in the app theme (owner 22/10/2026); they replaced the Game kho screen. */
const KhoCatalog = lazy(() => import("@/pages/KhoCatalog"));
const SupplierOrders = lazy(() => import("@/pages/SupplierOrders"));
const KhoCount = lazy(() => import("@/pages/KhoCount"));
const WarehouseSlips = lazy(() => import("@/pages/WarehouseSlips"));
const KhoReview = lazy(() => import("@/pages/KhoReview"));
const KhoCerts = lazy(() => import("@/pages/KhoCerts"));
const BepBnPayroll = lazy(() => import("@/pages/BepBnPayroll"));
const VNAgentDataAdmin = lazy(() => import("@/pages/VNAgentDataAdmin"));

const DEALER_ORDERING_HOST = "dathang.banhmique.vn";

function isDealerOrderingHost() {
  return window.location.hostname === DEALER_ORDERING_HOST;
}

function AppLoadingFallback() {
  return <PageLoader />;
}

function AuthTimeoutFallback() {
  const location = useLocation();
  // English on the owner-only admin surface, exact Vietnamese elsewhere.
  const copy = adminHostCopy();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="text-center space-y-4 max-w-sm">
        <AlertTriangle className="h-12 w-12 text-warning mx-auto" />
        <h2 className="text-lg font-semibold text-foreground">
          {copy.authTimeout.title}
        </h2>
        <p className="text-sm text-muted-foreground">
          {copy.authTimeout.body}
        </p>
        <div className="space-y-2">
          <Button onClick={clearSessionAndReload} className="w-full">
            <RefreshCw className="h-4 w-4 mr-2" />
            {copy.authTimeout.refreshSession}
          </Button>
          <Button
            variant="outline"
            onClick={() => window.location.reload()}
            className="w-full"
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            {copy.authTimeout.retry}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {copy.authTimeout.accessing(location.pathname)}
        </p>
      </div>
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, timedOut } = useAuth();

  if (loading) {
    return <AppLoadingFallback />;
  }

  // Dev-only bypass removed
  // Auth timed out without user = show recovery UI
  if (timedOut && !user) {
    return <AuthTimeoutFallback />;
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  return <>{children}</>;
}

function AuthzErrorFallback({ moduleLabel, onRetry }: { moduleLabel: string; onRetry: () => void }) {
  return (
    <div data-authz-error="v1" className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
        <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" />
        <h1 className="mt-3 text-xl font-semibold">Không kiểm tra được quyền truy cập</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Chưa xác minh được quyền xem module {moduleLabel} do lỗi kết nối. Trang tạm khóa để bảo đảm an toàn; vui lòng thử lại.
        </p>
        <Button className="mt-4" onClick={onRetry}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Thử lại
        </Button>
      </div>
    </div>
  );
}

function ModuleRoute({ moduleKey, children }: { moduleKey: string; children: React.ReactNode }) {
  const { user, loading, authzLoaded, authzError, canAccessModule, refreshRoles } = useAuth();
  const moduleLabels: Record<string, string> = {
    suppliers: "Nhà cung cấp",
    purchase_orders: "PO (Mua hàng)",
    payment_requests: "Duyệt chi / Công nợ phải trả",
    finance_cost: "Kiểm soát chi phí",
    finance_revenue: "Doanh thu",
    production_q7: "Kế hoạch SX - Xưởng Q7",
    q7_material_inventory: "Xuất-nhập-tồn NVL Q7",
    material_master: "Quản trị NVL chuẩn",
    production_products: "Quản lý sản phẩm",
    production_qa: "QA & Nhập kho TP",
    goods_receipts: "Phiếu nhập kho",
    inventory: "Kho",
  };
  const moduleLabel = moduleLabels[moduleKey] || moduleKey;

  if (loading) {
    return <AppLoadingFallback />;
  }

  // Same-user auth events re-check rights in the background (authzLoaded stays
  // true), so an open form is not unmounted. Only a first-time load or an
  // identity change blocks here; a failed check fails closed with a retry.
  if (user && !authzLoaded) {
    return authzError ? <AuthzErrorFallback moduleLabel={moduleLabel} onRetry={() => void refreshRoles()} /> : <AppLoadingFallback />;
  }

  if (!canAccessModule(moduleKey)) {
    return (
      <div data-authz-denied="v1" className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-md rounded-xl border bg-card p-6 text-center shadow-sm">
          <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" />
          <h1 className="mt-3 text-xl font-semibold">Không có quyền truy cập</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Trang này yêu cầu quyền xem module {moduleLabel} trong Quản lý người dùng.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function AppRoutes() {
  const { loading } = useAuth();
  const location = useLocation();
  const dealerHost = isDealerOrderingHost();
  const dealerPath = location.pathname === "/dealer" || location.pathname.startsWith("/dealer/");

  if (dealerHost) {
    return (
      <Routes>
        <Route path="/" element={<DealerPortal />} />
        <Route path="/promotion/:bannerId" element={<DealerPromotionDetail />} />
        <Route path="/dealer/promotion/:bannerId" element={<DealerPromotionDetail />} />
        <Route path="/dealer/*" element={<DealerPortal />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  if (dealerPath) {
    return (
      <Routes>
        <Route path="/dealer/promotion/:bannerId" element={<DealerPromotionDetail />} />
        <Route path="/dealer/*" element={<DealerPortal />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    );
  }

  // Owner-only data-assets admin: host-only, on admin.banhmique.vn (primary) or
  // the admin.vnagent.ai alias it is the whole site. The legacy /data-admin
  // route on other BMQ hosts was removed (2026-09-21): that path must never be
  // an alternate admin entry, so it falls through to the normal route table and
  // renders NotFound for anonymous visitors and signed-in owners alike.
  //
  // Deliberately NOT wrapped in the shared OwnerRoute here: that guard redirects
  // a denied user to "/", and on the admin host "/" matches this same "*" branch
  // again, so a non-owner would bounce forever with a blank screen. The owner
  // gate lives in VNAgentDataAdmin (it renders the English denied panel) and it
  // waits for authzLoaded before deciding, so this route only enforces sign-in.
  // The shared OwnerRoute behavior for BMQ routes below is untouched.
  if (isVnagentAdminHostname(window.location.hostname)) {
    return (
      <Routes>
        <Route path="/auth" element={<Auth />} />
        <Route
          path="*"
          element={
            <ProtectedRoute>
              <Suspense fallback={<AppLoadingFallback />}>
                <VNAgentDataAdmin />
              </Suspense>
            </ProtectedRoute>
          }
        />
      </Routes>
    );
  }

  if (loading) {
    return <AppLoadingFallback />;
  }

  return (
    <Routes>
      <Route path="/auth" element={<Auth />} />

      {/* The Game kho screen and Kho văn phòng are gone (owner 21–22/10/2026); old links land on Danh mục kho. */}
      <Route path="/warehouse/game" element={<Navigate to="/warehouse/danh-muc" replace />} />
      <Route path="/warehouse/office" element={<Navigate to="/warehouse/danh-muc" replace />} />

      {/* Main App Routes */}
      <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route path="/" element={<Index />} />
        <Route path="/suppliers" element={<ModuleRoute moduleKey="suppliers"><Suppliers /></ModuleRoute>} />
        <Route path="/invoices" element={<Invoices />} />
        <Route path="/payment-requests" element={<PaymentRequests />} />
        <Route path="/payment-requests/submissions/:id" element={<PaymentSubmission />} />
        <Route path="/payment-requests/cash-settle/:id" element={<CashSettlement />} />
        <Route path="/salary-payouts/:id" element={<SalaryPayout />} />
        <Route path="/goods-receipts" element={<GoodsReceipts />} />
        <Route path="/purchase-orders" element={<ModuleRoute moduleKey="purchase_orders"><PurchaseOrders /></ModuleRoute>} />
        <Route path="/dat-hang" element={<ModuleRoute moduleKey="supplier_orders"><Suspense fallback={<AppLoadingFallback />}><SupplierOrders /></Suspense></ModuleRoute>} />
        <Route path="/sku-costs" element={<Navigate to="/sku-costs/dashboard" replace />} />
        <Route path="/sku-costs/dashboard" element={<Suspense fallback={<AppLoadingFallback />}><SkuCostsDjango /></Suspense>} />
        <Route path="/sku-costs/management" element={<Suspense fallback={<AppLoadingFallback />}><SkuCostsManagement /></Suspense>} />
        <Route path="/sku-costs/analysis" element={<Suspense fallback={<AppLoadingFallback />}><SkuCostsAnalysis /></Suspense>} />
        {/* CEO khai báo removed (owner decision 2026-10-10): old links land on Duyệt chi. */}
        <Route path="/finance-control" element={<Navigate to="/payment-requests" replace />} />
        <Route path="/finance-control/cost" element={<Navigate to="/payment-requests" replace />} />
        <Route path="/finance-control/ceo-declaration" element={<Navigate to="/payment-requests" replace />} />
        <Route path="/finance-control/classification" element={<ModuleRoute moduleKey="finance_cost"><Suspense fallback={<AppLoadingFallback />}><FinanceControl mode="classification" /></Suspense></ModuleRoute>} />
        <Route path="/finance" element={<ModuleRoute moduleKey="finance_cost"><Suspense fallback={<AppLoadingFallback />}><FinanceReports /></Suspense></ModuleRoute>} />
        <Route path="/finance-control/payables" element={<ModuleRoute moduleKey="payment_requests"><PayablesManagement /></ModuleRoute>} />
        <Route path="/finance-control/revenue" element={<Suspense fallback={<AppLoadingFallback />}><RevenueManagementDashboard /></Suspense>} />
        <Route path="/finance-control/revenue/sources" element={<Suspense fallback={<AppLoadingFallback />}><RevenueSourceDetail /></Suspense>} />
        <Route path="/finance-control/revenue/setup" element={<Suspense fallback={<AppLoadingFallback />}><FinanceRevenueControl /></Suspense>} />
        <Route path="/finance-control/revenue/debt" element={<Suspense fallback={<AppLoadingFallback />}><NppDebtManagement /></Suspense>} />
        <Route path="/finance-control/revenue/points" element={<ModuleRoute moduleKey="finance_revenue"><Suspense fallback={<AppLoadingFallback />}><PointRevenueManagement /></Suspense></ModuleRoute>} />
        <Route path="/mini-crm" element={<Suspense fallback={<AppLoadingFallback />}><MiniCrm /></Suspense>} />
        <Route path="/sales-po-inbox" element={<Suspense fallback={<AppLoadingFallback />}><MiniCrm /></Suspense>} />
        {/* Production routes */}
        <Route path="/production/planning" element={<Navigate to="/production/planning/q7" replace />} />
        <Route path="/production/planning/q7/kfm" element={<ModuleRoute moduleKey="production_q7"><Suspense fallback={<AppLoadingFallback />}><KfmPrintToday /></Suspense></ModuleRoute>} />
        <Route path="/production/planning/q7" element={<ModuleRoute moduleKey="production_q7"><Suspense fallback={<AppLoadingFallback />}><ProductionPlanning /></Suspense></ModuleRoute>} />
        <Route path="/production/q7/inventory" element={<ModuleRoute moduleKey="q7_material_inventory"><Suspense fallback={<AppLoadingFallback />}><Q7MaterialInventory /></Suspense></ModuleRoute>} />
        <Route path="/material-master" element={<ModuleRoute moduleKey="material_master"><Suspense fallback={<AppLoadingFallback />}><MaterialMasterAdmin /></Suspense></ModuleRoute>} />
        <Route path="/material-master/system-status" element={<ModuleRoute moduleKey="material_master"><Suspense fallback={<AppLoadingFallback />}><MaterialMasterSystemStatus /></Suspense></ModuleRoute>} />
        <Route path="/production/products" element={<ModuleRoute moduleKey="production_products"><Suspense fallback={<AppLoadingFallback />}><ProductionProducts /></Suspense></ModuleRoute>} />
        <Route path="/production/qa" element={<ModuleRoute moduleKey="production_qa"><Suspense fallback={<AppLoadingFallback />}><QAInspection /></Suspense></ModuleRoute>} />
        <Route path="/payroll" element={<Suspense fallback={<AppLoadingFallback />}><BepBnPayroll /></Suspense>} />
        {/* Warehouse extension routes */}
        <Route path="/warehouse/danh-muc" element={<ModuleRoute moduleKey="inventory"><Suspense fallback={<AppLoadingFallback />}><KhoCatalog /></Suspense></ModuleRoute>} />
        <Route path="/warehouse/kiem-ke" element={<ModuleRoute moduleKey="inventory"><Suspense fallback={<AppLoadingFallback />}><KhoCount /></Suspense></ModuleRoute>} />
        <Route path="/warehouse/phieu" element={<ModuleRoute moduleKey="inventory"><Suspense fallback={<AppLoadingFallback />}><WarehouseSlips /></Suspense></ModuleRoute>} />
        <Route path="/warehouse/ra-soat" element={<ModuleRoute moduleKey="inventory"><Suspense fallback={<AppLoadingFallback />}><KhoReview /></Suspense></ModuleRoute>} />
        <Route path="/warehouse/ho-so-attp" element={<ModuleRoute moduleKey="inventory"><Suspense fallback={<AppLoadingFallback />}><KhoCerts /></Suspense></ModuleRoute>} />
        <Route path="/warehouse/stock-ledger" element={<ModuleRoute moduleKey="inventory"><Suspense fallback={<AppLoadingFallback />}><StockLedger /></Suspense></ModuleRoute>} />
        {/* Owner 22/10: Mua so với dùng and Giá vốn → Kho removed (decisions go through chat); old links land on Danh mục kho. */}
        <Route path="/warehouse/purchase-usage" element={<Navigate to="/warehouse/danh-muc" replace />} />
        <Route path="/warehouse/gia-von" element={<Navigate to="/warehouse/danh-muc" replace />} />
        <Route path="/warehouse/catalog-cleanup" element={<ModuleRoute moduleKey="inventory"><Suspense fallback={<AppLoadingFallback />}><StockCatalogCleanup /></Suspense></ModuleRoute>} />
        <Route path="/warehouse/tan-tao" element={<ModuleRoute moduleKey="inventory"><Suspense fallback={<AppLoadingFallback />}><TanTaoWarehouse /></Suspense></ModuleRoute>} />
        <Route path="/settings" element={<Settings />} />
        {/* Owner-only routes */}
        <Route path="/user-management" element={<OwnerRoute><UserManagement /></OwnerRoute>} />
        <Route path="/system-management" element={<OwnerRoute><SystemManagement /></OwnerRoute>} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
