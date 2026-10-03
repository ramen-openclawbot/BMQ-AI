#!/usr/bin/env python3
"""Text contract for Demo 3 stage 3B write-safety RPCs.

Guards that the two new server-authority functions keep the required
security-definer shape and that the client stops writing the guarded tables
directly.
"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261003100000_stage3_write_safety_rpcs.sql"
HOOKS = ROOT / "src/hooks/usePaymentRequests.ts"
DISPATCH_PAGE = ROOT / "src/pages/WarehouseDispatch.tsx"

REJECT_SIGNATURE = "public.reject_payment_request(uuid, text)"
TRANSITION_SIGNATURE = "public.transition_warehouse_dispatch_status(uuid, text)"


class Stage3WriteSafetyContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.migration = MIGRATION.read_text(encoding="utf-8")
        cls.hooks = HOOKS.read_text(encoding="utf-8")
        cls.dispatch_page = DISPATCH_PAGE.read_text(encoding="utf-8")

    def test_migration_defines_both_security_definer_functions(self) -> None:
        self.assertIn("create or replace function public.reject_payment_request(", self.migration)
        self.assertIn("create or replace function public.transition_warehouse_dispatch_status(", self.migration)
        self.assertGreaterEqual(self.migration.count("security definer"), 2)
        self.assertGreaterEqual(self.migration.count("set search_path = public, pg_temp"), 2)
        self.assertIn("for update", self.migration)

    def test_migration_revokes_and_grants_execute(self) -> None:
        for signature in (REJECT_SIGNATURE, TRANSITION_SIGNATURE):
            self.assertIn(
                f"revoke execute on function {signature} from public, anon;",
                self.migration,
            )
            self.assertIn(
                f"grant execute on function {signature} to authenticated, service_role;",
                self.migration,
            )
            self.assertIn(f"comment on function {signature} is", self.migration)

    def test_migration_carries_required_error_codes(self) -> None:
        for code in (
            "invalid_status",
            "has_payments",
            "rejection_reason_required",
            "invalid_transition",
            "inventory_item_not_found",
            "inventory_item_ambiguous",
            "invalid_quantity",
            "insufficient_stock",
        ):
            self.assertIn(code, self.migration)
        self.assertIn("using errcode = '42501'", self.migration)
        self.assertIn("using errcode = '22023'", self.migration)
        self.assertIn("using errcode = 'P0001'", self.migration)
        self.assertIn("using errcode = 'P0002'", self.migration)

    def test_warehouse_dispatch_never_clamps_stock_to_zero(self) -> None:
        self.assertNotIn("greatest(0", self.migration.lower())
        mutation = self.dispatch_page.split("const updateStatusMutation", 1)[1].split("const filtered", 1)[0]
        self.assertNotIn("Math.max(0", mutation)

    def test_reject_hook_uses_rpc_not_direct_update(self) -> None:
        self.assertIn('rpc("reject_payment_request"', self.hooks)
        self.assertNotIn('status: "rejected"', self.hooks)

    def test_bulk_approve_uses_allsettled_and_summarizer(self) -> None:
        self.assertIn("Promise.allSettled", self.hooks)
        self.assertIn("summarizeApprovalResults(ids, settled)", self.hooks)
        bulk = self.hooks.split("useBulkApprovePaymentRequest", 1)[1]
        self.assertNotIn("Promise.all(", bulk)

    def test_dispatch_page_uses_transition_rpc(self) -> None:
        self.assertIn('rpc("transition_warehouse_dispatch_status"', self.dispatch_page)
        mutation = self.dispatch_page.split("const updateStatusMutation", 1)[1].split("const filtered", 1)[0]
        self.assertNotIn('.from("inventory_items").update', mutation)
        self.assertNotIn('.from("warehouse_dispatches")', mutation)


if __name__ == "__main__":
    unittest.main()
