#!/usr/bin/env python3
"""Static contracts for Bếp bánh change/leave requests + attendance flags."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261110200000_payroll_bn_shift_requests.sql"
SHARED = ROOT / "supabase/functions/_shared/payroll-shifts.ts"
SHARED_TEST = ROOT / "supabase/functions/_shared/payroll-shifts.test.ts"
EDGE = ROOT / "supabase/functions/payslip-shifts/index.ts"
TYPES = ROOT / "src/lib/payslip-portal/types.ts"
API = ROOT / "src/lib/payslip-portal/shift-api.ts"
API_TEST = ROOT / "src/lib/payslip-portal/shift-api.test.ts"
HOOK = ROOT / "src/hooks/usePayrollBnShiftsAdmin.ts"
SMOKE = ROOT / "scripts/smoke_payroll_bn_shift_requests.sql"

FUNCTIONS = [
    "payroll_bn_shift_employee_name",
    "payroll_bn_shift_date_warnings",
    "payroll_bn_shift_request_impact",
    "submit_payroll_bn_shift_request",
    "cancel_payroll_bn_shift_request",
    "get_payroll_bn_shift_week",
    "get_payroll_bn_shift_board",
    "upsert_payroll_bn_shift_config",
    "list_payroll_bn_shift_requests",
    "decide_payroll_bn_shift_request",
    "get_payroll_bn_shift_attendance_flags",
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


def test_table_columns_checks_and_indexes() -> None:
    s = sql()
    for needle, label in [
        ("create table if not exists public.payroll_bn_shift_requests", "request table"),
        ("id uuid primary key default gen_random_uuid()", "request id"),
        (
            "week_start date not null references public.payroll_bn_shift_weeks(week_start) on delete cascade",
            "week fk",
        ),
        ("work_date date not null", "work date"),
        ("employee_code text not null check (length(btrim(employee_code)) > 0)", "employee code"),
        ("kind text not null check (kind in ('change', 'leave'))", "kind check"),
        ("from_shift_code text", "from snapshot"),
        (
            "to_shift_code text references public.payroll_bn_shift_types(code) on delete restrict",
            "to shift fk",
        ),
        ("reason text not null check (length(btrim(reason)) between 3 and 500)", "reason check"),
        (
            "state text not null default 'pending'",
            "state default",
        ),
        ("state in ('pending', 'approved', 'rejected', 'cancelled')", "state values"),
        ("decided_by uuid references auth.users(id) on delete set null", "decided by"),
        ("decided_at timestamptz", "decided at"),
        ("decision_note text", "decision note"),
        ("created_at timestamptz not null default now()", "created at"),
        ("updated_at timestamptz not null default now()", "updated at"),
        ("check (work_date >= week_start and work_date < week_start + 7)", "date inside week"),
        ("kind = 'change' and to_shift_code is not null", "change requires to shift"),
        ("kind = 'leave' and to_shift_code is null", "leave has no to shift"),
        ("where state = 'pending'", "one pending index"),
        ("on public.payroll_bn_shift_requests(employee_code, work_date)", "pending index columns"),
        ("on public.payroll_bn_shift_requests(week_start, state)", "week/state index"),
        ("before update on public.payroll_bn_shift_requests", "updated_at trigger"),
        ("execute function public.handle_updated_at()", "shared updated_at function"),
    ]:
        assert_contains(s, needle, label)


def test_rls_and_grants() -> None:
    s = sql()
    assert_contains(
        s,
        "alter table public.payroll_bn_shift_requests enable row level security",
        "request RLS",
    )
    assert_contains(
        s,
        "revoke all on table public.payroll_bn_shift_requests\n  from public, anon, authenticated;",
        "request browser revoke",
    )
    assert_contains(
        s,
        "grant all on table public.payroll_bn_shift_requests to service_role;",
        "request service_role grant",
    )
    assert "create policy" not in s, "no direct table policies for requests"
    assert "grant select on table public.payroll_bn_shift_requests to authenticated" not in s

    # Employee RPCs: service_role only.
    for rpc, signature in [
        ("submit_payroll_bn_shift_request", "text, date, text, text, text"),
        ("cancel_payroll_bn_shift_request", "text, uuid"),
        ("get_payroll_bn_shift_week", "text, date"),
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
            "  to service_role;",
            f"{rpc} service_role grant",
        )
        assert (
            f"grant execute on function public.{rpc}({signature})\n"
            "  to authenticated" not in s
        ), f"{rpc} must not be granted to authenticated"

    # Manager RPCs: authenticated only.
    for rpc, signature in [
        ("list_payroll_bn_shift_requests", "date, text"),
        ("decide_payroll_bn_shift_request", "uuid, boolean, text"),
        ("get_payroll_bn_shift_attendance_flags", "date"),
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
            "  to authenticated;",
            f"{rpc} authenticated grant",
        )
        assert (
            f"grant execute on function public.{rpc}({signature})\n"
            "  to authenticated, service_role" not in s
        ), f"{rpc} must not include service_role"

    assert " to anon" not in s, "nothing may be granted to anon"


def test_late_grace_and_config_preserves_extra_codes() -> None:
    s = sql()
    for needle, label in [
        (
            "add column if not exists late_grace_minutes integer not null default 0",
            "late grace column",
        ),
        ("check (late_grace_minutes between 0 and 120)", "late grace check"),
        ("v_late_grace := coalesce(", "config reads late grace"),
        ("payroll_shift_settings_invalid_late_grace", "late grace validation"),
        ("late_grace_minutes = v_late_grace", "config applies late grace"),
    ]:
        assert_contains(s, needle, label)

    config = function_body(s, "upsert_payroll_bn_shift_config")
    assert "extra_employee_codes =" not in config, (
        "config must never overwrite extra_employee_codes"
    )
    assert "extra_employee_codes" not in config.split("update public.payroll_bn_shift_settings", 1)[1], (
        "the settings update must not touch extra_employee_codes"
    )


def test_submit_request_rules() -> None:
    body = function_body(sql(), "submit_payroll_bn_shift_request")
    for needle, label in [
        ("shift_employee_required", "employee required"),
        ("shift_request_work_date_required", "work date required"),
        ("shift_request_invalid_kind", "kind validation"),
        ("shift_request_reason_required", "reason validation"),
        ("payroll_bn_shift_eligible(v_employee, v_week)", "eligibility"),
        ("shift_not_eligible", "not eligible error"),
        ("v_status <> 'published'", "published check"),
        ("now() <= v_deadline", "deadline check"),
        ("shift_request_use_registration", "use registration error"),
        ("(now() at time zone 'asia/ho_chi_minh')::date", "ICT today"),
        ("shift_request_past_date", "past date error"),
        ("v_week_row.closed_dates", "closed dates"),
        ("shift_request_closed_date", "closed date error"),
        ("v_entry.state <> 'registered'", "leave requires registered entry"),
        ("shift_request_no_shift", "no shift error"),
        ("t.active", "active target shift"),
        ("shift_invalid_shift", "invalid shift error"),
        ("v_to is not distinct from v_entry.shift_code", "same shift check"),
        ("shift_request_same_shift", "same shift error"),
        ("r.state = 'pending'", "duplicate pending check"),
        ("shift_request_duplicate", "duplicate error"),
        ("unique_violation", "unique violation race"),
        ("from_shift_code", "from snapshot stored"),
        ("'pending'", "pending insert"),
        ("'request_submitted'", "submit audit event"),
        ("payroll_bn_shift_coverage(v_week)", "coverage returned"),
    ]:
        assert_contains(body, needle, label)


def test_cancel_request_rules() -> None:
    body = function_body(sql(), "cancel_payroll_bn_shift_request")
    for needle, label in [
        ("for update", "row lock"),
        ("v_request.employee_code <> v_employee", "owner check"),
        ("shift_request_not_found", "not found error"),
        ("shift_request_not_pending", "not pending error"),
        ("v_request.state = 'cancelled'", "idempotent cancel"),
        ("state = 'cancelled'", "cancel state"),
        ("'request_cancelled'", "cancel audit event"),
    ]:
        assert_contains(body, needle, label)


def test_week_payload_keeps_old_keys_and_adds_new() -> None:
    body = function_body(sql(), "get_payroll_bn_shift_week")
    for needle, label in [
        # Phase 1 keys must stay.
        ("'eligible'", "eligible"),
        ("'week'", "week"),
        ("'shift_types'", "shift types"),
        ("'days'", "days"),
        ("'suggestion'", "suggestion"),
        ("'current_week'", "current week"),
        ("'can_edit'", "can edit"),
        ("'closed_dates'", "closed dates"),
        # Phase 2 keys.
        ("'requests'", "requests"),
        ("'can_request'", "can request"),
        ("v_can_request :=", "can request computation"),
        ("v_week + 6) >= v_today", "not fully in the past"),
        ("v_status = 'published'", "published week allows request"),
        ("now() > v_deadline", "deadline passed allows request"),
        ("from public.payroll_bn_shift_requests r", "own requests"),
        ("r.employee_code = v_employee", "request employee scope"),
        ("'decision_note'", "decision note"),
        ("'decided_at'", "decided at"),
    ]:
        assert_contains(body, needle, label)

    # No other employee identity may leak into the employee payload.
    assert "'employee_code'," not in body, "employee payload must not include employee codes"
    assert "employee_name" not in body, "employee payload must not include names"


def test_board_keeps_old_keys_and_adds_pending() -> None:
    body = function_body(sql(), "get_payroll_bn_shift_board")
    for needle, label in [
        ("'settings'", "settings"),
        ("'shift_types'", "shift types"),
        ("'quotas'", "quotas"),
        ("'week'", "week"),
        ("'coverage'", "coverage"),
        ("'employees'", "employees"),
        ("'totals'", "totals"),
        ("'warnings'", "warnings"),
        ("'below_needed'", "below needed"),
        ("'below_min_staff'", "below min staff"),
        ("'off_above_max'", "off above max"),
        ("'unregistered'", "unregistered"),
        ("'pending_requests'", "pending requests"),
        ("from public.payroll_bn_shift_requests", "request count source"),
        ("state = 'pending'", "pending filter"),
    ]:
        assert_contains(body, needle, label)


def test_manager_list_and_decide() -> None:
    s = sql()
    listing = function_body(s, "list_payroll_bn_shift_requests")
    for needle, label in [
        ("payroll_shift_forbidden", "role check"),
        ("payroll_shift_week_required", "week required"),
        ("shift_request_invalid_state", "state validation"),
        ("in ('pending', 'approved', 'rejected', 'cancelled')", "state values"),
        ("public.payroll_bn_shift_employee_name(r.employee_code)", "employee name resolution"),
        ("left join public.payroll_bn_shift_entries cur", "current entry"),
        ("'current_shift_code'", "current shift code"),
        ("'impact'", "impact"),
        ("public.payroll_bn_shift_request_impact(", "impact helper"),
        ("order by r.created_at desc", "newest first"),
    ]:
        assert_contains(listing, needle, label)

    decide = function_body(s, "decide_payroll_bn_shift_request")
    for needle, label in [
        ("payroll_shift_forbidden", "role check"),
        ("for update", "request row lock"),
        ("shift_request_not_pending", "not pending error"),
        ("v_entry.shift_code is distinct from v_request.from_shift_code", "stale snapshot"),
        ("shift_request_stale", "stale error"),
        ("public.set_payroll_bn_shift_entry(", "applies entry"),
        ("case when v_request.kind = 'leave' then null else v_request.to_shift_code end", "leave/change outcome"),
        ("state = 'approved'", "approved state"),
        ("state = 'rejected'", "rejected state"),
        ("'request_approved'", "approve event"),
        ("'request_rejected'", "reject event"),
        ("public.payroll_bn_shift_date_warnings(v_day)", "warnings"),
        ("'warnings'", "warnings payload"),
    ]:
        assert_contains(decide, needle, label)


def test_attendance_flags_four_kinds_and_overrides() -> None:
    body = function_body(sql(), "get_payroll_bn_shift_attendance_flags")
    for needle, label in [
        ("payroll_shift_forbidden", "role check"),
        ("v_week_row.status <> 'published'", "published only"),
        ("'flags'", "flags payload"),
        ("'no_show'", "no show"),
        ("'late'", "late"),
        ("'unscheduled'", "unscheduled"),
        ("'missing_out'", "missing out"),
        ("public.payroll_bn_attendance_events", "attendance ledger"),
        ("e.decision = 'accepted'", "accepted events"),
        ("e.event_kind = 'in'", "in event"),
        ("e.event_kind = 'out'", "out event"),
        ("payroll_bn_attendance_day_overrides", "day overrides"),
        ("has_override", "override suppression"),
        ("closed_dates", "closed dates"),
        ("is_closed", "closed suppression"),
        ("r.kind = 'leave'", "approved leave"),
        ("r.state = 'approved'", "approved leave state"),
        ("has_leave", "leave suppression"),
        ("late_grace_minutes", "late grace"),
        ("minutes_late", "minutes late"),
        ("b.work_date < v_today", "strictly before today"),
    ]:
        assert_contains(body, needle, label)

    assert "insert into" not in body, "attendance flags RPC must be read-only"


def test_every_function_sets_search_path() -> None:
    s = sql()
    for name in FUNCTIONS:
        body = function_body(s, name)
        assert "set search_path = public" in body, f"{name} must set search_path"
        assert "security definer" in body, f"{name} must be security definer"


def test_shared_module_and_tests() -> None:
    shared = read(SHARED)
    for needle, label in [
        ("export function validateShiftRequestInput", "request validator"),
        ("export function normalizeShiftRequest", "request normaliser"),
        ("export function mapShiftRequestError", "request error map"),
        ("export function isShiftRequestKind", "kind guard"),
        ("shift_request_use_registration", "use registration code"),
        ("shift_request_past_date", "past date code"),
        ("shift_request_closed_date", "closed date code"),
        ("shift_request_no_shift", "no shift code"),
        ("shift_request_duplicate", "duplicate code"),
        ("shift_request_same_shift", "same shift code"),
        ("shift_request_stale", "stale code"),
        ("shift_request_not_pending", "not pending code"),
    ]:
        assert_contains(shared, needle, label)

    tests = read(SHARED_TEST)
    for needle, label in [
        ("request validation accepts a future change and leave", "validation happy path"),
        ("request validation rejects past dates", "validation errors"),
        ("request error map returns Vietnamese messages", "error map test"),
        ("request normaliser tolerates missing optional fields", "normaliser test"),
    ]:
        assert_contains(tests, needle, label)


def test_edge_function_actions() -> None:
    edge = read(EDGE)
    for needle, label in [
        ("mapShiftRequestError", "shared error map"),
        ("validateShiftRequestInput", "shared validator"),
        ('action !== "request"', "request action"),
        ('action !== "cancel_request"', "cancel action"),
        ("submit_payroll_bn_shift_request", "submit request RPC"),
        ("cancel_payroll_bn_shift_request", "cancel request RPC"),
        ("p_employee_code: session.employee_code", "session employee scope"),
        ("p_work_date: validation.workDate", "validated work date"),
        ("p_kind: validation.kind", "validated kind"),
        ("p_to_shift_code: validation.toShiftCode", "validated to shift"),
        ("p_request_id: requestId", "request id"),
        ("x-payslip-session", "session header"),
        ("x-payslip-device", "device header"),
        ("session_required", "session required"),
        ("device_mismatch", "device mismatch"),
    ]:
        assert_contains(edge, needle, label)

    assert "body.employee_code" not in edge, "only the session employee_code may be used"


def test_client_types_api_and_admin_hook() -> None:
    types = read(TYPES)
    for needle, label in [
        ("export interface PayrollShiftRequest", "request type"),
        ("export type PayrollShiftRequestKind", "kind type"),
        ("export type PayrollShiftRequestState", "state type"),
        ("requests: PayrollShiftRequest[]", "week requests"),
        ("canRequest: boolean", "week can request"),
        ("requestChange(input", "request method"),
        ("cancelRequest(requestId", "cancel method"),
    ]:
        assert_contains(types, needle, label)

    api = read(API)
    for needle, label in [
        ("normalizeShiftRequestResult", "request result normaliser"),
        ("function asRequest", "request normaliser"),
        ('action: "request"', "request action"),
        ('action: "cancel_request"', "cancel action"),
        ("work_date: input.workDate", "work date payload"),
        ("to_shift_code: input.toShiftCode", "to shift payload"),
        ("reason: input.reason", "reason payload"),
        ("request_id: requestId", "request id payload"),
        ("status === 401", "401 handling"),
        ("PayslipSessionExpiredError", "session expiry"),
    ]:
        assert_contains(api, needle, label)

    api_test = read(API_TEST)
    for needle, label in [
        ("requestChange posts the request", "request test"),
        ("cancelRequest posts the request id", "cancel test"),
        ("normalizeShiftWeek tolerates a missing payload", "missing payload test"),
    ]:
        assert_contains(api_test, needle, label)

    hook = read(HOOK)
    for needle, label in [
        ("export function useShiftRequests", "requests hook"),
        ("export function useDecideShiftRequest", "decide hook"),
        ("export function useShiftAttendanceFlags", "flags hook"),
        ("list_payroll_bn_shift_requests", "list RPC"),
        ("decide_payroll_bn_shift_request", "decide RPC"),
        ("get_payroll_bn_shift_attendance_flags", "flags RPC"),
        ("payroll-bn-shift-requests", "requests key"),
        ("payroll-bn-shift-attendance-flags", "flags key"),
        ("pending_requests", "board pending count field"),
        ("late_grace_minutes", "late grace setting"),
        ("extra_employee_codes", "extra codes preserved in type"),
    ]:
        assert_contains(hook, needle, label)


def test_smoke_covers_required_cases() -> None:
    smoke = read(SMOKE)
    lowered = smoke.lower()
    for needle, label in [
        ("begin;", "transaction"),
        ("do $$", "single DO block"),
        ("set_config('request.jwt.claims'", "service-role claims"),
        ("rollback;", "rollback-only"),
        ("task_smoke_group", "throwaway group"),
        ("payroll_bn_shift_week_start", "week helper"),
        ("shift_request_use_registration", "open week case"),
        ("shift_request_past_date", "past date case"),
        ("shift_request_closed_date", "closed date case"),
        ("shift_request_no_shift", "no shift case"),
        ("shift_request_same_shift", "same shift case"),
        ("shift_request_duplicate", "duplicate case"),
        ("shift_request_stale", "stale case"),
        ("request_approved", "approve event"),
        ("request_rejected", "reject event"),
        ("request_cancelled", "cancel event"),
        ("cancel_not_idempotent", "cancel idempotency"),
        ("leave_entry_not_day_off", "leave entry case"),
        ("change_entry_not_applied", "change entry case"),
        ("reject_changed_entry", "reject keeps entry"),
        ("below_min_staff", "min staff warning"),
        ("over_needed", "over quota warning"),
        ("change_over_quota_warning_missing", "over quota assertion"),
        ("non_manager_not_blocked", "non-manager case"),
        ("non_service_role_not_blocked", "non-service-role case"),
        ("set local role authenticated", "grant check"),
        ("no_show", "no show flag"),
        ("'late'", "late flag"),
        ("unscheduled", "unscheduled flag"),
        ("missing_out", "missing out flag"),
        ("payroll_mission_progress", "progress still runs"),
        ("extra_employee_codes_changed", "extra codes untouched"),
        ("shift_req_smoke_pass", "final notice"),
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
