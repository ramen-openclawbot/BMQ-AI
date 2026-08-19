#!/usr/bin/env python3
"""Task9 attendance security/privacy/replay/retention hardening contracts."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase/migrations"
RETENTION = MIGRATIONS / "20260819153000_mobile_gps_attendance_retention_policy.sql"
HANDLER = ROOT / "supabase/functions/attendance-check-in/handler.ts"
HELPER = ROOT / "supabase/functions/_shared/attendance.ts"
REPORT_SHARED = ROOT / "supabase/functions/_shared/report.ts"
CARD = ROOT / "src/components/kiosk/AttendanceCheckInCard.tsx"
PORTAL_CONTRACT = ROOT / "scripts/test_kiosk_report_portal_contract.py"
RETENTION_SMOKE = ROOT / "scripts/smoke_mobile_gps_attendance_retention_policy_task9.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def uncommented_sql(sql: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines()).lower()


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def assert_not_contains(text: str, needle: str, label: str) -> None:
    assert needle not in text, f"Unexpected {label}: {needle!r}"


def test_task9_retention_policy_is_disabled_preview_only_and_non_destructive() -> None:
    sql = read(RETENTION).lower()
    executable = uncommented_sql(sql)
    for needle, label in [
        ("create table if not exists public.mobile_gps_attendance_retention_policy_config", "durable retention policy config table"),
        ("coordinate_detail_retention_days integer", "owner-configurable retention duration placeholder"),
        ("coordinate_detail_retention_days is null or coordinate_detail_retention_days > 0", "no zero/negative duration"),
        ("retention_days_configured", "status exposes explicit-positive-days gate"),
        ("retention_policy_enabled", "status exposes disabled-by-default effective state"),
        ("coalesce(coordinate_detail_retention_days, 0) > 0", "requires positive retention days"),
        ("create or replace view public.mobile_gps_attendance_retention_policy_status", "owner-only status view"),
        ("create or replace function public.preview_mobile_gps_attendance_coordinate_retention", "dry-run preview RPC"),
        ("p_batch_limit integer default 100", "bounded default batch"),
        ("least(greatest(coalesce(p_batch_limit, 100), 1), 500)", "hard batch bounds"),
        ("redaction_policy_disabled", "disabled status reason"),
        ("would_redact_device_coordinates", "policy defines device coordinate redaction"),
        ("would_redact_geofence_coordinates", "policy defines geofence coordinate redaction"),
        ("would_redact_request_ip_hash", "policy defines IP hash redaction"),
        ("would_redact_request_user_agent", "policy defines UA redaction"),
        ("preserves_decision_work_date_actor_distance_accuracy_audit", "policy preserves immutable decision evidence"),
        ("security definer", "fixed owner/service-role boundary"),
        ("set search_path = public", "fixed search path"),
        ("revoke all on function public.preview_mobile_gps_attendance_coordinate_retention", "default function revoke"),
        ("from public, anon", "public/anon roles denied"),
        ("grant execute on function public.preview_mobile_gps_attendance_coordinate_retention", "narrow RPC grant"),
        ("to authenticated, service_role", "owner-authenticated/service-role can preview only"),
        ("has_role((select auth.uid()), 'owner'", "owner-only authenticated visibility"),
    ]:
        assert_contains(sql, needle, label)

    for forbidden in [
        "update public.mobile_gps_attendance_events",
        "delete from public.mobile_gps_attendance_events",
        "truncate public.mobile_gps_attendance_events",
        "alter table public.mobile_gps_attendance_events alter column device_latitude drop not null",
        "grant update on table public.mobile_gps_attendance_events",
    ]:
        assert_not_contains(executable, forbidden, "automatic or enabled GPS evidence mutation")


def test_task9_retention_policy_does_not_invent_bmq_duration_or_enable_execution() -> None:
    sql = read(RETENTION).lower()
    executable = uncommented_sql(sql)
    assert_contains(sql, "coordinate_detail_retention_days is null", "default has no approved duration")
    assert_contains(sql, "dry_run_only boolean not null default true", "preview-only default")
    assert_contains(sql, "retention_policy_enabled false", "seeded disabled policy")
    for invented_duration in ["7 days", "14 days", "30 days", "60 days", "90 days", "180 days", "365 days"]:
        assert_not_contains(sql, invented_duration, "invented BMQ retention duration")
    for forbidden_exec in [
        "execute_mobile_gps_attendance_coordinate_retention",
        "apply_mobile_gps_attendance_coordinate_retention",
        "dry_run boolean default false",
        "p_dry_run boolean default false",
    ]:
        assert_not_contains(executable, forbidden_exec, "dangerous execution path")


def test_task9_public_edge_logs_and_errors_do_not_include_tokens_gps_raw_ip_or_raw_errors() -> None:
    handler = read(HANDLER)
    helper = read(HELPER)
    source = handler + "\n" + helper
    for needle, label in [
        ("function safeErrorCode", "safe error-code logger"),
        ("console.error(\"[attendance-check-in] duplicate replay audit failed\", safeErrorCode(replayAuditResult.error));", "safe duplicate replay log"),
        ("console.error(\"[attendance-check-in] record failed\", safeErrorCode(eventResult.error));", "safe record failure log"),
        ("console.error(\"[attendance-check-in] Unexpected error\", safeErrorCode(error));", "safe catch-all log"),
        ("publicAttendanceResponse", "stable public response helper"),
    ]:
        assert_contains(source, needle, label)
    for forbidden in [
        "console.error(\"[attendance-check-in] duplicate replay audit failed\", replayAuditResult.error)",
        "console.error(\"[attendance-check-in] record failed\", eventResult.error)",
        "console.error(\"[attendance-check-in] Unexpected error\", error)",
        "console.error(\"[attendance-check-in] raw_ip",
        "console.error(\"[attendance-check-in] gps",
    ]:
        assert_not_contains(handler, forbidden, "sensitive log detail")

    response_body = helper.split("export function publicAttendanceResponse", 1)[1]
    for forbidden in ["report_token", "token", "device_latitude", "device_longitude", "geofence_latitude", "geofence_longitude", "request_ip", "request_ip_hash", "request_user_agent"]:
        assert_not_contains(response_body, forbidden, "public response leakage")


def test_task9_replay_rate_session_and_device_capture_boundaries_are_explicit() -> None:
    handler = read(HANDLER).lower()
    report_shared = read(REPORT_SHARED).lower()
    helper = read(HELPER).lower()
    for needle, label in [
        ("pre-session-ip:${metadata.request_ip ?? \"unknown\"}", "pre-session server-observed IP rate limit"),
        ("actor:${ids.actortype}:${ids.deliverystaffid ?? ids.kioskreportstaffid", "post-actor rate limit"),
        ("captured_at_stale", "stale capture rejection"),
        ("captured_at_future", "future capture rejection"),
        (".is(\"revoked_at\", null)", "revoked session excluded"),
        (".gt(\"expires_at\", now)", "expired session excluded"),
        ("isuniqueviolation(eventresult.error)", "accepted duplicate/replay detection"),
        ("reason_code: \"already_checked_in\"", "replay audited as rejected"),
        ("if (!replayauditresult.ok)", "already_checked_in requires audit success"),
        ("attendance_record_failed", "audit failure is retryable failure, not false success"),
    ]:
        haystack = handler + "\n" + report_shared + "\n" + helper
        assert_contains(haystack, needle, label)


def test_task9_retention_role_smoke_covers_disabled_preview_and_no_event_mutation() -> None:
    smoke = read(RETENTION_SMOKE).lower()
    for needle, label in [
        ("begin;", "rollback transaction"),
        ("rollback;", "rollback cleanup"),
        ("retention_policy_disabled_by_default", "disabled-by-default runtime assertion"),
        ("retention_preview_is_dry_run_only", "preview-only runtime assertion"),
        ("retention_preview_owner_required", "owner authorization probe"),
        ("retention_preview_service_role_allowed", "service-role preview probe"),
        ("retention_policy_no_event_mutation", "protected ledger count assertion"),
        ("has_function_privilege('anon'", "anon execute denied probe"),
        ("has_function_privilege('authenticated'", "authenticated execute grant for owner-gated function"),
        ("has_function_privilege('service_role'", "service-role execute grant probe"),
    ]:
        assert_contains(smoke, needle, label)
    executable = uncommented_sql(smoke)
    for forbidden in [
        "update public.mobile_gps_attendance_events",
        "delete from public.mobile_gps_attendance_events",
        "truncate public.mobile_gps_attendance_events",
    ]:
        assert_not_contains(executable, forbidden, "smoke must not mutate GPS evidence")


def test_task9_privacy_copy_mentions_explicit_tap_purpose_and_spoofing_limitation_without_auto_gps() -> None:
    card = read(CARD)
    portal_contract = read(PORTAL_CONTRACT)
    for needle, label in [
        ("Bấm nút bên dưới", "explicit tap copy"),
        ("Vị trí chỉ dùng để xác nhận anh/chị đang ở đúng điểm làm việc khi chấm công", "purpose copy"),
        ("không theo dõi nền", "no background tracking copy"),
        ("Trình duyệt có thể báo vị trí sai nếu GPS/Wi‑Fi yếu hoặc thiết bị bị can thiệp", "browser GPS limitation copy"),
        ("BMQ chỉ ghi nhận kết quả chấm công và thông tin cần thiết để xử lý khiếu nại.", "non-alarming evidence copy"),
    ]:
        assert_contains(card, needle, label)
    render_before_handler = card.split("const handleCheckIn", 1)[0]
    assert_not_contains(render_before_handler, "navigator.geolocation.getCurrentPosition", "auto geolocation before explicit tap")
    assert_contains(portal_contract, "browser GPS limitation", "contract covers browser GPS spoofing/limitation copy")
