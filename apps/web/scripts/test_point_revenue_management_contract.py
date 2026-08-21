#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
PAGE = ROOT / "src" / "pages" / "PointRevenueManagement.tsx"
CSS = ROOT / "src" / "pages" / "point-revenue-management.css"
ROUTES = ROOT / "src" / "components" / "AppRoutes.tsx"
SIDEBAR = ROOT / "src" / "components" / "layout" / "Sidebar.tsx"
LANGUAGE = ROOT / "src" / "contexts" / "LanguageContext.tsx"
SHIFT_NOTES_MIGRATION = ROOT / "supabase" / "migrations" / "20260816100000_point_revenue_shift_notes.sql"


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

    shift_notes_sql = read(SHIFT_NOTES_MIGRATION).lower()
    for token in (
        "create or replace function public.get_kiosk_point_revenue_reviews",
        "report_notes text",
        "report.notes",
        "security definer",
        "set search_path = public",
        "has_module_permission",
        "'finance_revenue'",
        "revoke all",
        "from anon",
        "grant execute",
        "to authenticated",
    ):
        assert token in shift_notes_sql, f"shift-note RPC migration missing contract: {token}"

    page = read(PAGE)
    for token in (
        'data-testid="point-revenue-page"',
        'data-point-revenue-version="mobile-ranking-edit-v2"',
        'data-testid="point-revenue-editor"',
        'canEditModule("finance_revenue")',
        'get_kiosk_point_revenue_reviews',
        'get_kiosk_point_report_detail',
        'save_kiosk_point_report_correction',
        'createPointReportEditDraft',
        'recalculatePointInventory',
        'closeMobileEditor',
        'if (!open) closeMobileEditor()',
        'aria-live="polite"',
        'bánh bán ra trong ngày',
        'Xếp hạng điểm bán',
        'Tốt nhất hôm nay',
        'Bán ít nhất',
        'Tồn bánh hiện tại',
        'getBreadClosingQuantity',
        'useQueries',
        'Chưa đủ dữ liệu',
        'Không tải được',
        'Hủy',
        'Ghi chú ca',
        'row.report.report_notes',
        'Số bánh',
        'Doanh thu',
        'Lý do chỉnh sửa',
        'Lưu thay đổi',
    ):
        assert token in page, f"page missing daily-report behavior contract: {token}"

    for removed_copy in (
        'Danh sách kiểm tra',
        'Báo cáo kiosk cần kiểm tra',
        'Lưu & đánh dấu đã kiểm tra',
        'Chờ kiểm tra',
        'Đã kiểm tra',
        'Xem nhanh số bánh và doanh thu của từng điểm bán theo ngày.',
        'Kế toán được phép chỉnh sửa',
        'Tài khoản chỉ có quyền xem',
    ):
        assert removed_copy not in page, f"obsolete review UI remains: {removed_copy}"

    css = read(CSS)
    for token in (
        "hallmark · genre: modern-minimal · macrostructure: stat-led",
        "overflow-x: clip",
        "font-variant-numeric: tabular-nums",
        "prefers-reduced-motion: reduce",
        "@media (min-width: 40rem)",
        "@media (min-width: 60rem)",
        "--pr-color-accent:",
        "--pr-font-display:",
        ".pr-date-control {",
        "grid-template-columns: 3rem minmax(0, 1fr) 3rem;",
        ".pr-date-control input::-webkit-calendar-picker-indicator",
        "appearance: none;",
        ".pr-point-revenue {",
        "grid-column: 2 / -1;",
        ".pr-shift-note {",
        ".pr-inventory-overview {",
        ".pr-mobile-dialog .pr-editor-actions {",
        "height: 100dvh;",
        "overflow-wrap: anywhere;",
    ):
        assert token in css.lower(), f"Hallmark CSS missing: {token}"
    assert "transition-all" not in css
    assert "100vw" not in css

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
