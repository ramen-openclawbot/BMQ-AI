import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { AppLayout } from "@/components/layout/AppLayout";
import { Loader2, AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearSessionAndReload } from "@/lib/session-utils";
import Index from "@/pages/Index";
import Inventory from "@/pages/Inventory";
import Suppliers from "@/pages/Suppliers";
import Invoices from "@/pages/Invoices";
import PaymentRequests from "@/pages/PaymentRequests";
import LowStock from "@/pages/LowStock";
// ProductSKUs removed
import GoodsReceipts from "@/pages/GoodsReceipts";
import PurchaseOrders from "@/pages/PurchaseOrders";
import Reports from "@/pages/Reports";
import Settings from "@/pages/Settings";
import Auth from "@/pages/Auth";
import NotFound from "@/pages/NotFound";
import SkuCostsDjango from "@/pages/SkuCostsDjango";
import SkuCostsManagement from "@/pages/SkuCostsManagement";
import SkuCostsAnalysis from "@/pages/SkuCostsAnalysis";
import SkuCostsProducts from "@/pages/SkuCostsProducts";
import SkuCostsIngredients from "@/pages/SkuCostsIngredients";
import SkuCostsEmployees from "@/pages/SkuCostsEmployees";
import SkuCostsOverhead from "@/pages/SkuCostsOverhead";
import TraceabilityPublic from "@/pages/TraceabilityPublic";

// Warehouse App - eager load to prevent Safari chunk loading issues
import WarehouseHome from "@/warehouse/pages/WarehouseHome";

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
        <Route path="/sku-costs/dashboard" element={<SkuCostsDjango />} />
        <Route path="/sku-costs/management" element={<SkuCostsManagement />} />
        <Route path="/sku-costs/analysis" element={<SkuCostsAnalysis />} />
        <Route path="/sku-costs/products" element={<SkuCostsProducts />} />
        <Route path="/sku-costs/ingredients" element={<SkuCostsIngredients />} />
        <Route path="/sku-costs/employees" element={<SkuCostsEmployees />} />
        <Route path="/sku-costs/overhead" element={<SkuCostsOverhead />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
