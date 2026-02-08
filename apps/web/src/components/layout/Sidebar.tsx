import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { 
  LayoutDashboard, 
  Package, 
  Users, 
  FileText, 
  AlertTriangle,
  Settings,
  FileCheck,
  Barcode,
  LucideIcon,
  PackageCheck,
  ShoppingCart,
  BarChart3,
  FolderSearch,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePaymentStats } from "@/hooks/usePaymentStats";
import { useDraftPOCount } from "@/hooks/usePurchaseOrders";
import { Badge } from "@/components/ui/badge";
import { DriveImportProgressDialog } from "@/components/payment-requests/DriveImportProgressDialog";
import bmqLogo from "@/assets/bmq-logo.png";

interface NavItem {
  icon: LucideIcon;
  labelKey: keyof ReturnType<typeof useLanguage>["t"];
  path: string;
  showBadge?: boolean;
  showPOBadge?: boolean;
}

const navItems: NavItem[] = [
  { icon: LayoutDashboard, labelKey: "dashboard", path: "/" },
  { icon: BarChart3, labelKey: "reports", path: "/reports" },
  { icon: Package, labelKey: "inventory", path: "/inventory" },
  { icon: PackageCheck, labelKey: "goodsReceipts", path: "/goods-receipts" },
  { icon: ShoppingCart, labelKey: "purchaseOrders", path: "/purchase-orders", showPOBadge: true },
  { icon: Barcode, labelKey: "skuCosts", path: "/sku-costs" },
  { icon: Users, labelKey: "suppliers", path: "/suppliers" },
  { icon: FileText, labelKey: "invoices", path: "/invoices" },
  { icon: FileCheck, labelKey: "paymentRequests", path: "/payment-requests", showBadge: true },
  { icon: AlertTriangle, labelKey: "lowStock", path: "/low-stock" },
];

export function Sidebar() {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const { data: paymentStats } = usePaymentStats();
  const { data: draftPOCount } = useDraftPOCount();
  
  const [showDriveDialog, setShowDriveDialog] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const width = collapsed ? "4rem" : "16rem";
    document.documentElement.style.setProperty("--sidebar-width", width);
  }, [collapsed]);

  // Badge shows pending approval count
  const badgeCount = paymentStats?.pendingCount || 0;

  const handleScanDrive = () => {
    setShowDriveDialog(true);
  };

  return (
    <aside className={cn(
      "fixed left-0 top-0 z-40 h-screen bg-sidebar border-r border-sidebar-border transition-all duration-200",
      collapsed ? "w-16" : "w-64"
    )}>
      <div className="flex h-full flex-col">
        {/* Logo */}
        <div className={cn("flex items-center gap-3 border-b border-sidebar-border", collapsed ? "px-3 py-4" : "px-6 py-5")}>
          <img src={bmqLogo} alt="BMQ Logo" className={cn("h-10 w-auto", collapsed ? "mx-auto" : "h-12")} />
          {!collapsed && (
            <div className="flex-1">
              <h1 className="font-display text-sm font-bold text-sidebar-foreground leading-tight">
                {t.appTitle}
              </h1>
            </div>
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={cn(
              "ml-auto rounded-md p-1 text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50",
              collapsed && "ml-0"
            )}
            aria-label="Toggle sidebar"
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>

        {/* Navigation - scrollable */}
        <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
          {navItems.map((item) => (
            <div key={item.path}>
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-primary"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  )
                }
              >
                <item.icon className="h-5 w-5" />
                {!collapsed && <span className="flex-1">{t[item.labelKey]}</span>}
                {!collapsed && item.showBadge && badgeCount > 0 && (
                  <Badge variant="destructive" className="h-5 min-w-5 flex items-center justify-center text-xs">
                    {badgeCount}
                  </Badge>
                )}
                {!collapsed && item.showPOBadge && draftPOCount && draftPOCount > 0 && (
                  <Badge variant="secondary" className="h-5 min-w-5 flex items-center justify-center text-xs">
                    {draftPOCount}
                  </Badge>
                )}
              </NavLink>
              
              {/* Quick Action: Tạo PO từ GG Drive - under Purchase Orders */}
              {item.path === "/purchase-orders" && !collapsed && (
                <div className="ml-8 mt-1">
                  <button
                    onClick={handleScanDrive}
                    className="flex items-center gap-1.5 text-xs text-blue-500 hover:text-blue-600 px-4 py-1.5 w-full rounded hover:bg-sidebar-accent/30 transition-colors"
                  >
                    <FolderSearch className="h-3 w-3" />
                    <span>Tạo PO từ GG Drive</span>
                  </button>
                </div>
              )}

              {item.path === "/sku-costs" && !collapsed && (
                <div className="ml-8 mt-2 space-y-1">
                  <NavLink to="/sku-costs/dashboard" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground px-4 py-2 w-full rounded hover:bg-sidebar-accent/30 transition-colors">{t.skuCostDashboard}</NavLink>
                  <NavLink to="/sku-costs/management" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground px-4 py-2 w-full rounded hover:bg-sidebar-accent/30 transition-colors">{t.skuCostManagement}</NavLink>
                  <NavLink to="/sku-costs/analysis" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground px-4 py-2 w-full rounded hover:bg-sidebar-accent/30 transition-colors">{t.skuCostAnalysis}</NavLink>
                </div>
              )}
            </div>
          ))}
        </nav>

        {/* Settings */}
        <div className="px-4 py-4 border-t border-sidebar-border">
          <NavLink
            to="/settings"
            className="flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-all duration-200"
          >
            <Settings className="h-5 w-5" />
            {!collapsed && t.settings}
          </NavLink>
        </div>
      </div>
      
      {/* Drive Import Dialog - PO only */}
      <DriveImportProgressDialog
        open={showDriveDialog}
        onClose={(success) => {
          setShowDriveDialog(false);
          if (success) {
            // Invalidate PO and PR caches to refresh lists
            queryClient.invalidateQueries({ queryKey: ["purchase-orders"] });
            queryClient.invalidateQueries({ queryKey: ["draft-po-count"] });
            queryClient.invalidateQueries({ queryKey: ["payment-requests"] });
            queryClient.invalidateQueries({ queryKey: ["payment-stats"] });
          }
        }}
        importType="po"
      />
    </aside>
  );
}
