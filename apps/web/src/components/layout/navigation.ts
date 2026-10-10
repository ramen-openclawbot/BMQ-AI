import { Settings, type LucideIcon } from "lucide-react";
import { navItems, type NavItem } from "./Sidebar";
import { canViewNavItem, type NavAccess } from "./navAccess";

/**
 * Demo 3 shell: six top-level zones plus a utilities menu.
 * Pages, labels and permission keys come from the Sidebar's navItems so the
 * routes and module checks stay single-sourced; this file only groups them.
 */
export type ZoneId = "overview" | "sales" | "production" | "warehouse" | "approvals" | "ai";

export interface ShellPage {
  path: string;
  icon: LucideIcon;
  labelKey: NavItem["labelKey"];
  moduleKey?: string;
  ownerOnly?: boolean;
  dataPlatformOnly?: boolean;
  showBadge?: boolean;
  showPOBadge?: boolean;
}

export interface Zone {
  id: ZoneId;
  label: { vi: string; en: string };
  /** Pages in display order. The first visible one is the zone's landing page. */
  paths: string[];
  /** Route prefixes owned by the zone, used to highlight it on deep links. */
  prefixes: string[];
}

export interface UtilityGroup {
  label: { vi: string; en: string };
  paths: string[];
  prefixes: string[];
}

const SETTINGS_PAGE: ShellPage = { path: "/settings", icon: Settings, labelKey: "settings" };

const PAGES: Map<string, ShellPage> = (() => {
  const pages = new Map<string, ShellPage>();
  const add = (item: NavItem) => {
    if (item.path) {
      pages.set(item.path, {
        path: item.path,
        icon: item.icon,
        labelKey: item.labelKey,
        moduleKey: item.moduleKey,
        ownerOnly: item.ownerOnly,
        dataPlatformOnly: item.dataPlatformOnly,
        showBadge: item.showBadge,
        showPOBadge: item.showPOBadge,
      });
    }
    item.children?.forEach(add);
  };
  navItems.forEach(add);
  pages.set(SETTINGS_PAGE.path, SETTINGS_PAGE);
  return pages;
})();

export const ZONES: Zone[] = [
  { id: "overview", label: { vi: "Tổng quan", en: "Overview" }, paths: ["/"], prefixes: [] },
  {
    id: "sales",
    label: { vi: "Bán hàng", en: "Sales" },
    paths: [
      "/finance-control/revenue",
      "/finance-control/revenue/points",
      "/finance-control/revenue/debt",
      "/mini-crm",
      "/sales-po-inbox",
    ],
    prefixes: ["/finance-control/revenue", "/mini-crm", "/sales-po-inbox"],
  },
  {
    id: "production",
    label: { vi: "Sản xuất", en: "Production" },
    paths: [
      "/production/planning/q7",
      "/production/shifts",
      "/production/qa",
      "/production/products",
      // Kho NVL Q7 hidden from the menu 2026-10-10 (no entries in 30 days); the route still works.
    ],
    prefixes: ["/production"],
  },
  {
    id: "warehouse",
    label: { vi: "Kho", en: "Warehouse" },
    paths: [
      // Tồn kho, Kho bếp, Xuất kho, Báo cáo tồn kho and Tồn thấp hidden from the menu 2026-10-10
      // (no entries in 30 days); their routes still work and stay under this zone's prefixes.
      "/warehouse/stock-ledger",
      "/warehouse/auto-purchase",
      "/warehouse/tan-tao",
      "/goods-receipts",
      "/purchase-orders",
    ],
    prefixes: ["/inventory", "/warehouse", "/kitchen-inventory", "/goods-receipts", "/low-stock", "/purchase-orders"],
  },
  {
    id: "approvals",
    label: { vi: "Duyệt chi", en: "Approvals" },
    paths: [
      "/payment-requests",
      "/finance-control/payables",
      // CEO khai báo removed 2026-10-10 (its URL redirects to Duyệt chi).
      "/finance-control/classification",
    ],
    prefixes: [
      "/payment-requests",
      "/finance-control/payables",
      "/finance-control/ceo-declaration",
      "/finance-control/classification",
      "/finance-control/cost",
    ],
  },
  // "Hỏi AI" opens the existing VNAgent chat instead of navigating.
  { id: "ai", label: { vi: "Hỏi AI", en: "Ask AI" }, paths: [], prefixes: [] },
];

export const UTILITY_GROUPS: UtilityGroup[] = [
  {
    label: { vi: "Danh mục & chứng từ", en: "Catalogue & documents" },
    paths: ["/suppliers", "/invoices", "/material-master", "/sku-costs"],
    prefixes: ["/suppliers", "/invoices", "/material-master", "/sku-costs"],
  },
  {
    label: { vi: "Nhân sự", en: "People" },
    paths: ["/attendance", "/payroll"],
    prefixes: ["/attendance", "/payroll"],
  },
  {
    label: { vi: "Marketing", en: "Marketing" },
    paths: ["/marketing-sales/facebook-page"],
    prefixes: ["/marketing-sales"],
  },
  {
    label: { vi: "Hệ thống", en: "System" },
    paths: ["/settings", "/user-management", "/system-management", "/data-sources"],
    prefixes: ["/settings", "/user-management", "/system-management", "/data-sources"],
  },
];

export function getPage(path: string): ShellPage | undefined {
  return PAGES.get(path);
}

export function visiblePages(paths: string[], access: NavAccess): ShellPage[] {
  return paths
    .map((path) => PAGES.get(path))
    .filter((page): page is ShellPage => Boolean(page && canViewNavItem(page, access)));
}

const matchesPrefix = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** The zone that owns the current route, or null for utility pages / unknown routes. */
export function zoneForPath(pathname: string): Zone | null {
  if (pathname === "/") return ZONES[0];
  let best: { zone: Zone; length: number } | null = null;
  for (const zone of ZONES) {
    for (const prefix of zone.prefixes) {
      if (matchesPrefix(pathname, prefix) && (!best || prefix.length > best.length)) {
        best = { zone, length: prefix.length };
      }
    }
  }
  return best?.zone ?? null;
}

export function utilityGroupForPath(pathname: string): UtilityGroup | null {
  return UTILITY_GROUPS.find((group) => group.prefixes.some((prefix) => matchesPrefix(pathname, prefix))) ?? null;
}

/**
 * Whether a page link is the current page. A parent path stays active on its own
 * detail routes, except where a sibling link owns the deeper path
 * (revenue vs. its points/debt pages).
 */
export function isPageActive(pagePath: string, pathname: string, siblings: string[]): boolean {
  if (pagePath === "/") return pathname === "/";
  if (!matchesPrefix(pathname, pagePath)) return false;
  return !siblings.some(
    (other) => other !== pagePath && other.length > pagePath.length && matchesPrefix(other, pagePath) && matchesPrefix(pathname, other),
  );
}
