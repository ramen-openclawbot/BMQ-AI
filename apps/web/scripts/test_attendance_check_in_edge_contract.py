#!/usr/bin/env python3
"""Static contracts for Task4 attendance-check-in Edge Function."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUNCTION = ROOT / "supabase/functions/attendance-check-in/handler.ts"
HELPER = ROOT / "supabase/functions/_shared/attendance.ts"
INDEX = ROOT / "supabase/functions/attendance-check-in/index.ts"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def uncommented(text: str) -> str:
    return "\n".join(line.split("//", 1)[0] for line in text.splitlines()).lower()


def test_edge_function_accepts_only_report_token_and_device_gps_contract() -> None:
    helper = uncommented(read(HELPER))
    assert "body.report_token" in helper
    for allowed in ["body.latitude", "body.longitude", "body.accuracy", "body.captured_at"]:
        assert allowed in helper
    forbidden_client_authority = [
        "body.actor_type",
        "body.staff_id",
        "body.delivery_staff_id",
        "body.location_id",
        "body.geofence_latitude",
        "body.geofence_longitude",
        "body.radius_m",
        "body.distance_m",
    ]
    for forbidden in forbidden_client_authority:
        assert forbidden not in helper, f"Client authority must not be read: {forbidden}"


def test_server_side_geofence_resolution_contract() -> None:
    source = uncommented(read(FUNCTION) + "\n" + read(HELPER))
    for needle in [
        "resolveattendancegeofence",
        "sessioncontext.actor_type === \"delivery_staff\"",
        "geofence.code === \"warehouse_tan_tao\"",
        "geofence.location_type === \"kiosk\"",
        "geofence.kiosk_location_id === kiosklocationid",
        ".from(\"attendance_geofence_locations\")",
        ".eq(\"active\", true)",
        ".eq(\"code\", \"warehouse_tan_tao\")",
        ".eq(\"kiosk_location_id\", sessioncontext.session.location_id",
    ]:
        assert needle in source, f"Missing server geofence marker: {needle}"
    assert "attendance_geofence_not_configured" in source
    assert "geofence_coordinates_missing" in source


def test_distance_boundary_accuracy_privacy_and_response_contract() -> None:
    source = uncommented(read(FUNCTION) + "\n" + read(HELPER))
    for needle in [
        "default_attendance_radius_m = 20",
        "default_attendance_accuracy_threshold_m = 50",
        "haversinedistancemeters",
        "distance <= configured.radius_m",
        "params.device.accuracy_m > accuracythresholdm",
        "accuracy_too_low",
        "outside_geofence",
        "hashrequestip",
        "attendance_ip_hash_secret",
        "return null",
        "truncateuseragent",
        ".slice(0, 240)",
        "publicattendanceresponse",
        "distance_m: result.distance_m === null ? null : rounded(result.distance_m)",
    ]:
        assert needle in source, f"Missing decision/privacy marker: {needle}"
    response_source = source.split("export function publicattendanceresponse", 1)[1]
    for forbidden in ["raw_ip", "request_ip:", "geofence_latitude", "geofence_longitude"]:
        assert forbidden not in response_source, f"Public/raw leakage marker present: {forbidden}"


def test_ledger_rpc_idempotency_rate_limit_and_cors_contract() -> None:
    source = uncommented(read(FUNCTION))
    index = read(INDEX).lower()
    for needle in [
        "record_mobile_gps_attendance_event",
        "p_actor_type",
        "p_geofence_latitude",
        "p_geofence_longitude",
        "p_request_ip_hash",
        "p_request_user_agent",
        "isuniqueviolation",
        "already_checked_in",
        "p_decision: params.decision.accepted ? \"accepted\" : \"rejected\"",
        "p_reason_code: params.decision.reason_code",
        "consumeReportAuthRateLimit".lower(),
        "attendance-check-in",
        "method !== \"post\"",
        "access-control-allow-origin",
        "getallowedorigins(deps).includes(origin)",
    ]:
        assert needle.lower() in source, f"Missing Edge contract marker: {needle}"
    assert "serve((req) => handleattendancecheckin(req))" in index
