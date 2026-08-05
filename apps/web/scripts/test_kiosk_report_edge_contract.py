#!/usr/bin/env python3
"""Static contract checks for kiosk report Edge Functions."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUNCTIONS = ROOT / "supabase/functions"
SHARED = FUNCTIONS / "_shared/report.ts"
MIGRATION_GLOB = "202608*_kiosk_report*.sql"

REPORT_FUNCTIONS = [
    "report-auth-start",
    "report-auth-verify",
    "report-session",
    "report-bootstrap",
    "report-daily-save",
    "report-auth-logout",
    "kiosk-report-admin",
]


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def read_report_migrations() -> str:
    paths = sorted((ROOT / "supabase/migrations").glob(MIGRATION_GLOB))
    assert paths, "Missing kiosk report migrations"
    return "\n".join(read(path) for path in paths)


def test_report_plpgsql_migrations_are_supabase_parser_safe() -> None:
    paths = sorted((ROOT / "supabase/migrations").glob(MIGRATION_GLOB))
    assert paths, "Missing kiosk report migrations"
    for path in paths:
        source = read(path)
        function_count = source.lower().count("language plpgsql")
        assert function_count <= 1, f"Multiple PL/pgSQL functions in {path.name}"
        if function_count:
            function_start = source.lower().index("create or replace function")
            prefix = source[:function_start].lower()
            assert "on function public." not in prefix or "(\n" not in prefix, (
                f"Multiline FUNCTION grant confuses Supabase CLI in {path.name}"
            )
            closing = source.rfind("$$;")
            assert closing >= 0, f"Missing dollar-quoted function terminator in {path.name}"
            assert not source[closing + 3:].strip(), (
                f"Supabase CLI may group statements after PL/pgSQL function in {path.name}"
            )


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def assert_not_contains(text: str, needle: str, label: str) -> None:
    assert needle not in text, f"Unexpected {label}: {needle!r}"


def test_shared_report_auth_reuses_crypto_and_otp_transport_without_dealer_tables() -> None:
    source = read(SHARED)
    for needle, label in [
        ("sendDealerOtpZns", "shared VietGuys/Zalo transport reuse"),
        ("generateDealerOtp", "shared OTP generator reuse"),
        ("getOtpExpiresAt", "shared OTP expiry reuse"),
        ("timingSafeEqual", "shared crypto timing helper reuse"),
        ("hashReportOtp", "report-specific OTP hash"),
        ("hashReportSessionToken", "report-specific session hash"),
        ("normalizeDealerPhone", "shared Vietnamese phone normalization"),
    ]:
        assert_contains(source, needle, label)
    for forbidden in ["dealer_customer_contacts", "dealer_sessions", "dealer_otp_challenges"]:
        assert_not_contains(source, forbidden, f"dealer table {forbidden}")


def test_public_report_functions_do_not_query_dealer_auth_tables() -> None:
    for fn_name in REPORT_FUNCTIONS:
      source = read(FUNCTIONS / fn_name / "index.ts")
      for forbidden in ["dealer_customer_contacts", "dealer_sessions", "dealer_otp_challenges"]:
          assert_not_contains(source, forbidden, f"{fn_name} dealer table {forbidden}")


def test_report_auth_functions_use_report_tables_and_never_expose_salary() -> None:
    auth_start = read(FUNCTIONS / "report-auth-start/index.ts")
    auth_verify = read(FUNCTIONS / "report-auth-verify/index.ts")
    for needle, label in [
        ('from("kiosk_report_staff")', "staff lookup"),
        ('from("kiosk_report_otp_challenges")', "OTP challenge table"),
        ('eq("active", true)', "active staff guard"),
        ("kiosk_report_locations!inner", "active location join"),
    ]:
        assert_contains(auth_start, needle, label)
    for needle, label in [
        ('from("kiosk_report_otp_challenges")', "OTP verify table"),
        ("verify_kiosk_report_otp_atomic", "atomic report session creation"),
        ("staff: result.staff", "public staff payload"),
        ("location: result.location", "public location payload"),
    ]:
        assert_contains(auth_verify, needle, label)
    for source in [auth_start, auth_verify]:
        assert_not_contains(source, "monthly_salary_vnd", "salary exposure in public auth function")


def test_report_auth_session_ttl_matches_rpc_security_boundary() -> None:
    auth_verify = read(FUNCTIONS / "report-auth-verify/index.ts")
    shared = read(SHARED)
    migration = read_report_migrations()

    assert_contains(shared, "REPORT_SESSION_TTL_HOURS = 12", "bounded report session TTL")
    assert_contains(shared, "getReportSessionExpiresAt", "report-specific session expiry helper")
    assert_contains(auth_verify, "getReportSessionExpiresAt()", "report-specific session expiry use")
    assert_not_contains(auth_verify, "getSessionExpiresAt", "30-day dealer session expiry reuse")
    assert_contains(migration, "p_session_expires_at > v_now + interval '24 hours'", "RPC maximum session TTL")


def test_public_auth_is_generic_has_no_dev_otp_and_is_rate_limited() -> None:
    auth_start = read(FUNCTIONS / "report-auth-start/index.ts")
    auth_verify = read(FUNCTIONS / "report-auth-verify/index.ts")
    shared = read(SHARED)
    migration = read_report_migrations()

    assert_not_contains(auth_start, "dev_otp", "client-visible development OTP")
    assert_not_contains(auth_start, "CONTACT_SUPPORT_MESSAGE", "enumerable unknown-staff response")
    assert_not_contains(auth_start, "report_staff_not_registered", "enumerable unknown-staff reason")
    assert_not_contains(auth_start, "report_staff_needs_support", "enumerable ambiguous-staff reason")
    assert_contains(auth_start, "GENERIC_AUTH_START_MESSAGE", "generic auth-start response")
    assert_contains(auth_start, "otp_required: true", "indistinguishable OTP step")
    assert_not_contains(auth_start, "genericAuthStartResponse(req, {", "enumerable auth-start response shape")
    assert_not_contains(auth_start, "extra: Record<string, unknown>", "generic auth-start extra response fields")

    for source, label in [(auth_start, "auth start"), (auth_verify, "auth verify")]:
        assert_contains(source, "consumeReportAuthRateLimit", f"{label} rate limit")
    assert_contains(auth_verify, "verify_kiosk_report_otp_atomic", "atomic OTP consume/session RPC")
    assert_not_contains(auth_verify, '.from("kiosk_report_sessions")', "non-atomic report session insert")
    assert_not_contains(auth_verify, '.update({\n        attempts', "non-atomic OTP challenge mutation")
    assert_contains(shared, "hashReportRateLimitKey", "non-PII rate-limit key hashing")
    assert_contains(shared, "consume_kiosk_report_auth_rate_limit", "atomic rate-limit RPC")
    assert_contains(migration, "create table if not exists public.kiosk_report_auth_rate_limits", "rate-limit table")
    assert_contains(migration, "create or replace function public.consume_kiosk_report_auth_rate_limit", "atomic rate-limit function")
    assert_contains(migration, "revoke all on function public.consume_kiosk_report_auth_rate_limit", "rate-limit RPC grant hardening")
    assert_contains(migration, "create or replace function public.verify_kiosk_report_otp_atomic", "atomic OTP verification function")
    assert_contains(migration, "for update", "OTP challenge row lock")
    assert_contains(migration, "revoke all on function public.verify_kiosk_report_otp_atomic", "OTP RPC grant hardening")


def test_bootstrap_session_save_and_logout_contracts() -> None:
    session = read(FUNCTIONS / "report-session/index.ts")
    bootstrap = read(FUNCTIONS / "report-bootstrap/index.ts")
    daily_save = read(FUNCTIONS / "report-daily-save/index.ts")
    logout = read(FUNCTIONS / "report-auth-logout/index.ts")
    for needle, label in [
        ("resolveReportSession", "session resolver"),
        ("publicReportStaffProfile", "public staff response"),
    ]:
        assert_contains(session, needle, label)
    for needle, label in [
        ("kiosk_report_products", "product definitions"),
        ("sale_allowed, breadstick_consumption_ratio", "product sale and recipe metadata"),
        ("kiosk_report_channels", "channel definitions"),
        ("kiosk_daily_reports", "current draft/report lookup"),
        ("kiosk_daily_report_inventory_rows", "inventory rows"),
        ("sold_quantity, consumed_quantity, closing_quantity", "stored submitted consumption and closing values"),
        ("kiosk_daily_report_channel_rows", "channel rows"),
    ]:
        assert_contains(bootstrap, needle, label)
    for needle, label in [
        ("p_status: status", "submitted save mode"),
        ("current location/date", "current assignment guard copy"),
        ("save_kiosk_daily_report_atomic", "atomic daily report RPC"),
        ("ingredient_retail_sale_forbidden", "ingredient retail-sale rejection"),
    ]:
        assert_contains(daily_save, needle, label)
    for forbidden in [
        '.from("kiosk_daily_reports")',
        '.from("kiosk_daily_report_inventory_rows")',
        '.from("kiosk_daily_report_channel_rows")',
        ".delete()",
    ]:
        assert_not_contains(daily_save, forbidden, "non-transactional report write")

    migration = read_report_migrations()
    assert_contains(migration, "create or replace function public.save_kiosk_daily_report_atomic", "atomic save function")
    assert_contains(migration, "for update", "submitted-report lock")
    assert_contains(migration, "submitted_report_immutable", "submitted immutability inside transaction")
    assert_contains(migration, "v_breadstick_sold * product.breadstick_consumption_ratio", "transactional recipe consumption")
    assert_contains(migration, "ingredient_retail_sale_forbidden", "database ingredient retail-sale guard")
    assert_contains(migration, "revoke all on function public.save_kiosk_daily_report_atomic", "atomic save RPC grant hardening")
    assert_contains(logout, 'from("kiosk_report_sessions")', "report session revoke")

    public_sources = [session, bootstrap, daily_save, logout]
    for source in public_sources:
        assert_not_contains(source, "monthly_salary_vnd", "salary exposure in public function")


def test_admin_crud_function_uses_internal_token_crm_permission_check_and_salary() -> None:
    admin = read(FUNCTIONS / "kiosk-report-admin/index.ts")
    for needle, label in [
        ("requireCrmPermission", "CRM permission check"),
        ("supabaseAdmin.auth.getUser", "internal Supabase token validation"),
        ('from("user_module_permissions")', "module permission lookup"),
        ('eq("module_key", "crm")', "CRM module scope"),
        ('select("can_view, can_edit")', "view and edit permission fields"),
        ('requiredPermission === "edit"', "action-sensitive edit guard"),
        ('action === "list" ? "view" : "edit"', "list versus mutation permission split"),
        ("kiosk_report_locations", "locations CRUD"),
        ("kiosk_report_staff", "staff CRUD"),
        ("monthly_salary_vnd", "salary visible only in admin CRUD"),
        ("reassign_staff", "staff reassignment action"),
    ]:
        assert_contains(admin, needle, label)
    assert_not_contains(admin, "Forbidden: owner role required", "owner-only authorization")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
