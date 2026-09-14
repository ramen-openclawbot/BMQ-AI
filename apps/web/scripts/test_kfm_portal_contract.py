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
    require(CLIENT, "plateNumber", "saved vehicle uses plateNumber; submitted trip uses licensePlate")
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
    forbid(PANEL, 'data-kfm-action="preview-load"', "separate preview is removed from the unified print menu")
    require(PANEL, 'action: "create-load"', "approved GĐ3 must expose operator creation")


def test_trip_creation_is_guarded_and_recoverable() -> None:
    for marker in ('data-kfm-create="v2"', 'data-kfm-action="submit-create"',
                   'data-kfm-action="check-create"', 'createLock.current',
                   'requestId: crypto.randomUUID()', 'confirmed: true'):
        require(PANEL, marker, "create flow guard missing: " + marker)
    for marker in ('canCreateTrip(userId)', 'cached.vendorIds.includes(vendorId)',
                   'payload.revision !== revision', 'buildTripSubmission',
                   'from("kfm_trip_attempts").insert(row)', 'tripResult', 'baseline_asn_ids'):
        require(FUNCTION, marker, "server create guard missing: " + marker)
    require(CLIENT, 'verifyTripReadback', "success must follow per-line ASN readback")
    forbid(CLIENT, '`${SCE_API}/api/v1/portal/asn?vendorId=', "never create a separate ASN in parallel")


def test_unified_print_is_price_free_and_fail_closed() -> None:
    require(PANEL, 'layout: "NO_PRICE"', "all sheet exports hide prices")
    forbid(PANEL, '"FULL"', "no price-carrying UI option")
    require(FUNCTION, 'return String(value) === "FULL" ? "FULL" : "NO_PRICE"', "default hides prices")
    require(FUNCTION, 'strict: true', "ASN lookup errors cannot mean missing note")
    require(FUNCTION, 'freshFleet', "saved fleet must be rechecked before write")
    require(CLIENT, 'validateSavedTripForm', "saved choices validated server side")
    require(CLIENT, '/vendor-delivery/vehicles', "use portal saved vehicles")
    require(CLIENT, '/vendor-delivery/drivers', "use portal saved drivers")
    require(PANEL, 'defaultDriverId', "use vehicle default driver link")
    forbid(PANEL, 'dòng đã giao đủ', "allocations are not physical delivery evidence")
    require(FUNCTION, 'rawRows: source.items,', "read-only diagnostic API preserved")
    require(PANEL, 'PhieuGiaoHang', "preserve filename")


def test_the_panel_fits_a_phone_viewport() -> None:
    require(PANEL, 'data-kfm-mobile="v2"', "version the full-page mobile layout")
    require(PANEL, 'min-w-0', "content must shrink within app shell")
    require(PANEL, 'grid-cols-1', "actions stack on small screens")
    require(PANEL, 'h-11', "print targets must remain at least 44px high")
    forbid(PANEL, '<Dialog', "printing workspace must not be a modal")
    forbid(PANEL, '<table', "PO actions must not require horizontal table scrolling")


def test_every_print_action_shows_the_waiting_state() -> None:
    # Reported 2026-09-13: the PO printout opened a blank tab for several seconds
    # because only the trip sheet had a waiting state. Both print actions now
    # share one keyed slot, one banner and one pending tab.
    require(PANEL, "useState<string | null>(null)",
            "the waiting state must be keyed so every print action can use it")
    for key in ("`asn-${order.portalId}`",):
        require(PANEL, key, "each print action must drive the shared waiting state: %s" % key)
    require(PANEL, "writePrintPlaceholder",
            "the tab opened on click must show a placeholder, never a blank window")
    require(PANEL, 'data-kfm-printing=', "the waiting banner must stay present")


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
    forbid(PANEL, 'data-kfm-action="confirm"', "PO confirmation belongs to explicit trip creation")
    require(PANEL, 'data-kfm-action="print-po"', "PO export remains separate from delivery creation")
    require(PANEL, "unifiedPrint: true", "explicit print click authorizes the combined flow")


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
    routes = (ROOT / "src/components/AppRoutes.tsx").read_text()
    page = (ROOT / "src/pages/KfmPrintToday.tsx").read_text()
    require(PLANNING, 'data-kfm-portal-entry="v2"', "launcher links directly to today's workspace")
    require(PLANNING, 'to="/production/planning/q7/kfm"', "Q7 must open the dedicated route")
    require(routes, 'path="/production/planning/q7/kfm" element={<ModuleRoute moduleKey="production_q7">', "new route must retain Q7 permission")
    require(page, '<KfmPrintWorkspace', "page must reuse verified print workflow")
    require(PANEL, 'kfm-portal-sync', "keep existing authenticated proxy")
    require(PANEL, 'Authorization: `Bearer ${session.access_token}`', "retain user authentication")
    require(PANEL, 'configured === false', "unconfigured is not an empty queue")
    require(PLANNING, '"Kiểm tra PO"', "Q7 email workflow remains outside this slice")


def test_the_order_row_keeps_po_and_delivery_printing() -> None:
    require(PANEL, 'data-kfm-unified-print="v1"', "version unified behavior")
    forbid(PANEL, "DropdownMenu", "both actions must be directly visible")
    require(PANEL, 'data-kfm-action="print-asn"', "delivery note action")
    require(PANEL, 'data-kfm-po-print="v1"', "restored PO print marker")
    actions = PANEL.split('const renderOrderActions =', 1)[1].split('const renderCreate', 1)[0]
    assert actions.count('<Button') == 2, "exactly two direct actions per order"
    po_handler = PANEL.split('const handlePrintPo =', 1)[1].split('const renderOrderActions', 1)[0]
    require(po_handler, 'action: "po-pdf"', "PO click exports the existing PO")
    require(po_handler, 'createLock.current', "PO printing shares the synchronous print lock")
    for action in ('create-load', 'confirm', 'trip-options', 'openCreate', 'sendAndPrint'):
        forbid(po_handler, action, "PO export must not create or confirm anything")
    for marker in ('preview-load', 'print-asn-no-price', 'data-kfm-action="create-load"', '(có giá)', '(không giá)'):
        forbid(PANEL, marker, "obsolete menu option: " + marker)
    require(PANEL, 'existingNotes', "reprint existing notes without create")
    require(PANEL, 'sendAndPrint', "missing note continues to create and print")
    require(PANEL, 'renderOrderActions', "phone and desktop share action")
    require(PANEL, 'Printer', "printer icon retained")


def test_a_phone_row_needs_no_sideways_drag() -> None:
    require(PANEL, 'data-kfm-orders-cards="v2"', "one responsive list must serve all viewports")
    require(PANEL, 'break-all', "long PO codes stay readable")
    require(PANEL, 'creating?.order.portalId === order.portalId && renderCreate()', "missing fields expand inside their PO")
    forbid(PANEL, 'type="date"', "no date picker in today's workflow")
    require(PANEL, 'vnDateOffset(0)', "load today's Vietnam delivery date")
    forbid(PANEL, 'vnDateOffset(1)', "never default to tomorrow")
    require(PANEL, 'visibilitychange', "refresh the date when a suspended tab returns")
    require(PANEL, 'requireToday(snapshot.date)', "never submit a stale form after midnight")
    require(PANEL, 'requireToday(deliveryDate)', "stale PO actions require a fresh queue")
    require(PANEL, 'data-kfm-today="v1"', "version the new page")


def test_auto_confirmation_and_desktop_layout_contracts() -> None:
    for marker in ('data-kfm-auto-confirm="v1"', 'data-kfm-pending-changes="v1"', 'data-kfm-po-readback="v1"'):
        require(PANEL, marker, "review and readback must be visible")
    forbid(PANEL, 'action: "confirm"', "never send a separate PO confirmation")
    require(FUNCTION, "fresh.pendingChanges = await getTripPendingChanges", "check pending changes again before writing")
    require(FUNCTION, "if (!poConfirmation?.confirmed)", "do not claim success without PO readback")
    require(PLANNING, 'data-bmq-q7-header="v2"', "version the desktop header")
    require(PLANNING, 'sm:flex sm:flex-wrap', "wrap header actions")
    require(PLANNING, 'xl:grid-cols-[minmax(0,1fr)_360px]', "constrain the table column")
    payables = (ROOT / "src/pages/PaymentRequests.tsx").read_text()
    require(payables, 'data-bmq-payables-toolbar="v2"', "version the desktop toolbar")
    require(payables, 'data-bmq-payables-search-row="v2"', "search must have its own row")


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
