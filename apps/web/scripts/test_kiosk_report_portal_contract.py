#!/usr/bin/env python3
"""Static contract checks for the public kiosk daily report portal."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "src/App.tsx"
ROUTES = ROOT / "src/components/AppRoutes.tsx"
PORTAL = ROOT / "src/pages/KioskReportPortal.tsx"
CONFIG = ROOT / "supabase/config.toml"
CORS = ROOT / "supabase/functions/_shared/cors.ts"
MIGRATION_GLOB = "20260804103*_kiosk_report_portal*.sql"


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
        ("opening_quantity + received_quantity - shortage_quantity + transfer_quantity - waste_quantity - returns_quantity - sold_quantity", "closing formula"),
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


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
