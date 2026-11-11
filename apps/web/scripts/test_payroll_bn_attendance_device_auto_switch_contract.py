#!/usr/bin/env python3
"""Static contracts for payroll_bn Zalo-OTP attendance device auto-switch."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261112090000_payroll_bn_attendance_device_auto_switch.sql"
SHARED = ROOT / "supabase/functions/_shared/payroll-attendance.ts"
SHARED_TEST = ROOT / "supabase/functions/_shared/payroll-attendance.test.ts"
HOOK = ROOT / "src/hooks/usePayrollBnAttendanceAdmin.ts"
SMOKE = ROOT / "scripts/smoke_payroll_bn_attendance_device_auto_switch.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def sql() -> str:
    return read(MIGRATION).lower()


def function_sql(text: str, name: str) -> str:
    start = text.index(f"create or replace function public.{name}(")
    end = text.index("\n$$;", start)
    return text[start:end]


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def test_device_columns_are_added_with_safe_backfill() -> None:
    s = sql()
    for needle, label in [
        ("add column if not exists activation text", "activation column"),
        ("add column if not exists revoked_reason text", "revoked_reason column"),
        ("check (activation in ('first', 'otp_switch', 'manager'))", "activation vocabulary"),
        ("check (revoked_reason in ('replaced', 'manager'))", "revocation vocabulary"),
        ("set activation = 'first'", "active unapproved rows backfilled as first"),
        ("where status = 'active'\n  and approved_by is null", "only active/unapproved rows become first"),
        ("set activation = 'manager'", "manager-approved rows backfilled as manager"),
        ("where approved_by is not null", "manager backfill predicate"),
    ]:
        assert_contains(s, needle, label)

    # The migration must not silently change any device status.
    before_function = s[: s.index("create or replace function public.record_payroll_bn_attendance_event")]
    assert "set status =" not in before_function, "backfill must never change a device status"
    assert "set status =" not in before_function


def test_change_ledger_is_append_only_and_service_role_only() -> None:
    s = sql()
    for needle, label in [
        ("create table if not exists public.payroll_bn_attendance_device_changes", "change ledger table"),
        ("id uuid primary key default gen_random_uuid()", "change id"),
        ("employee_code text not null", "employee code"),
        ("from_device_hash text", "from hash"),
        ("to_device_hash text not null", "to hash"),
        ("user_agent_family text", "user agent"),
        ("session_id uuid", "session evidence"),
        ("event_id uuid", "event evidence"),
        ("changed_at timestamptz not null default now()", "changed_at"),
        ("on public.payroll_bn_attendance_device_changes(changed_at desc)", "newest-first index"),
        (
            "on public.payroll_bn_attendance_device_changes(employee_code, changed_at desc)",
            "employee change index",
        ),
        ("alter table public.payroll_bn_attendance_device_changes enable row level security", "change RLS"),
        (
            "revoke all on table public.payroll_bn_attendance_device_changes\n  from public, anon, authenticated",
            "change browser revoke",
        ),
        ("grant all on table public.payroll_bn_attendance_device_changes to service_role", "change service grant"),
        ("create or replace function public.reject_payroll_bn_attendance_device_change_mutation", "append-only fn"),
        (
            "before update or delete on public.payroll_bn_attendance_device_changes",
            "append-only trigger",
        ),
        ("payroll_bn_attendance_device_changes_are_immutable", "immutable exception"),
        ("using errcode = '45000'", "append-only SQLSTATE"),
    ]:
        assert_contains(s, needle, label)

    # No browser policy exists for the change ledger.
    assert "create policy" not in s, "change ledger must not have RLS policies"
    assert "to anon" not in s


def test_record_function_keeps_latest_signature_and_consent_gate() -> None:
    s = sql()
    record = function_sql(s, "record_payroll_bn_attendance_event")
    for needle, label in [
        ("p_employee_code text", "employee argument"),
        ("p_event_kind text", "event kind argument"),
        ("p_device_hash text", "device argument"),
        ("p_session_id uuid", "session argument"),
        ("p_latitude numeric", "latitude argument"),
        ("p_longitude numeric", "longitude argument"),
        ("p_accuracy_m numeric", "accuracy argument"),
        ("p_device_captured_at timestamptz", "captured-at argument"),
        ("p_selfie_path text", "selfie argument"),
        ("p_user_agent_family text default null", "user-agent argument"),
        ("coalesce(auth.role(), '') <> 'service_role'", "service-role-only check"),
        ("v_reason := 'session_invalid'", "existing session rule"),
        ("from public.payroll_bn_attendance_consents c", "consent lookup"),
        ("c.withdrawn_at is null", "consent must not be withdrawn"),
        ("from public.payroll_bn_attendance_consent_config cfg", "current consent version"),
        ("v_reason := 'consent_required'", "consent rejection"),
        ("'gate_disabled'", "existing gate rule"),
        ("'site_not_configured'", "existing site rule"),
        ("'no_location'", "existing location rule"),
        ("'low_accuracy'", "existing accuracy rule"),
        ("'outside_geofence'", "existing geofence rule"),
        ("'already_recorded'", "existing duplicate rule"),
        ("'checkout_before_checkin'", "existing ordering rule"),
        ("if v_reason = 'device_not_approved' and v_device_hash <> '' then", "pending-row path kept"),
    ]:
        assert_contains(record, needle, label)

    session_at = record.index("v_reason := 'session_invalid'")
    consent_at = record.index("'consent_required'")
    gate_at = record.index("-- rollout gate")
    assert session_at < consent_at < gate_at, "session -> consent -> gate order must be preserved"


def test_record_function_auto_switches_only_under_safe_conditions() -> None:
    s = sql()
    record = function_sql(s, "record_payroll_bn_attendance_event")
    for needle, label in [
        ("v_reason := 'device_used_by_other'", "anti-proxy rejection"),
        ("v_suspected_proxy := true", "anti-proxy flag"),
        ("and v_session_ok", "valid session required to auto-switch"),
        ("and v_device_hash <> ''", "non-empty hash required"),
        (
            "where d.device_hash = v_device_hash\n         and d.status = 'active'\n         and d.employee_code <> v_employee_code",
            "hash must not be active for another employee",
        ),
        (
            "where d.employee_code = v_employee_code\n         and d.device_hash = v_device_hash\n         and d.status = 'revoked'\n         and d.revoked_reason = 'manager'",
            "manager-revoked device guard",
        ),
        (
            "perform 1\n    from public.payroll_bn_attendance_devices d\n    where d.employee_code = v_employee_code\n    for update;",
            "employee device rows are locked",
        ),
        ("set status = 'revoked',\n        revoked_reason = 'replaced'", "previous device retired as replaced"),
        ("case when v_had_any_device then 'otp_switch' else 'first' end", "activation provenance"),
        ("approved_by = null", "OTP activation is not a manager approval"),
        ("revoked_reason = null", "reactivated device clears its old reason"),
        ("v_device_switch := v_had_any_device", "switch flag excludes the first device"),
        ("if v_device_switch and v_device_active then", "change row only for a real switch"),
        ("insert into public.payroll_bn_attendance_device_changes(", "change row insert"),
        ("from_device_hash,", "change from hash"),
        ("to_device_hash,", "change to hash"),
        ("v_previous_active_hash", "previous active hash captured"),
        ("v_event_id", "event id recorded"),
        ("v_reason := 'device_not_approved'", "blocked device still waits for a manager"),
    ]:
        assert_contains(record, needle, label)

    # The switch block is evaluated after the anti-proxy check.
    used_at = record.index("v_reason := 'device_used_by_other'")
    lock_at = record.index("for update;")
    assert used_at < lock_at, "auto-switch must follow the device_used_by_other check"

    # The change row is written after the event insert.
    event_insert_at = record.index("insert into public.payroll_bn_attendance_events(")
    change_insert_at = record.index("insert into public.payroll_bn_attendance_device_changes(")
    assert event_insert_at < change_insert_at, "change row must follow the event insert"


def test_approve_and_revoke_set_provenance() -> None:
    s = sql()
    approve = function_sql(s, "approve_payroll_bn_attendance_device")
    for needle, label in [
        ("public.payroll_bn_attendance_admin_allowed(v_uid)", "approve role check"),
        ("revoked_reason = 'replaced'", "approve retires old devices as replaced"),
        ("activation = 'manager'", "approve activation provenance"),
        ("revoked_reason = null", "approved row cannot stay revoked"),
    ]:
        assert_contains(approve, needle, label)

    revoke = function_sql(s, "revoke_payroll_bn_attendance_device")
    for needle, label in [
        ("public.payroll_bn_attendance_admin_allowed(v_uid)", "revoke role check"),
        ("revoked_reason = 'manager'", "revoke reason"),
        ("where id = p_device_id", "revoke target"),
    ]:
        assert_contains(revoke, needle, label)

    for name, signature in [
        ("approve_payroll_bn_attendance_device", "uuid"),
        ("revoke_payroll_bn_attendance_device", "uuid"),
    ]:
        assert_contains(
            s,
            f"function public.{name}({signature})",
            f"{name} signature",
        )
        assert_contains(
            s,
            f"grant execute on function public.{name}({signature})\n  to authenticated, service_role",
            f"{name} grant",
        )


def test_device_list_keeps_existing_keys_and_adds_provenance() -> None:
    s = sql()
    listing = function_sql(s, "list_payroll_bn_attendance_devices")
    for needle, label in [
        ("'id', d.id", "id key"),
        ("'employee_code', d.employee_code", "employee key"),
        ("'device_hash', d.device_hash", "hash key"),
        ("'status', d.status", "status key"),
        ("'first_seen_at', d.first_seen_at", "first seen key"),
        ("'approved_by', d.approved_by", "approver key"),
        ("'approved_at', d.approved_at", "approved-at key"),
        ("'user_agent_family', d.user_agent_family", "user-agent key"),
        ("'activation', d.activation", "activation key"),
        ("'revoked_reason', d.revoked_reason", "revoked reason key"),
        ("public.payroll_bn_attendance_admin_allowed(v_uid)", "device list role check"),
    ]:
        assert_contains(listing, needle, label)

    assert_contains(
        s,
        "grant execute on function public.list_payroll_bn_attendance_devices(text, text)\n  to authenticated, service_role",
        "device list grant",
    )


def test_change_list_rpc_is_manager_scoped() -> None:
    s = sql()
    listing = function_sql(s, "list_payroll_bn_attendance_device_changes")
    for needle, label in [
        ("p_since timestamptz default null", "since argument"),
        ("p_limit integer default 50", "limit argument"),
        ("coalesce(p_since, now() - interval '14 days')", "14-day default since"),
        ("least(200, greatest(1, coalesce(p_limit, 50)))", "limit clamped 1..200"),
        ("public.payroll_bn_attendance_admin_allowed(v_uid)", "changes role check"),
        ("'changes', coalesce(", "changes envelope"),
        ("'id', c.id", "change id key"),
        ("'employee_code', c.employee_code", "change employee key"),
        ("'employee_name', c.employee_name", "change employee name key"),
        ("'from_device_hash', c.from_device_hash", "change from key"),
        ("'to_device_hash', c.to_device_hash", "change to key"),
        ("'user_agent_family', c.user_agent_family", "change user agent key"),
        ("'changed_at', c.changed_at", "change timestamp key"),
        ("join public.payroll_bn_period_employees e", "latest catalogue join"),
        ("order by p.date_from desc, p.created_at desc", "latest period definition"),
        ("), ch.employee_code) as employee_name", "employee name fallback to code"),
        ("order by c.changed_at desc, c.id", "newest first"),
        ("limit v_limit", "server-side limit"),
    ]:
        assert_contains(listing, needle, label)

    assert_contains(
        s,
        "revoke all on function public.list_payroll_bn_attendance_device_changes(timestamptz, integer)\n  from public, anon, authenticated",
        "changes browser revoke",
    )
    assert_contains(
        s,
        "grant execute on function public.list_payroll_bn_attendance_device_changes(timestamptz, integer)\n  to authenticated, service_role",
        "changes grant",
    )
    assert "to anon" not in s


def test_shared_ts_mirror_and_tests_follow_the_new_rule() -> None:
    shared = read(SHARED)
    for needle, label in [
        ("sessionValid?: boolean", "session validity input"),
        ("deviceRevokedByManager?: boolean", "manager revocation input"),
        ("deviceActiveForOtherEmployee?: boolean", "other-employee input"),
        ("const autoActivatedByOtpSwitch", "OTP auto-activation rule"),
        ("input.sessionValid !== false", "session guard"),
        ("input.deviceActiveForOtherEmployee !== true", "other-employee guard"),
        ("input.deviceRevokedByManager !== true", "manager-revoked guard"),
        ('return reject("session_invalid")', "session rejection mirror"),
        (
            "Thiết bị này đã bị quản lý gỡ hoặc đang được dùng cho nhân viên khác. Vui lòng liên hệ quản lý.",
            "blocked-device Vietnamese message",
        ),
    ]:
        assert_contains(shared, needle, label)

    test_file = read(SHARED_TEST)
    for needle, label in [
        ("sessionValid: false", "invalid session test"),
        ("deviceRevokedByManager: true", "manager-revoked test"),
        ("deviceActiveForOtherEmployee: true", "other-employee test"),
        ("device_used_by_other", "anti-proxy test kept"),
        ("device_not_approved", "blocked-device test"),
        ("quản lý gỡ", "new message test"),
    ]:
        assert_contains(test_file, needle, label)


def test_hook_exposes_device_changes() -> None:
    hook = read(HOOK)
    for needle, label in [
        ('activation: "first" | "otp_switch" | "manager" | null', "device activation type"),
        ('revoked_reason: "replaced" | "manager" | null', "device revoked reason type"),
        ("export interface PayrollAttendanceAdminDeviceChange", "change type"),
        ("employee_name: string", "change employee name"),
        ("export function useAttendanceDeviceChanges", "changes hook"),
        ("list_payroll_bn_attendance_device_changes", "changes RPC call"),
        ("p_since: since ?? null", "since argument"),
        ('["payroll-bn-attendance-device-changes"]', "changes query key"),
        ("invalidateQueries({ queryKey: [\"payroll-bn-attendance-device-changes\"] })", "changes invalidation"),
    ]:
        assert_contains(hook, needle, label)


def test_smoke_covers_every_required_runtime_case() -> None:
    smoke = read(SMOKE)
    lowered = smoke.lower()
    for needle, label in [
        ("begin;", "transactional smoke"),
        ("do $$", "one DO block"),
        ("rollback;", "rollback cleanup"),
        ("set_config('request.jwt.claims'", "service-role claims"),
        ("task_device_switch_e", "TASK employees"),
        ("accept_payroll_bn_attendance_consent", "real consent RPC"),
        ("first_device", "first device case"),
        ("activation is distinct from 'first'", "first activation assertion"),
        ("first_device_wrote_change_row", "no change row for first device"),
        ("otp_switch", "automatic switch activation"),
        ("replaced", "previous device retirement"),
        ("second_device_change_count", "exactly one switch row"),
        ("session_invalid", "expired session case"),
        ("expired_session_activated_device", "nothing activated on expired session"),
        ("device_not_approved", "blocked device case"),
        ("pending", "pending row for another employee's hash"),
        ("device_used_by_other", "anti-proxy case"),
        ("revoke_payroll_bn_attendance_device", "manager revoke RPC"),
        ("manager_revoked_not_blocked", "manager-revoked guard"),
        ("approve_payroll_bn_attendance_device", "manager approve RPC"),
        ("activation' is distinct from 'manager'", "manager approval provenance"),
        ("list_payroll_bn_attendance_device_changes", "manager change list"),
        ("employee_name", "employee name in change list"),
        ("non_manager_changes_not_blocked", "non-manager refusal"),
        ("changes_update_not_blocked", "update blocked"),
        ("changes_delete_not_blocked", "delete blocked"),
        ("raise notice 'device_auto_switch_smoke_pass'", "pass notice"),
    ]:
        assert_contains(lowered, needle, label)

    assert "\\set" not in smoke and "\\gset" not in smoke, "smoke must be pure SQL"
    assert lowered.count("do $$") == 1, "smoke must use one DO block"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
