import { useEffect, useRef, useState } from "react";
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
  Tags,
  LucideIcon,
  PackageCheck,
  PackageSearch,
  ShoppingCart,
  Inbox,
  Scale,
  TrendingUp,
  UserRoundCog,
  FolderSearch,
  Shield,
  ServerCog,
  Database,
  Factory,
  CalendarClock,
  ClipboardCheck,
  Truck,
  BarChart4,
  ScanLine,
  Store,
  Wallet,
  Boxes,
  MessageCircle,
  X,
} from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { usePaymentStats } from "@/hooks/usePaymentStats";
import { useDraftPOCount } from "@/hooks/usePurchaseOrders";
import { DriveImportProgressDialog } from "@/components/payment-requests/DriveImportProgressDialog";
import bmqLogo from "@/assets/bmq-logo.png";
import { canViewNavItem } from "./navAccess";

export interface NavItem {
  icon: LucideIcon;
  labelKey: keyof ReturnType<typeof useLanguage>["t"];
  path?: string;
  section: "operations" | "finance" | "marketingSales" | "execution" | "production";
  showBadge?: boolean;
  showPOBadge?: boolean;
  /** Module key for permission filtering. If undefined, item is always visible. */
  moduleKey?: string;
  /** If true, only owners can see this item */
  ownerOnly?: boolean;
  dataPlatformOnly?: boolean;
  /** Kept routable but left out of the drawer and the top zones (unused pages, hidden 2026-10-10). */
  hiddenFromMenu?: boolean;
  /** Non-clickable children displayed as submenu links. */
  children?: NavItem[];
}

export const navItems: NavItem[] = [
  { icon: Database, labelKey: "dataSources", path: "/data-sources", section: "execution", ownerOnly: true, dataPlatformOnly: true },
  { icon: Shield, labelKey: "userManagement", path: "/user-management", section: "execution", ownerOnly: true, moduleKey: "user_management" },
  { icon: ServerCog, labelKey: "systemManagement", path: "/system-management", section: "execution", ownerOnly: true },
  { icon: LayoutDashboard, labelKey: "dashboard", path: "/", section: "execution", moduleKey: "dashboard" },

  {
    icon: Scale,
    labelKey: "financeCostManagement",
    section: "finance",
    moduleKey: "finance_cost",
    children: [
      // CEO khai báo replaced by Trình chi gấp (2026-10-07); route kept for history.
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
      { icon: Store, labelKey: "financePointRevenue", path: "/finance-control/revenue/points", section: "finance", moduleKey: "finance_revenue" },
      { icon: Wallet, labelKey: "financeDebtManagement", path: "/finance-control/revenue/debt", section: "finance", moduleKey: "finance_revenue" },
    ],
  },
  { icon: UserRoundCog, labelKey: "crm", path: "/mini-crm", section: "finance", moduleKey: "crm" },
  { icon: Inbox, labelKey: "poSales", path: "/sales-po-inbox", section: "finance", moduleKey: "sales_po_inbox" },
  { icon: ShoppingCart, labelKey: "poPurchasing", path: "/purchase-orders", section: "finance", showPOBadge: true, moduleKey: "purchase_orders" },

  {
    icon: MessageCircle,
    labelKey: "sectionMarketingSales",
    section: "marketingSales",
    children: [
      { icon: MessageCircle, labelKey: "facebookPageManagement", path: "/marketing-sales/facebook-page", section: "marketingSales", moduleKey: "facebook_messenger" },
    ],
  },

  {
    icon: Factory,
    labelKey: "productionPlanning",
    section: "production",
    moduleKey: "production_q7",
    children: [
      { icon: Factory, labelKey: "productionQ7", path: "/production/planning/q7", section: "production", moduleKey: "production_q7" },
      { icon: PackageSearch, labelKey: "q7MaterialInventory", path: "/production/q7/inventory", section: "production", moduleKey: "q7_material_inventory", hiddenFromMenu: true },
      { icon: Tags, labelKey: "productionProducts", path: "/production/products", section: "production", moduleKey: "production_products" },
    ],
  },
  { icon: CalendarClock, labelKey: "productionShifts", path: "/production/shifts", section: "production", moduleKey: "production_shifts" },
  { icon: ClipboardCheck, labelKey: "qaInspection", path: "/production/qa", section: "production", moduleKey: "production_qa" },

  { icon: ScanLine, labelKey: "attendance", path: "/attendance", section: "operations", moduleKey: "attendance" },
  { icon: Wallet, labelKey: "payroll", path: "/payroll", section: "operations", moduleKey: "payroll" },
  {
    icon: Package,
    labelKey: "inventory",
    section: "operations",
    children: [
      { icon: Package, labelKey: "inventoryOverview", path: "/inventory", section: "operations", moduleKey: "inventory", hiddenFromMenu: true },
      { icon: Boxes, labelKey: "tanTaoWarehouse", path: "/warehouse/tan-tao", section: "operations", moduleKey: "inventory" },
      { icon: CookingPot, labelKey: "kitchenInventory", path: "/kitchen-inventory", section: "operations", moduleKey: "kitchen_inventory", hiddenFromMenu: true },
      { icon: PackageCheck, labelKey: "goodsReceipts", path: "/goods-receipts", section: "operations", moduleKey: "goods_receipts" },
      { icon: Truck, labelKey: "warehouseDispatch", path: "/warehouse/dispatch", section: "operations", moduleKey: "inventory", hiddenFromMenu: true },
      { icon: BarChart4, labelKey: "stockReport", path: "/warehouse/stock-report", section: "operations", moduleKey: "inventory", hiddenFromMenu: true },
    ],
  },
  { icon: Barcode, labelKey: "skuCosts", path: "/sku-costs", section: "operations", moduleKey: "sku_costs" },
  { icon: Boxes, labelKey: "materialMaster", path: "/material-master", section: "operations", moduleKey: "material_master" },
  { icon: Users, labelKey: "suppliers", path: "/suppliers", section: "operations", moduleKey: "suppliers" },
  { icon: FileText, labelKey: "invoices", path: "/invoices", section: "operations", moduleKey: "invoices" },
  { icon: FileCheck, labelKey: "paymentRequests", path: "/payment-requests", section: "operations", showBadge: true, moduleKey: "payment_requests" },
  { icon: AlertTriangle, labelKey: "lowStock", path: "/low-stock", section: "operations", moduleKey: "low_stock", hiddenFromMenu: true },
];

const SIDEBAR_SCROLL_STORAGE_KEY = "bmq-sidebar-scroll-top";

/**
 * Demo 3 shell: the former left rail is now the "all functions" drawer.
 * It keeps every page, permission filter, badge and the Drive PO shortcut;
 * the grid button in the header and `bmq:open-sidebar` open it.
 */
export function Sidebar() {
  const { t, language } = useLanguage();
  const { pathname } = useLocation();
  const { isOwner, canAccessModule } = useAuth();
  const sectionLabels: Record<NavItem["section"], string> = {
    execution: t.sectionExecution,
    finance: t.sectionFinance,
    marketingSales: t.sectionMarketingSales,
    production: t.sectionProduction,
    operations: t.sectionOperations,
  };
  const queryClient = useQueryClient();
  const { data: paymentStats } = usePaymentStats();
  const { data: draftPOCount } = useDraftPOCount();
  const navRef = useRef<HTMLElement | null>(null);
  const restoreScrollFrameRef = useRef<number | null>(null);
  // The drawer is opened by events, not a Radix trigger, so remember who opened it.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const [showDriveDialog, setShowDriveDialog] = useState(false);
  // Closed drawer == collapsed. Every viewport starts closed; there is no rail.
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    const openSidebar = () => {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setCollapsed(false);
      restoreSidebarScroll();
    };
    window.addEventListener("bmq:open-sidebar", openSidebar);
    return () => window.removeEventListener("bmq:open-sidebar", openSidebar);
  }, []);

  useEffect(() => {
    if (!collapsed) restoreSidebarScroll();

    return () => {
      if (restoreScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreScrollFrameRef.current);
        restoreScrollFrameRef.current = null;
      }
    };
  }, [collapsed, pathname]);

  useEffect(() => {
    // Pages laid out against the old rail read this; the top-nav shell has none.
    document.documentElement.style.setProperty("--sidebar-width", "0rem");
  }, []);

  // Badge shows pending approval count
  const badgeCount = paymentStats?.pendingCount || 0;

  const handleScanDrive = () => {
    setCollapsed(true);
    setShowDriveDialog(true);
  };

  const restoreSidebarScroll = () => {
    if (typeof window === "undefined") return;
    if (restoreScrollFrameRef.current !== null) window.cancelAnimationFrame(restoreScrollFrameRef.current);

    restoreScrollFrameRef.current = window.requestAnimationFrame(() => {
      const nav = navRef.current;
      if (!nav) return;

      const selectedItem = nav.querySelector<HTMLElement>('[data-sidebar-active="true"], [aria-current="page"]');
      if (selectedItem) {
        const navRect = nav.getBoundingClientRect();
        const itemRect = selectedItem.getBoundingClientRect();
        const isVisible = itemRect.top >= navRect.top && itemRect.bottom <= navRect.bottom;

        if (!isVisible) {
          selectedItem.scrollIntoView({ block: "center" });
        }
      } else {
        const savedScroll = Number(window.sessionStorage.getItem(SIDEBAR_SCROLL_STORAGE_KEY) || "0");
        if (Number.isFinite(savedScroll)) nav.scrollTop = savedScroll;
      }

      restoreScrollFrameRef.current = null;
    });
  };

  const rememberSidebarScroll = () => {
    const nav = navRef.current;
    if (!nav || typeof window === "undefined") return;
    window.sessionStorage.setItem(SIDEBAR_SCROLL_STORAGE_KEY, String(nav.scrollTop));
  };

  const canViewItem = (item: NavItem) =>
    canViewNavItem(item, {
      isOwner,
      canAccessModule,
      dataPlatformEnabled: import.meta.env.VITE_BMQ_DATA_PLATFORM_ENABLED === "true",
    });

  const isChildActive = (child: NavItem) => {
    if (!child.path) return false;
    if (child.path === "/finance-control/revenue") {
      return pathname === child.path || (
        pathname.startsWith("/finance-control/revenue/") &&
        !pathname.startsWith("/finance-control/revenue/points") &&
        !pathname.startsWith("/finance-control/revenue/debt")
      );
    }
    return pathname === child.path;
  };

  // Filter nav items by permission. Parent groups remain visible when any child is visible.
  const visibleItems = navItems
    .filter((item) => !item.hiddenFromMenu)
    .map((item) => item.children ? { ...item, children: item.children.filter((child) => !child.hiddenFromMenu && canViewItem(child)) } : item)
    .filter((item) => (item.children ? item.children.length > 0 : canViewItem(item)));

  const closeAfterNavigate = () => {
    rememberSidebarScroll();
    setCollapsed(true);
  };

  const renderBadges = (item: NavItem) => (
    <>
      {item.showBadge && badgeCount > 0 && (
        <span className="d3-count is-alert" aria-label={`${badgeCount} ${language === "en" ? "pending" : "chờ duyệt"}`}>{badgeCount}</span>
      )}
      {item.showPOBadge && draftPOCount && draftPOCount > 0 && (
        <span className="d3-count" aria-label={`${draftPOCount} ${language === "en" ? "draft POs" : "PO nháp"}`}>{draftPOCount}</span>
      )}
    </>
  );

  return (
    <>
      <DialogPrimitive.Root open={!collapsed} onOpenChange={(open) => setCollapsed(!open)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="d3-drawer-scrim" />
          <DialogPrimitive.Content
            className="d3-drawer"
            data-bmq-app-drawer="demo3-v1"
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              const opener = returnFocusRef.current;
              returnFocusRef.current = null;
              if (opener?.isConnected) {
                event.preventDefault();
                opener.focus();
              }
            }}
          >
            <div className="d3-drawer-head">
              <img src={bmqLogo} alt="BMQ Logo" className="d3-drawer-logo" />
              <DialogPrimitive.Title className="d3-drawer-title">
                {language === "en" ? "All functions" : "Tất cả chức năng"}
                <small>BMQ AI</small>
              </DialogPrimitive.Title>
              <DialogPrimitive.Close className="d3-icon-btn" aria-label={language === "en" ? "Close" : "Đóng"}>
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>

            <nav ref={navRef} onScroll={rememberSidebarScroll} className="d3-drawer-nav">
              {visibleItems.map((item, idx) => {
                const prevItem = idx > 0 ? visibleItems[idx - 1] : null;
                const showSectionHeader = !prevItem || prevItem.section !== item.section;
                return (
                  <div key={item.path || item.labelKey}>
                    {showSectionHeader && <div className="d3-drawer-section">{sectionLabels[item.section]}</div>}

                    {item.children ? (
                      <div className="d3-drawer-group">
                        <div className="d3-drawer-group-label">
                          <item.icon className="h-4 w-4" aria-hidden="true" />
                          <span>{t[item.labelKey]}</span>
                        </div>
                        {item.children.map((child) => {
                          const childActive = isChildActive(child);
                          return (
                            <NavLink
                              key={child.path}
                              to={child.path || "#"}
                              data-sidebar-active={childActive ? "true" : undefined}
                              onClick={closeAfterNavigate}
                              className={cn("d3-drawer-link is-child", childActive && "is-active")}
                            >
                              <child.icon className="h-4 w-4" aria-hidden="true" />
                              <span>{t[child.labelKey]}</span>
                            </NavLink>
                          );
                        })}
                      </div>
                    ) : (
                      <NavLink
                        to={item.path || "#"}
                        end={item.path === "/"}
                        onClick={closeAfterNavigate}
                        className={({ isActive }) => cn("d3-drawer-link", isActive && "is-active")}
                      >
                        <item.icon className="h-4 w-4" aria-hidden="true" />
                        <span>{t[item.labelKey]}</span>
                        {renderBadges(item)}
                      </NavLink>
                    )}

                    {/* Quick Action: Tạo PO từ GG Drive - under Purchase Orders */}
                    {item.path === "/purchase-orders" && (
                      <button type="button" onClick={handleScanDrive} className="d3-drawer-link is-child is-action">
                        <FolderSearch className="h-4 w-4" aria-hidden="true" />
                        <span>{t.createPOFromDrive}</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </nav>

            <div className="d3-drawer-foot">
              <NavLink
                to="/settings"
                onClick={closeAfterNavigate}
                className={({ isActive }) => cn("d3-drawer-link", isActive && "is-active")}
              >
                <Settings className="h-4 w-4" aria-hidden="true" />
                <span>{t.settings}</span>
              </NavLink>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

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
    </>
  );
}
