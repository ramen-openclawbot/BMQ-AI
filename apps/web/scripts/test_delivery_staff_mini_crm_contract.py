#!/usr/bin/env python3
"""Static contracts for delivery-staff master data in Mini CRM."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MINI_CRM = ROOT / "src/pages/MiniCrm.tsx"
PANEL = ROOT / "src/components/mini-crm/DeliveryStaffAdminPanel.tsx"
MIGRATION = ROOT / "supabase/migrations/20260819090000_mini_crm_delivery_staff.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def test_mini_crm_exposes_delivery_staff_as_a_separate_object() -> None:
    mini_crm = read(MINI_CRM)
    panel = read(PANEL)
    assert 'TabsTrigger value="delivery_staff">Nhân viên giao hàng</TabsTrigger>' in mini_crm
    assert 'miniCrmSection === "delivery_staff"' in mini_crm
    assert "DeliveryStaffAdminPanel" in mini_crm
    assert "Họ và tên" in panel
    assert "Số điện thoại" in panel
    assert "Lương tháng" in panel
    assert "Trạng thái" in panel
    assert "Không cấp quyền đăng nhập" in panel


def test_delivery_staff_crud_respects_crm_view_and_edit_permissions() -> None:
    mini_crm = read(MINI_CRM)
    panel = read(PANEL)
    assert "canView={canViewKioskAdmin}" in mini_crm
    assert "canEdit={canEditKioskAdmin}" in mini_crm
    assert "enabled: canView" in panel
    assert "if (!canView)" in panel
    assert "{canEdit && (" in panel
    assert ".from(\"delivery_staff\")" in panel


def test_delivery_staff_schema_has_validation_rls_and_audit() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "create table if not exists public.delivery_staff",
        "phone_normalized",
        "monthly_salary_vnd",
        "delivery_staff_phone_normalized_check",
        "create unique index if not exists delivery_staff_active_phone_unique",
        "alter table public.delivery_staff enable row level security",
        "has_module_permission((select auth.uid()), 'crm', 'view')",
        "has_module_permission((select auth.uid()), 'crm', 'edit')",
        "create table if not exists public.delivery_staff_audit_logs",
        "create trigger audit_delivery_staff_changes",
    ]:
        assert needle in sql, f"Missing delivery-staff schema contract: {needle}"


def test_delivery_staff_migration_is_rerunnable() -> None:
    sql = read(MIGRATION).lower()
    assert "create unique index if not exists delivery_staff_active_phone_unique" in sql
    for policy in [
        "delivery_staff_select_crm",
        "delivery_staff_insert_crm",
        "delivery_staff_update_crm",
        "delivery_staff_audit_select_crm",
    ]:
        assert f"drop policy if exists {policy}" in sql, f"Policy must be dropped before recreate: {policy}"
        assert f"create policy {policy}" in sql


def test_delivery_staff_ui_does_not_surface_raw_database_errors() -> None:
    panel = read(PANEL)
    assert "formatDeliveryStaffError" in panel
    assert "Không thể tải danh sách nhân viên giao hàng. Vui lòng thử lại." in panel
    assert "Không thể lưu nhân viên giao hàng. Vui lòng thử lại hoặc báo quản trị viên." in panel
    assert 'console.error("Delivery staff query failed", queryError)' in panel
    assert 'console.error("Delivery staff save failed", saveError)' in panel
    assert "saveError?.message || \"Không thể lưu\"" not in panel
    assert "(error as Error)?.message" not in panel


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
