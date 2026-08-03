#!/usr/bin/env python3
"""Regression contract for automatic 1:1 stock issue after a goods receipt is finalized."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260803045200_auto_issue_goods_receipts.sql"


class AutoIssueGoodsReceiptsMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sql = MIGRATION.read_text(encoding="utf-8")
        cls.compact = re.sub(r"\s+", " ", cls.sql.lower())

    def test_has_dedicated_auditable_header_and_lines(self) -> None:
        self.assertIn("create table if not exists public.goods_receipt_auto_issues", self.compact)
        self.assertIn("goods_receipt_id uuid not null", self.compact)
        self.assertRegex(self.compact, r"unique\s*\(goods_receipt_id\)")
        self.assertIn("create table if not exists public.goods_receipt_auto_issue_items", self.compact)
        self.assertIn("goods_receipt_item_id uuid not null", self.compact)
        self.assertRegex(self.compact, r"unique\s*\(goods_receipt_item_id\)")
        self.assertIn("'system_auto'", self.compact)

    def test_trigger_runs_once_on_received_transition_inside_finalize_transaction(self) -> None:
        self.assertRegex(
            self.compact,
            r"create trigger auto_issue_goods_receipt_on_received after update of status on public\.goods_receipts",
        )
        self.assertRegex(
            self.compact,
            r"when \(old\.status is distinct from new\.status and new\.status::text = 'received'\)",
        )
        self.assertRegex(
            self.compact,
            r"for each row when \(old\.status is distinct from new\.status and new\.status::text = 'received'\) execute function public\.auto_issue_goods_receipt\(\)",
        )
        self.assertIn("drop trigger if exists auto_issue_goods_receipt_on_received", self.compact)

    def test_fail_closed_and_exact_one_to_one_stock_effect(self) -> None:
        self.assertIn("for update", self.compact)
        self.assertIn("if new.finalized_at is null then", self.compact)
        self.assertIn("auto issue requires at least one positive goods receipt item", self.compact)
        self.assertIn("auto issue requires an inventory item", self.compact)
        self.assertIn("auto issue requires exactly one receipt batch", self.compact)
        self.assertIn("auto issue batch quantity mismatch", self.compact)
        self.assertRegex(self.compact, r"set quantity = quantity - round\(v_quantity\)::integer")
        self.assertRegex(self.compact, r"set quantity = quantity - v_quantity")
        self.assertIn("movement_type,", self.compact)
        self.assertIn("'goods_receipt_in'", self.compact)
        self.assertIn("'production_consume'", self.compact)
        self.assertIn("-v_quantity", self.compact)

    def test_idempotency_guards_cover_documents_and_ledger(self) -> None:
        self.assertIn("on conflict (goods_receipt_id) do nothing", self.compact)
        self.assertIn("on conflict (goods_receipt_item_id) do nothing", self.compact)
        self.assertRegex(
            self.compact,
            r"select id into v_auto_issue_item_id from public\.goods_receipt_auto_issue_items where goods_receipt_item_id = v_item\.id; if found then continue;",
        )
        self.assertIn("create unique index if not exists inventory_movements_auto_receipt_ref_uidx", self.compact)
        self.assertIn("on conflict (movement_type, reference_type, reference_id)", self.compact)
        self.assertIn("where reference_type = 'goods_receipt_auto_issue'", self.compact)

    def test_security_and_rls_are_fail_closed(self) -> None:
        self.assertIn("security definer", self.compact)
        self.assertIn("set search_path = public", self.compact)
        for role in ("public", "anon", "authenticated", "service_role"):
            self.assertIn(
                f"revoke execute on function public.auto_issue_goods_receipt() from {role}",
                self.compact,
            )
        self.assertIn("enable row level security", self.compact)
        self.assertIn("drop policy if exists", self.compact)

    def test_no_historical_backfill_or_sales_dispatch_pollution(self) -> None:
        self.assertIn("existing received receipts are intentionally not backfilled", self.compact)
        self.assertNotIn("from public.goods_receipts gr", self.compact)
        self.assertNotIn("insert into public.warehouse_dispatches", self.compact)
        self.assertNotIn("insert into public.warehouse_dispatch_items", self.compact)


if __name__ == "__main__":
    unittest.main()
