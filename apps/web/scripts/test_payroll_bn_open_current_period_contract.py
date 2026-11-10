#!/usr/bin/env python3
"""Static contracts for opening the current Bếp BN payroll period."""
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261111090000_payroll_bn_open_current_period.sql"
SMOKE = ROOT / "scripts/smoke_payroll_bn_open_current_period.sql"
DB_CLIENT = ROOT / "src/lib/payroll-bn/db-client.ts"
DB_CLIENT_TEST = ROOT / "src/lib/payroll-bn/db-client.test.ts"
DB_MAPPING = ROOT / "src/lib/payroll-bn/db-mapping.ts"
DB_MAPPING_TEST = ROOT / "src/lib/payroll-bn/db-mapping.test.ts"
TYPES = ROOT / "src/lib/payroll-bn/types.ts"
COMPONENT_TYPES = ROOT / "src/components/payroll/bep-bn/types.ts"
HOOK = ROOT / "src/hooks/useBepBnData.ts"

FUNCTIONS = [
    "payroll_bn_open_period_internal",
    "payroll_bn_open_period",
    "get_payroll_bn_current_period",
]

# Remove the three function bodies so top-level statements can be inspected.
FUNCTION_RE = re.compile(
    r"create or replace function public\.\w+\([^)]*\)[\s\S]*?\$\$;",
    re.IGNORECASE,
)


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def sql() -> str:
    return read(MIGRATION).lower()


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def function_body(text: str, name: str) -> str:
    start = text.index(f"create or replace function public.{name}(")
    end = text.index("$$;", start)
    return text[start:end]


def test_three_functions_are_security_definer_with_search_path() -> None:
    s = sql()
    for name in FUNCTIONS:
        body = function_body(s, name)
        assert "security definer" in body, f"{name} must be security definer"
        assert "set search_path = public" in body, f"{name} must set search_path"


def test_internal_function_is_private() -> None:
    s = sql()
    assert_contains(
        s,
        "revoke all on function public.payroll_bn_open_period_internal(date, uuid)\n"
        "  from public, anon, authenticated;",
        "internal revoke",
    )
    assert_contains(
        s,
        "grant execute on function public.payroll_bn_open_period_internal(date, uuid)\n"
        "  to service_role;",
        "internal service_role grant",
    )
    assert (
        "grant execute on function public.payroll_bn_open_period_internal(date, uuid)\n"
        "  to authenticated"
    ) not in s, "internal worker must not be granted to authenticated"
    assert (
        "grant execute on function public.payroll_bn_open_period_internal(date, uuid)\n"
        "  to anon"
    ) not in s, "internal worker must not be granted to anon"


def test_public_rpcs_are_granted_only_to_logged_in_roles() -> None:
    s = sql()
    for rpc, signature in [
        ("payroll_bn_open_period", "date"),
        ("get_payroll_bn_current_period", ""),
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

    assert " to anon" not in s, "nothing may be granted to anon"


def test_internal_worker_is_advisory_locked_and_idempotent() -> None:
    s = sql()
    body = function_body(s, "payroll_bn_open_period_internal")
    for needle, label in [
        ("pg_advisory_xact_lock", "advisory lock"),
        ("hashtext('payroll_bn_open_period')", "fixed lock key"),
        ("created', false", "existing period flag"),
        ("created', true", "created flag"),
        ("'draft'", "draft status"),
        ("on conflict (period_id, employee_code) do nothing", "catalogue dedupe"),
        ("unique_violation", "period code race"),
        ("date_trunc(", "month normalisation"),
        ("interval '1 month' - interval '1 day'", "last day of month"),
        ("'t' || to_char(v_month, 'mm')", "period code format"),
        ("' — bếp bn'", "period name format"),
    ]:
        assert_contains(body, needle, label)

    assert "for update" not in body, "the opener must not lock period rows"


def test_catalogue_copy_skips_terminated_and_overrides() -> None:
    s = sql()
    body = function_body(s, "payroll_bn_open_period_internal")
    for needle, label in [
        ("e.employee_code", "employee code"),
        ("e.employee_name", "employee name"),
        ("e.group_name", "group"),
        ("e.employment_type", "employment type"),
        ("e.monthly_salary", "monthly salary"),
        ("e.daily_rate", "daily rate"),
        ("e.hourly_rate", "hourly rate"),
        ("e.overtime_rate", "overtime rate"),
        ("e.allowance", "allowance"),
        ("e.start_date", "start date"),
        ("e.end_date", "end date"),
        ("(e.end_date is null or e.end_date >= v_month)", "end-date filter"),
        ("standard_days_override", "override column present"),
    ]:
        assert_contains(body, needle, label)

    assert "e.standard_days_override" not in body, (
        "standard_days_override must never be copied from the source row"
    )
    # The inserted override value is the literal null between allowance and start_date.
    assert "e.allowance,\n      null,\n      e.start_date" in body, (
        "the copied rows must force standard_days_override to null"
    )


def test_rules_and_config_come_from_the_latest_earlier_period() -> None:
    s = sql()
    body = function_body(s, "payroll_bn_open_period_internal")
    for needle, label in [
        ("where p.date_from < v_month", "earlier-period filter"),
        ("order by p.date_from desc, p.created_at desc", "latest earlier period"),
        ("v_source.default_standard_days", "default days copied"),
        ("v_source.standard_days_by_group", "group days copied"),
        ("v_source.rules_config", "rules copied"),
        ("'[]'::jsonb", "holidays reset"),
    ]:
        assert_contains(body, needle, label)


def test_public_rpc_defaults_and_refuses_months() -> None:
    s = sql()
    body = function_body(s, "payroll_bn_open_period")
    for needle, label in [
        ("auth.uid()", "uid"),
        ("'asia/ho_chi_minh'", "ICT timezone"),
        ("insufficient_privilege: payroll edit required", "role error"),
        ("payroll_bn_period_month_in_future", "future error"),
        ("payroll_bn_period_month_in_past", "past error"),
        ("42501", "role sqlstate"),
        ("22023", "month sqlstate"),
        ("auth.role() = 'service_role'", "service role"),
        ("public.payroll_bn_open_period_internal(v_month, v_uid)", "internal call"),
    ]:
        assert_contains(body, needle, label)

    # The future check comes before the existing/past lookup.
    assert body.index("payroll_bn_period_month_in_future") < body.index(
        "payroll_bn_period_month_in_past"
    ), "future months must be refused before the past check"


def test_current_period_probe_shape() -> None:
    s = sql()
    body = function_body(s, "get_payroll_bn_current_period")
    for needle, label in [
        ("insufficient_privilege: payroll edit required", "role check"),
        ("'month'", "month key"),
        ("'period'", "period key"),
        ("'period_code'", "period code"),
        ("'period_name'", "period name"),
        ("'date_from'", "date from"),
        ("'date_to'", "date to"),
        ("'status'", "status"),
        ("'employees'", "employees"),
        ("'latest_period_code'", "latest code"),
        ("count(*)", "employee count"),
    ]:
        assert_contains(body, needle, label)


def test_daily_cron_is_idempotent() -> None:
    s = sql()
    assert_contains(s, "'payroll-bn-open-current-period'", "cron job name")
    assert_contains(s, "'5 17 * * *'", "cron schedule")
    assert_contains(s, "pg_extension where extname = 'pg_cron'", "cron schema guard")
    assert_contains(s, "cron.unschedule", "unschedule")
    assert_contains(s, "cron.schedule", "schedule")
    assert_contains(s, "payroll_bn_open_period_internal", "cron command")
    assert_contains(s, "now() at time zone 'asia/ho_chi_minh'", "cron ICT date")
    assert s.index("cron.unschedule") < s.index("cron.schedule"), (
        "the job must be unscheduled by name before scheduling"
    )


def test_migration_creates_no_period_and_edits_no_existing_rows() -> None:
    s = sql()
    stripped = FUNCTION_RE.sub("", s)
    for needle in [
        "insert into public.payroll_bn_periods",
        "insert into public.payroll_bn_period_employees",
        "update public.payroll_bn_periods",
        "update public.payroll_bn_period_employees",
        "delete from public.payroll_bn_periods",
        "delete from public.payroll_bn_period_employees",
    ]:
        assert needle not in stripped, f"top-level migration must not contain {needle!r}"

    # No update/delete of the two tables anywhere (the opener only inserts).
    for needle in [
        "update public.payroll_bn_periods",
        "update public.payroll_bn_period_employees",
        "delete from public.payroll_bn_periods",
        "delete from public.payroll_bn_period_employees",
    ]:
        assert needle not in s, f"migration must not contain {needle!r}"

    assert "create or replace function public.payroll_bn_import_attendance" not in s, (
        "the applied attendance import must not be redefined"
    )


def test_client_functions_types_and_mapping() -> None:
    client = read(DB_CLIENT)
    for needle, label in [
        ("export async function openPeriod", "openPeriod"),
        ("export async function getCurrentPeriod", "getCurrentPeriod"),
        ("payroll_bn_open_period", "open RPC"),
        ("get_payroll_bn_current_period", "current-period RPC"),
        ("mapOpenPeriodResult", "open mapper use"),
        ("mapCurrentPeriod", "current mapper use"),
        ("payroll_bn_period_month_in_future", "future message"),
        ("payroll_bn_period_month_in_past", "past message"),
    ]:
        assert_contains(client, needle, label)

    types = read(TYPES)
    for needle, label in [
        ("export interface PayrollBnOpenPeriodResult", "open result type"),
        ("export interface PayrollBnCurrentPeriodSummary", "current summary type"),
        ("export interface PayrollBnCurrentPeriod", "current period type"),
        ("sourcePeriodCode", "source period code"),
        ("latestPeriodCode", "latest period code"),
    ]:
        assert_contains(types, needle, label)

    mapping = read(DB_MAPPING)
    for needle, label in [
        ("export function mapOpenPeriodResult", "open mapper"),
        ("export function mapCurrentPeriod", "current mapper"),
        ("period_id", "open id key"),
        ("copied_employees", "copied count key"),
        ("latest_period_code", "latest code key"),
    ]:
        assert_contains(mapping, needle, label)

    component_types = read(COMPONENT_TYPES)
    for needle, label in [
        ("currentPeriod:", "data source currentPeriod"),
        ("openCurrentPeriod:", "data source openCurrentPeriod"),
        ("copiedEmployees: number", "open result contract"),
    ]:
        assert_contains(component_types, needle, label)

    hook = read(HOOK)
    for needle, label in [
        ('["payroll-bn", "current-period"]', "current query key"),
        ("openPeriod(client, null)", "open mutation call"),
        ("currentPeriod: currentPeriodQuery.data ?? null", "current period return"),
        ("openCurrentPeriod: async () =>", "open action return"),
        ("invalidateCurrentPeriod();", "current query invalidation"),
        ("invalidatePeriods();", "periods invalidation"),
        ("invalidatePeriod(result.periodId);", "opened period invalidation"),
    ]:
        assert_contains(hook, needle, label)


def test_client_and_mapping_tests_cover_the_new_paths() -> None:
    client_test = read(DB_CLIENT_TEST)
    for needle, label in [
        ("openPeriod sends the requested month", "open args test"),
        ("openPeriod sends null when no month is given", "open default test"),
        ("getCurrentPeriod maps month, period and latest code", "current map test"),
        ("getCurrentPeriod tolerates a missing period", "current tolerance test"),
        ("openPeriod and getCurrentPeriod map month errors", "month errors test"),
        ("Không thể mở kỳ lương của tháng trong tương lai", "future message test"),
        ("Không thể mở kỳ lương của tháng trước kỳ gần nhất", "past message test"),
    ]:
        assert_contains(client_test, needle, label)

    mapping_test = read(DB_MAPPING_TEST)
    for needle, label in [
        ("mapOpenPeriodResult maps the created period", "open mapping test"),
        ("mapOpenPeriodResult tolerates missing fields", "open tolerance test"),
        ("mapCurrentPeriod maps the month, period and latest code", "current mapping test"),
        ("mapCurrentPeriod tolerates a missing period", "current tolerance test"),
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
        ("payroll_bn_open_period(null)", "public open"),
        ("payroll_bn_open_period_internal", "internal worker"),
        ("get_payroll_bn_current_period", "current-period probe"),
        ("payroll_bn_shift_eligible", "shift eligibility"),
        ("payroll_bn_shift_settings", "eligible groups read from settings"),
        ("payroll_bn_period_employees_group_check", "throwaway group constraint"),
        ("task_open_", "TASK fixtures"),
        ("terminated_employee_copied", "terminated employee exclusion"),
        ("standard_days_override_copied", "override not copied"),
        ("copied_catalogue_values_changed", "salary/rate preservation"),
        ("second_open_not_idempotent", "second call idempotency"),
        ("second_open_added_rows", "second call adds no rows"),
        ("payroll_bn_period_month_in_future", "future month refusal"),
        ("insufficient_privilege", "non-manager refusal"),
        ("branch:", "documented branch"),
        ("task-only scenario", "TASK-only branch scenario"),
        ("open_period_smoke_pass", "final notice"),
    ]:
        assert_contains(lowered, needle, label)

    assert smoke.count("do $$") == 1, "smoke must be one DO block"
    assert "\\set" not in smoke and "\\gset" not in smoke, "smoke must be pure SQL"
    assert "commit;" not in lowered, "smoke must never commit"
    assert not (ROOT / "scripts" / "__pycache__").exists(), (
        "scripts must not keep __pycache__"
    )


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
