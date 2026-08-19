#!/usr/bin/env python3
"""Static contracts for attendance geofence master data in Mini CRM."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MINI_CRM = ROOT / "src/pages/MiniCrm.tsx"
PANEL = ROOT / "src/components/mini-crm/AttendanceGeofenceAdminPanel.tsx"
MIGRATION = ROOT / "supabase/migrations/20260819093000_attendance_geofence_locations.sql"
DELIVERY_PANEL = ROOT / "src/components/mini-crm/DeliveryStaffAdminPanel.tsx"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def test_attendance_geofence_schema_separates_kiosks_from_warehouse() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "create table if not exists public.attendance_geofence_locations",
        "location_type text not null",
        "check (location_type in ('kiosk', 'warehouse'))",
        "code text not null",
        "latitude numeric(9,6)",
        "longitude numeric(9,6)",
        "accepted_radius_m integer not null default 20",
        "kiosk_location_id uuid references public.kiosk_report_locations(id) on delete restrict",
        "attendance_geofence_locations_kiosk_location_unique",
        "where kiosk_location_id is not null",
        "constraint attendance_geofence_locations_kiosk_link_check",
        "constraint attendance_geofence_locations_coordinates_pair_check",
        "constraint attendance_geofence_locations_radius_check",
    ]:
        assert needle in sql, f"Missing geofence schema contract: {needle}"
    assert "location_type = 'kiosk' and kiosk_location_id is not null" not in sql, (
        "Kiosk geofence rows may optionally link to kiosk_report_locations; "
        "only non-null links must be one-to-one."
    )
    assert "location_type = 'warehouse' and kiosk_location_id is null" in sql


def test_attendance_geofence_schema_seeds_tan_tao_without_invented_coordinates() -> None:
    sql = read(MIGRATION).lower()
    assert "warehouse_tan_tao" in sql
    assert "kho tân tạo" in sql or "kho tan tao" in sql
    assert "null, null" in sql, "Kho Tân Tạo seed must leave latitude/longitude null until business supplies coordinates"
    assert "on conflict (code) do update" in sql
    assert "accepted_radius_m = 20" in sql
    assert "attendance_geofence_locations_seed_tan_tao" in sql


def test_attendance_geofence_schema_uses_crm_permissions_and_audits_changes() -> None:
    sql = read(MIGRATION).lower()
    for needle in [
        "create table if not exists public.attendance_geofence_location_audit_logs",
        "create trigger audit_attendance_geofence_location_changes",
        "alter table public.attendance_geofence_locations enable row level security",
        "has_module_permission((select auth.uid()), 'crm', 'view')",
        "has_module_permission((select auth.uid()), 'crm', 'edit')",
        "grant select, insert, update on table public.attendance_geofence_locations to authenticated",
        "grant select on table public.attendance_geofence_location_audit_logs to authenticated",
    ]:
        assert needle in sql, f"Missing geofence audit/RLS contract: {needle}"


def test_attendance_geofence_migration_is_rerunnable() -> None:
    sql = read(MIGRATION).lower()
    assert "add constraint attendance_geofence_locations_code_unique unique (code)" not in sql
    assert "attendance_geofence_locations_code_unique" in sql
    assert "if not exists" in sql
    for policy in [
        "attendance_geofence_locations_select_crm",
        "attendance_geofence_locations_insert_crm",
        "attendance_geofence_locations_update_crm",
        "attendance_geofence_location_audit_select_crm",
    ]:
        assert f"drop policy if exists {policy}" in sql, f"Policy must be dropped before recreate: {policy}"
        assert f"create policy {policy}" in sql


def test_attendance_geofence_ui_does_not_surface_raw_database_errors() -> None:
    panel = read(PANEL)
    assert "formatAttendanceGeofenceError" in panel
    assert "Không thể tải cấu hình GPS chấm công. Vui lòng thử lại." in panel
    assert "Không thể lưu cấu hình GPS chấm công. Vui lòng thử lại hoặc báo quản trị viên." in panel
    assert 'console.error("Attendance geofence query failed", error)' in panel
    assert 'console.error("Attendance geofence save failed", error)' in panel
    assert "error?.message || \"Không thể lưu\"" not in panel
    assert "const error = (geofencesQuery.error || kioskLocationsQuery.error) as Error" not in panel


def test_mini_crm_exposes_attendance_gps_tab_with_crm_permissions() -> None:
    mini_crm = read(MINI_CRM)
    panel = read(PANEL)
    assert "AttendanceGeofenceAdminPanel" in mini_crm
    assert '"attendance_geofences"' in mini_crm
    assert 'TabsTrigger value="attendance_geofences">GPS chấm công</TabsTrigger>' in mini_crm
    assert "canView={canViewKioskAdmin}" in mini_crm
    assert "canEdit={canEditKioskAdmin}" in mini_crm
    assert "enabled: canView" in panel
    assert "if (!canView)" in panel
    assert "{canEdit && (" in panel


def test_attendance_geofence_ui_manages_master_coordinates_not_staff_assignment() -> None:
    panel = read(PANEL)
    delivery_panel = read(DELIVERY_PANEL)
    for needle in [
        '.from("attendance_geofence_locations")',
        '.from("kiosk_report_locations")',
        "warehouse_tan_tao",
        "Kho Tân Tạo",
        "Bán kính chấp nhận (m)",
        "Vĩ độ",
        "Kinh độ",
        "Mặc định 20m",
        "Kiosk / điểm bán",
    ]:
        assert needle in panel, f"Missing geofence UI contract: {needle}"
    assert "attendance_geofence" not in delivery_panel
    assert "geofence_location_id" not in delivery_panel
    assert "Vui lòng chọn Kiosk / điểm bán." not in panel
    assert 'kiosk_location_id: draft.location_type === "kiosk" ? (draft.kiosk_location_id || null) : null' in panel


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
