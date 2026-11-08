#!/usr/bin/env python3
"""Static contracts for Bếp Q7 payroll_bn GPS attendance (server + client)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261109100000_payroll_bn_gps_attendance.sql"
SHARED = ROOT / "supabase/functions/_shared/payroll-attendance.ts"
PORTAL = ROOT / "supabase/functions/_shared/payslip-portal.ts"
CORS = ROOT / "supabase/functions/_shared/cors.ts"
AUTH_VERIFY = ROOT / "supabase/functions/payslip-auth-verify/index.ts"
TODAY = ROOT / "supabase/functions/payslip-attendance-today/index.ts"
CHECKIN = ROOT / "supabase/functions/payslip-attendance-checkin/index.ts"
CONFIG = ROOT / "supabase/config.toml"
SMOKE = ROOT / "scripts/smoke_payroll_bn_gps_attendance.sql"
API = ROOT / "src/lib/payslip-portal/attendance-api.ts"
DEVICE = ROOT / "src/lib/payslip-portal/device-id.ts"
GEOLOCATION = ROOT / "src/lib/payslip-portal/geolocation.ts"
SELFIE = ROOT / "src/lib/payslip-portal/selfie-compress.ts"
HOOK = ROOT / "src/hooks/usePayrollBnAttendanceAdmin.ts"
APP = ROOT / "src/App.tsx"
VERCEL = ROOT / "vercel.json"
PAYROLL_HTML = ROOT / "payroll.html"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def sql() -> str:
    return read(MIGRATION).lower()


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def test_kitchen_site_type_and_seed_never_invent_coordinates() -> None:
    s = sql()
    for needle, label in [
        ("location_type in ('kiosk', 'warehouse', 'kitchen')", "kitchen location type"),
        ("location_type in ('warehouse', 'kitchen') and kiosk_location_id is null", "kitchen kiosk-link rule"),
        ("'kitchen_q7'", "kitchen_q7 code"),
        ("'bếp q7'", "kitchen_q7 name"),
        ("on conflict (code) do nothing", "idempotent seed that preserves owner coordinates"),
    ]:
        assert_contains(s, needle, label)

    start = s.index("'kitchen_q7'")
    end = s.index("on conflict (code) do nothing", start)
    seed = s[start:end]
    assert "null" in seed, "kitchen_q7 seed must leave coordinates NULL"
    assert "10." not in seed and "106." not in seed, "kitchen_q7 seed must not invent coordinates"
    assert "50" in seed, "kitchen_q7 default radius must be 50m"


def test_gate_is_default_off_and_audited() -> None:
    s = sql()
    for needle, label in [
        ("create table if not exists public.payroll_bn_attendance_gates", "attendance gates table"),
        ("enabled boolean not null default false", "default-off gate"),
        ("create table if not exists public.payroll_bn_attendance_gate_audit_logs", "gate audit table"),
        ("audit_payroll_bn_attendance_gate_changes", "gate audit trigger"),
        ("alter table public.payroll_bn_attendance_gates enable row level security", "gate RLS"),
    ]:
        assert_contains(s, needle, label)


def test_one_active_device_per_employee() -> None:
    s = sql()
    for needle, label in [
        ("create table if not exists public.payroll_bn_attendance_devices", "devices table"),
        ("status in ('active', 'pending', 'revoked')", "device statuses"),
        ("payroll_bn_attendance_devices_one_active", "single active device index"),
        ("where status = 'active'", "partial unique predicate"),
        ("unique (employee_code, device_hash)", "employee/device uniqueness"),
    ]:
        assert_contains(s, needle, label)


def test_event_ledger_is_immutable_and_day_unique() -> None:
    s = sql()
    for needle, label in [
        ("create table if not exists public.payroll_bn_attendance_events", "events ledger"),
        ("event_kind in ('in', 'out')", "in/out kinds"),
        ("decision in ('accepted', 'rejected')", "decision vocabulary"),
        ("suspected_proxy boolean not null default false", "proxy flag"),
        ("payroll_bn_attendance_events_one_accepted_in", "one accepted in per day"),
        ("payroll_bn_attendance_events_one_accepted_out", "one accepted out per day"),
        ("where decision = 'accepted' and event_kind = 'in'", "in partial index predicate"),
        ("where decision = 'accepted' and event_kind = 'out'", "out partial index predicate"),
        ("payroll_bn_attendance_events_are_immutable", "immutable trigger message"),
        ("before update or delete on public.payroll_bn_attendance_events", "immutability trigger"),
        ("work_date = (server_received_at at time zone 'asia/ho_chi_minh')::date", "server Vietnam work date"),
        ("create table if not exists public.payroll_bn_attendance_day_overrides", "day overrides table"),
        ("unique (employee_code, work_date)", "one override per employee/day"),
    ]:
        assert_contains(s, needle, label)


def test_selfie_bucket_is_private_and_bounded() -> None:
    s = sql()
    for needle, label in [
        ("'payroll-attendance-selfies'", "selfie bucket id"),
        ("614400", "600 KB bucket limit"),
        ("'image/jpeg', 'image/webp'", "allowed selfie mime types"),
        ("payroll_bn_attendance_selfies_select_manager", "manager-only read policy"),
        ("add column if not exists device_hash text", "session device hash column"),
    ]:
        assert_contains(s, needle, label)
    bucket_insert = s[s.index("insert into storage.buckets"): s.index("drop policy if exists payroll_bn_attendance_selfies_select_manager")]
    assert "false" in bucket_insert, "selfie bucket must be private"


def test_record_rpc_rechecks_gate_device_geofence_and_order() -> None:
    s = sql()
    for needle, label in [
        ("create or replace function public.record_payroll_bn_attendance_event", "record RPC"),
        ("coalesce(auth.role(), '') <> 'service_role'", "service-role-only check"),
        ("public.payroll_bn_haversine_meters", "server haversine"),
        ("'gate_disabled'", "disabled gate reason"),
        ("'site_not_configured'", "unconfigured site reason"),
        ("'no_location'", "missing location reason"),
        ("'low_accuracy'", "accuracy reason"),
        ("'device_used_by_other'", "proxy reason"),
        ("'device_not_approved'", "unapproved device reason"),
        ("'already_recorded'", "duplicate reason"),
        ("'checkout_before_checkin'", "out-before-in reason"),
        ("'outside_geofence'", "outside radius reason"),
        ("v_suspected_proxy := true", "proxy flag assignment"),
        ("status = 'pending'", "pending device row"),
        ("from public.payroll_bn_attendance_events e", "existing accepted punches re-read"),
    ]:
        assert_contains(s, needle, label)


def test_admin_rpcs_and_grants() -> None:
    s = sql()
    for name in [
        "list_payroll_bn_attendance",
        "list_payroll_bn_attendance_devices",
        "approve_payroll_bn_attendance_device",
        "revoke_payroll_bn_attendance_device",
        "set_payroll_bn_attendance_gate",
        "approve_payroll_bn_attendance_day",
        "set_payroll_bn_kitchen_q7_site",
    ]:
        assert_contains(s, f"create or replace function public.{name}", f"{name} RPC")
        assert_contains(s, f"function public.{name}", f"{name} grant target")

    assert_contains(s, "public.has_module_permission(p_uid, 'payroll', 'edit')", "payroll.edit helper")
    assert_contains(s, "public.has_role(p_uid, 'owner')", "owner helper")

    # Browser roles may not write any of these tables.
    for table in [
        "payroll_bn_attendance_gates",
        "payroll_bn_attendance_devices",
        "payroll_bn_attendance_events",
        "payroll_bn_attendance_day_overrides",
    ]:
        assert_contains(
            s,
            f"revoke all on table public.{table} from public, anon, authenticated",
            f"{table} browser revoke",
        )
        assert_contains(s, f"alter table public.{table} enable row level security", f"{table} RLS")

    # The immutable event ledger has no browser SELECT; reads go through the RPC.
    assert_contains(
        s,
        "grant select on table public.payroll_bn_attendance_events to service_role",
        "events service-role read",
    )
    assert "grant select on table public.payroll_bn_attendance_events to authenticated" not in s
    assert "grant insert on table public.payroll_bn_attendance_events" not in s

    # The recording RPC is service_role only.
    service_revoke = s[s.index("revoke all on function public.record_payroll_bn_attendance_event"):]
    assert "from public, anon, authenticated" in service_revoke
    assert "to service_role" in service_revoke

    # Admin RPCs are callable by authenticated staff; anon is always revoked.
    for name in [
        "list_payroll_bn_attendance",
        "list_payroll_bn_attendance_devices",
        "approve_payroll_bn_attendance_device",
        "revoke_payroll_bn_attendance_device",
        "set_payroll_bn_attendance_gate",
        "approve_payroll_bn_attendance_day",
        "set_payroll_bn_kitchen_q7_site",
    ]:
        assert_contains(
            s,
            f"function public.{name}",
            f"{name} revoke/grant block",
        )
    assert "from public, anon, authenticated" in s
    assert "to authenticated, service_role" in s


def test_pure_module_and_reason_messages() -> None:
    shared = read(SHARED)
    for needle, label in [
        ("export function haversineMeters", "haversine"),
        ("export function vietnamWorkDate", "Vietnam work date"),
        ("export function evaluateCheckin", "evaluateCheckin"),
        ("export function dayStatus", "dayStatus"),
        ("export function validateSelfieUpload", "selfie validation"),
        ("PAYROLL_ATTENDANCE_MAX_ACCURACY_M = 100", "100m accuracy threshold"),
        ("PAYROLL_ATTENDANCE_SELFIE_MAX_BYTES = 600 * 1024", "600 KB selfie limit"),
        ("export function attendanceMessage", "Vietnamese messages"),
        ("device_used_by_other", "proxy reason"),
        ("checkout_before_checkin", "out-before-in reason"),
        ("Ngày công không được tính, vui lòng liên hệ quản lý duyệt", "exact incomplete-day text"),
    ]:
        assert_contains(shared, needle, label)


def test_device_binding_spans_verify_shared_and_portal() -> None:
    portal = read(PORTAL)
    verify = read(AUTH_VERIFY)
    for needle, label in [
        ("normalizePayslipDeviceId", "device id normalisation"),
        ("hashPayslipDeviceId", "device id SHA-256"),
        ("crypto.subtle.digest(\"SHA-256\"", "SHA-256 primitive"),
    ]:
        assert_contains(portal, needle, label)
    for needle, label in [
        ("device_id", "verify accepts device id"),
        ("device_hash: deviceHash", "session stores device hash"),
        ("invalid_device_id", "malformed device rejection"),
    ]:
        assert_contains(verify, needle, label)


def test_cors_keeps_old_origin_and_adds_new_portal() -> None:
    cors = read(CORS)
    for needle, label in [
        ("https://luong.banhmique.vn", "new payslip origin"),
        ("https://payroll.banhmique.vn", "legacy payslip origin"),
        ("payslip-attendance-today", "today function CORS"),
        ("payslip-attendance-checkin", "checkin function CORS"),
        ("x-payslip-device", "device header CORS"),
        ("x-payslip-session", "session header CORS"),
    ]:
        assert_contains(cors, needle, label)


def test_edge_functions_bind_session_device_and_private_selfie() -> None:
    today = read(TODAY)
    checkin = read(CHECKIN)
    for needle, label in [
        ("x-payslip-device", "today device header"),
        ("hashPayslipDeviceId", "today device hash"),
        ("session.device_hash", "today session binding"),
        ("dayStatus", "today per-day status"),
        ("incomplete_days", "today incomplete days"),
        ("attendanceMessage", "today Vietnamese messages"),
    ]:
        assert_contains(today, needle, label)

    for needle, label in [
        ("req.formData()", "multipart checkin"),
        ("validateSelfieUpload", "selfie validation"),
        ("payroll-attendance-selfies", "private bucket"),
        (".upload(selfiePath", "selfie upload"),
        ("record_payroll_bn_attendance_event", "ledger RPC"),
        ("p_selfie_path", "selfie path argument"),
        ("x-payslip-device", "checkin device header"),
        ("hashPayslipDeviceId", "checkin device hash"),
        ("kind !== \"in\" && kind !== \"out\"", "kind validation"),
    ]:
        assert_contains(checkin, needle, label)
    # Never return the coordinates of anyone.
    for forbidden in ["latitude:", "longitude:"]:
        assert forbidden not in today.split("return jsonResponse", 1)[1]


def test_config_disables_jwt_for_attendance_functions() -> None:
    config = read(CONFIG).lower()
    for name in ["payslip-attendance-today", "payslip-attendance-checkin"]:
        marker = f"[functions.{name}]"
        assert marker in config, f"Missing config section: {marker}"
        section = config.split(marker, 1)[1].split("[functions.", 1)[0]
        assert "verify_jwt = false" in section, f"{name} must accept the psp_ auth pattern"


def test_client_non_visual_modules() -> None:
    api = read(API)
    device = read(DEVICE)
    geo = read(GEOLOCATION)
    selfie = read(SELFIE)
    hook = read(HOOK)

    for needle, label in [
        ("payslip-attendance-today", "today endpoint"),
        ("payslip-attendance-checkin", "checkin endpoint"),
        ("x-payslip-device", "device header"),
        ("x-payslip-session", "session header"),
        ("FormData", "multipart client"),
        ("attendanceErrorMessage", "Vietnamese error mapping"),
    ]:
        assert_contains(api, needle, label)

    for needle, label in [
        ("bmq_payslip_device_id", "persistent device key"),
        ("localStorage", "localStorage"),
        ("memoryStorage", "in-memory fallback"),
        ("randomUUID", "UUID generation"),
    ]:
        assert_contains(device, needle, label)

    for needle, label in [
        ("enableHighAccuracy: true", "high accuracy"),
        ("timeout: GEOLOCATION_TIMEOUT_MS", "15s timeout"),
        ("maximumAge: 0", "no cached fix"),
        ("15_000", "15 seconds"),
        ("permission_denied", "permission error"),
        ("position_unavailable", "position error"),
        ("timeout", "timeout error"),
        ("insecure_context", "insecure context"),
        ("Chrome Android", "Android guidance"),
        ("Chrome máy tính", "desktop guidance"),
    ]:
        assert_contains(geo, needle, label)

    for needle, label in [
        ("SELFIE_MAX_SIDE = 1280", "1280 longest side"),
        ("SELFIE_TARGET_BYTES = 300 * 1024", "300 KB target"),
        ("0.8, 0.7, 0.6, 0.5", "quality steps"),
        ("computeTargetSize", "pure sizing math"),
        ("canvas.toBlob", "canvas JPEG"),
    ]:
        assert_contains(selfie, needle, label)

    for rpc in [
        "list_payroll_bn_attendance",
        "list_payroll_bn_attendance_devices",
        "approve_payroll_bn_attendance_device",
        "revoke_payroll_bn_attendance_device",
        "set_payroll_bn_attendance_gate",
        "approve_payroll_bn_attendance_day",
        "set_payroll_bn_kitchen_q7_site",
    ]:
        assert_contains(hook, rpc, f"{rpc} hook")


def test_host_move_and_permanent_redirect() -> None:
    app = read(APP)
    vercel = read(VERCEL)
    html = read(PAYROLL_HTML)
    assert 'const PAYSLIP_HOST = "luong.banhmique.vn"' in app
    assert 'const LEGACY_PAYSLIP_HOST = "payroll.banhmique.vn"' in app
    assert "isPayslipHost()" in app

    assert '"permanent": true' not in vercel or '"statusCode": 301' in vercel
    assert '"statusCode": 301' in vercel, "redirect must be a 301"
    assert '"destination": "https://luong.banhmique.vn/:path*"' in vercel
    assert vercel.index('"redirects"') < vercel.index('"rewrites"'), "redirect must precede rewrites"
    assert '"value": "luong.banhmique.vn"' in vercel
    assert '"destination": "/payroll.html"' in vercel

    assert "https://luong.banhmique.vn/" in html
    assert "og:url" in html and "twitter:image" in html
    assert "payroll.banhmique.vn" not in html


def test_smoke_documents_every_required_runtime_case() -> None:
    smoke = read(SMOKE).lower()
    for needle, label in [
        ("begin;", "transactional smoke"),
        ("rollback;", "rollback cleanup"),
        ("accept_inside", "inside radius"),
        ("accept_out_after_in", "check-out works"),
        ("reject_outside", "outside radius"),
        ("site_not_configured", "null coordinate site"),
        ("device_used_by_other", "device sharing"),
        ("suspected_proxy", "proxy flag"),
        ("out_before_in", "check-out before check-in"),
        ("checkout_before_checkin", "ordering reason"),
        ("events_update_not_blocked", "immutable update"),
        ("events_delete_not_blocked", "immutable delete"),
        ("anon_can_execute", "anon execute"),
        ("null, null", "null seeded coordinates for the unconfigured site"),
    ]:
        assert_contains(smoke, needle, label)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
