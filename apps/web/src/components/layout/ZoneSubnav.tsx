import { Link } from "react-router-dom";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePaymentStats } from "@/hooks/usePaymentStats";
import { useDraftPOCount } from "@/hooks/usePurchaseOrders";
import { cn } from "@/lib/utils";
import { isPageActive } from "./navigation";
import { useShellNav } from "./useShellNav";

/** Page chips for the current zone (or utility group), shown at the top of the content panel. */
export function ZoneSubnav() {
  const { t } = useLanguage();
  const { pathname, zones, utilities, activeZone, activeUtility, label } = useShellNav();
  const { data: paymentStats } = usePaymentStats();
  const { data: draftPOCount } = useDraftPOCount();

  const current = activeZone
    ? zones.find(({ zone }) => zone.id === activeZone.id)
    : utilities.find(({ group }) => group === activeUtility);
  const pages = current?.pages ?? [];
  if (pages.length < 2) return null;

  const heading = activeZone ? label(activeZone.label) : activeUtility ? label(activeUtility.label) : "";
  const paths = pages.map((page) => page.path);

  return (
    <nav className="d3-subnav" aria-label={heading}>
      {pages.map((page) => {
        const active = isPageActive(page.path, pathname, paths);
        const count = page.showBadge ? paymentStats?.pendingCount || 0 : page.showPOBadge ? draftPOCount || 0 : 0;
        return (
          <Link
            key={page.path}
            to={page.path}
            className={cn("d3-chip", active && "is-active")}
            aria-current={active ? "page" : undefined}
          >
            <page.icon className="h-4 w-4" aria-hidden="true" />
            <span>{t[page.labelKey]}</span>
            {count > 0 && <span className={cn("d3-count", page.showBadge && "is-alert")}>{count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
