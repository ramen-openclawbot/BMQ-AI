#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
PAGE = ROOT / "src" / "pages" / "PointRevenueManagement.tsx"
CSS = ROOT / "src" / "pages" / "point-revenue-management.css"
ROUTES = ROOT / "src" / "components" / "AppRoutes.tsx"
SIDEBAR = ROOT / "src" / "components" / "layout" / "Sidebar.tsx"
LANGUAGE = ROOT / "src" / "contexts" / "LanguageContext.tsx"


def read(path: Path) -> str:
    assert path.exists(), f"missing {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def main() -> None:
    migrations = sorted(MIGRATIONS.glob("*point_revenue_management*.sql"))
    assert len(migrations) == 1, "expected exactly one point revenue migration"
    sql = read(migrations[0]).lower()

    for token in (
        "create table if not exists public.kiosk_point_revenue_reviews",
        "create table if not exists public.kiosk_point_revenue_adjustments",
        "create table if not exists public.kiosk_point_revenue_audit_logs",
        "get_kiosk_point_revenue_reviews",
        "save_kiosk_point_revenue_review",
        "security definer",
        "set search_path = public",
        "has_module_permission",
        "'finance_revenue'",
        "'submitted'",
        "for update",
        "before_payload",
        "after_payload",
        "revoke all",
        "from anon",
        "grant execute",
        "to authenticated",
    ):
        assert token in sql, f"migration missing security/data contract: {token}"

    assert "insert into public.revenue_ledger_lines" not in sql, "must not double-post to corporate revenue ledger"
    assert "update public.kiosk_daily_report_channel_rows" not in sql, "submitted kiosk source must remain immutable"
    assert "delete from public.kiosk_daily_report_channel_rows" not in sql, "submitted kiosk source must remain immutable"

    page = read(PAGE)
    for token in (
        'data-testid="point-revenue-page"',
        'data-stitch-revenue-theme="mediterranean-glass"',
        'data-testid="point-revenue-worklist"',
        'data-testid="point-revenue-editor"',
        'data-testid="point-revenue-mobile-card"',
        'canEditModule("finance_revenue")',
        'get_kiosk_point_revenue_reviews',
        'get_kiosk_point_report_detail',
        'save_kiosk_point_report_correction',
        'const breadstickSoldQuantity = detail.channel_rows.reduce',
        'sold_quantity: breadstickSoldQuantity',
        'setInventoryRows(recalculateInventory(inventoryWithDerivedSales))',
        'aria-live="polite"',
        'Số lượng',
        'Thành tiền',
        'Lý do chỉnh sửa',
        'Lưu & đánh dấu đã kiểm tra',
    ):
        assert token in page, f"page missing behavior contract: {token}"

    css = read(CSS)
    for token in (
        "hallmark · macrostructure: workbench",
        "data-theme: mediterranean-glass",
        "hsl(var(--background))",
        "hsl(var(--card) / 0.82)",
        "backdrop-filter: blur(16px)",
        "overflow-x: clip",
        "font-variant-numeric: tabular-nums",
        "prefers-reduced-motion: reduce",
        "@media (min-width: 40rem)",
        "@media (min-width: 60rem)",
        "--pr-color-accent:",
        "--pr-font-display:",
    ):
        assert token in css.lower(), f"Hallmark CSS missing: {token}"
    assert "transition-all" not in css
    assert "100vw" not in css
    assert "custom bmq dusty-pink" not in css.lower()
    assert "oklch(" not in css.lower(), "page must use shared semantic BMQ tokens instead of a private legacy palette"

    routes = read(ROUTES)
    assert 'PointRevenueManagement' in routes
    assert 'path="/finance-control/revenue/points"' in routes
    assert 'ModuleRoute moduleKey="finance_revenue"' in routes

    sidebar = read(SIDEBAR)
    assert 'financePointRevenue' in sidebar
    assert 'path: "/finance-control/revenue/points"' in sidebar
    assert 'moduleKey: "finance_revenue"' in sidebar

    language = read(LANGUAGE)
    assert 'financePointRevenue: string;' in language
    assert 'financePointRevenue: "Point revenue"' in language
    assert 'financePointRevenue: "Doanh thu điểm bán"' in language

    print("PASS point revenue management contract")


if __name__ == "__main__":
    main()
