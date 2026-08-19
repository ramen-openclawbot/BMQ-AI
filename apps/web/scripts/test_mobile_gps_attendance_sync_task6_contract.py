#!/usr/bin/env python3
"""Task6 contracts for GPS accepted-event -> attendance_records sync."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"
TASK6_MIGRATION = MIGRATIONS / "20260819123000_mobile_gps_attendance_records_sync.sql"
TASK6_GUARD_MIGRATION = MIGRATIONS / "20260819123010_attendance_records_trusted_gps_provenance_guard.sql"
TASK3_RPC = MIGRATIONS / "20260819113020_record_mobile_gps_attendance_event_function.sql"
ATTENDANCE_PAGE = ROOT / "src/pages/AttendanceManagement.tsx"
SMOKE = ROOT / "scripts/smoke_mobile_gps_attendance_records_sync_task6.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def sql() -> str:
    return read(TASK6_MIGRATION).lower()


def guard_sql() -> str:
    return read(TASK6_GUARD_MIGRATION).lower()


def uncommented(text: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines()).lower()


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def assert_not_contains(text: str, needle: str, label: str) -> None:
    assert needle not in text, f"Unexpected {label}: {needle!r}"


def test_task6_migration_adds_safe_provenance_columns_and_sync_audit() -> None:
    s = sql()
    for needle, label in [
        ("alter table public.attendance_records", "attendance_records schema extension"),
        ("add column if not exists department text", "department snapshot"),
        ("add column if not exists source_type text", "source type provenance"),
        ("add column if not exists source_event_id uuid", "source event provenance"),
        ("references public.mobile_gps_attendance_events(id) on delete restrict", "immutable event FK"),
        ("add column if not exists source_actor_type text", "actor type provenance"),
        ("add column if not exists source_distance_m numeric(10,2)", "safe rounded distance"),
        ("add column if not exists source_accuracy_m numeric(8,2)", "safe rounded accuracy"),
        ("attendance_records_source_event_unique", "no duplicate source event links"),
        ("create table if not exists public.mobile_gps_attendance_sync_results", "durable sync audit table"),
        ("sync_status text not null", "sync status"),
        ("check (sync_status in ('synced', 'already_synced', 'skipped_locked', 'conflict'))", "safe sync status vocabulary"),
        ("unique(gps_event_id)", "one sync result per event"),
    ]:
        assert_contains(s, needle, label)


def function_body() -> str:
    text = uncommented(sql())
    start = text.index("create or replace function public.sync_mobile_gps_event_to_attendance_record")
    end = text.index("revoke all on function public.sync_mobile_gps_event_to_attendance_record", start)
    return text[start:end]


def update_block() -> str:
    body = function_body()
    start = body.index("update public.attendance_records")
    end = body.index("where id = v_record.id", start)
    return body[start:end]


def test_sync_function_is_locked_row_safe_idempotent_and_one_checkin_model() -> None:
    s = sql()
    for needle, label in [
        ("create or replace function public.sync_mobile_gps_event_to_attendance_record", "sync helper"),
        ("security definer", "definer boundary"),
        ("set search_path = public", "fixed search path"),
        ("from public.mobile_gps_attendance_events", "loads immutable event"),
        ("if v_event.decision <> 'accepted'", "rejected events skipped"),
        ("for update", "row lock"),
        ("locked_by_hr is true", "HR lock guard"),
        ("skipped_locked", "locked audit status"),
        ("on conflict (employee_code, work_date) do nothing", "race-safe attendance insert"),
        ("source_event_id is not null", "existing provenance conflict guard"),
        ("source_event_id is distinct from v_event.id", "do not relink another event"),
        ("actual_check_out", "check-out field considered"),
        ("null,\n    'missing_check_out'::public.attendance_status_type", "one-check-in/day does not invent checkout"),
        ("'missing_check_out'::public.attendance_status_type", "new GPS-only row records present day without checkout"),
        ("kiosk:' || v_event.kiosk_report_staff_id::text", "stable kiosk employee code"),
        ("delivery:' || v_event.delivery_staff_id::text", "stable delivery employee code"),
        ("'điểm bán'", "kiosk department snapshot"),
        ("'giao hàng'", "delivery department snapshot"),
    ]:
        assert_contains(s, needle, label)
    body = function_body()
    assert_not_contains(body, "actual_check_out = v_event.created_at", "invented GPS checkout time")


def test_existing_unlocked_update_uses_authoritative_gps_checkin_and_preserves_hr_fields() -> None:
    block = update_block()
    assert_contains(block, "actual_check_in = v_event.created_at", "GPS event timestamp is authoritative for existing unlocked rows")
    assert_not_contains(block, "coalesce(v_record.actual_check_in", "old check-in incorrectly kept over authoritative GPS timestamp")
    for forbidden in [
        "status =",
        "minutes_late =",
        "minutes_early_leave =",
        "missing_check_in =",
        "missing_check_out =",
        "actual_check_out =",
        "shift_assignment_id =",
        "shift_id =",
        "scheduled_start =",
        "scheduled_end =",
        "notes =",
    ]:
        assert_not_contains(block, forbidden, f"existing unlocked GPS sync must not overwrite unrelated field {forbidden}")



def test_attendance_records_provenance_guard_blocks_browser_and_direct_spoofing() -> None:
    s = guard_sql()
    for needle, label in [
        ("create table if not exists public.attendance_records_trusted_gps_context", "db-owned trusted context table"),
        ("revoke all on table public.attendance_records_trusted_gps_context from public, anon, authenticated, service_role", "direct service-role context writes revoked"),
        ("create or replace function public.guard_attendance_records_trusted_gps_provenance()", "single trigger guard function"),
        ("security definer", "guard can validate db-owned context independent of caller"),
        ("current_setting('attendance_records.trusted_gps_token', true)", "transaction-local token checked"),
        ("txid_current()", "transaction-bound context checked"),
        ("pg_backend_pid()", "backend-bound context checked"),
        ("attendance_records_gps_provenance_insert_forbidden", "spoof insert blocker"),
        ("attendance_records_gps_provenance_update_forbidden", "spoof update blocker"),
        ("attendance_records_gps_provenance_delete_forbidden", "trusted lineage delete blocker"),
        ("before insert or update or delete on public.attendance_records", "all DML paths guarded"),
    ]:
        assert_contains(s, needle, label)
    assert_not_contains(s, "current_user", "guard must not rely on trigger current_user semantics")
    assert_not_contains(s, "auth.role() = 'service_role'", "service role must not bypass provenance guard")


def test_sync_function_sets_and_clears_db_owned_trusted_context_around_gps_dml() -> None:
    body = function_body()
    for needle, label in [
        ("v_trusted_gps_token uuid", "sync creates per-call token"),
        ("gen_random_uuid()", "unguessable transaction token"),
        ("insert into public.attendance_records_trusted_gps_context", "sync writes db-owned context"),
        ("set_config('attendance_records.trusted_gps_token'", "sync sets transaction-local context"),
        ("delete from public.attendance_records_trusted_gps_context", "sync clears context"),
        ("set_config('attendance_records.trusted_gps_token', '', true)", "sync resets local context"),
        ("exception when others then", "sync cleans trusted context on errors"),
    ]:
        assert_contains(body, needle, label)
    assert_not_contains(body, "current_user", "sync must not rely on current_user for trusted provenance")

def test_task3_record_rpc_invokes_sync_atomically_after_accepted_insert_only() -> None:
    rpc = read(TASK3_RPC).lower()
    for needle, label in [
        ("v_sync_result jsonb", "sync result variable"),
        ("if p_decision = 'accepted' then", "accepted-only sync branch"),
        ("public.sync_mobile_gps_event_to_attendance_record(v_event_id)", "atomic sync helper call"),
        ("returns jsonb", "RPC returns event id plus sync result"),
        ("'event_id', v_event_id", "response includes event id"),
        ("'attendance_sync', v_sync_result", "response includes attendance sync"),
    ]:
        assert_contains(rpc, needle, label)
    rejected_branch = rpc.split("if p_decision = 'accepted' then", 1)[1]
    assert_contains(rejected_branch, "else", "rejected branch exists")
    assert_contains(rejected_branch, "'skipped_rejected'", "rejected branch does not create attendance")


def test_attendance_management_surfaces_safe_gps_source_without_sensitive_details() -> None:
    page = read(ATTENDANCE_PAGE).lower()
    for needle, label in [
        ("source_type", "record source field selected"),
        ("source_event_id", "source event field selected"),
        ("source_actor_type", "actor type selected"),
        ("source_distance_m", "distance selected"),
        ("source_accuracy_m", "accuracy selected"),
        ("mobile_gps", "mobile GPS label"),
        ("gps", "GPS badge"),
        ("math.round", "rounded safe numbers"),
    ]:
        assert_contains(page, needle, label)
    for forbidden in ["device_latitude", "device_longitude", "request_ip_hash", "request_user_agent"]:
        assert_not_contains(page, forbidden, "sensitive GPS detail in attendance UI")


def test_executable_smoke_documents_required_runtime_matrix() -> None:
    smoke = read(SMOKE).lower()
    uncommented_smoke = uncommented(smoke)
    for needle, label in [
        ("begin;", "transactional smoke"),
        ("rollback;", "rollback cleanup"),
        ("accepted_event_creates_attendance_record", "accepted sync probe"),
        ("rejected_event_does_not_create_attendance_record", "rejected no-op probe"),
        ("locked_row_skips_and_audits", "locked safety probe"),
        ("preexisting_unlocked_manual_row_minimally_updated", "manual row safe update probe"),
        ("delivery_accepted_event_creates_attendance_record", "delivery sync probe"),
        ("duplicate_accepted_idempotent_single_event_single_record", "idempotency probe"),
        ("no_checkout_time_invented", "one-check-in model probe"),
        ("authenticated_attendance_editor_provenance_spoofing_blocked", "authenticated spoof insert/update probes"),
        ("service_role_direct_provenance_spoofing_blocked", "direct service-role insert/update/detach/delete spoof probe"),
        ("service_role_direct_provenance_spoofing_blocked insert", "direct service-role spoof insert probe"),
        ("service_role_direct_provenance_spoofing_blocked update", "direct service-role spoof update probe"),
        ("service_role_direct_provenance_spoofing_blocked detach", "direct service-role detach probe"),
        ("service_role_direct_provenance_spoofing_blocked delete", "direct service-role delete probe"),
        ("set_config('attendance_records.trusted_gps_token'", "custom GUC spoof probe"),
        ("context sql forge", "protected context-table SQL spoof probe"),
        ("normal_attendance_edit_update_succeeds", "normal non-provenance update preserved"),
        ("gps_row_delete_rejected_manual_row_delete_allowed", "GPS delete blocked while manual delete preserved"),
        ("trusted_sync_succeeds_with_guard", "trusted sync survives provenance guard"),
        ("rollback_residue_absent", "post-rollback residue probe"),
        ("raise exception", "real assertion failures"),
    ]:
        assert_contains(uncommented_smoke, needle, label)
    assert_not_contains(uncommented_smoke, "select 'accepted_event_creates_attendance_record'", "marker-only accepted probe")
    assert_not_contains(uncommented_smoke, "select 'preexisting_unlocked_manual_row_minimally_updated'", "marker-only minimal update probe")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
