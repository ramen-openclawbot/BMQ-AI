#!/usr/bin/env python3
"""Task8 contracts for GPS attendance payroll preview-only reporting."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260819143000_payroll_gps_attendance_preview.sql"
PAYROLL_PAGE = ROOT / "src/pages/PayrollManagement.tsx"
SMOKE = ROOT / "scripts/smoke_payroll_gps_attendance_preview_task8.sql"

SENSITIVE_TOKENS = [
    "device_latitude",
    "device_longitude",
    "geofence_latitude",
    "geofence_longitude",
    "request_ip_hash",
    "request_user_agent",
]
PAYROLL_MUTATION_TOKENS = [
    "insert into public.payroll_runs",
    "update public.payroll_runs",
    "delete from public.payroll_runs",
    "truncate public.payroll_runs",
    "insert into public.payroll_lines",
    "update public.payroll_lines",
    "delete from public.payroll_lines",
    "truncate public.payroll_lines",
]


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def uncommented(text: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines()).lower()


def migration() -> str:
    return read(MIGRATION).lower()


def migration_uncommented() -> str:
    return uncommented(read(MIGRATION))


def page() -> str:
    return read(PAYROLL_PAGE).lower()


def smoke() -> str:
    return read(SMOKE).lower()


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def assert_not_contains(text: str, needle: str, label: str) -> None:
    assert needle not in text, f"Unexpected {label}: {needle!r}"


def function_body() -> str:
    s = migration_uncommented()
    assert "create or replace function public.get_payroll_gps_attendance_preview" in s
    return s.split("create or replace function public.get_payroll_gps_attendance_preview", 1)[1]


def test_task8_migration_defines_preview_only_bounded_security_definer_rpc() -> None:
    s = migration()
    fn = function_body()
    for needle, label in [
        ("create or replace function public.get_payroll_gps_attendance_preview", "payroll GPS preview RPC"),
        ("p_preview_only boolean default true", "default-on preview-only contract"),
        ("security definer", "SECURITY DEFINER boundary"),
        ("set search_path = public", "fixed search_path"),
        ("public.has_role(v_actor, 'owner')", "owner ACL"),
        ("public.has_module_permission(v_actor, 'payroll', 'view')", "payroll.view ACL"),
        ("public.has_module_permission(v_actor, 'payroll', 'edit')", "payroll.edit ACL"),
        ("payroll_gps_preview_forbidden", "fail-closed ACL error"),
        ("payroll_gps_preview_preview_only_required", "preview-only failure marker"),
        ("coalesce(nullif(current_setting('payroll.gps_preview_only', true), ''), 'on')", "DB setting fail-closed control"),
        ("payroll_gps_preview_date_range_too_broad", "bounded period marker"),
        ("v_run.period_to - v_run.period_from > 61", "62-day inclusive cap"),
        ("date_trunc('month', v_run.period_from::timestamp)::date", "monthly period start check"),
        ("(date_trunc('month', v_run.period_from::timestamp) + interval '1 month - 1 day')::date", "monthly period end check"),
        ("employee_code like 'kiosk:%'", "KIOSK employee-code filter"),
        ("employee_code like 'delivery:%'", "DELIVERY employee-code filter"),
        ("gps_valid_days", "GPS-derived present days"),
        ("attendance_present_days", "attendance_records present days"),
        ("payroll_total_days_present", "existing payroll result days"),
        ("gps_vs_attendance_days_delta", "attendance discrepancy"),
        ("gps_vs_payroll_days_delta", "payroll discrepancy"),
        ("attendance_locked_days", "locked attendance context"),
        ("attendance_manual_days", "manual attendance context"),
        ("override_days", "override context"),
        ("payroll_status", "safe calculated/not_calculated status"),
        ("has_persisted_payroll_result", "safe persisted payroll existence flag"),
        ("valid_actor_days", "canonical accepted GPS plus approved override day union"),
        ("gps_event_id is null", "override-only day support"),
        ("override_decision in ('accepted', 'excused')", "actual accepted/excused override contract"),
        ("count(distinct actor_day_key)", "one valid day per actor/date without double count"),
        ("not_calculated", "missing persisted payroll marker"),
        ("revoke all on function public.get_payroll_gps_attendance_preview", "explicit revoke"),
        ("grant execute on function public.get_payroll_gps_attendance_preview", "explicit grant"),
    ]:
        assert_contains(s if label.endswith("RPC") or "revoke" in label or "grant" in label else fn, needle, label)
    assert len(re.findall(r"language\s+plpgsql", fn)) <= 1, "Task8 migration should contain one PL/pgSQL RPC body"


def test_task8_rpc_is_read_only_for_payroll_and_privacy_minimized() -> None:
    fn = function_body()
    for forbidden in PAYROLL_MUTATION_TOKENS:
        assert_not_contains(fn, forbidden, f"payroll mutation in preview RPC: {forbidden}")
    assert_not_contains(fn, "public.payroll_calculate_run", "preview must not invoke calculating mutator")
    assert_not_contains(fn, "employee_wage_profiles", "preview must not read mutable current salary profiles")
    for forbidden in [
        "base_monthly_salary",
        "hourly_rate",
        "per_shift_rate",
        "existing_net_amount",
        "existing_payroll_snapshot",
        "pl.net_amount",
        "pl.snapshot",
        "snapshot as",
        "net_amount as",
    ]:
        assert_not_contains(fn, forbidden, f"preview RPC leaks salary/payroll-money/snapshot field {forbidden}")
    for forbidden in SENSITIVE_TOKENS:
        assert_not_contains(fn, forbidden, f"RPC leaks sensitive GPS/request detail {forbidden}")


def test_payroll_management_renders_clear_preview_ui_without_apply_action() -> None:
    p = page()
    for needle, label in [
        ("xem trước gps — chưa tính/chốt lương", "Vietnamese preview-only title"),
        ("gps payroll preview", "English preview-only title"),
        ("data-testid=\"payroll-gps-preview\"", "stable preview UI marker"),
        ("get_payroll_gps_attendance_preview", "preview RPC call"),
        ("p_preview_only: true", "client explicitly passes preview-only flag"),
        ("gpspreviewmetrics", "preview metrics rendered"),
        ("gpspreviewrows.map", "per-employee preview rows rendered"),
        ("row.employee_code", "employee code rendered"),
        ("row.gps_valid_days", "GPS days rendered"),
        ("row.attendance_present_days", "attendance days rendered"),
        ("row.payroll_total_days_present", "payroll days rendered"),
        ("row.gps_vs_attendance_days_delta", "attendance discrepancy rendered"),
        ("row.gps_vs_payroll_days_delta", "payroll discrepancy rendered"),
        ("row.attendance_locked_days", "locked context rendered"),
        ("row.attendance_manual_days", "manual context rendered"),
        ("row.override_days", "override context rendered"),
        ("row.payroll_status", "payroll status rendered"),
        ("not_calculated", "not-calculated status shown"),
        ("no payroll action", "no-apply explanation"),
    ]:
        assert_contains(p, needle, label)
    for forbidden in ["apply gps", "apply preview", "chốt gps", "tính/chốt gps"] + SENSITIVE_TOKENS:
        assert_not_contains(p, forbidden, f"preview UI exposes forbidden action/detail {forbidden}")



def test_payroll_management_missing_preview_rpc_is_capability_unavailable_only() -> None:
    p = page()
    for needle, label in [
        ("ispostgrestmissingrpc", "missing preview RPC detector"),
        ("capability_unavailable: true", "preview missing RPC state"),
        ("payroll_gps_preview_unavailable", "stable unavailable marker"),
        ("awaiting backend migration", "awaiting backend copy"),
        ("existing payroll actions remain available", "existing UI/actions preserved copy"),
        ("throw error", "real non-missing-RPC errors still surface"),
    ]:
        assert_contains(p, needle, label)


def test_executable_smoke_covers_required_task8_runtime_matrix_and_no_mutation_proof() -> None:
    s = uncommented(smoke())
    for needle, label in [
        ("begin;", "transactional smoke"),
        ("rollback;", "rollback cleanup"),
        ("double_apply_idempotent", "double-apply/rerunnable marker"),
        ("kiosk_and_delivery_actor_rows", "both actor types"),
        ("accepted_rejected_overrides_aggregate", "accepted/rejected/override aggregation"),
        ("locked_manual_override_context", "locked/manual/override context"),
        ("preview_discrepancies_compare_attendance_and_payroll", "discrepancy proof"),
        ("viewer_can_preview_payroll", "payroll.view permission"),
        ("editor_can_preview_payroll", "payroll.edit permission"),
        ("unauthorized_user_rejected", "permission denial"),
        ("preview_only_false_rejected", "fail-closed preview flag"),
        ("broad_date_range_rejected", "date bounds"),
        ("payroll_tables_unchanged_by_rpc", "no payroll mutation proof"),
        ("safe_payload_has_no_coordinates_ip_ua", "privacy proof"),
        ("override_only_day_included", "override-only valid day"),
        ("delivery_override_only_actor_row", "override-only delivery row without GPS event"),
        ("attached_override_validates_rejected_gps", "attached accepted override validates rejected GPS"),
        ("double_count_prevented", "accepted GPS plus override counted once per day"),
        ("rejected_without_override_invalid", "rejected GPS without override stays invalid"),
        ("safe_payload_has_no_salary_snapshot_keys", "no salary/money/snapshot JSON keys"),
        ("raise exception", "real executable assertions"),
    ]:
        assert_contains(s, needle, label)
    assert_not_contains(s, "select 'payroll_tables_unchanged_by_rpc'", "marker-only no-mutation proof")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
