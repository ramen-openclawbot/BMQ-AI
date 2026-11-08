#!/usr/bin/env python3
"""Static contracts for payroll_bn attendance consent + selfie retention."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261109120000_payroll_bn_attendance_consent.sql"
SHARED = ROOT / "supabase/functions/_shared/payroll-attendance.ts"
CORS = ROOT / "supabase/functions/_shared/cors.ts"
CONFIG = ROOT / "supabase/config.toml"
TODAY = ROOT / "supabase/functions/payslip-attendance-today/index.ts"
CONSENT = ROOT / "supabase/functions/payslip-attendance-consent/index.ts"
RETENTION = ROOT / "supabase/functions/payroll-attendance-selfie-retention/index.ts"
TYPES = ROOT / "src/lib/payslip-portal/types.ts"
API = ROOT / "src/lib/payslip-portal/attendance-api.ts"
API_TEST = ROOT / "src/lib/payslip-portal/attendance-api.test.ts"
HOOK = ROOT / "src/hooks/usePayrollBnAttendanceAdmin.ts"
SMOKE = ROOT / "scripts/smoke_payroll_bn_attendance_consent.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def sql() -> str:
    return read(MIGRATION).lower()


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def record_function(text: str) -> str:
    start = text.index("create or replace function public.record_payroll_bn_attendance_event")
    end = text.index("$sql$;", start)
    return text[start:end]


def test_consent_table_is_append_only_and_versioned() -> None:
    s = sql()
    for needle, label in [
        ("create table if not exists public.payroll_bn_attendance_consents", "consent table"),
        ("employee_code text not null", "employee code"),
        ("consent_version text not null", "consent version"),
        ("accepted_at timestamptz", "acceptance timestamp"),
        ("device_hash text not null", "device evidence"),
        ("session_id uuid references public.payroll_bn_payslip_sessions(id) on delete set null", "session evidence"),
        ("user_agent_family text", "user agent family"),
        ("withdrawn_at timestamptz", "withdrawal timestamp"),
        ("created_at timestamptz not null default now()", "created timestamp"),
        ("payroll_bn_attendance_consents_one_active", "partial unique index"),
        ("on public.payroll_bn_attendance_consents(employee_code, consent_version)", "one consent per employee/version"),
        ("where withdrawn_at is null", "non-withdrawn partial predicate"),
        ("create or replace function public.enforce_payroll_bn_attendance_consent_append_only", "append-only trigger fn"),
        ("before update or delete on public.payroll_bn_attendance_consents", "append-only trigger"),
        ("payroll_bn_attendance_consents_are_append_only", "delete blocked"),
        ("payroll_bn_attendance_consent_withdrawn_once", "withdraw once"),
        ("(to_jsonb(new) - 'withdrawn_at') is distinct from (to_jsonb(old) - 'withdrawn_at')", "only withdrawn_at may change"),
    ]:
        assert_contains(s, needle, label)


def test_consent_table_is_service_role_only() -> None:
    s = sql()
    assert_contains(
        s,
        "alter table public.payroll_bn_attendance_consents enable row level security",
        "consent RLS",
    )
    assert_contains(
        s,
        "revoke all on table public.payroll_bn_attendance_consents\n  from public, anon, authenticated",
        "browser revoke",
    )
    assert_contains(
        s,
        "grant all on table public.payroll_bn_attendance_consents to service_role",
        "service-role consent grant",
    )
    assert "grant select on table public.payroll_bn_attendance_consents to authenticated" not in s
    assert "create policy" not in s.split("payroll_bn_attendance_consents", 1)[1].split(
        "payroll_bn_attendance_consent_config", 1
    )[0]


def test_singleton_config_version_and_retention_default() -> None:
    s = sql()
    for needle, label in [
        ("create table if not exists public.payroll_bn_attendance_consent_config", "config table"),
        ("id boolean primary key default true", "singleton id"),
        ("current_version text not null", "current version"),
        ("selfie_retention_days int not null default 90", "90-day default"),
        ("check (selfie_retention_days between 30 and 365)", "retention bounds"),
        ("'2026-11-09'", "seeded version"),
        ("90\n", "seeded retention"),
        ("alter table public.payroll_bn_attendance_consent_config enable row level security", "config RLS"),
        ("revoke all on table public.payroll_bn_attendance_consent_config\n  from public, anon, authenticated", "config browser revoke"),
        ("grant all on table public.payroll_bn_attendance_consent_config to service_role", "config service grant"),
    ]:
        assert_contains(s, needle, label)


def test_record_rpc_checks_consent_after_session_before_accept_paths() -> None:
    s = sql()
    record = record_function(s)
    for needle, label in [
        ("p_employee_code text", "exact signature employee"),
        ("p_event_kind text", "exact signature kind"),
        ("p_device_hash text", "exact signature device"),
        ("p_session_id uuid", "exact signature session"),
        ("p_latitude numeric", "exact signature latitude"),
        ("p_longitude numeric", "exact signature longitude"),
        ("p_accuracy_m numeric", "exact signature accuracy"),
        ("p_device_captured_at timestamptz", "exact signature captured at"),
        ("p_selfie_path text", "exact signature selfie"),
        ("p_user_agent_family text default null", "exact signature UA"),
        ("coalesce(auth.role(), '') <> 'service_role'", "service-role check"),
        ("v_reason := 'session_invalid'", "existing session rule"),
        ("from public.payroll_bn_attendance_consents c", "consent lookup"),
        ("c.withdrawn_at is null", "withdrawn rows never accepted"),
        ("from public.payroll_bn_attendance_consent_config cfg", "current version lookup"),
        ("v_reason := 'consent_required'", "consent rejection"),
        ("'gate_disabled'", "existing gate rule"),
        ("'outside_geofence'", "existing geofence rule"),
        ("'device_used_by_other'", "existing proxy rule"),
        ("'already_recorded'", "existing duplicate rule"),
        ("'checkout_before_checkin'", "existing ordering rule"),
    ]:
        assert_contains(record, needle, label)

    session_at = record.index("v_reason := 'session_invalid'")
    consent_at = record.index("'consent_required'")
    gate_at = record.index("-- rollout gate")
    assert session_at < consent_at < gate_at, "consent check must sit between session and gate"


def test_accept_rejects_non_current_version_and_is_idempotent() -> None:
    s = sql()
    for needle, label in [
        ("create or replace function public.accept_payroll_bn_attendance_consent(", "accept RPC"),
        ("p_version text", "accept version argument"),
        ("p_device_hash text", "accept device argument"),
        ("p_session_id uuid", "accept session argument"),
        ("p_user_agent_family text", "accept UA argument"),
        ("select current_version into v_current_version", "current version read"),
        ("payroll_bn_attendance_consent_version_not_current", "non-current rejection"),
        ("if v_row.id is not null then\n    return jsonb_build_object('consent', to_jsonb(v_row));", "idempotent return"),
        ("exception when unique_violation then", "concurrent accept safe"),
        ("create or replace function public.withdraw_payroll_bn_attendance_consent(", "withdraw RPC"),
        ("set withdrawn_at = statement_timestamp()", "withdraw timestamp"),
        ("where employee_code = v_employee_code\n    and withdrawn_at is null", "withdraw only active rows"),
    ]:
        assert_contains(s, needle, label)

    for signature in [
        "accept_payroll_bn_attendance_consent(\n    text, text, text, uuid, text\n  ) from public, anon, authenticated",
        "accept_payroll_bn_attendance_consent(\n    text, text, text, uuid, text\n  ) to service_role",
        "withdraw_payroll_bn_attendance_consent(text)\n    from public, anon, authenticated",
        "withdraw_payroll_bn_attendance_consent(text)\n    to service_role",
    ]:
        assert_contains(s, signature, "consent RPC service-role grant")


def test_list_rpc_exposes_latest_consent_per_employee() -> None:
    s = sql()
    list_start = s.index("create or replace function public.list_payroll_bn_attendance(")
    list_end = s.index("$sql$;", list_start)
    listing = s[list_start:list_end]
    for needle, label in [
        ("'consents', coalesce((", "consents payload"),
        ("select distinct on (employee_code)", "latest row per employee"),
        ("'employee_code', c.employee_code", "employee code field"),
        ("'consent_version', c.consent_version", "version field"),
        ("'accepted_at', c.accepted_at", "accepted_at field"),
        ("'withdrawn_at', c.withdrawn_at", "withdrawn_at field"),
        ("order by employee_code, accepted_at desc, id desc", "latest ordering"),
    ]:
        assert_contains(listing, needle, label)
    assert_contains(
        s,
        "grant execute on function public.list_payroll_bn_attendance(date, date) to authenticated, service_role",
        "existing grant",
    )


def test_daily_retention_cron_uses_existing_shared_secret_pattern() -> None:
    s = sql()
    for needle, label in [
        ("cron.schedule(", "cron schedule"),
        ("'payroll-attendance-selfie-retention-daily'", "job name"),
        ("'30 20 * * *'", "20:30 UTC = 03:30 Asia/Ho_Chi_Minh"),
        ("net.http_post(", "edge call"),
        ("/functions/v1/payroll-attendance-selfie-retention", "retention endpoint"),
        ("'x-worker-secret', ", "shared secret header"),
        ("select worker_secret::text", "secret from singleton config"),
        ("cron.unschedule", "idempotent reschedule"),
    ]:
        assert_contains(s, needle, label)
    assert "03:30" in s, "migration must document the 03:30 ICT schedule"


def test_shared_module_consent_and_retention_logic() -> None:
    shared = read(SHARED)
    for needle, label in [
        ('PAYROLL_ATTENDANCE_CONSENT_VERSION = "2026-11-09"', "consent version constant"),
        ('"consent_required"', "consent reason"),
        ("consentAccepted?: boolean", "consent input"),
        ("if (input.consentAccepted === false) return reject(\"consent_required\")", "consent evaluation"),
        ("Bạn cần đọc và đồng ý thoả thuận sử dụng hình ảnh và vị trí trước khi chấm công.", "exact consent message"),
        ("export function attendanceConsentState", "consent state helper"),
        ("export function selfieRetentionCutoff", "retention cutoff helper"),
        ("export function selectExpiredSelfiePaths", "retention selection helper"),
        ("PAYROLL_ATTENDANCE_SELFIE_RETENTION_DEFAULT_DAYS = 90", "90-day constant"),
        ("PAYROLL_ATTENDANCE_SELFIE_RETENTION_MAX_PER_RUN = 1000", "1000/run cap"),
    ]:
        assert_contains(shared, needle, label)

    test_file = read(ROOT / "supabase/functions/_shared/payroll-attendance.test.ts")
    for needle, label in [
        ("consent_required", "consent test"),
        ("selfieRetentionCutoff", "cutoff test"),
        ("selectExpiredSelfiePaths", "selection test"),
    ]:
        assert_contains(test_file, needle, label)


def test_today_and_consent_functions_are_wired() -> None:
    today = read(TODAY)
    for needle, label in [
        ("payroll_bn_attendance_consent_config", "today config read"),
        ("payroll_bn_attendance_consents", "today consent read"),
        ("attendanceConsentState", "today state helper"),
        ("required_version: consent.requiredVersion", "today required version"),
        ("accepted: consent.accepted", "today accepted flag"),
        ("accepted_at: consent.acceptedAt", "today accepted_at"),
        ("withdrawn_at: consent.withdrawnAt", "today withdrawn_at"),
    ]:
        assert_contains(today, needle, label)

    consent = read(CONSENT)
    for needle, label in [
        ("payslip-attendance-consent", "consent endpoint header"),
        ("x-payslip-session", "consent session header"),
        ("x-payslip-device", "consent device header"),
        ("accept_payroll_bn_attendance_consent", "accept RPC call"),
        ("withdraw_payroll_bn_attendance_consent", "withdraw RPC call"),
        ("consent_version_not_current", "version error mapping"),
        ('401, "session_required"', "401 session required"),
        ('401, "session_invalid"', "401 session invalid"),
        ('401, "device_mismatch"', "401 device mismatch"),
    ]:
        assert_contains(consent, needle, label)

    retention = read(RETENTION)
    for needle, label in [
        ("payroll-attendance-selfies", "private bucket"),
        ("x-worker-secret", "worker secret header"),
        ("timingSafeEqual", "constant-time secret comparison"),
        ("selfie_retention_days", "config retention days"),
        (".list(folder", "paginated storage list"),
        (".remove(chunk", "storage removal"),
        ("selectExpiredSelfiePaths", "pure selection"),
        ("deleted", "deleted result"),
        ("scanned", "scanned result"),
    ]:
        assert_contains(retention, needle, label)
    assert "payroll_bn_attendance_events" not in retention, "retention must never touch the ledger"


def test_config_and_cors_register_new_functions() -> None:
    config = read(CONFIG).lower()
    for name in ["payslip-attendance-consent", "payroll-attendance-selfie-retention"]:
        marker = f"[functions.{name}]"
        assert marker in config, f"Missing config section: {marker}"
        section = config.split(marker, 1)[1].split("[functions.", 1)[0]
        assert "verify_jwt = false" in section, f"{name} must accept its own auth pattern"

    cors = read(CORS)
    assert_contains(cors, "payslip-attendance-consent", "consent CORS registration")


def test_client_types_api_and_hook_expose_consent() -> None:
    types = read(TYPES)
    for needle, label in [
        ("export interface PayrollAttendanceConsentState", "consent state type"),
        ("requiredVersion: string", "required version field"),
        ("accepted: boolean", "accepted field"),
        ("consent: PayrollAttendanceConsentState", "today.consent"),
        ("acceptConsent(version: string)", "accept client method"),
        ("withdrawConsent()", "withdraw client method"),
    ]:
        assert_contains(types, needle, label)

    api = read(API)
    for needle, label in [
        ("normalizeTodayPayload", "normalizer"),
        ("consent: asConsent(data?.consent ?? today.consent)", "consent normalisation"),
        ("payslip-attendance-consent", "consent endpoint"),
        ("acceptConsent(version: string)", "accept client"),
        ("withdrawConsent()", "withdraw client"),
        ("x-payslip-device", "device header"),
        ("x-payslip-session", "session header"),
        ("status === 401", "401 handling"),
    ]:
        assert_contains(api, needle, label)

    api_test = read(API_TEST)
    assert_contains(api_test, "acceptConsent", "client accept test")
    assert_contains(api_test, "withdrawConsent", "client withdraw test")

    hook = read(HOOK)
    for needle, label in [
        ("export interface PayrollAttendanceAdminConsent", "admin consent type"),
        ("consents: PayrollAttendanceAdminConsent[]", "admin list consents"),
        ("consents: attendanceQuery.data?.consents ?? []", "admin exposed consents"),
    ]:
        assert_contains(hook, needle, label)


def test_rollback_smoke_covers_required_cases() -> None:
    smoke = read(SMOKE)
    lowered = smoke.lower()
    for needle, label in [
        ("do $$", "single DO block"),
        ("set_config('request.jwt.claims'", "service-role claims"),
        ("rollback", "rollback-only"),
        ("consent_required", "no-consent rejection"),
        ("accept_payroll_bn_attendance_consent", "accept RPC"),
        ("withdraw_payroll_bn_attendance_consent", "withdraw RPC"),
        ("consent_version_not_current", "non-current version"),
        ("withdrawn_once", "withdraw only once"),
        ("only_withdrawn_at", "only withdrawn_at update"),
        ("delete_blocked", "delete blocked"),
    ]:
        assert_contains(lowered, needle, label)
    assert "\\set" not in smoke and "\\gset" not in smoke, "smoke must be pure SQL"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
