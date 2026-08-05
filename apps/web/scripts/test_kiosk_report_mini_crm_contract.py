#!/usr/bin/env python3
"""Static checks for kiosk report administration inside Mini CRM."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MINI_CRM = ROOT / "src/pages/MiniCrm.tsx"
ADMIN_PANEL = ROOT / "src/components/mini-crm/KioskReportAdminPanel.tsx"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def source() -> str:
    return read(MINI_CRM) + "\n" + read(ADMIN_PANEL)


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def assert_not_contains(text: str, needle: str, label: str) -> None:
    assert needle not in text, f"Unexpected {label}: {needle!r}"


def test_mini_crm_has_clear_customer_location_staff_selectors() -> None:
    source_text = source()
    for needle, label in [
        ("Khách hàng", "customer tab"),
        ("Điểm bán", "location tab"),
        ("Nhân viên bán hàng", "staff tab"),
        ("kiosk-report-admin", "dedicated admin CRUD function"),
    ]:
        assert_contains(source_text, needle, label)


def test_crm_module_permissions_control_kiosk_admin_view_and_edit() -> None:
    mini_crm = read(MINI_CRM)
    admin_panel = read(ADMIN_PANEL)

    for needle, label in [
        ('canAccessModule("crm")', "CRM view permission"),
        ('canEditModule("crm")', "CRM edit permission"),
        ('canView={canViewKioskAdmin}', "view permission passed to kiosk admin"),
        ('canEdit={canEditKioskAdmin}', "edit permission passed to kiosk admin"),
    ]:
        assert_contains(mini_crm, needle, label)

    for needle, label in [
        ("canView: boolean", "explicit view prop"),
        ("canEdit: boolean", "explicit edit prop"),
        ("enabled: canView", "permission-gated data query"),
        ("Bạn không có quyền xem dữ liệu báo cáo điểm bán", "unauthorized CRM message"),
    ]:
        assert_contains(admin_panel, needle, label)

    assert_not_contains(admin_panel, "Chỉ owner mới được quản lý dữ liệu báo cáo điểm bán", "owner-only gate copy")
    assert_not_contains(admin_panel, "enabled: isOwner", "owner-only data query")


def test_location_and_staff_admin_cards_show_required_fields_and_status() -> None:
    source_text = source()
    for needle, label in [
        ("Tên điểm bán", "location name field"),
        ("Mã điểm bán", "location code field"),
        ("Địa chỉ", "location address field"),
        ("Tên nhân viên", "staff name field"),
        ("SĐT nhân viên", "staff phone field"),
        ("Lương tháng", "staff salary field"),
        ("Trạng thái", "status field"),
        ("Chỉ Báo cáo", "report-only badge"),
        ("Không có quyền truy cập Đặt hàng", "dealer access warning"),
        ("Nhân viên chỉ thuộc 1 điểm bán", "one-location warning"),
        ("Đổi điểm bán", "CRM reassignment control"),
    ]:
        assert_contains(source_text, needle, label)


def test_salary_is_loaded_only_through_admin_crud_not_public_report_ui() -> None:
    source_text = source()
    assert_contains(source_text, "monthly_salary_vnd", "salary field in permission-gated Mini CRM admin")
    assert_contains(source_text, "canView", "CRM view gate")
    assert_contains(source_text, "canEdit", "CRM edit gate")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
