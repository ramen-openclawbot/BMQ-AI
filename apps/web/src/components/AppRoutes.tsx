import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { lazy, Suspense } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { AppLayout } from "@/components/layout/AppLayout";
import { OwnerRoute } from "@/components/OwnerRoute";
import { Loader2, AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearSessionAndReload } from "@/lib/session-utils";

// Eager load: pages nhẹ, core navigation
import Index from "@/pages/Index";
import Inventory from "@/pages/Inventory";
import Suppliers from "@/pages/Suppliers";
import Invoices from "@/pages/Invoices";
import PaymentRequests from "@/pages/PaymentRequests";
import LowStock from "@/pages/LowStock";
import GoodsReceipts from "@/pages/GoodsReceipts";
import PurchaseOrders from "@/pages/PurchaseOrders";
import Settings from "@/pages/Settings";
import Auth from "@/pages/Auth";
import NotFound from "@/pages/NotFound";
import SkuCostsProducts from "@/pages/SkuCostsProducts";
import SkuCostsIngredients from "@/pages/SkuCostsIngredients";
import SkuCostsEmployees from "@/pages/SkuCostsEmployees";
import SkuCostsOverhead from "@/pages/SkuCostsOverhead";
import TraceabilityPublic from "@/pages/TraceabilityPublic";
import UserManagement from "@/pages/UserManagement";
import SystemManagement from "@/pages/SystemManagement";
import WarehouseHome from "@/warehouse/pages/WarehouseHome";

// Lazy load: pages nặng — chỉ tải khi user vào trang đó
const MiniCrm = lazy(() => import("@/pages/MiniCrm"));
const FinanceControl = lazy(() => import("@/pages/FinanceControl"));
const FinanceRevenueControl = lazy(() => import("@/pages/FinanceRevenueControl"));
const SkuCostsManagement = lazy(() => import("@/pages/SkuCostsManagement"));
const SkuCostsAnalysis = lazy(() => import("@/pages/SkuCostsAnalysis"));
const SkuCostsDjango = lazy(() => import("@/pages/SkuCostsDjango"));
const Reports = lazy(() => import("@/pages/Reports"));
const NiraanDashboard = lazy(() => import("@/pages/NiraanDashboard"));
const ProductionPlanning = lazy(() => import("@/pages/ProductionPlanning"));
const ProductionShifts = lazy(() => import("@/pages/ProductionShifts"));
const QAInspection = lazy(() => import("@/pages/QAInspection"));
const WarehouseDispatch = lazy(() => import("@/pages/WarehouseDispatch"));
const StockReport = lazy(() => import("@/pages/StockReport"));

function AppLoadingFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

function AuthTimeoutFallback() {
  const location = useLocation();

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="text-center space-y-4 max-w-sm">
        <AlertTriangle className="h-12 w-12 text-warning mx-auto" />
        <h2 className="text-lg font-semibold text-foreground">
          Đang gặp sự cố kết nối
        </h2>
        <p className="text-sm text-muted-foreground">
          Không thể xác thực phiên đăng nhập. Điều này thường xảy ra trên Safari.
        </p>
        <div className="space-y-2">
          <Button onClick={clearSessionAndReload} className="w-full">
            <RefreshCw className="h-4 w-4 mr-2" />
            Làm mới phiên
          </Button>
          <Button
            variant="outline"
            onClick={() => window.location.reload()}
            className="w-full"
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            Thử lại
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Đang cố truy cập: {location.pathname}
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

export function AppRoutes() {
  const { loading } = useAuth();

  if (loading) {
    return <AppLoadingFallback />;
  }

  return (
    <Routes>
      <Route path="/auth" element={<Auth />} />
      <Route path="/trace/:token" element={<TraceabilityPublic />} />

      {/* Warehouse App Route - uses main app auth */}
      <Route path="/kho" element={
        <ProtectedRoute>
          <WarehouseHome />
        </ProtectedRoute>
      } />

      {/* Main App Routes */}
      <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        <Route path="/" element={<Index />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/suppliers" element={<Suppliers />} />
        <Route path="/invoices" element={<Invoices />} />
        <Route path="/payment-requests" element={<PaymentRequests />} />
        <Route path="/goods-receipts" element={<GoodsReceipts />} />
        <Route path="/purchase-orders" element={<PurchaseOrders />} />
        <Route path="/low-stock" element={<LowStock />} />
        <Route path="/sku-costs" element={<Navigate to="/sku-costs/dashboard" replace />} />
        <Route path="/sku-costs/dashboard" element={<Suspense fallback={<AppLoadingFallback />}><SkuCostsDjango /></Suspense>} />
        <Route path="/sku-costs/management" element={<Suspense fallback={<AppLoadingFallback />}><SkuCostsManagement /></Suspense>} />
        <Route path="/sku-costs/analysis" element={<Suspense fallback={<AppLoadingFallback />}><SkuCostsAnalysis /></Suspense>} />
        <Route path="/sku-costs/products" element={<SkuCostsProducts />} />
        <Route path="/sku-costs/ingredients" element={<SkuCostsIngredients />} />
        <Route path="/sku-costs/employees" element={<SkuCostsEmployees />} />
        <Route path="/sku-costs/overhead" element={<SkuCostsOverhead />} />
        <Route path="/reports" element={<Suspense fallback={<AppLoadingFallback />}><Reports /></Suspense>} />
        <Route path="/niraan-dashboard" element={<Suspense fallback={<AppLoadingFallback />}><NiraanDashboard /></Suspense>} />
        <Route path="/finance-control" element={<Navigate to="/finance-control/cost" replace />} />
        <Route path="/finance-control/cost" element={<Suspense fallback={<AppLoadingFallback />}><FinanceControl /></Suspense>} />
        <Route path="/finance-control/revenue" element={<Suspense fallback={<AppLoadingFallback />}><FinanceRevenueControl /></Suspense>} />
        <Route path="/mini-crm" element={<Suspense fallback={<AppLoadingFallback />}><MiniCrm /></Suspense>} />
        <Route path="/sales-po-inbox" element={<Suspense fallback={<AppLoadingFallback />}><MiniCrm /></Suspense>} />
        {/* Production routes */}
        <Route path="/production/planning" element={<Suspense fallback={<AppLoadingFallback />}><ProductionPlanning /></Suspense>} />
        <Route path="/production/shifts" element={<Suspense fallback={<AppLoadingFallback />}><ProductionShifts /></Suspense>} />
        <Route path="/production/qa" element={<Suspense fallback={<AppLoadingFallback />}><QAInspection /></Suspense>} />
        {/* Warehouse extension routes */}
        <Route path="/warehouse/dispatch" element={<Suspense fallback={<AppLoadingFallback />}><WarehouseDispatch /></Suspense>} />
        <Route path="/warehouse/stock-report" element={<Suspense fallback={<AppLoadingFallback />}><StockReport /></Suspense>} />
        <Route path="/settings" element={<Settings />} />
        {/* Owner-only routes */}
        <Route path="/user-management" element={<OwnerRoute><UserManagement /></OwnerRoute>} />
        <Route path="/system-management" element={<OwnerRoute><SystemManagement /></OwnerRoute>} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
