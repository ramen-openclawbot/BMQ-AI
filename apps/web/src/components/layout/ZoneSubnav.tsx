import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePaymentStats } from "@/hooks/usePaymentStats";
import { useDraftPOCount } from "@/hooks/usePurchaseOrders";
import { useKhoHoldCount } from "@/hooks/useKhoHolds";
import { cn } from "@/lib/utils";
import { isPageActive } from "./navigation";
import { useShellNav } from "./useShellNav";

/** Page chips for the current zone (or utility group), shown at the top of the content panel. */
export function ZoneSubnav() {
  const { t } = useLanguage();
  const { pathname, zones, utilities, activeZone, activeUtility, label } = useShellNav();
  const { data: paymentStats } = usePaymentStats();
  const { data: draftPOCount } = useDraftPOCount();
  const holdCount = useKhoHoldCount();
  const navRef = useRef<HTMLElement | null>(null);
  const [more, setMore] = useState<"start" | "end" | "both" | undefined>();

  // Which edges hide more chips; drives the edge fade in bmq-shell.css.
  const measure = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const start = nav.scrollLeft > 2;
    const end = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2;
    setMore(start && end ? "both" : start ? "start" : end ? "end" : undefined);
  }, []);

  // Bring the current page's chip into view on narrow screens, then measure.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const active = nav.querySelector<HTMLElement>(".d3-chip.is-active");
    if (active && nav.scrollWidth > nav.clientWidth) {
      nav.scrollLeft = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
    }
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [pathname, measure]);

  const current = activeZone
    ? zones.find(({ zone }) => zone.id === activeZone.id)
    : utilities.find(({ group }) => group === activeUtility);
  const pages = current?.pages ?? [];
  if (pages.length < 2) return null;

  const heading = activeZone ? label(activeZone.label) : activeUtility ? label(activeUtility.label) : "";
  const paths = pages.map((page) => page.path);

  return (
    <nav className="d3-subnav" aria-label={heading} ref={navRef} onScroll={measure} data-more={more}>
      {pages.map((page) => {
        const active = isPageActive(page.path, pathname, paths);
        const count = page.showBadge ? paymentStats?.pendingTotalCount || 0 : page.showPOBadge ? draftPOCount || 0 : page.showHoldBadge ? holdCount : 0;
        return (
          <Link
            key={page.path}
            to={page.path}
            className={cn("d3-chip", active && "is-active")}
            aria-current={active ? "page" : undefined}
          >
            <page.icon className="h-4 w-4" aria-hidden="true" />
            <span>{t[page.labelKey]}</span>
            {count > 0 && <span className={cn("d3-count", (page.showBadge || page.showHoldBadge) && "is-alert")}>{count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
