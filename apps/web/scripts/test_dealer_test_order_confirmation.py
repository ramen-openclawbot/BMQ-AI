#!/usr/bin/env python3
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260827113000_dealer_test_order_zbs_confirmations.sql"
WORKER = ROOT / "supabase/functions/dealer-test-order-confirm-notify/index.ts"
CONFIG = ROOT / "supabase/config.toml"


class DealerTestOrderConfirmationContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.assert_file(MIGRATION, "dedicated test confirmation migration")
        cls.assert_file(WORKER, "dedicated test confirmation worker")
        cls.migration = MIGRATION.read_text(encoding="utf-8")
        cls.worker = WORKER.read_text(encoding="utf-8")
        cls.config = CONFIG.read_text(encoding="utf-8")

    @staticmethod
    def assert_file(path: Path, label: str) -> None:
        if not path.is_file():
            raise AssertionError(f"missing {label}: {path.relative_to(ROOT)}")

    def test_uses_separate_private_outbox_and_feature_flag(self) -> None:
        for marker in [
            "dealer_test_order_confirmations",
            "dealer_test_order_confirmation_enabled",
            "values ('dealer_test_order_confirmation_enabled', 'true')",
            "enable row level security",
            "revoke all on table public.dealer_test_order_confirmations from public, anon, authenticated",
            "grant select, insert, update on table public.dealer_test_order_confirmations to service_role",
        ]:
            self.assertIn(marker, self.migration)

    def test_queue_is_future_only_and_server_test_derived(self) -> None:
        for marker in [
            "queue_dealer_test_order_confirmation",
            "after insert on public.dealer_order_items",
            "v_order.is_test = true",
            "c.is_test = true",
            "c.id = v_order.contact_id",
            "c.customer_id = v_order.customer_id",
            "'THỬ NGHIỆM - KHÔNG XỬ LÝ'",
        ]:
            self.assertIn(marker, self.migration)
        self.assertNotRegex(
            self.migration.lower(),
            r"insert\s+into\s+public\.dealer_test_order_confirmations\s*\([^;]+\)\s*select\b",
        )

    def test_real_confirmation_outbox_and_rpc_are_not_reused(self) -> None:
        self.assertNotIn('.from("dealer_customer_order_confirmations")', self.worker)
        self.assertNotIn('claim_dealer_customer_order_confirmations', self.worker)
        self.assertNotIn('commit_dealer_customer_order_confirmation_send', self.worker)
        self.assertIn('.from("dealer_test_order_confirmations")', self.worker)
        self.assertIn('claim_dealer_test_order_confirmations', self.worker)
        self.assertIn('commit_dealer_test_order_confirmation_send', self.worker)

    def test_terminal_suppressed_row_is_never_requeued_by_late_item_insert(self) -> None:
        self.assertNotIn(
            "dealer_test_order_confirmations.status in ('pending', 'suppressed')",
            self.migration,
        )
        self.assertIn(
            "dealer_test_order_confirmations.status = 'pending'",
            self.migration,
        )

    def test_send_commit_locks_order_and_contact_before_irreversible_lease(self) -> None:
        commit_sql = self.migration.split(
            "create or replace function public.commit_dealer_test_order_confirmation_send",
            1,
        )[1].split("revoke all on function public.commit_dealer_test_order_confirmation_send", 1)[0]
        for marker in [
            "select n.order_id, n.contact_id",
            "into v_order_id, v_contact_id",
            "for update;",
            "from public.dealer_orders o",
            "where o.id = v_order_id",
            "from public.dealer_customer_contacts c",
            "where c.id = v_contact_id",
            "and n.order_id = v_order_id",
            "and n.contact_id = v_contact_id",
        ]:
            self.assertIn(marker, commit_sql)
        self.assertGreaterEqual(commit_sql.count("for update;"), 2)

    def test_claim_and_commit_fail_closed_on_test_identity_and_order_status(self) -> None:
        for marker in [
            "auth.role() is distinct from 'service_role'",
            "o.is_test = true",
            "c.is_test = true",
            "o.status = 'submitted'",
            "for update of n skip locked",
            "send_committed",
            "revoke all on function public.claim_dealer_test_order_confirmations(integer) from public, anon, authenticated",
            "revoke all on function public.commit_dealer_test_order_confirmation_send(uuid) from public, anon, authenticated",
        ]:
            self.assertIn(marker, self.migration)

    def test_worker_targets_only_active_test_contact_and_labels_message(self) -> None:
        for marker in [
            '.eq("is_active", true)',
            '.eq("is_test", true)',
            'customerName: "THỬ NGHIỆM - KHÔNG XỬ LÝ"',
            'trackingId: `dealer-test-order-confirm-${job.order_id}`',
            'sendDealerOrderConfirmationZns',
            'DEALER_VIETGUYS_ORDER_CONFIRM_TEMPLATE_ID',
            'dealer_test_order_confirmation_enabled',
        ]:
            self.assertIn(marker, self.worker)

    def test_transient_precommit_retries_become_terminal_at_limit(self) -> None:
        self.assertGreaterEqual(
            self.worker.count("const retryExhausted = job.attempt_count >= job.max_attempts;"),
            2,
        )
        self.assertGreaterEqual(
            self.worker.count('status: retryExhausted ? "failed" : "pending"'),
            2,
        )
        for marker in [
            'last_error: retryExhausted ? "contact_lookup_retry_exhausted" : "contact_lookup_unavailable"',
            'last_error: retryExhausted ? "send_commit_retry_exhausted" : "send_commit_unavailable"',
            "if (retryExhausted) failed += 1;",
        ]:
            self.assertIn(marker, self.worker)

    def test_cancellation_suppresses_only_test_outbox_before_send_commit(self) -> None:
        for marker in [
            "suppress_non_submitted_dealer_test_order_confirmation",
            "update public.dealer_test_order_confirmations",
            "status in ('pending', 'processing')",
            "order_not_submitted_before_send",
        ]:
            self.assertIn(marker, self.migration)

    def test_dedicated_worker_schedule_and_config_are_explicit(self) -> None:
        for marker in [
            "dealer-test-order-confirm-notify-every-minute",
            "/functions/v1/dealer-test-order-confirm-notify",
            "x-worker-secret",
        ]:
            self.assertIn(marker, self.migration)
        block = self.config.split("[functions.dealer-test-order-confirm-notify]", 1)
        self.assertEqual(len(block), 2, "missing dedicated worker config block")
        self.assertIn("verify_jwt = false", block[1].split("[functions.", 1)[0])

    def test_table_and_payload_do_not_duplicate_phone_or_provider_secret(self) -> None:
        table_match = re.search(
            r"create table if not exists public\.dealer_test_order_confirmations\s*\((.*?)\n\);",
            self.migration,
            re.S | re.I,
        )
        if table_match is None:
            self.fail("missing dedicated test confirmation table DDL")
        table_ddl = table_match.group(1).lower()
        self.assertIn("contact_id", table_ddl)
        self.assertNotIn("phone", table_ddl)
        self.assertNotRegex(self.migration, r"(?i)(access_token|refresh_token|app_secret)\s*=\s*'[^']+'")


if __name__ == "__main__":
    unittest.main()
