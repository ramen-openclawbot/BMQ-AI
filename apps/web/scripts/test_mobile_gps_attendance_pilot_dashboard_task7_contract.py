#!/usr/bin/env python3
"""Task7 contracts for mobile GPS attendance pilot dashboard and exception reconciliation."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"
TASK7_MIGRATION = MIGRATIONS / "20260819133000_mobile_gps_attendance_pilot_dashboard.sql"
ATTENDANCE_PAGE = ROOT / "src/pages/AttendanceManagement.tsx"
SMOKE = ROOT / "scripts/smoke_mobile_gps_attendance_pilot_dashboard_task7.sql"

SENSITIVE_TOKENS = [
    "device_latitude",
    "device_longitude",
    "geofence_latitude",
    "geofence_longitude",
    "request_ip_hash",
    "request_user_agent",
]


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def uncommented(text: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines()).lower()


def sql() -> str:
    return read(TASK7_MIGRATION).lower()


def page() -> str:
    return read(ATTENDANCE_PAGE).lower()


def smoke() -> str:
    return read(SMOKE).lower()


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def assert_not_contains(text: str, needle: str, label: str) -> None:
    assert needle not in text, f"Unexpected {label}: {needle!r}"


def test_task7_migration_creates_safe_view_and_bounded_security_definer_rpc() -> None:
    s = sql()
    u = uncommented(s)
    for needle, label in [
        ("create or replace view public.mobile_gps_attendance_pilot_event_summaries", "safe aggregate event view"),
        ("create or replace function public.get_mobile_gps_attendance_pilot_dashboard", "pilot dashboard RPC"),
        ("security definer", "RPC security definer boundary"),
        ("set search_path = public", "fixed search path"),
        ("public.has_role(v_actor, 'owner')", "owner ACL"),
        ("public.has_module_permission(v_actor, 'attendance', 'view')", "attendance.view ACL"),
        ("public.has_module_permission(v_actor, 'attendance', 'edit')", "attendance.edit ACL"),
        ("mobile_gps_attendance_pilot_dashboard_forbidden", "fail-closed ACL error"),
        ("least(greatest(coalesce(p_limit, 50), 1), 200)", "bounded page size"),
        ("coalesce(p_date_from, (now() at time zone 'asia/ho_chi_minh')::date)", "server VN date default"),
        ("coalesce(p_date_to, v_date_from)", "bounded date default"),
        ("row_number() over (order by", "keyset-ish bounded ordering window"),
        ("round(e.distance_m, 0)", "rounded distance"),
        ("round(e.device_accuracy_m, 0)", "rounded accuracy"),
        ("duplicate", "duplicate/already checked in reason support"),
        ("already_checked_in", "stable duplicate reason code"),
        ("low_accuracy", "low-accuracy metric/reason"),
        ("outside_radius", "outside-radius metric/reason"),
        ("override_count", "override metric"),
        ("success_rate", "success rate metric"),
        ("jsonb_agg", "bounded event payload"),
        ("revoke all on function public.get_mobile_gps_attendance_pilot_dashboard", "explicit revoke"),
        ("grant execute on function public.get_mobile_gps_attendance_pilot_dashboard", "explicit authenticated grant"),
    ]:
        assert_contains(s, needle, label)
    assert len(re.findall(r"language\s+plpgsql", u)) <= 1, "Task7 migration must contain at most one PL/pgSQL body"
    for forbidden in SENSITIVE_TOKENS:
        view_section = u.split("create or replace view public.mobile_gps_attendance_pilot_event_summaries", 1)[1].split("create or replace function", 1)[0]
        assert_not_contains(view_section, forbidden, f"safe pilot view leaks {forbidden}")


def test_task7_rpc_filters_metrics_and_payload_do_not_expose_sensitive_gps_or_request_details() -> None:
    s = uncommented(sql())
    fn = s.split("create or replace function public.get_mobile_gps_attendance_pilot_dashboard", 1)[1]
    for needle, label in [
        ("p_date_from date default null", "date-from filter"),
        ("p_date_to date default null", "date-to filter"),
        ("p_employee_query text default null", "employee filter"),
        ("p_actor_type text default null", "actor type filter"),
        ("p_geofence_query text default null", "location/geofence filter"),
        ("p_decision text default null", "decision filter"),
        ("where e.work_date between v_date_from and v_date_to", "date-range predicate"),
        ("and (p_actor_type is null or e.actor_type = p_actor_type)", "actor predicate"),
        ("and (p_decision is null or e.decision = p_decision)", "decision predicate"),
        ("event_count", "metric count"),
        ("accepted_count", "accepted metric"),
        ("rejected_count", "rejected metric"),
        ("low_accuracy_count", "low accuracy metric"),
        ("outside_radius_count", "outside radius metric"),
        ("duplicate_count", "duplicate metric"),
        ("override_count", "override metric"),
        ("has_next_page", "pagination marker"),
    ]:
        assert_contains(fn, needle, label)
    for forbidden in SENSITIVE_TOKENS:
        assert_not_contains(fn, f"'{forbidden}'", f"RPC JSON payload exposes {forbidden}")


def test_attendance_management_renders_pilot_tab_controls_metrics_events_and_pagination() -> None:
    p = page()
    for needle, label in [
        ("<tabstrigger value=\"pilot\"", "visible pilot tab trigger"),
        ("<tabscontent value=\"pilot\"", "matching pilot tabs content"),
        ("data-testid=\"attendance-pilot-dashboard\"", "pilot dashboard section marker"),
        ("get_mobile_gps_attendance_pilot_dashboard", "pilot RPC query"),
        ("p_date_from: pilotdatefrom || null", "date-from filter wired to RPC"),
        ("p_date_to: pilotdateto || pilotdatefrom || null", "date-to filter wired to RPC"),
        ("p_employee_query: pilotemployeequery.trim() || null", "employee filter wired to RPC"),
        ("p_actor_type: pilotactortype || null", "actor filter wired to RPC"),
        ("p_geofence_query: pilotgeofencequery.trim() || null", "location filter wired to RPC"),
        ("p_decision: pilotdecision || null", "decision filter wired to RPC"),
        ("setpilotdatefrom", "date-from control changes state"),
        ("setpilotdateto", "date-to control changes state"),
        ("setpilotemployeequery", "employee control changes state"),
        ("setpilotactortype", "actor control changes state"),
        ("setpilotgeofencequery", "location control changes state"),
        ("setpilotdecision", "decision control changes state"),
        ("setpilotoffset(0)", "filter changes reset pagination"),
        ("pilotmetrics.success_rate", "success-rate metric rendered from dashboard"),
        ("pilotmetrics.low_accuracy_count", "low accuracy metric rendered from dashboard"),
        ("pilotmetrics.outside_radius_count", "outside radius metric rendered from dashboard"),
        ("pilotmetrics.override_count", "override metric rendered from dashboard"),
        ("pilotmetrics.duplicate_count", "duplicate metric rendered from dashboard"),
        ("pilotattendanceevents.map", "actual pilot event iteration"),
        ("formatpilotreason(row.reason_code)", "stable reason labels rendered per row"),
        ("row.decision === \"accepted\"", "accepted/rejected badges rendered"),
        ("row.distance_m_rounded", "rounded distance rendered"),
        ("row.accuracy_m_rounded", "rounded accuracy rendered"),
        ("row.has_override", "override indicator rendered"),
        ("formatpilotreason(\"already_checked_in\")", "duplicate indicator rendered"),
        ("pilotpagination?.has_next_page", "next-page state rendered"),
        ("setpilotoffset(pilotoffset +", "next-page control advances offset"),
        ("math.max(0, pilotoffset -", "previous-page control bounds offset"),
    ]:
        assert_contains(p, needle, label)
    for forbidden in SENSITIVE_TOKENS + ["<map", "google.maps", "leaflet", "mapbox"]:
        assert_not_contains(p, forbidden, f"UI leaks raw coordinate/tracking detail {forbidden}")



def test_attendance_management_is_frontend_compatible_before_task6_task7_migrations() -> None:
    p = page()
    for needle, label in [
        ("provenance_attendance_record_select", "new provenance select is isolated"),
        ("legacy_attendance_record_select", "legacy attendance_records select fallback"),
        ("ispostgrestundefinedcolumn", "undefined-column/schema-cache fallback guard"),
        ("referencesprovenancecolumn", "fallback requires a named provenance column"),
        ('code === "42703"', "PostgreSQL undefined-column code"),
        ('code === "pgrst204"', "PostgREST missing-column code"),
        ("source_type: null", "legacy rows map null source_type"),
        ("source_event_id: null", "legacy rows map null source_event_id"),
        ("source_actor_type: null", "legacy rows map null source_actor_type"),
        ("source_distance_m: null", "legacy rows map null source_distance_m"),
        ("source_accuracy_m: null", "legacy rows map null source_accuracy_m"),
        ("ispostgrestmissingrpc", "missing pilot RPC detector"),
        ("capability_unavailable: true", "pilot missing RPC capability-unavailable state"),
        ("records, events, and planner tabs remain available", "unavailable copy preserves other tabs"),
        ("throw error", "real non-compatibility errors still surface"),
    ]:
        assert_contains(p, needle, label)
    assert_not_contains(p, 'message.includes("column")', "generic column errors must not trigger compatibility fallback")


def test_task7_rpc_rejects_invalid_and_over_broad_date_ranges() -> None:
    s = uncommented(sql())
    fn = s.split("create or replace function public.get_mobile_gps_attendance_pilot_dashboard", 1)[1]
    for needle, label in [
        ("mobile_gps_attendance_pilot_dashboard_invalid_date_range", "stable reversed range error"),
        ("mobile_gps_attendance_pilot_dashboard_date_range_too_broad", "stable broad range error"),
        ("v_date_to - v_date_from > 89", "90-day inclusive server-side cap"),
        ("where e.work_date between v_date_from and v_date_to", "bounded date predicate before scan result"),
    ]:
        assert_contains(fn, needle, label)
    for needle, label in [
        ("mobile_gps_attendance_events_work_date_decision_actor_idx", "work_date/decision/actor index"),
        ("on public.mobile_gps_attendance_events(work_date desc, decision, actor_type, created_at desc)", "bounded event scan index order"),
    ]:
        assert_contains(s, needle, label)


def test_executable_smoke_covers_acl_filters_metrics_pagination_and_sensitive_field_absence() -> None:
    s = uncommented(smoke())
    for needle, label in [
        ("begin;", "transactional smoke"),
        ("rollback;", "rollback cleanup"),
        ("viewer_can_read_safe_summary", "viewer ACL probe"),
        ("attendance_editor_can_read_safe_summary", "editor ACL probe"),
        ("unauthorized_user_rejected", "unauthorized ACL probe"),
        ("date_employee_actor_geofence_decision_filters", "filter probe"),
        ("metrics_success_low_accuracy_outside_duplicate_override", "metric probe"),
        ("pagination_is_bounded", "pagination probe"),
        ("safe_payload_has_no_coordinates_ip_ua", "privacy probe"),
        ("detail_coordinates_only_allowlist_view", "coordinate detail allowlist probe"),
        ("invalid_date_range_rejected", "reversed range rejection probe"),
        ("broad_date_range_rejected", "over-90-day rejection probe"),
        ("valid_90_day_range_accepted", "valid capped range acceptance probe"),
        ("double_apply_idempotent", "double-apply/rerunnable marker"),
        ("raise exception", "real assertions"),
    ]:
        assert_contains(s, needle, label)
    assert_not_contains(s, "select 'viewer_can_read_safe_summary'", "marker-only viewer probe")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
