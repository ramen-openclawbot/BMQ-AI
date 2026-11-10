#!/usr/bin/env python3
"""Static contracts for GPS attendance import + attendance/schedule summary."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261110220000_payroll_bn_gps_attendance_import.sql"
SMOKE = ROOT / "scripts/smoke_payroll_bn_gps_attendance_import.sql"
DB_CLIENT = ROOT / "src/lib/payroll-bn/db-client.ts"
DB_CLIENT_TEST = ROOT / "src/lib/payroll-bn/db-client.test.ts"
DB_MAPPING = ROOT / "src/lib/payroll-bn/db-mapping.ts"
DB_MAPPING_TEST = ROOT / "src/lib/payroll-bn/db-mapping.test.ts"
TYPES = ROOT / "src/lib/payroll-bn/types.ts"

FUNCTIONS = [
    "payroll_bn_gps_admin_allowed",
    "payroll_bn_gps_attendance_rows",
    "preview_payroll_bn_gps_attendance",
    "import_payroll_bn_gps_attendance",
    "get_payroll_bn_period_schedule_summary",
]


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def sql() -> str:
    return read(MIGRATION).lower()


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def function_body(text: str, name: str) -> str:
    start = text.index(f"create or replace function public.{name}")
    end = text.index("$sql$;", start) if "$sql$;" in text[start:] else text.index("$$;", start)
    return text[start:end]


def test_source_column_and_check() -> None:
    s = sql()
    for needle, label in [
        (
            "add column if not exists source text default 'machine'",
            "source column",
        ),
        ("check (source in ('machine', 'gps'))", "source check"),
        ("payroll_bn_attendance_imports_source_check", "source constraint"),
    ]:
        assert_contains(s, needle, label)


def test_three_rpcs_are_security_definer_with_search_path() -> None:
    s = sql()
    for name in FUNCTIONS:
        body = function_body(s, name)
        assert "security definer" in body, f"{name} must be security definer"
        assert "set search_path = public" in body, f"{name} must set search_path"


def test_grants_nothing_to_anon() -> None:
    s = sql()
    for rpc, signature in [
        ("preview_payroll_bn_gps_attendance", "uuid, date, date"),
        ("import_payroll_bn_gps_attendance", "uuid, date, date"),
        ("get_payroll_bn_period_schedule_summary", "uuid"),
    ]:
        assert_contains(
            s,
            f"revoke all on function public.{rpc}({signature})\n"
            "  from public, anon, authenticated;",
            f"{rpc} revoke",
        )
        assert_contains(
            s,
            f"grant execute on function public.{rpc}({signature})\n"
            "  to authenticated, service_role;",
            f"{rpc} grant",
        )

    for rpc, signature in [
        ("payroll_bn_gps_admin_allowed", "uuid"),
        ("payroll_bn_gps_attendance_rows", "uuid, date, date"),
    ]:
        assert_contains(
            s,
            f"revoke all on function public.{rpc}({signature})\n"
            "  from public, anon, authenticated;",
            f"{rpc} revoke",
        )
        assert (
            f"grant execute on function public.{rpc}({signature})\n"
            "  to authenticated" not in s
        ), f"{rpc} must not be granted to authenticated"

    assert " to anon" not in s, "nothing may be granted to anon"


def test_import_refuses_locked_and_uses_on_conflict_do_nothing() -> None:
    s = sql()
    import_body = function_body(s, "import_payroll_bn_gps_attendance")
    for needle, label in [
        ("v_period.status = 'locked'", "locked period check"),
        ("payroll_bn_period_locked", "locked error"),
        ("55006", "locked sqlstate"),
        ("on conflict (period_id, employee_code, work_date) do nothing", "row upsert skip"),
        ("on conflict (period_id, sha256) do nothing", "import dedupe"),
        ("'gps'", "gps source"),
        ("sha256(convert_to(", "canonical sha"),
        ("encode(", "hex sha"),
        ("row_count = v_inserted", "real inserted count"),
        ("attendance_approved_at = null", "approval reset"),
        ("jsonb_array_length(v_to_insert) = 0", "empty no-import path"),
        ("already_imported", "already imported flag"),
        ("skipped_codes", "skipped codes"),
    ]:
        assert_contains(import_body, needle, label)


def test_import_never_updates_or_deletes_attendance_rows() -> None:
    s = sql()
    forbidden = [
        "update public.payroll_bn_attendance_rows",
        "delete from public.payroll_bn_attendance_rows",
        "update public.payroll_bn_attendance_events",
        "delete from public.payroll_bn_attendance_events",
    ]
    for needle in forbidden:
        assert needle not in s, f"migration must not contain {needle!r}"


def test_preview_and_summary_are_read_only() -> None:
    s = sql()
    for name in ("preview_payroll_bn_gps_attendance", "get_payroll_bn_period_schedule_summary"):
        body = function_body(s, name)
        for forbidden in ("insert into", "update public.", "delete from"):
            assert forbidden not in body, f"{name} must be read-only ({forbidden})"


def test_helper_uses_first_in_last_out_and_published_shift_late() -> None:
    s = sql()
    body = function_body(s, "payroll_bn_gps_attendance_rows")
    for needle, label in [
        ("min(e.server_received_at)", "first accepted in"),
        ("max(e.server_received_at)", "last accepted out"),
        ("event_kind = 'in'", "in event"),
        ("event_kind = 'out'", "out event"),
        ("e.decision = 'accepted'", "accepted only"),
        ("at time zone 'asia/ho_chi_minh'", "ICT time"),
        ("b.check_out_at > b.check_in_at", "out after in"),
        ("payroll_bn_shift_weeks", "published week lookup"),
        ("w.status = 'published'", "published only"),
        ("payroll_bn_shift_types", "shift start"),
        ("late_grace_minutes", "grace setting"),
        ("'late_minutes'", "late minutes"),
        ("'scheduled_shift_code'", "scheduled shift code"),
        ("'scheduled_start'", "scheduled start"),
        ("'has_override'", "override flag"),
        ("'already_in_period'", "already in period"),
        ("'skipped_codes'", "skipped codes"),
        ("payroll_bn_gps_range_invalid", "range error"),
        ("payroll_bn_period_not_found", "period not found"),
    ]:
        assert_contains(body, needle, label)


def test_summary_counts_and_covered_range() -> None:
    s = sql()
    body = function_body(s, "get_payroll_bn_period_schedule_summary")
    for needle, label in [
        ("payroll_bn_shift_eligible", "eligibility"),
        ("payroll_bn_shift_week_start", "week start"),
        ("w.status = 'published'", "published weeks"),
        ("closed_dates", "closed dates"),
        ("'scheduled_days'", "scheduled days"),
        ("'off_days'", "off days"),
        ("'worked_days'", "worked days"),
        ("'worked_scheduled'", "worked scheduled"),
        ("'no_show_days'", "no show"),
        ("'unscheduled_days'", "unscheduled"),
        ("'late_days'", "late days"),
        ("'late_minutes_total'", "late minutes"),
        ("'missing_out_days'", "missing out"),
        ("'approved_leaves'", "approved leaves"),
        ("'approved_changes'", "approved changes"),
        ("'covered_from'", "covered from"),
        ("'covered_to'", "covered to"),
        ("'details'", "details"),
        ("payroll_bn_attendance_day_overrides", "day override"),
        ("payroll_bn_attendance_rows", "attendance rows"),
        ("'no_show'", "no show kind"),
        ("'late'", "late kind"),
        ("'unscheduled'", "unscheduled kind"),
        ("'missing_out'", "missing out kind"),
    ]:
        assert_contains(body, needle, label)


def test_existing_machine_import_is_not_redefined() -> None:
    s = sql()
    assert "create or replace function public.payroll_bn_import_attendance" not in s, (
        "the applied machine-file import must not be redefined"
    )


def test_client_functions_types_and_mapping() -> None:
    client = read(DB_CLIENT)
    for needle, label in [
        ("previewGpsAttendance", "preview function"),
        ("importGpsAttendance", "import function"),
        ("getPeriodScheduleSummary", "summary function"),
        ("preview_payroll_bn_gps_attendance", "preview RPC"),
        ("import_payroll_bn_gps_attendance", "import RPC"),
        ("get_payroll_bn_period_schedule_summary", "summary RPC"),
        ("normalizeImportSource", "source mapping"),
        ("source: normalizeImportSource(row.source)", "import source"),
    ]:
        assert_contains(client, needle, label)

    types = read(TYPES)
    for needle, label in [
        ("export interface GpsAttendancePreview", "preview type"),
        ("export interface GpsAttendanceImportResult", "import type"),
        ("export interface PeriodScheduleSummary", "summary type"),
        ("export type AttendanceImportSource", "source type"),
        ("export interface GpsAttendancePreviewRow", "preview row type"),
        ("export interface PeriodScheduleEmployee", "summary employee type"),
    ]:
        assert_contains(types, needle, label)

    mapping = read(DB_MAPPING)
    for needle, label in [
        ("export function mapGpsAttendancePreview", "preview mapper"),
        ("export function mapGpsAttendanceImportResult", "import mapper"),
        ("export function mapPeriodScheduleSummary", "summary mapper"),
        ("export function normalizeImportSource", "source normalizer"),
    ]:
        assert_contains(mapping, needle, label)

    client_test = read(DB_CLIENT_TEST)
    for needle, label in [
        ("previewGpsAttendance sends the period/date range", "preview test"),
        ("importGpsAttendance maps inserted rows", "import test"),
        ("getPeriodScheduleSummary sends the period id", "summary test"),
        ("Kỳ lương đã chốt", "locked message test"),
        ("Khoảng ngày lấy chấm công GPS", "range message test"),
    ]:
        assert_contains(client_test, needle, label)

    mapping_test = read(DB_MAPPING_TEST)
    for needle, label in [
        ("mapGpsAttendancePreview maps rows", "preview mapping test"),
        ("mapGpsAttendanceImportResult maps", "import mapping test"),
        ("mapPeriodScheduleSummary maps counts", "summary mapping test"),
        ("normalizeImportSource defaults", "source mapping test"),
    ]:
        assert_contains(mapping_test, needle, label)


def test_smoke_covers_required_cases() -> None:
    smoke = read(SMOKE)
    lowered = smoke.lower()
    for needle, label in [
        ("begin;", "transaction"),
        ("do $$", "single DO block"),
        ("set_config('request.jwt.claims'", "service-role claims"),
        ("rollback;", "rollback-only"),
        ("task_smoke_group", "throwaway group"),
        ("preview_payroll_bn_gps_attendance", "preview"),
        ("import_payroll_bn_gps_attendance", "import"),
        ("get_payroll_bn_period_schedule_summary", "summary"),
        ("payroll_bn_shift_week_start", "week helper"),
        ("first_in_last_out_unexpected", "first-in/last-out"),
        ("machine_row_overwritten", "machine row preserved"),
        ("second_import_inserted_rows", "second import"),
        ("task_gps_outside", "outside code"),
        ("late_minutes_unexpected", "late minutes"),
        ("late_without_shift_not_null", "late null without shift"),
        ("payroll_bn_period_locked", "locked period"),
        ("non_manager_not_blocked", "non-manager"),
        ("no_show", "no show"),
        ("unscheduled", "unscheduled"),
        ("missing_out", "missing out"),
        ("approved_leaves", "approved leave"),
        ("payroll_bn_import_attendance", "machine import still works"),
        ("gps_import_smoke_pass", "final notice"),
    ]:
        assert_contains(lowered, needle, label)

    assert smoke.count("do $$") == 1, "smoke must be one DO block"
    assert "\\set" not in smoke and "\\gset" not in smoke, "smoke must be pure SQL"
    assert "commit;" not in lowered, "smoke must never commit"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
