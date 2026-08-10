#!/usr/bin/env python3
"""Static contract checks for the public kiosk daily report portal."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "src/App.tsx"
ROUTES = ROOT / "src/components/AppRoutes.tsx"
PORTAL = ROOT / "src/pages/KioskReportPortal.tsx"
DAILY_SAVE = ROOT / "supabase/functions/report-daily-save/index.ts"
CONFIG = ROOT / "supabase/config.toml"
CORS = ROOT / "supabase/functions/_shared/cors.ts"
MIGRATION_GLOB = "202608*_kiosk_report*.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def read_report_migrations() -> str:
    paths = sorted((ROOT / "supabase/migrations").glob(MIGRATION_GLOB))
    assert paths, "Missing kiosk report migrations"
    return "\n".join(read(path) for path in paths)


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def assert_not_contains(text: str, needle: str, label: str) -> None:
    assert needle not in text, f"Unexpected {label}: {needle!r}"


def test_report_host_isolated_from_internal_routes_and_title() -> None:
    app = read(APP)
    routes = read(ROUTES)
    for needle, label in [
        ('const KIOSK_REPORT_HOST = "baocao.banhmique.vn"', "report host constant"),
        ("KioskReportPortal", "direct report portal import/render"),
        ('document.title = "BMQ Báo Cáo Điểm Bán"', "report host title"),
    ]:
        assert_contains(app, needle, label)
    assert_contains(routes, 'const DEALER_ORDERING_HOST = "dathang.banhmique.vn"', "dealer host remains")


def test_report_ui_matches_approved_copy_and_shape() -> None:
    portal = read(PORTAL)
    for needle, label in [
        ('"/assets/brand/bmq-logo-master-1024.png"', "master BMQ logo asset"),
        ("bg-[#fefbf9]", "warm white report background"),
        ("linear-gradient(90deg, #dc4f78 0%, #dc527a 100%)", "approved pink OTP gradient"),
        ("Báo cáo bán hàng", "phone-step title"),
        ("Dành cho nhân viên điểm bán BMQ", "phone-step subtitle"),
        ("Số điện thoại", "phone field label"),
        ("09xx xxx xxx", "phone placeholder"),
        ("Nhận mã OTP qua Zalo", "phone-step action"),
        ("Mã xác thực được gửi qua Zalo", "phone-step assurance"),
        ("Số điện thoại chưa được kích hoạt?", "inactive-phone guidance"),
        ("Liên hệ quản lý BMQ", "manager contact copy"),
        ("© 2026 Bánh Mì Que Pháp BMQ", "phone-step footer"),
        ("Nhập mã OTP", "OTP step copy"),
        ("Thông tin nhân viên", "staff header"),
        ("Điểm bán", "location header"),
        ("Ngày báo cáo", "date header"),
        ("Tồn kho & luân chuyển", "inventory section"),
        ("Doanh thu theo kênh", "revenue section"),
        ("Bánh mì que", "product list"),
        ("Pate", "product list"),
        ("Ớt", "product list"),
        ("Bánh mì sấy", "product list"),
        ("Khách lẻ", "channel list"),
        ("ShopeeFood", "channel list"),
        ("GrabFood", "channel list"),
        ("beFood", "channel list"),
        ("Lưu nháp", "draft action"),
        ("Gửi báo cáo", "submit action"),
        ("fixed bottom-0", "fixed mobile bottom action"),
    ]:
        assert_contains(portal, needle, label)


def test_otp_step_uses_pink_action_and_hides_backend_details() -> None:
    portal = read(PORTAL)
    pink_gradient = "linear-gradient(90deg, #dc4f78 0%, #dc527a 100%)"
    assert portal.count(pink_gradient) >= 2, "phone and OTP actions must use the same approved pink gradient"
    assert_not_contains(portal, "setStatusMessage(result.data.message", "backend auth-start explanation")
    assert_not_contains(portal, "setErrorMessage(result.error", "raw backend error details")
    assert_contains(portal, "Mã OTP không đúng hoặc đã hết hạn.", "concise OTP verification error")


def test_authenticated_report_matches_approved_responsive_design_system() -> None:
    portal = read(PORTAL)
    for needle, label in [
        ('bg-[#fff8fa]', "approved warm-pink report canvas"),
        ('text-[#20212d]', "approved ink color"),
        ('#ec5b91', "approved primary pink"),
        ('lg:pl-[238px]', "approved desktop sidebar offset"),
        ('function ReportSidebar', "desktop BMQ sidebar"),
        ('function ProductIcon', "product icon system"),
        ('function ChannelIcon', "channel brand icon system"),
        ('expandedProductCode', "inventory accordion state"),
        ('Báo cáo ngày', "approved report title"),
        ('Chưa gửi', "approved draft status"),
        ('Kiểm tra & gửi', "approved compact submit action copy"),
        ('Tổng số bán', "approved totals copy"),
        ('data-testid="report-shell"', "responsive QA hook"),
        ('data-testid="inventory-section"', "inventory QA hook"),
        ('data-testid="channel-section"', "channel QA hook"),
    ]:
        assert_contains(portal, needle, label)
    assert_not_contains(portal, 'bg-[#f3f4f6]', "legacy gray authenticated canvas")
    assert_not_contains(portal, 'min-w-[920px]', "legacy horizontally scrolling inventory table")
    assert_not_contains(portal, 'Không thu tiền mặt', "removed non-cash helper copy")
    assert_contains(portal, 'grid-cols-[40px_minmax(0,1fr)]', "mobile channel identity row")
    assert_contains(portal, 'col-span-2 grid min-w-0 grid-cols-2', "mobile channel fields use their own full-width row")
    assert_contains(portal, 'min-w-0 break-words', "channel names can wrap under Android text scaling")
    assert_contains(portal, 'mb-1 block text-[10px] leading-tight', "channel field labels wrap instead of clipping")
    assert_not_contains(portal, 'whitespace-nowrap text-[13px]', "channel name must not overflow its fixed column")


def test_hallmark_redesign_is_compact_clear_and_mobile_safe() -> None:
    portal = read(PORTAL)
    for needle, label in [
        ('data-hallmark="compact-operational"', "Hallmark redesign stamp"),
        ('data-testid="inventory-ledger"', "flat inventory ledger"),
        ('divide-y divide-[#f2e5e9] border-y', "single-layer row separation"),
        ('data-testid="computed-closing"', "computed closing presentation"),
        ("Hệ thống tính", "computed-field explanation"),
        ('grid-cols-2 gap-x-2.5 gap-y-2.5 min-[360px]:grid-cols-3 sm:grid-cols-4', "320px-safe inventory grid"),
        ('lg:pl-[238px]', "tablet-safe desktop shell breakpoint"),
        ('lg:hidden', "mobile/tablet header and action breakpoint"),
        ('pb-[calc(0.75rem+env(safe-area-inset-bottom))]', "safe-area sticky action bar"),
        ("Wheat", "bread product line icon"),
        ("PackageOpen", "packaged product line icon"),
        ("Flame", "chili product line icon"),
        ("Kiểm tra & gửi", "compact submit copy"),
    ]:
        assert_contains(portal, needle, label)
    assert_not_contains(portal, "Kiểm tra & gửi báo cáo", "two-line-prone submit copy")
    for emoji in ["🥖", "🥫", "🌶️", "🥨"]:
        assert_not_contains(portal, emoji, "platform-dependent product emoji")


def test_ingredient_consumption_keeps_pate_automatic_and_chili_manually_editable() -> None:
    portal = read(PORTAL)
    for needle, label in [
        ('from "@/lib/kiosk-report-inventory"', "shared inventory calculation import"),
        ('sale_allowed: false', "ingredient sale-disabled product metadata"),
        ('breadstick_consumption_ratio: 1 / 20', "pate consumption ratio"),
        ('Tiêu hao tự động', "automatic ingredient consumption label"),
        ('1 hộp = 20 bánh mì que', "pate recipe explanation"),
        ('row.product_code === "ot"', "chili-specific manual usage guard"),
        ('label="Ớt sử dụng"', "manual chili usage field"),
        ('updateInventoryRow(row.product_code, "consumed_quantity", value)', "manual chili usage state update"),
        ('calculateEffectiveConsumedQuantity', "trusted effective consumption calculation"),
        ('isRetailSaleAllowed(product)', "retail sale field guard"),
    ]:
        assert_contains(portal, needle, label)


def test_inventory_opening_is_carried_and_locked_when_system_managed() -> None:
    portal = read(PORTAL)
    for needle, label in [
        ("opening_inventory_rows", "carried opening inventory response"),
        ("opening_source_report_date", "opening inventory source date"),
        ("setOpeningLocked", "opening lock state"),
        ("openingLocked && !row.opening_reconciliation_required", "locked opening input except reconciliation"),
        ("Tồn đầu được chuyển tự động từ tồn cuối ngày", "rollover explanation"),
        ("SAFE_SAVE_ERROR_MESSAGES", "safe save error allowlist"),
        ("SAFE_SAVE_ERROR_MESSAGES.has(result.error)", "allowlisted chronology guidance rendering"),
    ]:
        assert_contains(portal, needle, label)


def test_negative_inventory_requires_physical_opening_reconciliation_before_submit() -> None:
    portal = read(PORTAL)
    for needle, label in [
        ("opening_reconciliation_required", "per-product reconciliation state"),
        ("isNegativeInventoryClosing", "shared negative-closing guard"),
        ("Tồn hôm trước bị âm", "physical count guidance"),
        ("Vui lòng kiểm đếm và nhập tồn đầu thực tế", "opening reconciliation instruction"),
        ("Tồn cuối không được âm", "negative submit blocker"),
        ("setExpandedProductCode", "open offending inventory row"),
        ('data-kiosk-inventory-product={row.product_code}', "offending row scroll target"),
        ('scrollIntoView({ behavior: "smooth", block: "center" })', "bring submit blocker into view"),
        ("openingLocked && !row.opening_reconciliation_required", "only reconciled opening is editable"),
    ]:
        assert_contains(portal, needle, label)


def test_walk_in_revenue_is_derived_from_quantity_at_12000_vnd() -> None:
    portal = read(PORTAL)
    assert_contains(portal, 'calculateKioskChannelAmount', "shared channel amount calculation")
    assert_contains(portal, 'disabled={isSubmitted || cashChannel}', "walk-in amount input lock")
    assert_contains(portal, 'Khách lẻ tự tính 12.000đ × số lượng', "walk-in auto amount explanation")
    assert_contains(portal, 'channel_rows: channelRows.map', "derived amount save payload")
    assert_not_contains(portal, 'value={placeholder ? "" :', "placeholder masking entered amount")
    assert_contains(portal, 'placeholder && Number(value) === 0', "zero-only non-cash placeholder")


def test_breadstick_inventory_sales_are_derived_from_channel_quantities() -> None:
    portal = read(PORTAL)
    daily_save = read(DAILY_SAVE)
    for needle, label in [
        ("const breadstickSoldQuantity = totalQuantity", "portal channel-total source of truth"),
        ("deriveBreadstickInventoryRow", "portal derived sales calculation row"),
        ("calcClosing(row, consumedQuantity, breadstickSoldQuantity)", "derived sales closing calculation"),
        ("hasNegativeClosing(row, consumedQuantity, breadstickSoldQuantity)", "derived sales negative validation"),
        ('label="Đã bán" value={breadstickSoldQuantity}', "derived breadstick sold display"),
        ('sold_quantity: row.product_code === "banh_mi_que"', "derived portal save payload"),
        ("? breadstickSoldQuantity", "portal payload uses derived sales"),
    ]:
        assert_contains(portal, needle, label)
    for needle, label in [
        ("sumValidatedChannelQuantities", "edge validated channel-total source of truth"),
        ('new Set<string>', "edge active channel allowlist"),
        ('validationError.code === "duplicate_report_channel"', "edge duplicate channel rejection"),
        ('validationError.code', "edge unknown channel rejection"),
        ('productCode === "banh_mi_que" ? breadstickSoldQuantity', "edge overwrites stale clients"),
    ]:
        assert_contains(daily_save, needle, label)


def test_report_portal_uses_only_report_functions() -> None:
    portal = read(PORTAL)
    for fn_name in [
        "report-auth-start",
        "report-auth-verify",
        "report-bootstrap",
        "report-daily-save",
        "report-auth-logout",
    ]:
        assert_contains(portal, f'"{fn_name}"', f"{fn_name} invocation")
    for forbidden in ["dealer-auth-start", "dealer-auth-verify", "dealer-catalog", "dealer-order-submit"]:
        assert_not_contains(portal, forbidden, f"dealer function {forbidden}")


def test_report_functions_are_registered_with_cors() -> None:
    config = read(CONFIG)
    cors = read(CORS)
    assert_contains(cors, "https://baocao.banhmique.vn", "report CORS origin")
    assert_contains(cors, "REPORT_PORTAL_FUNCTIONS", "report-only CORS scope")
    assert_contains(cors, "isReportPortalFunction(req)", "report CORS request guard")
    for fn_name in [
        "report-auth-start",
        "report-auth-verify",
        "report-session",
        "report-bootstrap",
        "report-daily-save",
        "report-auth-logout",
        "kiosk-report-admin",
    ]:
        assert_contains(config, f"[functions.{fn_name}]", f"{fn_name} config entry")
        block = config.split(f"[functions.{fn_name}]", 1)[1].split("[functions.", 1)[0]
        assert_contains(block, "verify_jwt = false", f"{fn_name} verify_jwt=false")


def test_report_schema_contract() -> None:
    sql = read_report_migrations()
    for needle, label in [
        ("create table if not exists public.kiosk_report_locations", "locations table"),
        ("create table if not exists public.kiosk_report_staff", "staff table"),
        ("full_name text not null", "staff full name"),
        ("phone_raw text not null", "staff raw phone"),
        ("phone_normalized text not null", "staff normalized phone"),
        ("location_id uuid not null references public.kiosk_report_locations", "exactly one staff location FK"),
        ("monthly_salary_vnd numeric", "salary field"),
        ("active boolean not null default true", "staff active flag"),
        ("create table if not exists public.kiosk_report_otp_challenges", "report OTP table"),
        ("create table if not exists public.kiosk_report_sessions", "report session table"),
        ("create table if not exists public.kiosk_daily_reports", "daily reports table"),
        ("create table if not exists public.kiosk_daily_report_inventory_rows", "inventory child rows"),
        ("create table if not exists public.kiosk_daily_report_channel_rows", "channel child rows"),
        ("constraint kiosk_daily_reports_location_date_unique unique (location_id, report_date)", "one report per location/date"),
        ("status text not null default 'draft'", "draft status"),
        ("check (status in ('draft', 'submitted'))", "draft/submitted status check"),
        ("closing_quantity numeric(12,3) generated always as", "computed closing field"),
        ("consumed_quantity numeric(12,3)", "derived ingredient consumption field"),
        ("opening_quantity + received_quantity - shortage_quantity + transfer_quantity - waste_quantity - returns_quantity - sold_quantity - consumed_quantity", "closing formula with ingredient consumption"),
        ("sale_allowed boolean not null default true", "retail-sale product policy"),
        ("breadstick_consumption_ratio numeric(12,6)", "recipe consumption ratio"),
        ("set sale_allowed = false, breadstick_consumption_ratio = 0.05", "pate recipe policy"),
        ("Bánh mì que", "inventory product seed"),
        ("Pate", "inventory product seed"),
        ("Ớt", "inventory product seed"),
        ("Bánh mì sấy", "inventory product seed"),
        ("Khách lẻ", "channel seed"),
        ("ShopeeFood", "channel seed"),
        ("GrabFood", "channel seed"),
        ("beFood", "channel seed"),
        ("block_report_staff_dealer_contact_phone", "report staff blocks dealer contact trigger"),
        ("block_dealer_contact_report_staff_phone", "dealer contact blocks report staff trigger"),
        ("revoke_active_report_sessions_for_staff", "staff reassignment/session revoke trigger"),
    ]:
        assert_contains(sql, needle, label)


def test_dual_portal_test_access_requires_explicit_flags_on_both_rows() -> None:
    sql = read_report_migrations()
    assert sql.count("allow_dual_portal_access boolean not null default false") >= 2
    assert_contains(
        sql,
        "new.allow_dual_portal_access = true and krs.allow_dual_portal_access = true",
        "dealer activation requires matching kiosk dual-access flag",
    )
    assert_contains(
        sql,
        "new.allow_dual_portal_access = true and dcc.allow_dual_portal_access = true",
        "kiosk activation requires matching dealer dual-access flag",
    )
    assert_contains(
        sql,
        "update of phone_normalized, active, allow_dual_portal_access",
        "kiosk trigger rechecks dual-access flag changes",
    )
    assert_contains(
        sql,
        "update of phone_normalized, is_active, allow_dual_portal_access",
        "dealer trigger rechecks dual-access flag changes",
    )


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
