#!/usr/bin/env python3
"""Static contracts for Task3 mobile GPS attendance immutable ledger."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"
TASK3_GLOB = "202608191130*.sql"
SMOKE = ROOT / "scripts/smoke_mobile_gps_attendance_ledger.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def task3_sql() -> str:
    paths = sorted(MIGRATIONS.glob(TASK3_GLOB))
    assert paths, "Missing Task3 attendance ledger migrations"
    return "\n".join(read(path) for path in paths)


def uncommented(sql: str) -> str:
    lines = []
    for line in sql.splitlines():
        lines.append(line.split("--", 1)[0])
    return "\n".join(lines).lower()


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def assert_not_contains(text: str, needle: str, label: str) -> None:
    assert needle not in text, f"Unexpected {label}: {needle!r}"


def test_task3_migrations_are_parser_safe_rerunnable_and_no_evidence_dml() -> None:
    paths = sorted(MIGRATIONS.glob(TASK3_GLOB))
    assert paths, "Missing Task3 migrations"
    for path in paths:
        source = read(path)
        lower = source.lower()
        function_count = lower.count("language plpgsql")
        assert function_count <= 1, f"Multiple PL/pgSQL functions in {path.name}"
        if function_count:
            closing = source.rfind("$$;")
            assert closing >= 0, f"Missing dollar-quoted function terminator in {path.name}"
            assert not source[closing + 3 :].strip(), f"Statements after PL/pgSQL function in {path.name}"
        assert (
            "if not exists" in lower
            or "drop trigger if exists" in lower
            or "create or replace function" in lower
            or ("revoke all on function" in lower and "grant execute on function" in lower)
            or (
                path.name in {
                    "20260819113021_record_mobile_gps_attendance_event_grants.sql",
                    "20260819113022_record_mobile_gps_attendance_event_service_role_grant.sql",
                }
                and ("revoke all on function" in lower or "grant execute on function" in lower)
            )
        )

    executable = uncommented(task3_sql())
    for forbidden in [
        "update public.mobile_gps_attendance_events",
        "delete from public.mobile_gps_attendance_events",
        "truncate public.mobile_gps_attendance_events",
    ]:
        assert_not_contains(executable, forbidden, "GPS evidence mutation in migration")


def test_attendance_event_schema_captures_actor_shape_gps_geofence_decision_and_metadata() -> None:
    sql = task3_sql().lower()
    for needle, label in [
        ("create table if not exists public.mobile_gps_attendance_events", "GPS ledger table"),
        ("actor_type text not null", "actor type"),
        ("check (actor_type in ('report_staff', 'delivery_staff'))", "actor allowlist"),
        ("kiosk_report_staff_id uuid references public.kiosk_report_staff(id) on delete restrict", "report staff FK"),
        ("delivery_staff_id uuid references public.delivery_staff(id) on delete restrict", "delivery staff FK"),
        ("mobile_gps_attendance_events_actor_shape_check", "exactly-one actor constraint"),
        ("work_date date not null", "Vietnam work date"),
        ("device_latitude numeric(9,6) not null", "device latitude"),
        ("device_longitude numeric(9,6) not null", "device longitude"),
        ("device_accuracy_m numeric(8,2) not null", "device accuracy"),
        ("device_captured_at timestamptz not null", "device captured time"),
        ("geofence_location_id uuid references public.attendance_geofence_locations(id) on delete restrict", "geofence FK"),
        ("geofence_code text not null", "geofence code snapshot"),
        ("geofence_name text not null", "geofence name snapshot"),
        ("geofence_location_type text not null", "geofence type snapshot"),
        ("geofence_latitude numeric(9,6) not null", "geofence latitude snapshot"),
        ("geofence_longitude numeric(9,6) not null", "geofence longitude snapshot"),
        ("geofence_radius_m integer not null", "geofence radius snapshot"),
        ("distance_m numeric(10,2) not null", "server distance"),
        ("decision text not null", "decision"),
        ("check (decision in ('accepted', 'rejected'))", "decision allowlist"),
        ("reason_code text not null", "stable reason code"),
        ("session_id uuid references public.kiosk_report_sessions(id) on delete restrict", "session reference"),
        ("request_ip_hash text", "minimized IP hash"),
        ("request_user_agent text", "minimized user agent"),
        ("created_at timestamptz not null default now()", "server created timestamp"),
        ("mobile_gps_attendance_events_work_date_vn_check", "server timestamp/work date CHECK"),
        ("work_date = (created_at at time zone 'asia/ho_chi_minh')::date", "Vietnam work_date derived from created_at"),
    ]:
        assert_contains(sql, needle, label)

    for needle in [
        "mobile_gps_attendance_events_device_latitude_check",
        "device_latitude between -90 and 90",
        "mobile_gps_attendance_events_device_longitude_check",
        "device_longitude between -180 and 180",
        "device_accuracy_m >= 0",
        "geofence_latitude between -90 and 90",
        "geofence_longitude between -180 and 180",
        "request_ip_hash ~ '^[0-9a-f]{64}$'",
    ]:
        assert_contains(sql, needle, f"coordinate/privacy guard {needle}")


def test_one_accepted_per_actor_day_allows_rejected_multiplicity() -> None:
    sql = task3_sql().lower()
    for needle, label in [
        ("mobile_gps_attendance_events_report_staff_one_accepted_per_day", "report staff partial unique index"),
        ("mobile_gps_att_events_delivery_one_accepted_day", "delivery staff partial unique index"),
        ("unique", "unique accepted constraint"),
        ("where decision = 'accepted' and actor_type = 'report_staff'", "report accepted-only predicate"),
        ("where decision = 'accepted' and actor_type = 'delivery_staff'", "delivery accepted-only predicate"),
    ]:
        assert_contains(sql, needle, label)
    assert "where decision = 'rejected'" not in sql


def test_ledger_is_immutable_and_writable_only_by_service_role_rpc() -> None:
    sql = task3_sql().lower()
    for needle, label in [
        ("alter table public.mobile_gps_attendance_events enable row level security", "ledger RLS"),
        ("revoke all on table public.mobile_gps_attendance_events from service_role", "service-role direct DML revoke"),
        ("revoke insert, update, delete, truncate on table public.mobile_gps_attendance_events from public, anon, authenticated", "browser direct DML revoke"),
        ("grant select on table public.mobile_gps_attendance_events to service_role", "service-role read-only direct grant"),
        ("grant select on table public.mobile_gps_attendance_events to authenticated", "read-only grant"),
        ("create trigger mobile_gps_attendance_events_immutable", "immutability trigger"),
        ("raise exception 'mobile_gps_attendance_events_are_immutable'", "immutability SQLSTATE marker"),
        ("create or replace function public.record_mobile_gps_attendance_event", "narrow insert RPC"),
        ("v_event_timestamp timestamptz := statement_timestamp()", "single authoritative server timestamp"),
        ("(v_event_timestamp at time zone 'asia/ho_chi_minh')::date", "server-derived Vietnam work date"),
        ("created_at\n  ) values", "RPC explicitly writes created_at from event timestamp"),
        ("security definer", "security definer RPC"),
        ("set search_path = public", "fixed search path"),
        ("revoke all on function public.record_mobile_gps_attendance_event", "RPC public revoke"),
        ("from public, anon, authenticated", "browser RPC denial"),
        ("grant execute on function public.record_mobile_gps_attendance_event", "RPC service-role grant"),
        ("to service_role", "service-role-only RPC"),
        ("insert into public.mobile_gps_attendance_events", "only RPC inserts evidence"),
    ]:
        assert_contains(sql, needle, label)

    function_sql = read(MIGRATIONS / "20260819113020_record_mobile_gps_attendance_event_function.sql").lower()
    assert_contains(function_sql, "revoke execute on function public.record_mobile_gps_attendance_event", "same-file function execute revoke after SECURITY DEFINER creation")
    assert function_sql.index("create or replace function public.record_mobile_gps_attendance_event") < function_sql.index("revoke execute on function public.record_mobile_gps_attendance_event")
    grants_sql = read(MIGRATIONS / "20260819113021_record_mobile_gps_attendance_event_grants.sql").lower()
    assert_not_contains(function_sql, "p_work_date date", "client-supplied work_date RPC parameter")
    assert_not_contains(grants_sql, "uuid,\n  date,\n  numeric", "legacy RPC grant signature with p_work_date")


def test_event_session_consistency_is_enforced_by_insert_trigger() -> None:
    sql = task3_sql().lower()
    for needle, label in [
        ("create or replace function public.validate_mobile_gps_attendance_event_insert", "event/session validator function"),
        ("create trigger mobile_gps_attendance_events_insert_validate", "event/session validator trigger"),
        ("before insert on public.mobile_gps_attendance_events", "insert-time validation boundary"),
        ("from public.kiosk_report_sessions", "session row loaded at DB boundary"),
        ("new.session_id", "event session checked"),
        ("new.actor_type is distinct from v_session.actor_type", "actor type consistency"),
        ("new.kiosk_report_staff_id is distinct from v_session.staff_id", "report staff consistency"),
        ("new.delivery_staff_id is distinct from v_session.delivery_staff_id", "delivery staff consistency"),
        ("mobile_gps_attendance_event_session_actor_mismatch", "session mismatch rejection marker"),
    ]:
        assert_contains(sql, needle, label)


def test_manual_override_linked_evidence_and_duplicate_contracts_are_enforced() -> None:
    sql = task3_sql().lower()
    for needle, label in [
        ("create or replace function public.validate_mobile_gps_attendance_manual_override_insert", "override validator function"),
        ("create trigger mobile_gps_attendance_manual_overrides_insert_validate", "override validator trigger"),
        ("before insert on public.mobile_gps_attendance_manual_overrides", "insert-time override validation"),
        ("from public.mobile_gps_attendance_events", "linked GPS evidence loaded"),
        ("new.gps_event_id is not null", "GPS-linked branch"),
        ("new.actor_type is distinct from v_event.actor_type", "override actor type evidence match"),
        ("new.work_date is distinct from v_event.work_date", "override work date evidence match"),
        ("new.kiosk_report_staff_id is distinct from v_event.kiosk_report_staff_id", "override report staff evidence match"),
        ("new.delivery_staff_id is distinct from v_event.delivery_staff_id", "override delivery staff evidence match"),
        ("mobile_gps_attendance_override_gps_event_mismatch", "override evidence mismatch marker"),
        ("mobile_gps_att_overrides_report_staff_one_per_day", "report staff duplicate override unique index"),
        ("mobile_gps_att_overrides_delivery_one_per_day", "delivery staff duplicate override unique index"),
        ("where actor_type = 'report_staff'", "report override partial predicate"),
        ("where actor_type = 'delivery_staff'", "delivery override partial predicate"),
    ]:
        assert_contains(sql, needle, label)


def test_coordinate_detail_view_uses_explicit_privacy_safe_allowlist() -> None:
    schema_sql = read(MIGRATIONS / "20260819113000_mobile_gps_attendance_ledger_schema.sql").lower()
    view_sql = schema_sql.split("create or replace view public.mobile_gps_attendance_event_coordinate_details", 1)[1].split("alter table public.mobile_gps_attendance_events", 1)[0]
    assert_not_contains(view_sql, "select *", "future-column leakage in coordinate detail view")
    for forbidden in ["request_ip_hash", "request_user_agent"]:
        assert_not_contains(view_sql, forbidden, "privacy metadata in coordinate detail view")
    for required in [
        "device_latitude",
        "device_longitude",
        "geofence_latitude",
        "geofence_longitude",
        "distance_m",
        "created_at",
    ]:
        assert_contains(view_sql, required, f"coordinate allowlist column {required}")


def test_attendance_reads_use_module_permissions_and_detailed_coordinates_are_limited() -> None:
    sql = task3_sql().lower()
    for needle, label in [
        ("mobile_gps_attendance_events_select_attendance_payroll", "module read policy"),
        ("has_module_permission((select auth.uid()), 'attendance', 'view')", "attendance view read"),
        ("has_module_permission((select auth.uid()), 'payroll', 'view')", "payroll view read"),
        ("create or replace view public.mobile_gps_attendance_event_summaries", "redacted summary view"),
        ("grant select on public.mobile_gps_attendance_event_summaries to authenticated", "summary view grant"),
        ("create or replace view public.mobile_gps_attendance_event_coordinate_details", "coordinate detail view"),
        ("mobile_gps_attendance_event_coordinate_details_select", "coordinate detail policy"),
        ("has_module_permission((select auth.uid()), 'attendance', 'edit')", "coordinate detail limited to operators"),
        ("has_module_permission((select auth.uid()), 'payroll', 'edit')", "payroll operator coordinate detail"),
    ]:
        assert_contains(sql, needle, label)


def test_manual_override_table_is_audited_and_separate_from_gps_evidence() -> None:
    sql = task3_sql().lower()
    for needle, label in [
        ("create table if not exists public.mobile_gps_attendance_manual_overrides", "manual override table"),
        ("gps_event_id uuid references public.mobile_gps_attendance_events(id) on delete restrict", "optional GPS evidence reference"),
        ("actor_type text not null", "override actor type"),
        ("work_date date not null", "override work date"),
        ("override_decision text not null", "override decision"),
        ("reason_code text not null", "override reason code"),
        ("reason_note text not null", "operator reason note"),
        ("created_by uuid not null default auth.uid()", "override actor audit server default"),
        ("created_at timestamptz not null default now()", "override timestamp"),
        ("mobile_gps_attendance_manual_overrides_actor_shape_check", "override actor shape"),
        ("alter table public.mobile_gps_attendance_manual_overrides enable row level security", "override RLS"),
        ("mgps_att_overrides_ins_att_payroll", "operator insert policy"),
        ("created_by = (select auth.uid())", "non-spoofable override actor policy"),
        ("created_by is not null", "null override actor rejected"),
    ]:
        assert_contains(sql, needle, label)
    executable = uncommented(sql)
    assert_not_contains(executable, "update public.mobile_gps_attendance_events set decision", "override mutating GPS evidence")


def test_executable_real_postgresql_smoke_covers_runtime_invariants() -> None:
    smoke = read(SMOKE).lower()
    for needle, label in [
        ("begin;", "rollback smoke transaction"),
        ("rollback;", "rollback smoke cleanup"),
        ("actor_shape_rejects_two_staff_ids", "actor-shape runtime probe"),
        ("invalid_coordinates_rejected", "coordinate runtime probe"),
        ("one_accepted_per_actor_day", "accepted uniqueness runtime probe"),
        ("rejected_attempts_are_unlimited", "rejected multiplicity runtime probe"),
        ("ledger_update_rejected", "immutability update probe"),
        ("ledger_delete_rejected", "immutability delete probe"),
        ("direct_browser_dml_denied", "browser DML grant probe"),
        ("svc_insert", "service-role insert privilege probe"),
        ("svc_update", "service-role update privilege probe"),
        ("svc_delete", "service-role delete privilege probe"),
        ("svc_exec", "service-role RPC execute privilege probe"),
        ("service_role_rpc_insert_allowed", "service-role RPC probe"),
        ("event_session_actor_mismatch_rejected", "event/session actor mismatch probe"),
        ("event_session_delivery_id_mismatch_rejected", "event/session delivery mismatch probe"),
        ("manual_override_gps_event_actor_mismatch_rejected", "override linked actor mismatch probe"),
        ("manual_override_gps_event_work_date_mismatch_rejected", "override linked date mismatch probe"),
        ("duplicate_report_staff_override_rejected", "duplicate report override probe"),
        ("duplicate_delivery_staff_override_rejected", "duplicate delivery override probe"),
        ("coordinate_detail_view_privacy_allowlist", "privacy-safe coordinate view probe"),
        ("manual_override_does_not_mutate_gps_evidence", "override separation probe"),
        ("event_work_date_uses_vietnam_midnight_boundary", "Vietnam midnight boundary probe"),
        ("event_work_date_rejects_created_at_mismatch", "work_date/created_at CHECK probe"),
        ("manual_override_unauthenticated_actor_rejected", "override unauthenticated/null actor probe"),
        ("manual_override_spoofed_actor_rejected", "override spoof actor probe"),
        ("manual_override_auth_actor_succeeds", "override auth.uid actor probe"),
    ]:
        assert_contains(smoke, needle, label)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
