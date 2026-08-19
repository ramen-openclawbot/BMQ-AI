#!/usr/bin/env python3
"""Task10 contracts for default-off mobile GPS attendance pilot rollout gate."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIGRATION_GLOB = "202608191630*_mobile_gps_attendance_rollout_gate*.sql"
PORTAL = ROOT / "src/pages/KioskReportPortal.tsx"
REPORT_SHARED = ROOT / "supabase/functions/_shared/report.ts"
REPORT_SESSION = ROOT / "supabase/functions/report-session/index.ts"
AUTH_VERIFY = ROOT / "supabase/functions/report-auth-verify/index.ts"
REPORT_SHARED_TEST = ROOT / "supabase/functions/_shared/report.test.ts"
ATTENDANCE_HANDLER = ROOT / "supabase/functions/attendance-check-in/handler.ts"
ATTENDANCE_TEST = ROOT / "supabase/functions/attendance-check-in/handler.test.ts"
SMOKE = ROOT / "scripts/smoke_mobile_gps_attendance_rollout_gate_task10.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")



def read_task10_migrations() -> str:
    paths = sorted((ROOT / "supabase/migrations").glob(MIGRATION_GLOB))
    assert paths, "Missing Task10 rollout gate migrations"
    return "\n".join(read(path) for path in paths)

def sql_without_comments(text: str) -> str:
    return re.sub(r"--.*", "", text)


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def assert_not_contains(text: str, needle: str, label: str) -> None:
    assert needle not in text, f"Unexpected {label}: {needle!r}"


def test_rollout_gate_schema_is_default_off_audited_and_owner_attendance_edit_managed() -> None:
    sql = read_task10_migrations()
    uncommented = sql_without_comments(sql).lower()
    for needle, label in [
        ("create table if not exists public.mobile_gps_attendance_pilot_actor_gates", "pilot actor gate table"),
        ("actor_type text not null", "actor type column"),
        ("actor_id uuid not null", "exact actor id column"),
        ("enabled boolean not null default false", "default-off enabled flag"),
        ("created_by uuid not null default auth.uid()", "audit creator"),
        ("updated_by uuid not null default auth.uid()", "audit updater"),
        ("create table if not exists public.mobile_gps_attendance_pilot_actor_gate_audit_logs", "audit log table"),
        ("audit_mobile_gps_attendance_pilot_actor_gate_change", "audit trigger function"),
        ("actor_type in ('report_staff', 'delivery_staff')", "actor allowlist"),
        ("unique(actor_type, actor_id)", "one row per actor"),
        ("has_module_permission((select auth.uid()), 'attendance', 'edit')", "attendance edit boundary"),
        ("has_role((select auth.uid()), 'owner')", "owner boundary"),
    ]:
        assert_contains(sql, needle, label)
    for forbidden in ["insert into public.mobile_gps_attendance_pilot_actor_gates", "warehouse_tan_tao', true", "enabled = true"]:
        assert_not_contains(uncommented, forbidden, f"automatic enable/seed {forbidden}")


def test_safe_session_payload_exposes_only_attendance_enabled_boolean_and_defaults_false() -> None:
    shared = read(REPORT_SHARED)
    session = read(REPORT_SESSION)
    verify = read(AUTH_VERIFY)
    shared_test = read(REPORT_SHARED_TEST)
    for source, label in [(shared, "shared report helpers"), (session, "report-session"), (verify, "report-auth-verify")]:
        assert_contains(source, "attendance_enabled", label)
    for needle, label in [
        ("resolveAttendanceEnabled", "server-side gate resolver"),
        ("resolvePostOtpAttendanceEnabled", "post-OTP gate resolver"),
        ("attendance_enabled = false", "fail closed default"),
        ("gateRpcName", "minimal boolean RPC name indirection"),
    ]:
        assert_contains(shared, needle, label)
    for needle, label in [
        ("resolvePostOtpAttendanceEnabled", "report-auth-verify calls shared post-OTP resolver"),
        ("const attendanceEnabled = await resolvePostOtpAttendanceEnabled(supabase, result)", "immediate post-OTP gate wiring"),
        ("attendance_enabled: attendanceEnabled === true", "auth verify response uses resolved boolean"),
    ]:
        assert_contains(verify, needle, label)
    assert_not_contains(verify, "result.attendance_enabled", "trusting nonexistent RPC attendance flag")
    for needle, label in [
        ("post-OTP attendance resolver returns true for enabled delivery actor", "Deno enabled gate test"),
        ("post-OTP attendance resolver returns false for disabled report actor", "Deno disabled gate test"),
        ("immediate post-OTP response can receive attendance_enabled true without session reload", "immediate UI true Deno proof"),
        ("assert.equal(deps.rpcCalls[0].args.p_actor_id", "exact actor ID assertion"),
    ]:
        assert_contains(shared_test, needle, label)
    public_profile_body = shared.split("export function publicReportActorProfile", 1)[1].split("export function publicReportStaffProfile", 1)[0]
    for forbidden in ["actor_id", "enabled_by", "enabled_at", "gate", "geofence", "latitude", "longitude"]:
        assert_not_contains(public_profile_body, forbidden, f"session payload leaks {forbidden}")


def test_portal_renders_attendance_card_only_when_session_boolean_is_true() -> None:
    portal = read(PORTAL)
    for needle, label in [
        ("attendance_enabled?: boolean", "typed session boolean"),
        ("const [attendanceEnabled, setAttendanceEnabled] = useState(false)", "default false state"),
        ("setAttendanceEnabled(sessionResult.data.attendance_enabled === true)", "old session response defaults false"),
        ("setAttendanceEnabled(result.data.attendance_enabled === true)", "auth verify response defaults false"),
        ("attendanceEnabled && <AttendanceCheckInCard", "conditional report-staff card"),
        ("attendanceEnabled && (", "conditional delivery card"),
        ('setAttendanceEnabled(false)', "logout/clear disables attendance UI"),
    ]:
        assert_contains(portal, needle, label)
    assert portal.count("<AttendanceCheckInCard") == 2, "only two attendance card render sites should remain"


def test_attendance_check_in_independently_enforces_gate_before_geofence_or_ledger() -> None:
    handler = read(ATTENDANCE_HANDLER)
    test = read(ATTENDANCE_TEST)
    for needle, label in [
        ("resolveAttendanceActorGate", "server-side gate resolver"),
        ("attendance_pilot_not_enabled", "fail-closed code"),
        ("if (!gate.enabled)", "gate branch"),
        ("loadCandidateGeofences", "geofence resolver"),
        ("recordAttendanceEvent", "ledger writer"),
    ]:
        assert_contains(handler, needle, label)
    gate_index = handler.index("resolveAttendanceActorGate")
    geofence_index = handler.index("loadCandidateGeofences(supabase, sessionContext)")
    ledger_index = handler.index("recordAttendanceEvent({ supabase")
    assert gate_index < geofence_index < ledger_index, "gate must run before geofence lookup and ledger writes"
    for needle, label in [
        ("attendance-check-in fails closed before geofence lookup when pilot gate disabled", "disabled gate Deno test"),
        ("attendance-check-in allows enabled pilot actor to continue to geofence and ledger", "enabled gate Deno test"),
        ("assert.equal(deps.geofenceTableReads, 0)", "disabled gate skips geofence"),
        ("assert.equal(deps.rpcCalls.length, 0)", "disabled gate skips ledger"),
    ]:
        assert_contains(test, needle, label)


def test_readiness_rpc_returns_counts_codes_only_without_precise_coordinates() -> None:
    sql = read_task10_migrations()
    readiness = sql.split("get_mobile_gps_attendance_rollout_readiness", 1)[1]
    for needle, label in [
        ("returns jsonb", "readiness JSON"),
        ("enabled_actor_count", "enabled count"),
        ("active_geofences_missing_coordinates_count", "missing coords count"),
        ("enabled_actors_missing_geofence_count", "enabled without geofence count"),
        ("enabled_actors_missing_geofence_codes", "safe actor codes"),
        ("geofences_missing_coordinates_codes", "safe geofence codes"),
        ("has_role(v_actor, 'owner')", "owner auth"),
        ("has_module_permission(v_actor, 'attendance', 'edit')", "attendance edit auth"),
    ]:
        assert_contains(readiness, needle, label)
    for forbidden in ["'latitude'", "'longitude'", "'device_latitude'", "'device_longitude'", "'request_ip'", "'user_agent'"]:
        assert_not_contains(readiness.lower(), forbidden, f"readiness coordinate/private leak {forbidden}")


def test_executable_sql_smoke_covers_disabled_enabled_readiness_and_regression() -> None:
    smoke = read(SMOKE)
    uncommented = sql_without_comments(smoke).lower()
    for needle, label in [
        ("begin;", "rollback smoke transaction"),
        ("rollback;", "rollback cleanup"),
        ("attendance_pilot_not_enabled", "disabled actor fail-closed probe"),
        ("attendance_geofence_not_configured", "enabled without geofence coordinates probe"),
        ("within_geofence", "enabled configured geofence success probe"),
        ("get_mobile_gps_attendance_rollout_readiness", "readiness probe"),
        ("report-daily-save", "report regression marker"),
        ("raise exception", "executable assertions"),
    ]:
        assert_contains(smoke, needle, label)
    for forbidden in ["10.000000", "106.000000", "device_latitude", "request_ip_hash", "user_agent"]:
        assert_not_contains(uncommented.split("get_mobile_gps_attendance_rollout_readiness", 1)[-1], forbidden, f"readiness leak in smoke {forbidden}")
