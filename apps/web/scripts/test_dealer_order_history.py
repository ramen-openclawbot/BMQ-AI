#!/usr/bin/env python3
"""Regression contract for the dealer order-history destination."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
PORTAL = ROOT / "src/pages/DealerPortal.tsx"
HISTORY_FUNCTION = ROOT / "supabase/functions/dealer-order-history/index.ts"
HISTORY_STYLE = ROOT / "src/styles/dealer-order-history.css"
MIGRATION = ROOT / "supabase/migrations/20260806211532_dealer_order_history_summary.sql"
CONFIG = ROOT / "supabase/config.toml"


class DealerOrderHistoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.portal = PORTAL.read_text(encoding="utf-8")
        cls.function = HISTORY_FUNCTION.read_text(encoding="utf-8") if HISTORY_FUNCTION.exists() else ""
        cls.style = HISTORY_STYLE.read_text(encoding="utf-8") if HISTORY_STYLE.exists() else ""
        cls.migration = MIGRATION.read_text(encoding="utf-8") if MIGRATION.exists() else ""
        cls.config = CONFIG.read_text(encoding="utf-8")

    def test_bottom_orders_opens_history_but_agent_row_still_opens_chat(self) -> None:
        inbox = self.portal.split('data-dealer-agent-screen="inbox"', 1)[1].split("</nav>", 1)[0]
        agent_row = inbox.split('data-dealer-agent-row="order"', 1)[1].split("</button>", 1)[0]
        bottom_nav = inbox.split('data-dealer-agent-nav="messages-orders-account"', 1)[1]
        self.assertIn('setActiveNav("order")', agent_row)
        self.assertIn('setActiveNav("orders")', bottom_nav)

    def test_history_ui_has_approved_hallmark_structure_and_states(self) -> None:
        for marker in (
            'data-dealer-agent-screen="orders"',
            'data-dealer-order-history="mobile-first"',
            'data-dealer-order-history-filter',
            'data-dealer-order-history-summary',
            'data-dealer-order-history-list',
            'data-dealer-order-history-pagination',
            'data-dealer-order-history-detail',
            'data-dealer-order-history-state="loading"',
            'data-dealer-order-history-state="empty"',
            'data-dealer-order-history-state="error"',
        ):
            self.assertIn(marker, self.portal)
        for copy in ("Đơn hàng của tôi", "Ngày", "Tháng", "Năm", "Tổng số bánh giao", "Tổng tiền", "Đã ghi nhận"):
            self.assertIn(copy, self.portal)

    def test_period_changes_reset_page_and_request_is_customer_id_free(self) -> None:
        self.assertIn("setOrderHistoryPage(1)", self.portal)
        invoke_slice = self.portal.split('"dealer-order-history"', 1)[1].split("}, undefined", 1)[0]
        self.assertNotIn("customer_id", invoke_slice)
        self.assertIn("granularity", invoke_slice)
        self.assertIn("anchor", invoke_slice)
        self.assertIn("page: orderHistoryPage", invoke_slice)
        self.assertIn("page_size: 10", invoke_slice)

    def test_edge_function_derives_customer_from_session_and_caps_pagination(self) -> None:
        self.assertIn("resolveDealerSession", self.function)
        self.assertIn("sessionContext.customer.id", self.function)
        self.assertNotIn("body.customer_id", self.function)
        self.assertIn("const PAGE_SIZE = 10", self.function)
        self.assertIn("Math.min", self.function)
        self.assertIn("Asia/Ho_Chi_Minh", self.function)
        self.assertIn('.range(from, to)', self.function)
        self.assertIn('.rpc("dealer_order_history_summary"', self.function)

    def test_physical_quantity_and_money_semantics_are_explicit(self) -> None:
        normalized_migration = " ".join(self.migration.lower().split())
        self.assertIn("i.physical_quantity", normalized_migration)
        self.assertIn("coalesce(i.ordered_quantity, i.quantity) + i.exchange_quantity + i.makeup_quantity", normalized_migration)
        self.assertIn("sum(o.total_amount_vnd)", normalized_migration)
        self.assertIn("count(*)", normalized_migration)

    def test_summary_rpc_is_service_role_only(self) -> None:
        normalized_migration = " ".join(self.migration.lower().split())
        self.assertIn("revoke all on function public.dealer_order_history_summary", normalized_migration)
        self.assertIn("from public, anon, authenticated", normalized_migration)
        self.assertIn("grant execute on function public.dealer_order_history_summary", normalized_migration)
        self.assertIn("to service_role", normalized_migration)

    def test_history_function_is_registered_without_gateway_jwt(self) -> None:
        self.assertIn("[functions.dealer-order-history]", self.config)
        config_slice = self.config.split("[functions.dealer-order-history]", 1)[1].split("[functions.", 1)[0]
        self.assertIn("verify_jwt = false", config_slice)

    def test_exact_order_lookup_is_session_scoped_and_deep_linked(self) -> None:
        self.assertIn("order_number?: unknown", self.function)
        self.assertIn("normalizeOrderNumber", self.function)
        self.assertIn('.eq("customer_id", sessionContext.customer.id)', self.function)
        self.assertIn('.eq("order_number", requestedOrderNumber)', self.function)
        self.assertIn('code: "order_not_found"', self.function)
        self.assertNotIn("body.customer_id", self.function)

        self.assertIn("DEALER_ORDER_DEEP_LINK_STORAGE_KEY", self.portal)
        self.assertIn('searchParams.get("view") === "orders"', self.portal)
        self.assertIn('searchParams.get("order")', self.portal)
        self.assertIn("sessionStorage.setItem", self.portal)
        self.assertIn("order_number: pendingOrderDeepLink", self.portal)
        self.assertIn("setSelectedHistoryOrder(exactOrder)", self.portal)
        self.assertIn("setDeepLinkedOrderActive(true)", self.portal)
        self.assertIn("pendingOrderDeepLink || deepLinkedOrderActive", self.portal)
        self.assertIn("setDeepLinkedOrderActive(false)", self.portal)
        self.assertIn("sessionStorage.removeItem(DEALER_ORDER_DEEP_LINK_STORAGE_KEY)", self.portal)
        self.assertIn("Không tìm thấy đơn hàng trong tài khoản này.", self.portal)

    def test_dedicated_hallmark_styles_are_scoped_and_mobile_safe(self) -> None:
        self.assertIn("Hallmark · macrostructure: Operational Workbench", self.style)
        self.assertIn('[data-dealer-agent-screen="orders"]', self.style)
        self.assertIn("font-variant-numeric: tabular-nums", self.style)
        self.assertIn("min-height: 44px", self.style)
        self.assertIn("prefers-reduced-motion: reduce", self.style)
        self.assertNotIn("100vw", self.style)


if __name__ == "__main__":
    unittest.main()
