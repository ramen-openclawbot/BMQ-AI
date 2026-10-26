#!/usr/bin/env python3
"""Contract for material-keyed inventory items and the one-time day-name merge."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261103050000_inventory_item_by_material.sql"
SOURCE_MIGRATION = ROOT / "supabase/migrations/20261102850000_kho_lots_expiry.sql"
MANUAL = ROOT / "supabase/manual/20261026_merge_day_inventory_items.sql"

FUNCTION_NAME = "finalize_goods_receipt_stock_payable_unchecked_20260817"
BEGIN_MARKER = "-- BEGIN canonical-material inventory item lookup (20261103050000)"
END_MARKER = "-- END canonical-material inventory item lookup (20261103050000)"

REFERENCING_TABLES = (
    "goods_receipt_items",
    "inventory_movements",
    "inventory_batches",
    "goods_receipt_auto_issue_items",
    "payment_request_items",
    "invoice_items",
    "order_items",
    "cost_classification_rules",
)


def compact(sql: str) -> str:
    return re.sub(r"\s+", " ", sql.lower())


def function_body(sql: str) -> str:
    lower = sql.lower()
    start = lower.index(f"create or replace function public.{FUNCTION_NAME}(")
    as_pos = sql.index("AS $$", start)
    body_start = as_pos + len("AS $$")
    body_end = sql.index("$$;", body_start)
    return sql[body_start:body_end]


def strip_new_lookup(body: str) -> str:
    start = body.index(BEGIN_MARKER)
    end = body.index(END_MARKER) + len(END_MARKER)
    stripped = body[:start] + body[end:]
    return stripped.replace("  v_material_name text;\n", "", 1)


def strip_old_lookup(body: str) -> str:
    start = body.index("IF v_inventory_item_id IS NULL THEN")
    insert_pos = body.index("INSERT INTO public.inventory_batches (")
    end = body.rindex("END IF;", start, insert_pos) + len("END IF;")
    return body[:start] + body[end:]


def normalized(body: str) -> str:
    return re.sub(r"\s+", " ", body).strip()


class InventoryItemByMaterialContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sql = MIGRATION.read_text(encoding="utf-8")
        cls.source = SOURCE_MIGRATION.read_text(encoding="utf-8")
        cls.manual = MANUAL.read_text(encoding="utf-8")
        cls.compact = compact(cls.sql)
        cls.manual_compact = compact(cls.manual)

    def test_function_keeps_signature_security_and_grants(self) -> None:
        self.assertIn(
            f"create or replace function public.{FUNCTION_NAME}(",
            self.compact,
        )
        self.assertIn(f"{FUNCTION_NAME}( p_receipt_id uuid, p_user_id uuid )", self.compact)
        self.assertIn("returns jsonb", self.compact)
        self.assertIn("language plpgsql", self.compact)
        self.assertIn("security definer", self.compact)
        self.assertIn("set search_path = public", self.compact)
        self.assertIn(
            f"revoke all on function public.{FUNCTION_NAME}(uuid, uuid) "
            "from public, anon, authenticated",
            self.compact,
        )
        self.assertIn(
            f"grant execute on function public.{FUNCTION_NAME}(uuid, uuid) to service_role",
            self.compact,
        )

    def test_exact_name_lookup_precedes_canonical_material_lookup(self) -> None:
        exact_name = self.compact.index("name ilike v_item.product_name")
        material_lookup = self.compact.index("where lower(btrim(name)) = lower(btrim(v_material_name))")
        self.assertLess(exact_name, material_lookup)
        self.assertIn("if v_inventory_item_id is null and v_material_name is not null then", self.compact)
        self.assertIn("v_item.canonical_material_id is not null", self.compact)
        self.assertIn("select m.canonical_name into v_material_name", self.compact)
        self.assertIn(
            "where lower(btrim(name)) = lower(btrim(v_material_name))",
            self.compact,
        )

    def test_insert_uses_canonical_name_with_product_name_fallback(self) -> None:
        self.assertIn("coalesce(v_material_name, v_item.product_name)", self.compact)
        self.assertNotRegex(
            self.compact,
            r"insert into public\.inventory_items \([^)]*\) values \( v_item\.product_name,",
        )

    def test_rest_of_function_body_is_unchanged(self) -> None:
        new_rest = normalized(strip_new_lookup(function_body(self.sql)))
        old_rest = normalized(strip_old_lookup(function_body(self.source)))
        self.assertEqual(old_rest, new_rest)

    def test_manual_script_is_a_single_dry_run_do_block_outside_migrations(self) -> None:
        self.assertEqual(1, len(re.findall(r"\bdo \$\$", self.manual, flags=re.IGNORECASE)))
        self.assertNotIn("create or replace function", self.manual_compact)
        self.assertIn("v_dry_run boolean := true", self.manual_compact)
        self.assertNotIn("migrations", MANUAL.parts)
        self.assertEqual("manual", MANUAL.parent.name)
        self.assertFalse((ROOT / "supabase/migrations" / MANUAL.name).exists())

    def test_manual_only_merges_day_suffixed_names(self) -> None:
        self.assertIn("i.name ~* '(ng[aà]y\\s*[0-9]{1,2}|[^0-9][0-9]{1,2})\\s*$'", self.manual_compact)

    def test_manual_requires_name_without_day_to_match_material(self) -> None:
        self.assertIn("like regexp_replace(lower(btrim(i.name))", self.manual_compact)
        self.assertIn("|| ' %'", self.manual_compact)
        self.assertIn("and min(m.canonical_name) !~ '[0-9]'", self.manual_compact)

    def test_manual_repoints_every_referencing_table(self) -> None:
        for table in REFERENCING_TABLES:
            self.assertRegex(
                self.manual_compact,
                rf"update public\.{table} set inventory_item_id = v_target_id where inventory_item_id = v_r\.id",
            )

    def test_manual_guards_totals_counts_and_dangling_references(self) -> None:
        self.assertIn("if v_quantity_after <> v_quantity_before then", self.manual_compact)
        self.assertIn("raise exception 'abort total inventory quantity changed", self.manual_compact)

        self.assertIn("if v_movements_after <> v_movements_before then", self.manual_compact)
        self.assertIn("abort inventory_movements row count changed", self.manual_compact)
        self.assertIn("if v_batches_after <> v_batches_before then", self.manual_compact)
        self.assertIn("abort inventory_batches row count changed", self.manual_compact)
        self.assertIn(
            "if v_auto_issue_items_after <> v_auto_issue_items_before then",
            self.manual_compact,
        )
        self.assertIn(
            "abort goods_receipt_auto_issue_items row count changed",
            self.manual_compact,
        )

        self.assertIn("still reference deleted inventory_items", self.manual_compact)
        self.assertIn("raise exception 'abort % row(s) still reference deleted inventory_items", self.manual_compact)
        self.assertIn(
            "raise exception 'dry_run ok: merged=%, skipped=%', v_merged, cardinality(v_skipped_ids)",
            self.manual_compact,
        )
        self.assertIn("raise notice 'skipped inventory_items with multiple canonical materials", self.manual_compact)


if __name__ == "__main__":
    unittest.main(verbosity=2)
