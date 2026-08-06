#!/usr/bin/env python3
"""Contracts for dealer duplicate-order prevention and chat resolution."""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
PORTAL = ROOT / "src/pages/DealerPortal.tsx"
SUBMIT = ROOT / "supabase/functions/dealer-order-submit/index.ts"
HISTORY = ROOT / "supabase/functions/dealer-order-history/index.ts"
MIGRATION = ROOT / "supabase/migrations/20260806224000_dealer_duplicate_order_guard.sql"


class DealerDuplicateOrderGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.portal = PORTAL.read_text(encoding="utf-8")
        cls.submit = SUBMIT.read_text(encoding="utf-8")
        cls.history = HISTORY.read_text(encoding="utf-8")
        cls.migration = MIGRATION.read_text(encoding="utf-8") if MIGRATION.exists() else ""

    def test_atomic_rpc_serializes_and_deduplicates_submissions(self) -> None:
        for marker in (
            "client_submission_id uuid",
            "order_fingerprint text",
            "dealer_orders_client_submission_uidx",
            "submit_dealer_order_guarded",
            "pg_advisory_xact_lock",
            "interval '10 minutes'",
            "o.status <> 'cancelled'",
            "p_duplicate_action is distinct from 'add'",
            "insert into public.dealer_orders",
            "insert into public.dealer_order_items",
            "insert into public.dealer_order_notifications",
        ):
            self.assertIn(marker, self.migration)

    def test_rpc_is_service_role_only(self) -> None:
        self.assertIn(
            "revoke all on function public.submit_dealer_order_guarded",
            self.migration,
        )
        self.assertIn("from public, anon, authenticated", self.migration)
        self.assertIn("grant execute on function public.submit_dealer_order_guarded", self.migration)
        self.assertIn("to service_role", self.migration)

    def test_edge_computes_server_fingerprint_and_uses_atomic_rpc(self) -> None:
        self.assertIn("computeOrderFingerprint", self.submit)
        self.assertIn('duplicate_action?: unknown', self.submit)
        self.assertIn('client_submission_id?: unknown', self.submit)
        self.assertIn('.rpc("submit_dealer_order_guarded"', self.submit)
        self.assertNotIn('.from("dealer_orders")\n      .insert', self.submit)
        self.assertIn('similar_order_exists', self.submit)

    def test_chat_renders_duplicate_choice_without_creating_order(self) -> None:
        self.assertIn("duplicateOrderPrompt", self.portal)
        self.assertIn("Đơn hàng tương tự đã được đặt", self.portal)
        self.assertIn("Quý Khách Hàng muốn cộng dồn hay huỷ?", self.portal)
        self.assertIn('data-dealer-chat-choices="duplicate-order"', self.portal)
        self.assertIn('data-dealer-chat-choice="duplicate-add"', self.portal)
        self.assertIn('data-dealer-chat-choice="duplicate-cancel"', self.portal)
        self.assertIn("Cộng dồn", self.portal)
        self.assertIn("Huỷ", self.portal)
        self.assertIn("client_submission_id", self.portal)
        self.assertIn("duplicate_action", self.portal)

    def test_cancelled_duplicates_are_excluded_from_history_and_summary(self) -> None:
        self.assertIn('.neq("status", "cancelled")', self.history)
        self.assertIn("o.status <> 'cancelled'", self.migration)
        self.assertIn("create or replace function public.dealer_order_history_summary", self.migration)


if __name__ == "__main__":
    unittest.main()
