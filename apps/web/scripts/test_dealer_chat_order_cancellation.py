#!/usr/bin/env python3
"""Contracts for customer self-cancellation in BMQ Agent chat."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
PORTAL = ROOT / "src/pages/DealerPortal.tsx"
HISTORY_FUNCTION = ROOT / "supabase/functions/dealer-order-history/index.ts"
MIGRATION = ROOT / "supabase/migrations/20260902214500_dealer_chat_self_cancellation.sql"


class DealerChatOrderCancellationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.portal = PORTAL.read_text(encoding="utf-8")
        cls.function = HISTORY_FUNCTION.read_text(encoding="utf-8")
        cls.migration = MIGRATION.read_text(encoding="utf-8") if MIGRATION.exists() else ""

    def test_exact_huy_intent_bypasses_the_order_parser(self) -> None:
        self.assertIn("isDealerChatCancellationIntent", self.portal)
        parse_body = self.portal.split("const handleParseNppOrderText = () => {", 1)[1].split("\n  };", 1)[0]
        cancel_index = parse_body.index("isDealerChatCancellationIntent(submittedText)")
        confirmation_index = parse_body.index("isDealerChatConfirmationIntent(submittedText)")
        parser_index = parse_body.index("parseDealerChatOrderText(submittedText, dealerRoutes)")
        self.assertLess(cancel_index, confirmation_index)
        self.assertLess(cancel_index, parser_index)

    def test_chat_uses_multiple_choice_then_send_then_confirmation(self) -> None:
        panel = self.portal.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        for marker in (
            'data-dealer-cancellation-stage="select"',
            'data-dealer-cancellation-choice',
            'data-dealer-cancellation-action="send"',
            'data-dealer-cancellation-stage="confirm"',
            'data-dealer-cancellation-action="confirm"',
        ):
            self.assertIn(marker, panel)
        self.assertIn('type="checkbox"', panel)
        self.assertIn("Gửi", panel)
        self.assertIn("Xác nhận huỷ", panel)

    def test_confirmation_repeats_selected_order_details_before_irreversible_action(self) -> None:
        panel = self.portal.split("function NppQuickOrderPanel", 1)[1].split("function QuantityCell", 1)[0]
        confirm = panel.split('data-dealer-cancellation-stage="confirm"', 1)[1].split('data-dealer-cancellation-stage="success"', 1)[0]
        self.assertIn("selectedCancellationOrders.map", confirm)
        self.assertIn("order.order_number", confirm)
        self.assertIn("order.physical_quantity", confirm)
        self.assertIn("order.total_amount_vnd", confirm)
        self.assertNotIn("truncate", confirm)

    def test_chat_calls_session_scoped_list_and_cancel_actions(self) -> None:
        self.assertIn('action: "self_cancel_list"', self.portal)
        self.assertIn('action: "self_cancel_confirm"', self.portal)
        self.assertIn("dealer_token: sessionToken", self.portal)
        self.assertIn("order_ids: selectedCancellationOrderIds", self.portal)
        self.assertNotIn("customer_id: dealerCustomer", self.portal)
        self.assertIn("const cancellationSubmittingRef = useRef(false)", self.portal)

    def test_edge_function_uses_resolved_session_for_both_actions(self) -> None:
        self.assertIn("resolveDealerSession", self.function)
        self.assertIn('body.action === "self_cancel_list"', self.function)
        self.assertIn('body.action === "self_cancel_confirm"', self.function)
        self.assertIn('.rpc("dealer_self_cancellable_orders"', self.function)
        self.assertIn('.rpc("cancel_dealer_orders_from_portal"', self.function)
        self.assertIn("sessionContext.customer.id", self.function)
        self.assertIn("sessionContext.contact.id", self.function)
        self.assertIn("sessionContext.session.id", self.function)
        self.assertNotIn("body.customer_id", self.function)

    def test_rpc_is_atomic_vietnam_day_scoped_and_fail_closed(self) -> None:
        normalized = " ".join(self.migration.lower().split())
        self.assertIn("asia/ho_chi_minh", normalized)
        self.assertIn("for update", normalized)
        self.assertIn("for update of reservation", normalized)
        self.assertIn("for update of notification", normalized)
        self.assertIn("status = 'submitted'", normalized)
        self.assertIn("revenue_ledger_lines", normalized)
        self.assertIn("approval_status <> 'superseded'", normalized)
        self.assertIn("tan_tao_warehouse_reservations", normalized)
        self.assertIn("status = 'dispatched'", normalized)
        self.assertIn("notification_type = 'production_bread_order'", normalized)
        self.assertIn("update public.dealer_orders", normalized)
        self.assertIn("set status = 'cancelled'", normalized)
        self.assertIn("dealer_order_cancellation_events", normalized)
        self.assertIn("dealer_order_notifications_status_check", normalized)
        self.assertIn("'cancelled'", normalized)
        self.assertIn("'pending_owner_review'", normalized)
        self.assertIn("self_cancel_notification_in_flight", normalized)
        self.assertIn("set status = 'cancelled', locked_at = null", normalized)
        self.assertIn("p_is_test = true or not exists", normalized)
        self.assertIn("if p_is_test = false and exists", normalized)

    def test_rpc_is_service_role_only_and_test_isolated(self) -> None:
        normalized = " ".join(self.migration.lower().split())
        self.assertIn("p_is_test boolean", normalized)
        self.assertIn("o.is_test = p_is_test", normalized)
        for function_name in ("dealer_self_cancellable_orders", "cancel_dealer_orders_from_portal"):
            self.assertIn(f"revoke all on function public.{function_name}", normalized)
            self.assertIn(f"grant execute on function public.{function_name}", normalized)
        self.assertIn("from public, anon, authenticated", normalized)
        self.assertIn("to service_role", normalized)


if __name__ == "__main__":
    unittest.main()
