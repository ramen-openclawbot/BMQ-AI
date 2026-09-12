#!/usr/bin/env python3
"""Focused static contracts for the KFM/Seedcom partner-portal bridge.

The portal API lives on logis.seedcom.vn and rejects browser preflight from
ai.banhmique.vn, so the SPA can only reach it through an Edge Function proxy.
These contracts pin that shape: verified endpoints, read-only behaviour,
credentials from the environment, and the UI entry point.
"""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
CLIENT = (ROOT / "supabase/functions/_shared/kfm-portal.ts").read_text()
FUNCTION = (ROOT / "supabase/functions/kfm-portal-sync/index.ts").read_text()
PANEL = (ROOT / "src/components/production/KfmPortalDialog.tsx").read_text()
PLANNING = (ROOT / "src/pages/ProductionPlanning.tsx").read_text()


def require(source: str, marker: str, message: str) -> None:
    assert marker in source, message


def forbid(source: str, marker: str, message: str) -> None:
    assert marker not in source, message


def test_portal_client_pins_the_verified_contract() -> None:
    require(CLIENT, "https://sso.seedcom.vn/uaa", "the SSO host must be the verified one")
    require(CLIENT, "https://logis.seedcom.vn/sce-api", "the portal API host must be logis, not partners")
    require(CLIENT, "sce-client-1i15ym2j", "the portal client id must match the SPA bundle")
    require(CLIENT, "oauth2/authorize", "login must start at the OAuth2 authorize endpoint")
    require(CLIENT, "code_challenge_method", "the authorize request must carry PKCE")
    require(CLIENT, '"S256"', "the PKCE challenge method must be S256")
    require(CLIENT, "codeVerifier", "the exchange must send the PKCE verifier")
    require(CLIENT, "/sce/oauth", "the redirect uri must match the registered portal callback")
    require(CLIENT, "auth/sso/sce/exchange", "login must exchange the SSO code for a token")
    require(CLIENT, "auth/sso/sce/refresh", "a stored refresh token must be tried before the password")
    require(CLIENT, "accessToken", "the exchange endpoint answers with accessToken, not token")
    require(CLIENT, "/api/v1/portal/orders?", "orders must come from the verified portal endpoint")
    require(CLIENT, "deliveryDateFrom", "orders must be filtered by delivery date")
    require(CLIENT, "_csrf", "the SSO form requires its CSRF token")
    require(CLIENT, "readLoginForm(html, pageUrl)", "the form action must resolve against the landing page URL")
    forbid(CLIENT, "SSO_BASE}${action", "the already-prefixed form action must not be joined to SSO_BASE again")


def test_the_bridge_exposes_only_the_approved_operator_actions() -> None:
    # Approved 2026-09-13 (owner: "2A" - VNAgent builds the buttons, the operator
    # clicks every step by hand). Confirm plus the two printouts are the whole
    # approved surface; the rest of the portal stays outside the app.
    require(CLIENT, "/api/v1/portal/orders/${options.orderId}/confirm?vendorId=",
            "confirm must use the verified endpoint and pass vendorId")
    require(CLIENT, "/api/v1/purchase-orders/${poId}/export-pdf",
            "the PO sheet must come from the verified export endpoint")
    require(CLIENT, "/api/v1/portal/asn/${options.asnId}/export-pdf?",
            "the delivery note must come from the verified export endpoint")
    for forbidden in ("/reject", "/propose-change", "/approve-change", "/cancel",
                      "/dispatch", "/send-to-vendor", "export-pdf-batch"):
        forbid(CLIENT, forbidden, "%s is not an approved action" % forbidden)
    require(FUNCTION, 'ACTIONS = ["list", "detail", "confirm", "po-pdf", "asn-pdf"]',
            "the action list must be exactly the approved surface")
    require(FUNCTION, '"POST"', "the function must accept POST for the read request")
    require(FUNCTION, 'method !== "POST"', "only POST may reach the portal call")


def test_the_panel_shows_no_money() -> None:
    for marker in ("Tổng (gồm VAT)", "orderTotalWithTax", "orderTotal", "taxTotal"):
        forbid(PANEL, marker, "the KFM panel must show products and quantities only")
    require(PANEL, "totalQty", "quantities stay visible on the order list")
    require(PANEL, 'data-kfm-action="confirm"', "the confirm button must be present")
    require(PANEL, 'data-kfm-action="print-po"', "the PO print button must be present")
    require(PANEL, 'data-kfm-action="print-asn"', "the delivery-note print button must be present")
    require(PANEL, "window.confirm", "a write to the portal must be confirmed by the operator first")


def test_credentials_come_from_the_environment_only() -> None:
    require(FUNCTION, 'Deno.env.get("KFM_PORTAL_USERNAME")', "the portal user must come from Edge Function secrets")
    require(FUNCTION, 'Deno.env.get("KFM_PORTAL_PASSWORD")', "the portal password must come from Edge Function secrets")
    require(FUNCTION, '"not_configured"', "a missing credential must be reported, never guessed")
    # No literal credential anywhere in the new surface.
    for source in (CLIENT, FUNCTION, PANEL):
        assert not re.search(r"KFM_PORTAL_PASSWORD\s*[:=]\s*[\"']", source), \
            "the password must never be hardcoded"


def test_the_proxy_is_authenticated_and_cors_aware() -> None:
    require(FUNCTION, "corsPreflightResponse", "browser preflight must be answered")
    require(FUNCTION, 'req.method !== "POST"', "only POST may reach the portal call")
    require(FUNCTION, "auth.getUser()", "the caller must be an authenticated app user")
    require(FUNCTION, 'error: "unauthorized" }, 401', "an anonymous caller must get 401")


def test_the_ui_entry_point_is_wired() -> None:
    require(PANEL, 'data-kfm-portal-entry="v1"', "the launcher must carry a stable marker")
    require(PANEL, "kfm-portal-sync", "the panel must call the proxy function")
    require(PANEL, "Authorization: `Bearer ${session.access_token}`", "the proxy call must carry the Supabase token")
    require(PANEL, "configured === false", "an unconfigured portal must be explained, not hidden")
    require(PANEL, "Kiểm tra PO", "the panel must point at the existing email PO check")
    require(FUNCTION, 'fallback: "po-gmail-sync"', "the proxy must name the email PO flow as the fallback")
    require(PLANNING, 'from "@/components/production/KfmPortalDialog"', "the panel must be imported by the production plan")
    require(PLANNING, "<KfmPortalDialog isVi={isVi} />", "the panel must sit next to the email PO check")
    require(PLANNING, '"Kiểm tra PO"', "the existing email PO check must stay in place")


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("ok   %s" % name)
            except AssertionError as error:  # noqa: PERF203
                failures += 1
                print("FAIL %s -> %s" % (name, error))
    print("\n%d failure(s)" % failures)
    raise SystemExit(1 if failures else 0)
