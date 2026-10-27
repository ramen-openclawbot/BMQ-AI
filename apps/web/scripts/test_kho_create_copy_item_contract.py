#!/usr/bin/env python3
"""Contract for public.kho_create_item (create / copy one Kho item, server side)."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261103060000_kho_create_copy_item.sql"
FUNCTION_NAME = "kho_create_item"
SIGNATURE = (
    "( p_name text, p_unit text, p_class text, p_tan_tao boolean, p_q7 boolean, "
    "p_note text, p_copy_from uuid, p_request_id uuid )"
)

ERROR_CODES = (
    "insufficient_privilege",
    "invalid_name",
    "item_name_duplicate",
    "unit_not_allowed",
    "invalid_class",
    "kho_location_required",
    "invalid_note",
    "item_not_found",
    "request_id_required",
)

FORBIDDEN_WRITES = (
    "tan_tao_material_movements",
    "q7_inventory_movements",
    "stock_material_aliases",
    "q7_material_issue_material_mappings",
)


def compact(sql: str) -> str:
    return re.sub(r"\s+", " ", sql.lower())


def function_body(sql: str) -> str:
    lower = sql.lower()
    start = lower.index(f"create or replace function public.{FUNCTION_NAME}(")
    as_pos = sql.index("as $$", start)
    body_start = as_pos + len("as $$")
    body_end = sql.index("$$;", body_start)
    return sql[body_start:body_end]


class KhoCreateCopyItemContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sql = MIGRATION.read_text(encoding="utf-8")
        cls.body = function_body(cls.sql)
        cls.compact = compact(cls.sql)
        cls.body_compact = compact(cls.body)

    def test_signature_security_and_search_path(self) -> None:
        self.assertIn(
            f"create or replace function public.{FUNCTION_NAME}{SIGNATURE}",
            self.compact,
        )
        self.assertIn("returns jsonb", self.compact)
        self.assertIn("language plpgsql", self.compact)
        self.assertIn("security definer", self.compact)
        self.assertIn("set search_path = public, pg_temp", self.compact)

    def test_permission_requires_actor_and_material_alias_can_admin(self) -> None:
        self.assertIn("v_actor uuid := auth.uid()", self.body_compact)
        self.assertIn("public.material_alias_can_admin(v_actor)", self.body_compact)
        self.assertIn("auth.role()", self.body_compact)
        self.assertIn("service_role", self.body_compact)
        self.assertIn("raise exception 'insufficient_privilege' using errcode = '42501'", self.body_compact)
        # The permission check must come before the idempotent replay lookup.
        self.assertLess(
            self.body_compact.index("material_alias_can_admin(v_actor)"),
            self.body_compact.index("warehouse_game_requests"),
        )

    def test_every_new_error_code_is_raised(self) -> None:
        for code in ERROR_CODES:
            self.assertRegex(
                self.body_compact,
                rf"raise exception '{code}' using errcode = '[0-9a-z]+'",
                code,
            )

    def test_duplicate_name_uses_the_same_key_as_kho_save_item(self) -> None:
        self.assertIn("public.kho_item_name_key(v_name)", self.body_compact)
        self.assertIn(
            "public.kho_item_name_key(k.name) = v_name_key", self.body_compact
        )
        self.assertIn("k.active = true", self.body_compact)
        self.assertIn("k.merged_into_id is null", self.body_compact)

    def test_idempotency_uses_warehouse_game_requests(self) -> None:
        self.assertIn(
            "pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text))",
            self.body_compact,
        )
        self.assertIn("from public.warehouse_game_requests r", self.body_compact)
        self.assertIn("r.action = 'kho_create_item'", self.body_compact)
        self.assertIn("insert into public.warehouse_game_requests", self.body_compact)
        self.assertIn("values (p_request_id, 'kho_create_item'", self.body_compact)
        # The action list of the idempotency table must accept the new value.
        self.assertIn("'kho_create_item'", self.compact)
        self.assertIn("warehouse_game_requests_action_check", self.compact)

    def test_copy_reads_source_and_copies_only_definition_data(self) -> None:
        self.assertIn("from public.kitchen_inventory_items k", self.body_compact)
        self.assertIn("k.id = p_copy_from", self.body_compact)
        self.assertIn("k.merged_into_id is null", self.body_compact)
        self.assertIn("v_source.item_class", self.body_compact)
        self.assertIn("v_source.in_tan_tao", self.body_compact)
        self.assertIn("v_source.pastry_q7", self.body_compact)
        self.assertIn("v_source.note", self.body_compact)
        self.assertIn("insert into public.stock_item_unit_factors", self.body_compact)
        self.assertIn("attp_profile = v_source.attp_profile", self.body_compact)

    def test_copy_does_not_touch_stock_ledgers_aliases_mappings_or_canonical_link(self) -> None:
        for table in FORBIDDEN_WRITES:
            self.assertNotRegex(
                self.body_compact,
                rf"insert\s+into\s+public\.{table}\b",
                table,
            )
        self.assertNotIn("canonical_material_id", self.body_compact)

    def test_item_insert_leaves_the_code_to_the_existing_trigger(self) -> None:
        columns = re.search(
            r"insert into public\.kitchen_inventory_items \((.*?)\) values",
            self.body_compact,
        )
        self.assertIsNotNone(columns)
        assert columns is not None
        self.assertNotIn("item_code", columns.group(1))
        self.assertNotIn("kho_next_item_code", self.body_compact)
        self.assertIn("'ingredient'", self.body_compact)
        self.assertIn("'manual:' || v_name_key", self.body_compact)
        self.assertIn("'owner'", self.body_compact)

    def test_result_shape_and_grants(self) -> None:
        self.assertIn("'status', 'created'", self.body_compact)
        self.assertIn("'item_id', v_item_id", self.body_compact)
        self.assertIn("'item_code', v_item_code", self.body_compact)
        self.assertIn("'in_tan_tao', v_tan_tao", self.body_compact)
        self.assertIn("'in_q7', v_q7", self.body_compact)
        self.assertIn("'copied_from', p_copy_from", self.body_compact)

        self.assertIn(
            "revoke all on function public.kho_create_item("
            "text, text, text, boolean, boolean, text, uuid, uuid) from public, anon",
            self.compact,
        )
        self.assertIn(
            "grant execute on function public.kho_create_item("
            "text, text, text, boolean, boolean, text, uuid, uuid) to authenticated",
            self.compact,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
