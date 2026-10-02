import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell, FileCheck, LayoutGrid, LogOut, Search, Settings, ShoppingCart, Sparkles } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { usePaymentStats } from "@/hooks/usePaymentStats";
import { useDraftPOCount } from "@/hooks/usePurchaseOrders";
import { cn } from "@/lib/utils";
import bmqLogo from "@/assets/bmq-logo.png";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { canViewNavItem } from "./navAccess";
import { getPage } from "./navigation";
import { ShellSearch } from "./ShellSearch";
import { openAgentChat, openAppDrawer, useShellNav } from "./useShellNav";

export function Header() {
  const { user, profile, signOut, isOwner } = useAuth();
  const { t, language, setLanguage } = useLanguage();
  const navigate = useNavigate();
  const { zones, activeZone, access, label } = useShellNav();
  const [searchOpen, setSearchOpen] = useState(false);

  const displayName = profile?.full_name || user?.user_metadata?.full_name || user?.email?.split("@")[0] || "User";
  const initials = displayName.charAt(0).toUpperCase();
  const en = language === "en";

  // Notifications are real counts only: pending approvals and draft POs the user may open.
  const { data: paymentStats } = usePaymentStats();
  const { data: draftPOCount } = useDraftPOCount();
  const paymentPage = getPage("/payment-requests");
  const poPage = getPage("/purchase-orders");
  const notices = [
    paymentPage && canViewNavItem(paymentPage, access)
      ? { key: "payments", icon: FileCheck, count: paymentStats?.pendingCount || 0, text: en ? "Payment requests awaiting approval" : "Phiếu đề nghị chi chờ duyệt", to: "/payment-requests" }
      : null,
    poPage && canViewNavItem(poPage, access)
      ? { key: "po", icon: ShoppingCart, count: draftPOCount || 0, text: en ? "Draft purchase orders" : "PO mua hàng đang nháp", to: "/purchase-orders" }
      : null,
  ].filter((notice): notice is NonNullable<typeof notice> => Boolean(notice));
  const unread = notices.reduce((sum, notice) => sum + notice.count, 0);

  // Sliding pill under the active zone tab.
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  const measure = useCallback(() => {
    const tabs = tabsRef.current;
    const active = tabs?.querySelector<HTMLElement>('[data-zone-active="true"]');
    if (!tabs || !active) {
      setIndicator(null);
      return;
    }
    setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
  }, []);

  useLayoutEffect(() => {
    measure();
    const tabs = tabsRef.current;
    const active = tabs?.querySelector<HTMLElement>('[data-zone-active="true"]');
    if (tabs && active && tabs.scrollWidth > tabs.clientWidth) {
      tabs.scrollTo({ left: active.offsetLeft - (tabs.clientWidth - active.offsetWidth) / 2, behavior: "smooth" });
    }
    // Tab widths change when the web font arrives or labels switch language.
    let cancelled = false;
    document.fonts?.ready.then(() => !cancelled && measure());
    if (typeof ResizeObserver === "undefined" || !tabs) return () => { cancelled = true; };
    const observer = new ResizeObserver(measure);
    observer.observe(tabs);
    tabs.querySelectorAll(".d3-tab").forEach((tab) => observer.observe(tab));
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [measure, activeZone?.id, language, zones.length]);

  return (
    <header className="d3-header" data-bmq-shell="demo3-v1">
      <div className="d3-brand">
        <Link to="/" className="d3-logo" aria-label={en ? "BMQ home" : "Trang chủ BMQ"}>
          <img src={bmqLogo} alt="BMQ — Bánh Mì Que Pháp" />
        </Link>
        <button type="button" className="d3-search" onClick={() => setSearchOpen(true)} aria-label={en ? "Search functions" : "Tìm chức năng"}>
          <Search className="h-4 w-4" aria-hidden="true" />
          <span>{en ? "Search" : "Tìm kiếm"}</span>
          <kbd>⌘K</kbd>
        </button>
      </div>

      {zones.length > 0 && (
        <nav className="d3-tabs" ref={tabsRef} aria-label={en ? "Main areas" : "Khu chức năng"}>
          {indicator && <span className="d3-tabs-ind" style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }} aria-hidden="true" />}
          {zones.map(({ zone, href }) => {
            if (zone.id === "ai") {
              return (
                <button key={zone.id} type="button" className="d3-tab is-ai" onClick={openAgentChat}>
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  {label(zone.label)}
                </button>
              );
            }
            const isActive = activeZone?.id === zone.id;
            return (
              <Link
                key={zone.id}
                to={href || "/"}
                className={cn("d3-tab", isActive && "is-active")}
                data-zone-active={isActive ? "true" : undefined}
                aria-current={isActive ? "page" : undefined}
              >
                {label(zone.label)}
              </Link>
            );
          })}
        </nav>
      )}

      <div className="d3-actions">
        <button type="button" className="d3-icon-btn d3-search-mobile" onClick={() => setSearchOpen(true)} aria-label={en ? "Search functions" : "Tìm chức năng"}>
          <Search className="h-4 w-4" />
        </button>

        {notices.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="d3-icon-btn" aria-label={en ? `Notifications${unread ? `, ${unread} open` : ""}` : `Thông báo${unread ? `, ${unread} việc cần xử lý` : ""}`}>
                <Bell className="h-4 w-4" />
                {unread > 0 && <span className="d3-dot" aria-hidden="true" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="d3-menu w-72">
              <DropdownMenuLabel>{en ? "Needs attention" : "Cần xử lý"}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {notices.map((notice) => (
                <DropdownMenuItem key={notice.key} onSelect={() => navigate(notice.to)} className="d3-menu-item">
                  <notice.icon className="h-4 w-4" aria-hidden="true" />
                  <span className="flex-1">{notice.text}</span>
                  <span className={cn("d3-count", notice.count > 0 && notice.key === "payments" && "is-alert")}>{notice.count}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <button type="button" className="d3-icon-btn" onClick={openAppDrawer} aria-label={en ? "All functions" : "Tất cả chức năng"}>
          <LayoutGrid className="h-4 w-4" />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="d3-avatar" aria-label={en ? `Account: ${displayName}` : `Tài khoản: ${displayName}`}>
              {initials}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="d3-menu w-64">
            <DropdownMenuLabel className="d3-menu-user">
              <span>{displayName}</span>
              <small>{isOwner ? (en ? "Owner" : "Chủ sở hữu") : (en ? "User" : "Người dùng")}</small>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="d3-menu-section">{t.language}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={language}
              onValueChange={(value) => setLanguage(value === "en" ? "en" : "vi")}
              aria-label={t.language}
              data-header-language="en-vi-v1"
            >
              {/* Keep the menu open so the switch is visible immediately. */}
              <DropdownMenuRadioItem value="vi" onSelect={(event) => event.preventDefault()} className="d3-menu-item">
                Tiếng Việt
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="en" onSelect={(event) => event.preventDefault()} className="d3-menu-item">
                English
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate("/settings")} className="d3-menu-item">
              <Settings className="h-4 w-4" aria-hidden="true" />
              {t.settings}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={signOut} className="d3-menu-item text-destructive">
              <LogOut className="h-4 w-4" aria-hidden="true" />
              {t.signOut}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ShellSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </header>
  );
}
