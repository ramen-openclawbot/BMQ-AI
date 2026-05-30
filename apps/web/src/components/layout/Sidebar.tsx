import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard,
  Package,
  CookingPot,
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
  path?: string;
  section: "operations" | "finance" | "execution" | "production";
  showBadge?: boolean;
  showPOBadge?: boolean;
  /** Module key for permission filtering. If undefined, item is always visible. */
  moduleKey?: string;
  /** If true, only owners can see this item */
  ownerOnly?: boolean;
  /** Non-clickable children displayed as submenu links. */
  children?: NavItem[];
}

const navItems: NavItem[] = [
  { icon: Shield, labelKey: "userManagement", path: "/user-management", section: "execution", ownerOnly: true, moduleKey: "user_management" },
  { icon: ServerCog, labelKey: "systemManagement", path: "/system-management", section: "execution", ownerOnly: true },
  { icon: LayoutDashboard, labelKey: "dashboard", path: "/", section: "execution", moduleKey: "dashboard" },

  {
    icon: Scale,
    labelKey: "financeCostManagement",
    section: "finance",
    moduleKey: "finance_cost",
    children: [
      { icon: CalendarClock, labelKey: "financeCeoDeclaration", path: "/finance-control/ceo-declaration", section: "finance", moduleKey: "finance_cost" },
      { icon: ClipboardCheck, labelKey: "financeCostClassification", path: "/finance-control/classification", section: "finance", moduleKey: "finance_cost" },
      { icon: FileCheck, labelKey: "financePayablesManagement", path: "/finance-control/payables", section: "finance", moduleKey: "payment_requests" },
    ],
  },
  {
    icon: TrendingUp,
    labelKey: "financeRevenueManagement",
    section: "finance",
    moduleKey: "finance_revenue",
    children: [
      { icon: TrendingUp, labelKey: "financeRevenueManagement", path: "/finance-control/revenue", section: "finance", moduleKey: "finance_revenue" },
      { icon: Wallet, labelKey: "financeDebtManagement", path: "/finance-control/revenue/debt", section: "finance", moduleKey: "finance_revenue" },
    ],
  },
  { icon: UserRoundCog, labelKey: "crm", path: "/mini-crm", section: "finance", moduleKey: "crm" },
  { icon: Inbox, labelKey: "poSales", path: "/sales-po-inbox", section: "finance", moduleKey: "sales_po_inbox" },
  { icon: ShoppingCart, labelKey: "poPurchasing", path: "/purchase-orders", section: "finance", showPOBadge: true, moduleKey: "purchase_orders" },

  {
    icon: Factory,
    labelKey: "productionPlanning",
    section: "production",
    moduleKey: "production_q7",
    children: [
      { icon: Factory, labelKey: "productionQ7", path: "/production/planning/q7", section: "production", moduleKey: "production_q7" },
    ],
  },
  { icon: CalendarClock, labelKey: "productionShifts", path: "/production/shifts", section: "production", moduleKey: "production" },
  { icon: ClipboardCheck, labelKey: "qaInspection", path: "/production/qa", section: "production", moduleKey: "production" },

  { icon: ScanLine, labelKey: "attendance", path: "/attendance", section: "operations", moduleKey: "attendance" },
  { icon: Wallet, labelKey: "payroll", path: "/payroll", section: "operations", moduleKey: "payroll" },
  { icon: Package, labelKey: "inventory", path: "/inventory", section: "operations", moduleKey: "inventory" },
  { icon: CookingPot, labelKey: "kitchenInventory", path: "/kitchen-inventory", section: "operations", moduleKey: "kitchen_inventory" },
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
  const { pathname } = useLocation();
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
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 767px)").matches : false
  );
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 767px)").matches : false
  );

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const syncMobileState = () => {
      setIsMobile(media.matches);
      setCollapsed(media.matches);
    };

    syncMobileState();
    media.addEventListener("change", syncMobileState);
    return () => media.removeEventListener("change", syncMobileState);
  }, []);

  useEffect(() => {
    const openSidebar = () => setCollapsed(false);
    window.addEventListener("bmq:open-sidebar", openSidebar);
    return () => window.removeEventListener("bmq:open-sidebar", openSidebar);
  }, []);

  useEffect(() => {
    const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
    const width = isMobile ? "0rem" : collapsed ? "4rem" : "16rem";
    document.documentElement.style.setProperty("--sidebar-width", width);
  }, [collapsed]);

  // Badge shows pending approval count
  const badgeCount = paymentStats?.pendingCount || 0;

  const handleScanDrive = () => {
    setShowDriveDialog(true);
  };

  const canViewItem = (item: NavItem) => {
    if (item.ownerOnly && !isOwner) return false;
    if (item.moduleKey && !item.ownerOnly) return canAccessModule(item.moduleKey);
    return true;
  };

  const isChildActive = (child: NavItem) => {
    if (!child.path) return false;
    if (child.path === "/finance-control/revenue") {
      return pathname === child.path || (
        pathname.startsWith("/finance-control/revenue/") &&
        !pathname.startsWith("/finance-control/revenue/debt")
      );
    }
    return pathname === child.path;
  };

  // Filter nav items by permission. Parent groups remain visible when any child is visible.
  const visibleItems = navItems
    .map((item) => item.children ? { ...item, children: item.children.filter(canViewItem) } : item)
    .filter((item) => (item.children ? item.children.length > 0 : canViewItem(item)));

  return (
    <>
      {isMobile && !collapsed && (
        <button
          type="button"
          aria-label="Đóng sidebar"
          className="fixed inset-0 z-30 bg-black/45 md:hidden"
          onClick={() => setCollapsed(true)}
        />
      )}
      <aside
        data-stitch-mobile-sidebar="compact-readable"
        className={cn(
        "fixed left-0 top-0 z-40 h-dvh border-r border-sidebar-border/60 bg-sidebar/70 shadow-card backdrop-blur-xl transition-all duration-200",
        collapsed ? "-translate-x-full w-16 md:translate-x-0" : "w-64"
      )}>
      <div className="flex h-full flex-col">
        {/* Logo */}
        <div className={cn("flex items-center gap-3 border-b border-sidebar-border", collapsed ? "px-3 py-4" : "px-4 py-3 md:px-6 md:py-5")}>
          <img src={bmqLogo} alt="BMQ Logo" className={cn("h-10 w-auto", collapsed ? "mx-auto" : "h-10 md:h-12")} />
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
        <nav className="font-sidebar flex-1 space-y-0.5 overflow-y-auto px-3 py-3 pb-20 md:space-y-1 md:px-4 md:py-6 md:pb-24">
          {visibleItems.map((item, idx) => {
            const prevItem = idx > 0 ? visibleItems[idx - 1] : null;
            const showSectionHeader = !prevItem || prevItem.section !== item.section;
            return (
              <div key={item.path || item.labelKey}>
                {!collapsed && showSectionHeader && (
                  <div className="pt-2.5 first:pt-0 md:pt-4">
                    {idx !== 0 && <div className="mx-3 mb-2 border-t border-sidebar-border/70 md:mx-4 md:mb-3" />}
                    <div className="px-3 pb-1 text-[10px] font-extrabold uppercase tracking-[0.08em] text-white/80 drop-shadow-[0_1px_1px_rgba(0,0,0,0.45)] md:px-4 md:text-[11px] md:font-bold md:text-white/70 md:drop-shadow-none">
                      {sectionLabels[item.section]}
                    </div>
                  </div>
                )}

                {item.children ? (
                  <div>
                    <div className="group relative flex h-10 items-center gap-2.5 rounded-lg border border-transparent px-3 text-[13px] font-extrabold text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.55)] md:h-auto md:gap-3 md:py-2.5 md:text-sm md:font-bold md:text-white md:drop-shadow-none">
                      <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-sidebar-accent/30 transition-colors md:h-8 md:w-8">
                        <item.icon className="h-4 w-4" />
                      </span>
                      {!collapsed && <span className="flex-1">{t[item.labelKey]}</span>}
                    </div>
                    {!collapsed && (
                      <div className="ml-8 mt-0.5 space-y-0.5 md:ml-10 md:mt-1 md:space-y-1">
                        {item.children.map((child) => {
                          const childActive = isChildActive(child);
                          return (
                            <NavLink
                              key={child.path}
                              to={child.path || "#"}
                              onClick={() => {
                                if (window.matchMedia("(max-width: 767px)").matches) setCollapsed(true);
                              }}
                              className={cn(
                                "relative flex h-9 items-center gap-2 rounded-md px-3 text-[13px] font-extrabold text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.55)] transition-colors md:h-auto md:py-1.5 md:text-sm md:font-bold md:text-white md:drop-shadow-none",
                                childActive
                                  ? "bg-sidebar-accent/85 text-black md:text-black before:absolute before:left-0 before:top-1.5 before:h-6 before:w-0.5 before:rounded-full before:bg-black md:before:hidden"
                                  : "hover:bg-sidebar-accent/30 hover:text-white"
                              )}
                            >
                              <child.icon className="h-3.5 w-3.5" />
                              <span>{t[child.labelKey]}</span>
                            </NavLink>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <NavLink
                    to={item.path || "#"}
                    onClick={() => {
                      if (window.matchMedia("(max-width: 767px)").matches) setCollapsed(true);
                    }}
                    className={({ isActive }) =>
                      cn(
                        "group relative flex h-10 items-center gap-2.5 rounded-lg border border-transparent px-3 text-[13px] font-extrabold text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.55)] transition-all duration-200 md:h-auto md:gap-3 md:py-2.5 md:text-sm md:font-bold md:text-white md:drop-shadow-none",
                        isActive
                          ? "bg-sidebar-accent/85 text-black md:text-black border-sidebar-border/80 shadow-sm before:absolute before:left-0 before:top-2 before:h-6 before:w-0.5 before:rounded-full before:bg-black md:before:hidden"
                          : "hover:bg-sidebar-accent/40 hover:text-white"
                      )
                    }
                  >
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-sidebar-accent/30 transition-colors group-hover:bg-sidebar-accent/50 md:h-8 md:w-8">
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
                )}

                {/* Quick Action: Tạo PO từ GG Drive - under Purchase Orders */}
                {item.path === "/purchase-orders" && !collapsed && (
                  <div className="ml-8 mt-0.5 md:ml-10 md:mt-1">
                    <button
                      onClick={handleScanDrive}
                      className="flex h-8 w-full items-center gap-1.5 rounded-md px-3 text-xs font-extrabold text-white/95 drop-shadow-[0_1px_1px_rgba(0,0,0,0.5)] transition-colors hover:bg-sidebar-accent/30 hover:text-white md:h-auto md:py-1.5 md:font-bold md:drop-shadow-none"
                    >
                      <FolderSearch className="h-3 w-3" />
                      <span>{t.createPOFromDrive}</span>
                    </button>
                  </div>
                )}

              </div>
            );
          })}
        </nav>

        {/* Settings */}
        <div className="border-t border-sidebar-border/60 bg-sidebar/60 px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-xl md:px-4 md:py-4 md:pb-[max(1rem,env(safe-area-inset-bottom))]">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(
                "relative flex h-10 items-center gap-2.5 rounded-lg px-3 text-[13px] font-extrabold text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.55)] transition-all duration-200 hover:bg-sidebar-accent/40 hover:text-white md:h-auto md:gap-3 md:py-2.5 md:text-sm md:font-bold md:text-white md:drop-shadow-none",
                isActive && "bg-sidebar-accent/85 text-black md:text-black shadow-sm hover:text-black"
              )
            }
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-sidebar-accent/30 md:h-8 md:w-8">
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
    </>
  );
}
