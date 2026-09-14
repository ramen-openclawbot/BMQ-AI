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
    # clicks every step by hand). Confirm plus the printouts are the whole
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
    for action in ("list", "detail", "confirm", "po-pdf", "asn-pdf",
                   "loads", "load-detail", "load-pdf"):
        require(FUNCTION, '"%s"' % action, "the %s action must be exposed" % action)
    require(FUNCTION, '"POST"', "the function must accept POST for the read request")
    require(FUNCTION, 'method !== "POST"', "only POST may reach the portal call")


def test_the_panel_offers_no_trip_surface() -> None:
    # Owner 2026-09-14: every trip carries exactly one order today, so the trip
    # sheet repeated the order's own delivery note and the whole section went.
    # The read-only trip endpoints stay verified in the client and the bridge for
    # the day a trip really carries several orders; only the panel surface is
    # gone, so re-adding it is a UI change and not a new integration.
    require(CLIENT, "/api/v1/portal/inbound-loads?", "the trip read must stay available in the client")
    require(CLIENT, "/api/v1/portal/inbound-loads/${options.loadId}/export-pdf?",
            "the trip sheet must stay available in the client")
    require(CLIENT, "licensePlate", "the plate field must stay the one the portal really sends")
    require(CLIENT, "driverPhone", "the trip shape must keep the driver phone")
    forbid(CLIENT, "plateNumber", "the portal has no plateNumber field")
    require(FUNCTION, '"load-pdf"', "the trip sheet must stay available in the bridge")
    require(PANEL, "Đang chuẩn bị file in", "printing must show the portal's waiting state")
    for marker in ('data-kfm-loads-section', 'data-kfm-loads-toggle', 'data-kfm-loads-filter',
                   'data-kfm-action="print-load"', "handlePrintLoad", "showLoads",
                   "filterLoadsByDate", "loadsQuery", 'action: "loads"'):
        forbid(PANEL, marker, "the panel must carry no trip surface: %s" % marker)


def test_the_trip_draft_is_read_only_and_built_from_the_po_items() -> None:
    # Approved 2026-09-14 (owner: option "A" - the delivery note is raised the
    # way the portal raises it, through a delivery trip). Stage 1 only: the body
    # is assembled and shown for review, and no create call exists yet.
    # Corrected 2026-09-14 against the portal's own bundle: the trip form reads
    # `useLazyGetPortalOrderDetailQuery({ id, vendorId })`, i.e. the portal order
    # detail, and rewrites the lines from its RESOLVED QUANTITY requests. The
    # earlier PO-items endpoint was a wrong guess and mapped every quantity to 0.
    require(CLIENT, "/api/v1/portal/orders/${options.orderId}?vendorId=${options.vendorId}",
            "the trip body must be built from the portal order detail the portal reads")
    require(CLIENT, "data.requests", "approved quantities come from the order's requests")
    require(CLIENT, "data.requestItems", "approved quantities come from the order's request items")
    require(CLIENT, 'asString(parent.status) !== "RESOLVED"',
            "only RESOLVED requests count as approved")
    require(CLIENT, '!== "QUANTITY"', "only quantity requests may change a line's amount")
    require(CLIENT, "finalQuantity", "the approved amount is the line's finalQuantity")
    require(CLIENT, "shippedMap", "the portal skips lines its shippedMap has already covered")
    require(CLIENT, "buildTripDraft", "the draft builder must be a named, reviewable unit")
    require(CLIENT, "poItemId", "the mapped item must carry poItemId")
    require(CLIENT, "cartons", "the mapped item must carry cartons")
    require(CLIENT, "uomName", "the portal sends the unit as uomName")
    require(CLIENT, "internalCode", "the product code falls back to internalCode")
    require(CLIENT, "totalPallets", "the stop must carry the portal's totals fields")
    # The portal sends the ORDERED quantity as `shipQty` and always sends 0 for
    # `cartons`; both are what its own body carries, so both are pinned here.
    require(CLIENT, "shipQty,\n      cartons: 0", "the portal sends the ordered amount and zero cartons")
    # GĐ3 approved: the separate create helper may post; draft still only reads.
    require(CLIENT, "&submit=true", "the confirmed create flow must match the portal")
    forbid(CLIENT, "&submit=false", "this slice must not silently create a draft")
    forbid(CLIENT, "inbound-loads/${options.loadId}/cancel", "cancelling a trip is not approved")
    require(FUNCTION, '"trip-draft"', "the bridge must expose the read-only draft action")
    # Reported 2026-09-14: the panel showed a successful response carrying only
    # `source: "kfm_portal"`, because the deployed function was one version behind
    # and an unknown action fell through to the order list. Fail loudly instead.
    require(FUNCTION, '"unknown_action"', "an action the server does not know must be refused")
    require(FUNCTION, 'action === "list" && String(payload.action) !== "list"',
            "only a missing action may default to the order list")
    require(PANEL, 'data-kfm-action="preview-load"', "the row menu must offer the preview")
    require(PANEL, 'data-kfm-load-preview="v1"', "the preview panel must carry a stable marker")
    require(PANEL, 'action: "create-load"', "approved GĐ3 must expose operator creation")


def test_trip_creation_is_guarded_and_recoverable() -> None:
    for marker in ('data-kfm-create="v1"', 'data-kfm-action="submit-create"',
                   'data-kfm-action="check-create"', 'createLock.current',
                   'requestId: crypto.randomUUID()', 'confirmed: true'):
        require(PANEL, marker, "create flow guard missing: " + marker)
    for marker in ('canCreateTrip(userId)', 'cached.vendorIds.includes(vendorId)',
                   'payload.revision !== revision', 'buildTripSubmission',
                   'from("kfm_trip_attempts").insert(row)', 'tripResult', 'baseline_asn_ids'):
        require(FUNCTION, marker, "server create guard missing: " + marker)
    require(CLIENT, 'verifyTripReadback', "success must follow per-line ASN readback")
    forbid(CLIENT, '`${SCE_API}/api/v1/portal/asn?vendorId=', "never create a separate ASN in parallel")


def test_empty_trip_preview_does_not_claim_physical_delivery() -> None:
    require(PANEL, 'data-kfm-load-empty="v1"', "empty drafts must explain new-trip eligibility")
    forbid(PANEL, "dòng đã giao đủ", "assignment to a trip does not prove physical delivery")
    require(PANEL, "không phải phiếu đã tạo", "new-trip preview must be distinguished from an existing note")
    require(PANEL, "shippedMap: result.shippedMap", "the operator must see actual filter quantities")
    require(FUNCTION, "rawRows: source.items,", "all excluded rows must remain available for comparison")
    require(FUNCTION, "shippedMap: source.shippedMap,", "filter keys without values are insufficient evidence")
    require(FUNCTION, "const sourcePoId = Number(source.po.id)", "PO identity must come from the source")
    forbid(FUNCTION, "draft.stops[0]?.items[0]?.poId", "empty drafts must not lose their PO identity")


def test_the_delivery_note_prints_with_prices_like_the_portal() -> None:
    # Corrected 2026-09-14 from the portal's own bundle: its print menu offers two
    # layouts and `FULL` (prices shown) is the default it calls by itself
    # (`p("FULL")` on the print button). `NO_PRICE` is the opt-in alternative.
    # The bridge had been hardcoding `hidePrice: true`, which is the opposite of
    # the portal's default and the reason the copy differed.
    require(CLIENT, 'export type KfmPrintLayout = "FULL" | "NO_PRICE"',
            "both portal print layouts must be modelled")
    require(CLIENT, 'const layout = options.layout ?? "FULL"',
            "printing must default to the portal's price-carrying layout")
    require(CLIENT, '(options.layout ?? "FULL") === "NO_PRICE"',
            "prices must only be hidden when the price-free layout is asked for")
    forbid(CLIENT, "hidePrice !== false", "a default must never silently hide the prices")
    require(FUNCTION, 'return String(value) === "NO_PRICE" ? "NO_PRICE" : "FULL"',
            "the bridge must normalise the layout and default to FULL")
    require(FUNCTION, "printLayout", "the print handlers must resolve the layout")
    require(PANEL, 'data-kfm-action="print-asn-no-price"',
            "the menu must offer the portal's price-free delivery note")
    require(PANEL, 'handlePrintAsn(order, "FULL")',
            "the plain delivery-note entry must print with prices")
    require(PANEL, "PhieuGiaoHang_", "the sheet must keep the portal's file name")


def test_the_panel_fits_a_phone_viewport() -> None:
    # Reported 2026-09-13 on an iPhone 17 Pro Max: the action column sat outside
    # the screen, so the print button was unreachable. The dialog caps its height,
    # its grid children may shrink, and the action column is pinned to the edge.
    require(PANEL, 'data-kfm-mobile="v1"', "the mobile layout fix must carry a stable marker")
    require(PANEL, "max-h-[90dvh]", "the dialog must cap its height on a short screen")
    require(PANEL, "overflow-y-auto", "the dialog must scroll instead of overflowing")
    require(PANEL, "min-w-0", "the dialog's grid children must be allowed to shrink")
    require(PANEL, "sticky right-0", "the action column must stay visible while a row scrolls")
    require(PANEL, "sm:ml-auto", "trailing badges must wrap on phones instead of being clipped")


def test_every_print_action_shows_the_waiting_state() -> None:
    # Reported 2026-09-13: the PO printout opened a blank tab for several seconds
    # because only the trip sheet had a waiting state. Both print actions now
    # share one keyed slot, one banner and one pending tab.
    require(PANEL, "useState<string | null>(null)",
            "the waiting state must be keyed so every print action can use it")
    for key in ("`po-${order.portalId}`", "`asn-${order.portalId}`"):
        require(PANEL, key, "each print action must drive the shared waiting state: %s" % key)
    require(PANEL, "writePrintPlaceholder",
            "the tab opened on click must show a placeholder, never a blank window")
    require(PANEL, 'data-kfm-printing="v1"', "the waiting banner must stay present")


def test_the_pending_tab_is_readable_on_a_phone() -> None:
    # Reported 2026-09-13 with a screenshot: on an iPhone 17 Pro Max the pending
    # tab was a tiny line in a white screen. The waiting page scales with the
    # viewport and names the sheet being built.
    require(PANEL, "kfm-spin", "the pending tab needs a spinner, not just small text")
    require(PANEL, "clamp(", "the pending tab must scale with the viewport")
    require(PANEL, "${hint}", "the pending tab must name the sheet it is building")
    # Reported 2026-09-14: two animations ran at once and the text read as a speck
    # in a white screen. A fresh about:blank tab carries no viewport meta, so the
    # phone laid the page out at the 980px default and shrank the whole thing, and
    # the bouncing dots were a second animation beside the spinner.
    require(PANEL, '"viewport"', "the pending tab must declare its own viewport")
    require(PANEL, "width=device-width", "the pending tab must use the device width")
    forbid(PANEL, "kfm-wait", "the pending tab must show a single animation")


def test_the_panel_shows_no_money() -> None:
    for marker in ("Tổng (gồm VAT)", "orderTotalWithTax", "orderTotal", "taxTotal"):
        forbid(PANEL, marker, "the KFM panel must show products and quantities only")
    require(PANEL, "totalQty", "quantities stay visible on the order list")
    require(PANEL, 'data-kfm-action="confirm"', "the confirm button must be present")
    require(PANEL, 'data-kfm-action="print-po"', "the PO print button must be present")
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


def test_the_order_row_prints_both_sheets_from_one_menu() -> None:
    # Reported 2026-09-14: the row's truck button had been dropped, so a single
    # order's delivery note could no longer be printed from the list. Both sheets
    # now hang off one printer menu, which keeps a single print entry point per
    # row while the truck stays off the row itself.
    require(PANEL, 'data-kfm-action="print-menu"', "the order row needs one print entry point")
    require(PANEL, 'data-kfm-action="print-po"', "the menu must offer the PO sheet")
    require(PANEL, 'data-kfm-action="print-asn"', "the menu must offer the delivery note")
    require(PANEL, "handlePrintAsn", "the delivery note must stay printable from the order")
    require(PANEL, 'action: "asn-pdf"', "the delivery note must use the verified export endpoint")
    require(PANEL, "detail.order?.asns?.[0]", "the delivery note id must come from the order detail")
    require(PANEL, "renderOrderActions", "the phone card and the table must share one action cluster")
    require(PANEL, "Printer", "the row's single print entry point must show the printer glyph")
    forbid(PANEL, "FileText", "an unused document icon must not stay imported")


def test_a_phone_row_needs_no_sideways_drag() -> None:
    # Reported 2026-09-14 with a screenshot: the five-column table had to be
    # dragged sideways on an iPhone, which scrolled the "PO100…" prefix off the
    # row and clipped the header. Phones get a stacked card instead, and the
    # table only renders where it actually fits.
    require(PANEL, 'data-kfm-orders-cards="v1"', "phones need their own stacked order card")
    require(PANEL, "md:hidden", "the card list must replace the table on small screens")
    require(PANEL, "hidden max-h-96 min-w-0 overflow-auto rounded-xl border border-border md:block",
            "the table must only render from the md breakpoint up")
    require(PANEL, "break-all", "the full PO code must stay readable without scrolling")


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
