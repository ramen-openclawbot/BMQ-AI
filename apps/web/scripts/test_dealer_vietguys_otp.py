#!/usr/bin/env python3
"""Static regression checks for dealer OTP delivery through VietGuys ZBS Mobile."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEALER_SHARED = ROOT / "supabase/functions/_shared/dealer.ts"
AUTH_START = ROOT / "supabase/functions/dealer-auth-start/index.ts"
PORTAL = ROOT / "src/pages/DealerPortal.tsx"
ROUTES = ROOT / "src/components/AppRoutes.tsx"
RELAY = ROOT.parents[1] / "ops/otp-relay/app/server.mjs"
STATUS_DEBUG = ROOT / "supabase/functions/dealer-otp-status-debug/index.ts"

shared = DEALER_SHARED.read_text(encoding="utf-8")
auth_start = AUTH_START.read_text(encoding="utf-8")
portal = PORTAL.read_text(encoding="utf-8")
routes = ROUTES.read_text(encoding="utf-8")
relay = RELAY.read_text(encoding="utf-8")
status_debug = STATUS_DEBUG.read_text(encoding="utf-8")


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"missing {label}: expected to find {needle!r}"


def assert_not_contains(text: str, needle: str, label: str) -> None:
    assert needle not in text, f"unexpected {label}: found {needle!r}"


def test_dealer_host_routes_to_public_portal() -> None:
    assert_contains(routes, 'const DEALER_ORDERING_HOST = "dathang.banhmique.vn"', "dealer custom domain host")
    assert_contains(routes, '<Route path="/" element={<DealerPortal />} />', "dealer host root portal route")


def test_portal_uses_existing_dealer_auth_functions() -> None:
    for needle, label in [
        ('"dealer-auth-start"', "start OTP function"),
        ('"dealer-auth-verify"', "verify OTP function"),
        ('"dealer-catalog"', "dealer catalog function"),
        ('"dealer-order-submit"', "dealer order submit function"),
    ]:
        assert_contains(portal, needle, label)


def test_auth_start_keeps_crm_contact_lookup_and_generic_message() -> None:
    for needle, label in [
        ('from("dealer_customer_contacts")', "CRM dealer contact lookup"),
        ('mini_crm_customers!inner', "active Mini CRM customer join"),
        ('eq("phone_normalized", phoneNormalized)', "normalized phone lookup"),
        ('GENERIC_AUTH_START_MESSAGE', "generic non-enumerating auth message"),
        ('OTP_RESEND_COOLDOWN_SECONDS = 60', "resend cooldown"),
    ]:
        assert_contains(auth_start, needle, label)


def test_vietguys_zbs_mobile_request_shape() -> None:
    for needle, label in [
        ('"https://api-v2.vietguys.biz:4438/zalo/v4/send"', "VietGuys ZBS Mobile endpoint"),
        ('"DEALER_VIETGUYS_ACCESS_TOKEN"', "VietGuys access token env"),
        ('"DEALER_VIETGUYS_USERNAME"', "VietGuys username env"),
        ('"DEALER_VIETGUYS_OA_ID"', "VietGuys OA id env"),
        ('"DEALER_VIETGUYS_TEMPLATE_ID"', "VietGuys template id env"),
        ('"Access-Token": accessToken', "VietGuys Access-Token header"),
        ('username,', "VietGuys username payload"),
        ('mobile: params.phoneNormalized', "VietGuys mobile payload"),
        ('tracking_id: params.challengeId', "tracking id payload"),
        ('failover: "sms"', "SMS failover enabled"),
        ('oa_id: oaId', "ZNS OA id payload"),
        ('template_id: templateId', "ZNS template payload"),
        ('otp: params.otp', "OTP template data"),
        ('sms: {', "SMS fallback block"),
        ('brand: smsBrand', "SMS brand payload"),
        ('unicode: false', "non-unicode SMS fallback"),
        ('provider: "vietguys_zbs_mobile"', "provider audit label"),
        ('"DEALER_OTP_RELAY_URL"', "optional OTP relay URL env"),
        ('"DEALER_OTP_RELAY_SECRET"', "optional OTP relay HMAC secret env"),
        ('sendVietGuysRequestViaRelay', "OTP relay helper"),
        ('"X-BMQ-Relay-Signature"', "OTP relay signature header"),
        ('"X-BMQ-Relay-Timestamp"', "OTP relay timestamp header"),
    ]:
        assert_contains(shared, needle, label)


def test_dealer_otp_no_longer_defaults_to_zalo_direct_api() -> None:
    assert_not_contains(shared, "https://business.openapi.zalo.me/message/template", "direct Zalo template endpoint")
    assert_not_contains(shared, '"access_token": accessToken', "direct Zalo access_token header")
    assert_not_contains(shared, '"Authorization": `Bearer ${accessToken}`', "direct Zalo bearer header")
    assert_not_contains(shared, "provider: \"zalo_zns\"", "legacy Zalo provider label")


def test_relay_and_debug_function_support_delivery_status_checks() -> None:
    for needle, label in [
        ('req.url === "/status"', "relay status route"),
        ("https://api.vietguys.biz:4438/zalo/v1/status", "VietGuys status endpoint"),
        ("provider status response", "status log label"),
        ("sanitizeProviderPreview", "redacted provider response logging"),
        ("response_preview", "safe status/send preview logging"),
    ]:
        assert_contains(relay, needle, label)

    for needle, label in [
        ("DEALER_OTP_STATUS_DEBUG_SECRET", "debug shared secret gate"),
        ("DEALER_OTP_RELAY_URL", "debug relay URL env"),
        ("DEALER_OTP_RELAY_SECRET", "debug relay HMAC env"),
        ("transaction_ids", "debug transaction id input"),
        ("/status", "debug calls relay status route"),
        ("safePreview", "debug redacts provider response"),
    ]:
        assert_contains(status_debug, needle, label)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
