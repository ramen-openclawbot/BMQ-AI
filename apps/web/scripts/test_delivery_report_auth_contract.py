#!/usr/bin/env python3
"""Static contracts for delivery-staff OTP/session separation on baocao."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS = ROOT / "supabase/functions"
SHARED = FUNCTIONS / "_shared/report.ts"
MIGRATIONS = ROOT / "supabase/migrations"
DELIVERY_MIGRATION_GLOB = "202608191030*.sql"
NEW_MIGRATION = MIGRATIONS / "20260819103000_delivery_staff_report_auth_sessions.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def read_delivery_migrations() -> str:
    paths = sorted(MIGRATIONS.glob(DELIVERY_MIGRATION_GLOB))
    assert paths, "Missing delivery report auth migrations"
    return "\n".join(read(path) for path in paths)


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def assert_not_contains(text: str, needle: str, label: str) -> None:
    assert needle not in text, f"Unexpected {label}: {needle!r}"


def test_delivery_otp_schema_extends_report_auth_without_weakening_report_staff_contract() -> None:
    migration = read_delivery_migrations()

    for needle, label in [
        ("alter table public.kiosk_report_otp_challenges", "OTP table extension"),
        ("add column if not exists actor_type text not null default 'report_staff'", "OTP actor type"),
        ("add column if not exists delivery_staff_id uuid references public.delivery_staff(id)", "OTP delivery actor FK"),
        ("drop not null", "existing staff/location nullable for delivery-only OTPs"),
        ("kiosk_report_otp_actor_shape_check", "OTP actor shape check"),
        ("actor_type = 'report_staff'", "report staff actor shape"),
        ("actor_type = 'delivery_staff'", "delivery actor shape"),
        ("alter table public.kiosk_report_sessions", "session table extension"),
        ("kiosk_report_sessions_actor_shape_check", "session actor shape check"),
        ("create index if not exists kiosk_report_sessions_delivery_staff_idx", "delivery session index"),
        ("create or replace function public.verify_kiosk_report_otp_atomic", "atomic verifier updated in same migration"),
        ("'actor_type', 'report_staff'", "report verify payload actor type"),
        ("'actor_type', 'delivery_staff'", "delivery verify payload actor type"),
    ]:
        assert_contains(migration, needle, label)

    assert_not_contains(migration.lower(), "monthly_salary_vnd'", "salary in public JSON payload")
    assert_not_contains(migration.lower(), "gps", "GPS/private location payload")


def test_delivery_migrations_are_parser_safe_and_harden_rpc_grants() -> None:
    paths = sorted(MIGRATIONS.glob(DELIVERY_MIGRATION_GLOB))
    assert paths, "Missing delivery report auth migrations"
    for path in paths:
        source = read(path)
        function_count = source.lower().count("language plpgsql")
        assert function_count <= 1, f"Multiple PL/pgSQL functions in {path.name}"
        if function_count:
            closing = source.rfind("$$;")
            assert closing >= 0, f"Missing dollar-quoted function terminator in {path.name}"
            assert not source[closing + 3 :].strip(), (
                f"Supabase CLI may group statements after PL/pgSQL function in {path.name}"
            )

    migration = read_delivery_migrations()
    assert_contains(
        migration,
        "revoke all on function public.verify_kiosk_report_otp_atomic(uuid, text, text, text, timestamptz, text, text) from public, anon, authenticated",
        "verify RPC public/authenticated revoke",
    )
    assert_contains(
        migration,
        "grant execute on function public.verify_kiosk_report_otp_atomic(uuid, text, text, text, timestamptz, text, text) to service_role",
        "verify RPC service role grant",
    )


def test_delivery_phone_collision_guards_preserve_dealer_and_report_audience_separation() -> None:
    migration = read_delivery_migrations()

    for needle, label in [
        ("block_delivery_staff_active_phone_collision", "delivery phone guard"),
        ("from public.kiosk_report_staff krs", "delivery vs report staff collision"),
        ("from public.dealer_customer_contacts dcc", "delivery vs dealer contact collision"),
        ("Phone % is already active for kiosk reports; delivery staff cannot use report-staff access", "safe report collision error"),
        ("Phone % is already active for dealer ordering; delivery staff cannot use dealer access", "safe dealer collision error"),
        ("before insert or update of phone_normalized, active", "delivery trigger columns"),
        ("on public.delivery_staff", "delivery trigger target"),
        ("block_report_staff_dealer_contact_phone", "existing report/dealer guard preserved"),
        ("from public.delivery_staff ds", "report/dealer guards include delivery"),
    ]:
        assert_contains(migration, needle, label)


def test_auth_start_is_generic_and_can_issue_delivery_challenges_without_enumeration() -> None:
    auth_start = read(FUNCTIONS / "report-auth-start/index.ts")

    assert_contains(auth_start, "genericAuthStartResponse", "generic auth-start response helper")
    assert_contains(auth_start, '.from("delivery_staff")', "delivery staff eligibility lookup")
    assert_contains(auth_start, 'actor_type: "delivery_staff"', "delivery OTP actor marker")
    assert_contains(auth_start, 'actor_type: "report_staff"', "report OTP actor marker")
    assert_contains(auth_start, "staffRows.length + deliveryRows.length !== 1", "ambiguous/unknown fail-closed branch")
    assert_contains(auth_start, "OTP_RESEND_COOLDOWN_SECONDS", "shared cooldown for either actor")
    assert_contains(auth_start, "return genericAuthStartResponse(req);", "single generic success response path")
    assert_not_contains(auth_start, "genericAuthStartResponse(req, {", "enumerable generic response extras")
    serve_body = auth_start.split("async function sendEligibleReportOtpChallenge", 1)[0]
    assert_not_contains(serve_body, "challenge_id", "public challenge id enumeration")
    assert_not_contains(auth_start, "delivery_staff_not_registered", "enumerable delivery unknown reason")
    assert_not_contains(auth_start, "delivery_staff_needs_support", "enumerable delivery support reason")
    assert_not_contains(auth_start, "monthly_salary_vnd", "delivery salary exposure")


def test_auth_verify_and_session_return_minimal_actor_profile() -> None:
    auth_verify = read(FUNCTIONS / "report-auth-verify/index.ts")
    shared = read(SHARED)
    session = read(FUNCTIONS / "report-session/index.ts")

    for source, label in [(auth_verify, "verify"), (shared, "shared"), (session, "session")]:
        assert_contains(source, "actor_type", f"{label} actor type")
        assert_not_contains(source, "monthly_salary_vnd", f"{label} salary exposure")
        assert_not_contains(source.lower(), "gps", f"{label} GPS exposure")

    assert_contains(shared, "publicReportActorProfile", "generic public actor profile helper")
    assert_contains(shared, "delivery_staff", "delivery session resolver path")
    assert_contains(session, "publicReportActorProfile", "session returns either actor profile")


def test_report_bootstrap_and_daily_save_reject_delivery_sessions_fail_closed() -> None:
    bootstrap = read(FUNCTIONS / "report-bootstrap/index.ts")
    daily_save = read(FUNCTIONS / "report-daily-save/index.ts")

    for source, label in [(bootstrap, "bootstrap"), (daily_save, "daily save")]:
        assert_contains(source, "requireKioskReportStaffSession", f"{label} report-staff-only gate")
        assert_contains(source, "delivery_staff_forbidden", f"{label} delivery forbidden code")
        assert_contains(source, "Nhân viên giao hàng không có quyền gửi báo cáo điểm bán", f"{label} safe error copy")

    assert_contains(read(FUNCTIONS / "report-session/index.ts"), "resolveReportSession", "portal shell still accepts resolved session")


PUBLIC_REPORT_FUNCTIONS = [
    "report-auth-start/index.ts",
    "report-auth-verify/index.ts",
    "report-session/index.ts",
    "report-bootstrap/index.ts",
    "report-daily-save/index.ts",
]


def test_auth_start_public_response_does_not_await_external_otp_send() -> None:
    auth_start = read(FUNCTIONS / "report-auth-start/index.ts")

    assert_contains(auth_start, "EdgeRuntime.waitUntil", "background OTP send scheduling")
    assert_contains(auth_start, "scheduleReportOtpDelivery", "safe background scheduling helper")
    assert_contains(auth_start, "sendEligibleReportOtpChallenge", "eligible challenge background helper")
    assert_contains(auth_start, "return genericAuthStartResponse(req);", "immediate generic public response")
    assert_contains(auth_start, "EdgeRuntime.waitUntil is unavailable", "absent EdgeRuntime fail-closed log")
    serve_body = auth_start.split("async function sendEligibleReportOtpChallenge", 1)[0]
    response_index = serve_body.rindex("return genericAuthStartResponse(req);")
    scheduled_index = serve_body.index("scheduleReportOtpDelivery(() => sendEligibleReportOtpChallenge")
    assert scheduled_index < response_index, "eligible send must be scheduled before the generic public response returns"
    assert_not_contains(serve_body, "await sendDealerOtpZns", "awaited external provider in public request path")
    assert_not_contains(serve_body, "await sendEligibleReportOtpChallenge", "awaited eligible OTP helper in public request path")


def test_auth_start_uses_atomic_otp_challenge_rpc_without_split_select_update_insert() -> None:
    auth_start = read(FUNCTIONS / "report-auth-start/index.ts")
    helper_body = auth_start.split("async function sendEligibleReportOtpChallenge", 1)[1]

    assert_contains(helper_body, '.rpc("create_kiosk_report_otp_challenge_atomic"', "atomic challenge RPC call")
    assert_contains(helper_body, "status === \"created\"", "ZNS only for created challenge")
    assert_contains(helper_body, "status === \"cooldown\"", "cooldown challenge branch")
    assert_not_contains(helper_body, '.select("id")', "split cooldown SELECT in helper")
    assert_not_contains(helper_body, '.insert({', "split challenge INSERT in helper")
    assert_not_contains(helper_body, 'send_status: "superseded"', "split supersede UPDATE in helper")
    assert_contains(helper_body, '.eq("id", challengeId)', "provider updates exact created challenge")
    assert_not_contains(helper_body, '.eq("phone_normalized", phoneNormalized)', "provider failure must not update by phone")


def test_atomic_otp_challenge_rpc_is_service_role_only_and_locks_phone() -> None:
    migration = read_delivery_migrations()
    function_name = "create_kiosk_report_otp_challenge_atomic"
    assert_contains(migration, f"create or replace function public.{function_name}", "atomic challenge RPC")
    assert_contains(
        migration,
        "pg_advisory_xact_lock(hashtextextended('public.kiosk_report_otp_challenge:' || p_phone_normalized, 0))",
        "phone-keyed transaction advisory lock",
    )
    assert_contains(migration, "interval '60 seconds'", "authoritative SQL cooldown window")
    assert_contains(migration, "'status', 'cooldown'", "cooldown result")
    assert_contains(migration, "'status', 'created'", "created result")
    assert_contains(migration, "send_status = 'superseded'", "prior challenge consumption")
    assert_contains(migration, "grant execute on function public.create_kiosk_report_otp_challenge_atomic", "service role grant")
    assert_contains(migration, "to service_role", "service role only execute")
    assert_contains(migration, "from public, anon, authenticated", "browser role revoke")
    function_file = read(MIGRATIONS / "20260819103040_kiosk_report_otp_challenge_atomic_function.sql").lower()
    assert_contains(function_file, "revoke execute on function public.create_kiosk_report_otp_challenge_atomic", "same-file function execute revoke after SECURITY DEFINER creation")
    assert function_file.index("create or replace function public.create_kiosk_report_otp_challenge_atomic") < function_file.index("revoke execute on function public.create_kiosk_report_otp_challenge_atomic")


def test_real_concurrency_smoke_exists_for_atomic_otp_challenge_race() -> None:
    smoke = read(ROOT / "scripts/smoke_report_auth_start_atomic_concurrency.py")
    for needle, label in [
        ("psycopg", "real PostgreSQL driver"),
        ("threading.Barrier", "two-transaction synchronization"),
        ("create_kiosk_report_otp_challenge_atomic", "runtime atomic RPC call"),
        ("one_created_one_cooldown", "single send lease assertion marker"),
        ("count(*)", "single challenge row assertion"),
        ("send_status = 'pending'", "single provider-send lease assertion"),
    ]:
        assert_contains(smoke, needle, label)


def test_public_report_functions_do_not_leak_raw_internal_error_messages() -> None:
    expected_messages = {
        "report-auth-start/index.ts": "Không thể bắt đầu xác thực báo cáo. Vui lòng thử lại sau.",
        "report-auth-verify/index.ts": "Không thể xác thực OTP. Vui lòng thử lại sau.",
        "report-session/index.ts": "Không thể tải phiên báo cáo. Vui lòng thử lại sau.",
        "report-bootstrap/index.ts": "Không thể tải báo cáo. Vui lòng thử lại sau.",
        "report-daily-save/index.ts": "Không thể lưu báo cáo. Vui lòng thử lại sau.",
    }
    for rel_path, safe_message in expected_messages.items():
        source = read(FUNCTIONS / rel_path)
        public_catch = source.split("} catch (error) {", 1)[1].split("});", 1)[0]
        assert_contains(source, "console.error", f"{rel_path} server-side internal logging")
        assert_contains(source, safe_message, f"{rel_path} stable Vietnamese generic error")
        assert_not_contains(public_catch, "error instanceof Error ? error.message", f"{rel_path} raw Error.message public leak")
        assert_not_contains(public_catch, "return errorResponse(req, message, 500", f"{rel_path} message variable public leak")


def test_report_session_has_no_public_report_staff_profile_noop_import() -> None:
    session = read(FUNCTIONS / "report-session/index.ts")
    assert_not_contains(session, "publicReportStaffProfile", "no-op publicReportStaffProfile import/void")


def test_phone_collision_triggers_take_same_normalized_phone_advisory_lock() -> None:
    migration = read_delivery_migrations()
    lock_marker = "pg_advisory_xact_lock(hashtextextended('public.report_actor_phone:' || coalesce(new.phone_normalized, ''), 0))"
    assert migration.count(lock_marker) >= 3, "each delivery/report/dealer collision trigger function must lock the normalized phone"
    for function_name in [
        "block_delivery_staff_active_phone_collision",
        "block_report_staff_dealer_contact_phone",
        "block_dealer_contact_report_staff_phone",
    ]:
        start = migration.index(f"create or replace function public.{function_name}()")
        end = migration.index("return new;", start)
        body = migration[start:end]
        assert_contains(body, lock_marker, f"{function_name} phone advisory lock")
        first_exists = body.index("exists (")
        lock_pos = body.index(lock_marker)
        assert lock_pos < first_exists, f"{function_name} must lock before cross-audience EXISTS checks"


def test_real_concurrency_smoke_exists_for_phone_collision_race() -> None:
    smoke = read(ROOT / "scripts/smoke_delivery_phone_collision_concurrency.py")
    for needle, label in [
        ("psycopg", "real PostgreSQL driver"),
        ("threading.Barrier", "two-transaction synchronization"),
        ("pg_advisory_xact_lock", "runtime advisory lock assertion"),
        ("only_one_active_audience_commit", "single winner assertion marker"),
        ("delivery_never_shares", "delivery denial assertion marker"),
        ("dealer_report_dual_portal_exception", "dealer/report deliberate exception assertion marker"),
    ]:
        assert_contains(smoke, needle, label)
