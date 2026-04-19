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
  Inbox,
  BarChart3,
  Landmark,
  Scale,
  TrendingUp,
  UserRoundCog,
  FolderSearch,
  ChevronLeft,
  ChevronRight,
  Shield,
  ServerCog,
  Factory,
  CalendarClock,
  ClipboardCheck,
  Truck,
  BarChart4,
  ScanLine,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { usePaymentStats } from "@/hooks/usePaymentStats";
import { useDraftPOCount } from "@/hooks/usePurchaseOrders";
import { Badge } from "@/components/ui/badge";
import { DriveImportProgressDialog } from "@/components/payment-requests/DriveImportProgressDialog";
import bmqLogo from "@/assets/bmq-logo.png";

interface NavItem {
  icon: LucideIcon;
  labelKey: keyof ReturnType<typeof useLanguage>["t"];
  path: string;
  section: "operations" | "finance" | "execution" | "production";
  showBadge?: boolean;
  showPOBadge?: boolean;
  /** Module key for permission filtering. If undefined, item is always visible. */
  moduleKey?: string;
  /** If true, only owners can see this item */
  ownerOnly?: boolean;
}

const navItems: NavItem[] = [
  { icon: Shield, labelKey: "userManagement", path: "/user-management", section: "execution", ownerOnly: true, moduleKey: "user_management" },
  { icon: ServerCog, labelKey: "systemManagement", path: "/system-management", section: "execution", ownerOnly: true },
  { icon: Landmark, labelKey: "investorDashboard", path: "/niraan-dashboard", section: "execution", moduleKey: "niraan_dashboard" },
  { icon: LayoutDashboard, labelKey: "dashboard", path: "/", section: "execution", moduleKey: "dashboard" },
  { icon: BarChart3, labelKey: "reports", path: "/reports", section: "execution", moduleKey: "reports" },

  { icon: Scale, labelKey: "financeCostManagement", path: "/finance-control/cost", section: "finance", moduleKey: "finance_cost" },
  { icon: TrendingUp, labelKey: "financeRevenueManagement", path: "/finance-control/revenue", section: "finance", moduleKey: "finance_revenue" },
  { icon: UserRoundCog, labelKey: "crm", path: "/mini-crm", section: "finance", moduleKey: "crm" },
  { icon: Inbox, labelKey: "poSales", path: "/sales-po-inbox", section: "finance", moduleKey: "sales_po_inbox" },
  { icon: ShoppingCart, labelKey: "poPurchasing", path: "/purchase-orders", section: "finance", showPOBadge: true, moduleKey: "purchase_orders" },

  { icon: Factory, labelKey: "productionPlanning", path: "/production/planning", section: "production", moduleKey: "production" },
  { icon: CalendarClock, labelKey: "productionShifts", path: "/production/shifts", section: "production", moduleKey: "production" },
  { icon: ClipboardCheck, labelKey: "qaInspection", path: "/production/qa", section: "production", moduleKey: "production" },

  { icon: ScanLine, labelKey: "attendance", path: "/attendance", section: "operations", moduleKey: "attendance" },
  { icon: Wallet, labelKey: "payroll", path: "/payroll", section: "operations", moduleKey: "payroll" },
  { icon: Package, labelKey: "inventory", path: "/inventory", section: "operations", moduleKey: "inventory" },
  { icon: PackageCheck, labelKey: "goodsReceipts", path: "/goods-receipts", section: "operations", moduleKey: "goods_receipts" },
  { icon: Truck, labelKey: "warehouseDispatch", path: "/warehouse/dispatch", section: "operations", moduleKey: "inventory" },
  { icon: BarChart4, labelKey: "stockReport", path: "/warehouse/stock-report", section: "operations", moduleKey: "inventory" },
  { icon: Barcode, labelKey: "skuCosts", path: "/sku-costs", section: "operations", moduleKey: "sku_costs" },
  { icon: Users, labelKey: "suppliers", path: "/suppliers", section: "operations", moduleKey: "suppliers" },
  { icon: FileText, labelKey: "invoices", path: "/invoices", section: "operations", moduleKey: "invoices" },
  { icon: FileCheck, labelKey: "paymentRequests", path: "/payment-requests", section: "operations", showBadge: true, moduleKey: "payment_requests" },
  { icon: AlertTriangle, labelKey: "lowStock", path: "/low-stock", section: "operations", moduleKey: "low_stock" },
];

export function Sidebar() {
  const { t } = useLanguage();
  const { isOwner, canAccessModule } = useAuth();
  const sectionLabels: Record<NavItem["section"], string> = {
    execution: t.sectionExecution,
    finance: t.sectionFinance,
    production: t.sectionProduction,
    operations: t.sectionOperations,
  };
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

  // Filter nav items by permission
  const visibleItems = navItems.filter((item) => {
    if (item.ownerOnly && !isOwner) return false;
    if (item.moduleKey && !item.ownerOnly) return canAccessModule(item.moduleKey);
    return true;
  });

  return (
    <aside className={cn(
      "fixed left-0 top-0 z-40 h-dvh bg-sidebar border-r border-sidebar-border transition-all duration-200",
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
        <nav className="flex-1 px-4 py-6 pb-24 space-y-1 overflow-y-auto">
          {visibleItems.map((item, idx) => {
            const prevItem = idx > 0 ? visibleItems[idx - 1] : null;
            const showSectionHeader = !prevItem || prevItem.section !== item.section;
            return (
              <div key={item.path}>
                {!collapsed && showSectionHeader && (
                  <div className="pt-4 first:pt-0">
                    {idx !== 0 && <div className="mx-4 mb-3 border-t border-sidebar-border/70" />}
                    <div className="px-4 pb-1 text-[11px] uppercase tracking-[0.08em] text-sidebar-foreground/45 font-semibold">
                      {sectionLabels[item.section]}
                    </div>
                  </div>
                )}

                <NavLink
                  to={item.path}
                  className={({ isActive }) =>
                    cn(
                      "group relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-200 border border-transparent",
                      isActive
                        ? "bg-sidebar-accent/80 text-sidebar-primary font-semibold border-sidebar-border/80 shadow-sm"
                        : "text-sidebar-foreground/75 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground"
                    )
                  }
                >
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-accent/30 group-hover:bg-sidebar-accent/50 transition-colors">
                    <item.icon className="h-4 w-4" />
                  </span>
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
                  <div className="ml-10 mt-1">
                    <button
                      onClick={handleScanDrive}
                      className="flex items-center gap-1.5 text-xs text-blue-500/90 hover:text-blue-500 px-3 py-1.5 w-full rounded-md hover:bg-sidebar-accent/30 transition-colors"
                    >
                      <FolderSearch className="h-3 w-3" />
                      <span>{t.createPOFromDrive}</span>
                    </button>
                  </div>
                )}

                {item.path === "/sku-costs" && !collapsed && (
                  <div className="ml-10 mt-2 space-y-1">
                    <NavLink to="/sku-costs/dashboard" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground px-3 py-1.5 w-full rounded-md hover:bg-sidebar-accent/30 transition-colors">{t.skuCostDashboard}</NavLink>
                    <NavLink to="/sku-costs/management" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground px-3 py-1.5 w-full rounded-md hover:bg-sidebar-accent/30 transition-colors">{t.skuCostManagement}</NavLink>
                    <NavLink to="/sku-costs/analysis" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground px-3 py-1.5 w-full rounded-md hover:bg-sidebar-accent/30 transition-colors">{t.skuCostAnalysis}</NavLink>
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Settings */}
        <div className="px-4 py-4 border-t border-sidebar-border pb-[max(1rem,env(safe-area-inset-bottom))] bg-sidebar/95 backdrop-blur supports-[backdrop-filter]:bg-sidebar/80">
          <NavLink
            to="/settings"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-foreground/75 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground transition-all duration-200"
          >
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-accent/30">
              <Settings className="h-4 w-4" />
            </span>
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
