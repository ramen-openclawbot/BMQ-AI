#!/usr/bin/env python3
"""Static contracts for weekly Bếp bánh shift registration (payroll_bn)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261110180000_payroll_bn_shift_schedule.sql"
SHARED = ROOT / "supabase/functions/_shared/payroll-shifts.ts"
SHARED_TEST = ROOT / "supabase/functions/_shared/payroll-shifts.test.ts"
CORS = ROOT / "supabase/functions/_shared/cors.ts"
CONFIG = ROOT / "supabase/config.toml"
EDGE = ROOT / "supabase/functions/payslip-shifts/index.ts"
TYPES = ROOT / "src/lib/payslip-portal/types.ts"
API = ROOT / "src/lib/payslip-portal/shift-api.ts"
API_TEST = ROOT / "src/lib/payslip-portal/shift-api.test.ts"
HOOK = ROOT / "src/hooks/usePayrollBnShiftsAdmin.ts"
SMOKE = ROOT / "scripts/smoke_payroll_bn_shift_schedule.sql"

TABLES = [
    "payroll_bn_shift_types",
    "payroll_bn_shift_quotas",
    "payroll_bn_shift_settings",
    "payroll_bn_shift_weeks",
    "payroll_bn_shift_entries",
    "payroll_bn_shift_events",
]

MANAGER_RPCS = [
    "get_payroll_bn_shift_board",
    "set_payroll_bn_shift_entry",
    "publish_payroll_bn_shift_week",
    "reopen_payroll_bn_shift_week",
    "set_payroll_bn_shift_closed_dates",
    "upsert_payroll_bn_shift_config",
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


def test_tables_columns_constraints_and_rls() -> None:
    s = sql()
    for table in TABLES:
        assert_contains(s, f"create table if not exists public.{table}", f"{table} table")
        assert_contains(s, f"alter table public.{table} enable row level security", f"{table} RLS")
        assert_contains(
            s,
            f"revoke all on table public.{table} from public, anon, authenticated",
            f"{table} browser revoke",
        )
        assert_contains(
            s,
            f"grant all on table public.{table} to service_role",
            f"{table} service_role grant",
        )
        assert f"grant select on table public.{table} to authenticated" not in s

    for needle, label in [
        ("code text primary key check (length(btrim(code)) > 0)", "shift type code"),
        ("start_time time not null", "shift start time"),
        ("end_time time", "shift end time"),
        ("sort integer not null default 0", "shift sort"),
        ("active boolean not null default true", "shift active"),
        ("shift_code text not null references public.payroll_bn_shift_types(code)", "quota shift fk"),
        ("iso_dow integer check (iso_dow between 1 and 7)", "quota iso weekday"),
        ("needed integer not null default 0 check (needed >= 0)", "quota needed"),
        ("quota_group text", "quota group"),
        ("unique (shift_code, iso_dow)", "one quota per shift/day"),
        ("eligible_groups text[] not null default '{bếp bánh}'::text[]", "eligible groups default"),
        ("open_iso_dow integer not null default 2", "open day default"),
        ("deadline_iso_dow integer not null default 6", "deadline day default"),
        ("deadline_time time not null default '12:00'", "deadline time default"),
        ("max_off_per_day integer not null default 2", "off limit default"),
        ("min_staff_per_day integer not null default 5", "min staff default"),
        ("min_off_days_per_week integer not null default 1", "min off days default"),
        ("week_start date primary key", "week primary key"),
        ("check (extract(isodow from week_start) = 1)", "Monday week"),
        ("status in ('open', 'published')", "week statuses"),
        ("closed_dates date[] not null default '{}'::date[]", "closed dates"),
        ("shift_code text references public.payroll_bn_shift_types(code)", "entry shift fk"),
        ("state in ('registered', 'waitlist')", "entry states"),
        ("source in ('employee', 'manager', 'carried')", "entry sources"),
        ("previous_shift_code text", "previous shift"),
        ("unique (employee_code, work_date)", "one choice per employee/day"),
        ("work_date >= week_start and work_date < week_start + 7", "entry inside week"),
        ("reject_payroll_bn_shift_event_mutation", "audit append-only fn"),
        ("payroll_bn_shift_events_are_append_only", "audit append-only error"),
        ("before update or delete on public.payroll_bn_shift_events", "audit update/delete blocked"),
    ]:
        assert_contains(s, needle, label)


def test_only_settings_are_seeded() -> None:
    s = sql()
    assert_contains(s, "insert into public.payroll_bn_shift_settings(id)", "settings seed")
    assert s.count("insert into public.payroll_bn_shift_types") == 1, (
        "shift types must only be written by the config RPC, never seeded"
    )
    assert s.count("insert into public.payroll_bn_shift_quotas") == 1, (
        "quotas must only be written by the config RPC, never seeded"
    )
    config = function_body(s, "upsert_payroll_bn_shift_config")
    assert "insert into public.payroll_bn_shift_types" in config, "config writes shift types"
    assert "insert into public.payroll_bn_shift_quotas" in config, "config writes quotas"
    assert "insert into public.payroll_bn_shift_types" not in s[: s.index(config)], "no seed"


def test_helpers() -> None:
    s = sql()
    for name, needles in {
        "payroll_bn_shift_week_start": [
            "extract(isodow from p_date)::integer - 1",
        ],
        "payroll_bn_shift_opens_at": [
            "p_week_start - 7 + (v_settings.open_iso_dow - 1)",
            "at time zone 'asia/ho_chi_minh'",
        ],
        "payroll_bn_shift_deadline": [
            "p_week_start - 7 + (v_settings.deadline_iso_dow - 1)",
            "v_settings.deadline_time",
            "at time zone 'asia/ho_chi_minh'",
        ],
        "payroll_bn_shift_eligible": [
            "from public.payroll_bn_periods p",
            "order by p.date_from desc",
            "e.group_name = any(s.eligible_groups)",
            "e.end_date is null or e.end_date >= p_week_start",
        ],
        "payroll_bn_shift_coverage": [
            "for v_day_offset in 0..6 loop",
            "'code', v_type.code",
            "'quota_group'",
            "'off_count'",
            "'total_staff'",
        ],
    }.items():
        body = function_body(s, name)
        for needle in needles:
            assert_contains(body, needle, f"{name} {needle}")


def test_employee_rpcs_are_service_role_only() -> None:
    s = sql()
    for rpc, signature in [
        ("get_payroll_bn_shift_week", "text, date"),
        ("submit_payroll_bn_shift_registration", "text, date, jsonb"),
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


def test_submit_validates_and_locks_the_week() -> None:
    s = sql()
    body = function_body(s, "submit_payroll_bn_shift_registration")
    for needle, label in [
        ("pg_advisory_xact_lock", "week advisory lock"),
        ("hashtextextended('payroll_bn_shift_week:'", "week lock key"),
        ("if not public.payroll_bn_shift_eligible(v_employee, v_week)", "eligibility"),
        ("v_status <> 'open'", "open week"),
        ("now() < public.payroll_bn_shift_opens_at(v_week)", "opening window"),
        ("now() > public.payroll_bn_shift_deadline(v_week)", "deadline window"),
        ("shift_registration_closed", "closed error"),
        ("v_date = any(v_closed_dates)", "closed dates ignored"),
        ("shift_incomplete_week", "incomplete week error"),
        ("t.active", "active shift only"),
        ("shift_invalid_shift", "invalid shift error"),
        ("v_off_days < coalesce(v_settings.min_off_days_per_week, 1)", "min off days"),
        ("shift_day_off_required", "day off error"),
        ("v_count >= coalesce(v_settings.max_off_per_day, 2)", "off waitlist"),
        ("v_count >= v_needed", "quota waitlist"),
        ("q.quota_group = v_group", "quota group waitlist"),
        ("'waitlist'", "waitlist state"),
        ("'employee'", "employee source"),
        ("delete from public.payroll_bn_shift_entries", "replace previous choices"),
    ]:
        assert_contains(body, needle, label)


def test_manager_rpcs_use_admin_helper() -> None:
    s = sql()
    for rpc in MANAGER_RPCS:
        body = function_body(s, rpc)
        assert_contains(body, "payroll_mission_admin_allowed(v_uid)", f"{rpc} admin check")
        assert_contains(body, "payroll_shift_forbidden", f"{rpc} forbidden error")


def test_manager_edit_publish_reopen_closed_dates() -> None:
    s = sql()
    entry = function_body(s, "set_payroll_bn_shift_entry")
    for needle, label in [
        ("source = 'manager'", "manager source"),
        ("state = 'registered'", "manager registered state"),
        ("entry.source = 'employee'", "keeps employee choice"),
        ("entry.previous_shift_code", "previous shift kept"),
        ("on conflict (employee_code, work_date) do update", "cell upsert"),
        ("insert into public.payroll_bn_shift_weeks", "week row created"),
    ]:
        assert_contains(entry, needle, label)

    publish = function_body(s, "publish_payroll_bn_shift_week")
    for needle, label in [
        ("'carried'", "carried source"),
        ("prev.work_date + 7", "shifted +7 days"),
        ("not exists (", "only unregistered employees"),
        ("current_entry.week_start = v_week", "no current entry"),
        ("prev.state = 'registered'", "registered suggestions only"),
        ("status = 'published'", "published status"),
        ("published_at = now()", "published timestamp"),
    ]:
        assert_contains(publish, needle, label)

    reopen = function_body(s, "reopen_payroll_bn_shift_week")
    assert_contains(reopen, "status = 'open'", "reopen status")
    assert_contains(reopen, "published_at = null", "reopen clears published")

    closed = function_body(s, "set_payroll_bn_shift_closed_dates")
    assert_contains(closed, "closed_dates = coalesce(v_dates, '{}'::date[])", "closed dates stored")
    assert_contains(closed, "d >= v_week", "closed dates inside week")

    config = function_body(s, "upsert_payroll_bn_shift_config")
    for needle, label in [
        ("payroll_shift_type_duplicate_code", "unique codes"),
        ("invalid_start_time", "HH:MM start time"),
        ("invalid_end_time", "HH:MM end time"),
        ("payroll_shift_quota_negative_needed", "needed >= 0"),
        ("payroll_shift_quota_invalid_iso_dow", "iso_dow 1..7"),
        ("delete from public.payroll_bn_shift_quotas", "quotas replaced"),
        ("delete from public.payroll_bn_shift_types", "types replaced"),
    ]:
        assert_contains(config, needle, label)


def test_board_exposes_coverage_warnings_and_suggestions() -> None:
    body = function_body(sql(), "get_payroll_bn_shift_board")
    for needle, label in [
        ("'settings'", "settings"),
        ("'shift_types'", "shift types"),
        ("'quotas'", "quotas"),
        ("'week'", "week"),
        ("'employees'", "employees"),
        ("'employee_name'", "employee name"),
        ("'employment_type'", "employment type"),
        ("'entries'", "entries"),
        ("'suggestions'", "suggestions"),
        ("'carried', true", "carried flag"),
        ("'coverage'", "coverage"),
        ("'below_needed'", "below needed warning"),
        ("'below_min_staff'", "below min staff warning"),
        ("'off_above_max'", "off above max warning"),
        ("'unregistered'", "unregistered warning"),
        ("'totals'", "totals"),
    ]:
        assert_contains(body, needle, label)


def test_employee_payload_never_leaks_other_employees() -> None:
    s = sql()
    for rpc in ("get_payroll_bn_shift_week", "submit_payroll_bn_shift_registration"):
        body = function_body(s, rpc)
        assert "employee_name" not in body, f"{rpc} must not expose employee names"
        assert "payroll_bn_period_employees" not in body, (
            f"{rpc} must not read the period roster"
        )
        assert "from public.payroll_bn_shift_entries" in body, f"{rpc} reads own entries"

    get_body = function_body(s, "get_payroll_bn_shift_week")
    for needle, label in [
        ("where employee_code = v_employee", "employee scoping"),
        ("'eligible'", "eligible flag"),
        ("'week'", "week"),
        ("'shift_types'", "shift types"),
        ("'days'", "days"),
        ("'suggestion'", "suggestion"),
        ("'current_week'", "current week"),
    ]:
        assert_contains(get_body, needle, label)
    # The only employee_code in the payload is inside a WHERE/INSERT, never a
    # jsonb_build_object key.
    assert "'employee_code'," not in get_body, "payload must not include employee codes"


def test_progress_keeps_signature_and_uses_per_date_cutoff() -> None:
    s = sql()
    body = function_body(s, "payroll_mission_progress")
    for needle, label in [
        ("create or replace function public.payroll_mission_progress(p_offer_id uuid)", "signature"),
        ("returns jsonb", "return type"),
        ("language plpgsql", "language"),
        ("stable", "volatility"),
        ("security definer", "security definer"),
        ("set search_path = public", "search_path"),
        ("from public.payroll_mission_offers", "offer lookup"),
        ("from public.payroll_mission_campaigns", "campaign lookup"),
        ("v_offer.status = 'accepted'", "accepted-date window"),
        ("greatest(", "window start"),
        ("least(v_campaign.ends_on, v_today)", "window end today"),
        ("e.decision = 'accepted'", "accepted events only"),
        ("e.event_kind = 'in'", "in events"),
        ("days_with_in", "in-day count"),
        ("days_complete", "complete-day count"),
        ("days_missing_out", "missing-out count"),
        ("on_time_days", "on-time count"),
        ("make_interval(mins => v_grace_minutes)", "grace minutes"),
        ("v_days_with_in >= v_min_days and v_days_missing_out = 0", "regular rule"),
        ("v_days_with_in >= 1 and v_on_time = v_days_with_in", "punctual rule"),
        ("'met', v_met", "met flag"),
        ("'cutoff', to_char(v_cutoff, 'hh24:mi')", "fallback cutoff detail"),
        ("'scheduled_days', v_scheduled_days", "scheduled days detail"),
        ("from public.payroll_bn_shift_entries", "schedule lookup"),
        ("en.work_date = d.work_date", "per-date schedule"),
        ("en.state = 'registered'", "registered schedule only"),
        ("en.shift_code is not null", "shift entry only"),
        ("coalesce(scheduled.start_time, v_cutoff)", "schedule before fallback"),
    ]:
        assert_contains(body, needle, label)

    ordered = [
        body.index("if v_offer.shift_start is not null"),
        body.index("from public.payroll_bn_employee_shifts"),
        body.index("coalesce(v_params->>'cutoff'"),
        body.index("time '07:00'"),
    ]
    assert ordered == sorted(ordered), "fallback precedence must be preserved"

    for needle, label in [
        (
            "revoke all on function public.payroll_mission_progress(uuid)\n"
            "  from public, anon, authenticated;",
            "function revoke",
        ),
        (
            "grant execute on function public.payroll_mission_progress(uuid)\n"
            "  to service_role;",
            "function grant",
        ),
    ]:
        assert_contains(s, needle, label)


def test_shared_pure_logic_and_tests() -> None:
    shared = read(SHARED)
    for needle, label in [
        ("export function weekStart", "weekStart"),
        ("export function shiftDeadline", "deadline"),
        ("export function shiftOpensAt", "opens at"),
        ("export function validateRegistration", "registration validation"),
        ("export function coverage", "coverage"),
        ("export function carrySuggestion", "carried suggestion"),
        ("export function cutoffForDate", "per-date cutoff"),
        ("shift_registration_closed", "closed error"),
        ("shift_not_eligible", "not eligible error"),
        ("shift_invalid_shift", "invalid shift error"),
        ("shift_incomplete_week", "incomplete week error"),
        ("shift_day_off_required", "day off error"),
        ("quota_group", "quota group"),
        ("waitlist", "waitlist"),
    ]:
        assert_contains(shared, needle, label)

    tests = read(SHARED_TEST)
    for needle, label in [
        ("submitting after the deadline is rejected", "deadline test"),
        ("submitting before the opening instant is rejected", "opening test"),
        ("a missing day makes the week incomplete", "missing day test"),
        ("a duplicate day makes the week incomplete", "duplicate day test"),
        ("a closed date is ignored", "closed date test"),
        ("a week without a day off is rejected", "day off test"),
        ("an unknown or inactive shift is rejected", "invalid shift test"),
        ("a full shift is saved as waitlist", "full shift test"),
        ("a day off beyond the daily limit is saved as waitlist", "off limit test"),
        ("a quota group shares one needed number", "quota group test"),
        ("a carried suggestion is the previous week moved +7 days", "carry test"),
        ("per-date cutoff uses the registered shift", "cutoff test"),
        ("Monday/Sunday week boundaries at 23:59 and 00:01 Vietnam time", "week boundary test"),
    ]:
        assert_contains(tests, needle, label)


def test_edge_function_auth_scope_and_error_mapping() -> None:
    edge = read(EDGE)
    for needle, label in [
        ("x-payslip-session", "session header"),
        ("x-payslip-device", "device header"),
        ("payroll_bn_payslip_sessions", "session lookup"),
        ("hashPayslipDeviceId", "device binding"),
        ("get_payroll_bn_shift_week", "get RPC"),
        ("submit_payroll_bn_shift_registration", "submit RPC"),
        ("p_employee_code: session.employee_code", "employee scoping"),
        ("action === \"get\"", "get action"),
        ("action !== \"submit\"", "submit action"),
        ("401", "401 rules"),
        ("session_required", "session required"),
        ("device_mismatch", "device mismatch"),
        ("shift_registration_closed", "closed message"),
        ("shift_not_eligible", "not eligible message"),
        ("shift_day_off_required", "day off message"),
        ("shift_invalid_shift", "invalid shift message"),
        ("shift_incomplete_week", "incomplete week message"),
    ]:
        assert_contains(edge, needle, label)

    assert "body.employee_code" not in edge, "only the session employee_code may be used"
    assert "p_employee_code: body" not in edge, "only the session employee_code may be used"


def test_config_and_cors_register_payslip_shifts() -> None:
    config = read(CONFIG).lower()
    marker = "[functions.payslip-shifts]"
    assert marker in config, "missing config section [functions.payslip-shifts]"
    section = config.split(marker, 1)[1].split("[functions.", 1)[0]
    assert "verify_jwt = false" in section, "payslip-shifts must accept psp_ auth"

    cors = read(CORS)
    assert_contains(cors, "payslip-shifts", "CORS registration")
    assert_contains(cors, "PAYSLIP_PORTAL_FUNCTIONS", "payslip portal function set")


def test_client_types_api_and_admin_hook() -> None:
    types = read(TYPES)
    for needle, label in [
        ("export interface PayrollShiftWeek", "week type"),
        ("export interface PayrollShiftDay", "day type"),
        ("export interface PayrollShiftSource", "source type"),
        ("getShiftWeek(", "get method"),
        ("submitShiftRegistration(", "submit method"),
    ]:
        assert_contains(types, needle, label)

    api = read(API)
    for needle, label in [
        ("normalizeShiftWeek", "normalizer"),
        ("payslip-shifts", "endpoint"),
        ("x-payslip-session", "session header"),
        ("x-payslip-device", "device header"),
        ("action: \"get\"", "get action"),
        ("action: \"submit\"", "submit action"),
        ("status === 401", "401 handling"),
        ("PayslipSessionExpiredError", "session expiry"),
    ]:
        assert_contains(api, needle, label)

    api_test = read(API_TEST)
    for needle, label in [
        ("getShiftWeek sends session/device headers", "get test"),
        ("submitShiftRegistration posts snake_case entries", "submit test"),
        ("a 401 clears the session", "401 test"),
    ]:
        assert_contains(api_test, needle, label)

    hook = read(HOOK)
    for needle, label in [
        ("get_payroll_bn_shift_board", "board RPC"),
        ("set_payroll_bn_shift_entry", "set entry RPC"),
        ("publish_payroll_bn_shift_week", "publish RPC"),
        ("reopen_payroll_bn_shift_week", "reopen RPC"),
        ("set_payroll_bn_shift_closed_dates", "closed dates RPC"),
        ("upsert_payroll_bn_shift_config", "config RPC"),
        ("invalidateQueries", "cache invalidation"),
        ("payroll-bn-shifts", "query key"),
    ]:
        assert_contains(hook, needle, label)


def test_rollback_smoke_covers_required_cases() -> None:
    smoke = read(SMOKE)
    lowered = smoke.lower()
    for needle, label in [
        ("begin;", "transaction"),
        ("do $$", "single DO block"),
        ("set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)", "service-role claims"),
        ("rollback;", "rollback-only"),
        ("upsert_payroll_bn_shift_config", "config fixture"),
        ("submit_payroll_bn_shift_registration", "submit RPC"),
        ("shift_registration_closed", "deadline case"),
        ("shift_day_off_required", "no day off case"),
        ("set_payroll_bn_shift_closed_dates", "closed date case"),
        ("last_slot_not_waitlisted", "last slot case"),
        ("off_limit_not_waitlisted", "off limit case"),
        ("previous_shift_code", "manager previous shift case"),
        ("publish_payroll_bn_shift_week", "publish case"),
        ("carried_entries_not_stored", "carried case"),
        ("get_payroll_bn_shift_board", "board case"),
        ("below_needed", "board warning"),
        ("payroll_mission_progress", "progress case"),
        ("07:45", "late/on-time check-in"),
        ("scheduled_days", "scheduled days detail"),
        ("time '08:00'", "scheduled 08:00 start"),
        ("events_delete_not_blocked", "audit append-only case"),
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
