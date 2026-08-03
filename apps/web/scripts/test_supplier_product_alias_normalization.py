#!/usr/bin/env python3
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260803041500_supplier_product_alias_normalization.sql"
SCAN_PO = ROOT / "supabase/functions/scan-purchase-order/index.ts"


class SupplierProductAliasNormalizationTest(unittest.TestCase):
    def migration_sql(self) -> str:
        self.assertTrue(MIGRATION.exists(), f"Missing migration: {MIGRATION.name}")
        return MIGRATION.read_text(encoding="utf-8")

    def update_block(self, sql: str, table: str) -> str:
        match = re.search(rf"update\s+public\.{table}\b[\s\S]+?;", sql)
        if match is None:
            self.fail(f"Missing update block for {table}")
        return match.group(0)

    def test_alias_registry_is_supplier_scoped_and_secured(self):
        sql = self.migration_sql()
        self.assertIn("create table if not exists public.supplier_product_aliases", sql.lower())
        self.assertRegex(sql.lower(), r"unique\s*\(\s*supplier_id\s*,\s*normalized_alias\s*\)")
        self.assertIn("enable row level security", sql.lower())
        self.assertIn("normalize_ocr_cost_key", sql)

    def test_all_procurement_item_paths_are_normalized(self):
        sql = self.migration_sql().lower()
        expected_triggers = {
            "purchase_order_items": ("normalize_supplier_purchase_order_item", "purchase_order_id"),
            "payment_request_items": ("normalize_supplier_payment_request_item", "payment_request_id"),
            "goods_receipt_items": ("normalize_supplier_goods_receipt_item", "goods_receipt_id"),
            "invoice_items": ("normalize_supplier_invoice_item", "invoice_id"),
        }
        for table, (trigger, parent_column) in expected_triggers.items():
            self.assertRegex(
                sql,
                rf"drop\s+trigger\s+if\s+exists\s+{trigger}\s+on\s+public\.{table}\s*;",
            )
            self.assertRegex(
                sql,
                rf"create\s+trigger\s+{trigger}\s+before\s+insert\s+or\s+update(?:\s+of\s+[a-z_,\s]+)?\s+on\s+public\.{table}",
            )
            self.assertRegex(
                sql,
                rf"create\s+trigger\s+{trigger}\s+before\s+insert\s+or\s+update\s+of\s+[a-z_,\s]*\b{parent_column}\b[a-z_,\s]*\s+on\s+public\.{table}",
            )
        self.assertIn("supplier_id", sql)
        self.assertIn("sku_id", sql)

    def test_bao_bi_minh_tuan_alias_is_not_global(self):
        sql = self.migration_sql()
        self.assertIn("25130d62-a087-4308-afd0-dfbc7f43daa6", sql)
        self.assertIn("Bao bì nhựa", sql)
        self.assertIn("Bao bánh mì", sql)
        self.assertIn("20e6bf63-32fd-4d46-be55-151dd1629e11", sql)
        self.assertNotRegex(
            sql.lower(),
            r"update\s+public\.[a-z_]+\s+set\s+product_name\s*=\s*'bao bánh mì'\s+where\s+lower\(product_name\)\s*=\s*'bao bì nhựa'\s*;",
        )

    def test_existing_wrong_rows_and_duplicate_sku_are_repaired(self):
        sql = self.migration_sql().lower()
        for table in ("purchase_order_items", "payment_request_items", "goods_receipt_items", "invoice_items"):
            self.assertIn(f"update public.{table}", sql)
        for table, parent, parent_link in (
            ("payment_request_items", "payment_requests", "pr.purchase_order_id"),
            ("goods_receipt_items", "goods_receipts", "gr.purchase_order_id"),
        ):
            block = self.update_block(sql, table)
            self.assertIn(f"from public.{parent}", block)
            self.assertIn("join public.purchase_orders po", block)
            self.assertIn(f"po.id = {parent_link}", block)
            self.assertIn("po.po_number in ('po-000705', 'po-000706')", block)
        invoice_block = self.update_block(sql, "invoice_items")
        self.assertIn("po.id = inv.purchase_order_id", invoice_block)
        self.assertIn("from public.payment_requests pr", invoice_block)
        self.assertIn("pr.id = inv.payment_request_id", invoice_block)
        self.assertIn("pr.purchase_order_id = po.id", invoice_block)
        self.assertIn("from public.goods_receipts gr", invoice_block)
        self.assertIn("gr.id = inv.goods_receipt_id", invoice_block)
        self.assertIn("gr.purchase_order_id = po.id", invoice_block)
        self.assertIn("po.po_number in ('po-000705', 'po-000706')", invoice_block)
        self.assertIn("a3fdfd14-ec17-4ea2-a91a-35993fcdf014", sql)
        self.assertIn("delete from public.product_skus", sql)
        self.assertIn("po-000705", sql)
        self.assertIn("po-000706", sql)

    def test_migration_is_rerunnable_and_trigger_functions_are_not_client_callable(self):
        sql = self.migration_sql().lower()
        self.assertIn("drop policy if exists supplier_product_aliases_authenticated_read", sql)
        for trigger, table in (
            ("normalize_supplier_purchase_order_item", "purchase_order_items"),
            ("normalize_supplier_payment_request_item", "payment_request_items"),
            ("normalize_supplier_goods_receipt_item", "goods_receipt_items"),
            ("normalize_supplier_invoice_item", "invoice_items"),
            ("guard_supplier_product_sku_alias", "product_skus"),
        ):
            self.assertRegex(
                sql,
                rf"drop\s+trigger\s+if\s+exists\s+{trigger}\s+on\s+public\.{table}\s*;",
            )
        self.assertNotRegex(
            sql,
            r"grant\s+execute\s+on\s+function\s+public\.(normalize_supplier_procurement_item|guard_supplier_product_sku_alias)\(\)\s+to\s+[^;]*(authenticated|service_role)",
        )
        for function_name in ("normalize_supplier_procurement_item", "guard_supplier_product_sku_alias"):
            self.assertIn(f"revoke all on function public.{function_name}() from public", sql)
            self.assertIn(f"revoke all on function public.{function_name}() from anon", sql)
            self.assertIn(f"revoke all on function public.{function_name}() from authenticated", sql)
            self.assertIn(f"revoke all on function public.{function_name}() from service_role", sql)

    def test_po_ocr_prompt_requires_literal_transcription(self):
        source = SCAN_PO.read_text(encoding="utf-8")
        self.assertIn("chép nguyên văn tên hàng", source.lower())
        self.assertIn("không được suy diễn chất liệu", source.lower())
        self.assertIn("Bao bánh mì", source)
        self.assertIn("Bao bì nhựa", source)


if __name__ == "__main__":
    unittest.main()
