#!/usr/bin/env python3
"""Static contract checks for 20261102560000_kho_unit_conversions.sql.

No database connection. These checks guard the data layer of the per-item unit
dialog:
  * D-G exist with the same SECURITY DEFINER / search_path envelope;
  * the write RPCs use kho_item_can_edit (or service_role) and replay;
  * both ledger source CHECK constraints keep every old value + unit_factor_fix;
  * no DELETE and no write to goods_receipt_items / goods_receipts / documents;
  * the preserved functions are not redefined here;
  * anon cannot execute the new RPCs and cannot write the new tables.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102560000_kho_unit_conversions.sql"

FUNCTIONS = (
    "kho_get_units()",
    "kho_add_stock_unit(text, uuid)",
    "kho_get_item_conversions(uuid)",
    "kho_set_item_conversion(uuid, text, numeric, boolean, uuid)",
)

Q7_SOURCES = (
    "manual_receipt",
    "signed_q7_issue",
    "manual_adjustment",
    "goods_receipt",
    "production_material_issue",
    "production_material_issue_reversal",
    "item_merge",
    "item_merge_revert",
    "stock_transfer",
)

TAN_TAO_SOURCES = (
    "goods_receipt",
    "manual_adjustment",
    "item_merge",
    "item_merge_revert",
    "stock_transfer",
    "production",
)

PRESERVED = (
    "create or replace function public.post_stock_goods_receipt_item(",
    "create or replace function public.change_stock_item_unit(",
    "create or replace function public.kho_save_item(",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def extract_function(text: str, marker: str) -> str:
    start = text.index(marker)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    end = text.index(tag + ";", start + match.end())
    return text[start : end + len(tag) + 1]


def source_values(text: str, constraint: str) -> str:
    start = text.index(f"add constraint {constraint}")
    end = text.index(");", start)
    return text[start:end]


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. D-G exist with the security envelope --------------------------
    for signature in FUNCTIONS:
        name = signature.split("(")[0]
        marker = f"create or replace function public.{name}("
        assert_true(marker in lower, f"missing function {signature}")
        body = extract_function(migration, marker)
        body_lower = body.lower()
        assert_true("security definer" in body_lower, f"{name} must be SECURITY DEFINER")
        assert_true(
            "set search_path = public, pg_temp" in body_lower,
            f"{name} must pin search_path = public, pg_temp",
        )
        assert_true(
            f"revoke all on function public.{signature} from public, anon" in lower,
            f"{signature} must revoke public/anon",
        )
        assert_true(
            f"grant execute on function public.{signature} to authenticated, service_role"
            in lower,
            f"{signature} must grant authenticated/service_role",
        )

    # --- 2. the write RPCs gate on kho_item_can_edit / service_role --------
    for marker in (
        "create or replace function public.kho_add_stock_unit(",
        "create or replace function public.kho_set_item_conversion(",
    ):
        body = extract_function(migration, marker)
        body_lower = body.lower()
        assert_true(
            "public.kho_item_can_edit(" in body_lower,
            f"{marker} must call kho_item_can_edit",
        )
        assert_true(
            "coalesce(auth.role(), '') <> 'service_role'" in body_lower,
            f"{marker} must allow service_role",
        )
        assert_true(
            "'unit_forbidden'" in body_lower and "errcode = '42501'" in body_lower,
            f"{marker} must raise unit_forbidden with 42501",
        )

    read_gate = extract_function(
        migration, "create or replace function public.kho_get_item_conversions("
    ).lower()
    for needle in (
        "q7_material_inventory_can_view",
        "stock_count_can_view('tan_tao')",
        "stock_count_can_view('q7')",
        "kho_item_can_edit",
        "insufficient_privilege",
    ):
        assert_true(needle in read_gate, f"kho_get_item_conversions must gate on {needle}")

    # --- 3. replay actions -------------------------------------------------
    add = extract_function(
        migration, "create or replace function public.kho_add_stock_unit("
    ).lower()
    for needle in (
        "pg_advisory_xact_lock",
        "from public.warehouse_game_requests",
        "insert into public.warehouse_game_requests",
        "'kho_add_unit'",
    ):
        assert_true(needle in add, f"kho_add_stock_unit must contain {needle}")

    save = extract_function(
        migration, "create or replace function public.kho_set_item_conversion("
    ).lower()
    for needle in (
        "pg_advisory_xact_lock",
        "from public.warehouse_game_requests",
        "insert into public.warehouse_game_requests",
        "'kho_set_conversion'",
    ):
        assert_true(needle in save, f"kho_set_item_conversion must contain {needle}")

    action_block = migration[
        migration.index("warehouse_game_requests_action_check") :
    ]
    action_block = action_block[: action_block.index(");")]
    for action in (
        "rename",
        "change_unit",
        "set_item_pastry_q7",
        "kho_save_item",
        "kho_add_unit",
        "kho_set_conversion",
    ):
        assert_true(f"'{action}'" in action_block, f"warehouse_game_requests must allow {action}")

    # --- 4. source CHECK constraints keep every old value + the new one ----
    q7_block = source_values(migration, "q7_inventory_movements_source_check")
    for source in Q7_SOURCES + ("unit_factor_fix",):
        assert_true(f"'{source}'" in q7_block, f"q7 source check lost {source}")

    tt_block = source_values(migration, "tan_tao_material_movements_source_check")
    for source in TAN_TAO_SOURCES + ("unit_factor_fix",):
        assert_true(f"'{source}'" in tt_block, f"tan_tao source check lost {source}")

    # --- 5. no DELETE, no document write, preserved bodies ----------------
    assert_true(re.search(r"\bdelete\s+from\b", lower) is None, "migration must not DELETE")
    for table in ("goods_receipt_items", "goods_receipts", "documents"):
        assert_true(
            re.search(
                rf"\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?{table}\b",
                lower,
            )
            is None,
            f"migration must not write {table}",
        )
    for marker in PRESERVED:
        assert_true(marker not in migration, f"must not redefine {marker}")

    # --- 6. new tables, RLS and no client write ---------------------------
    assert_true(
        "create table if not exists public.stock_item_unit_factors" in lower,
        "missing stock_item_unit_factors",
    )
    assert_true(
        "create table if not exists public.stock_unit_events" in lower,
        "missing stock_unit_events",
    )
    for table in ("stock_item_unit_factors", "stock_unit_events"):
        assert_true(
            f"alter table public.{table} enable row level security" in lower,
            f"{table} must enable RLS",
        )
        assert_true(
            re.search(
                rf"grant\s+(?:insert|update|delete)[^;]*on table public\.{table}[^;]*to[^;]*authenticated",
                lower,
            )
            is None,
            f"{table} must not grant writes to authenticated",
        )
    assert_true(
        "for select to authenticated using (true)" in lower,
        "stock_item_unit_factors needs a select policy for authenticated",
    )
    assert_true(
        re.search(
            r"grant[^;]*on table public\.stock_unit_events[^;]*to[^;]*authenticated",
            lower,
        )
        is None,
        "stock_unit_events must not grant anything to authenticated",
    )
    assert_true(
        re.search(
            r"create policy stock_item_unit_factors_select[\s\S]*?for select to authenticated",
            lower,
        )
        is not None,
        "stock_item_unit_factors select policy must target authenticated",
    )
    factors_block = lower[
        lower.index("create table if not exists public.stock_item_unit_factors") :
    ]
    factors_block = factors_block[: factors_block.index(");")]
    assert_true("factor > 0" in factors_block, "factor must be checked > 0")

    # --- 7. kho_add_stock_unit behaviour ---------------------------------
    for needle in (
        "'unit_label_invalid'",
        "'unit_is_measure'",
        "'exists'",
        "'created'",
        "public.normalize_stock_unit(",
        "'count'",
        "'kilo'",
        "'gam'",
        "'mililit'",
        "'cc'",
        "insert into public.stock_unit_events",
    ):
        assert_true(needle in add, f"kho_add_stock_unit must contain {needle}")

    # --- 8. kho_get_item_conversions payload -----------------------------
    for needle in (
        "public.normalize_document_unit(",
        "public.stock_material_aliases",
        "a.line_class = 'stock'",
        "public.stock_unit_line_factor(",
        "'factors'",
        "'disagree'",
        "'auto'",
        "'supplier_names'",
        "'line_count'",
        "'posted_count'",
        "'last_receipt_date'",
        "'gr-item:'",
        "'saved'",
        "'can_edit'",
        "'cutover'",
    ):
        assert_true(needle in read_gate, f"kho_get_item_conversions must contain {needle}")

    # --- 9. kho_set_item_conversion behaviour ----------------------------
    for needle in (
        "'invalid_factor'",
        "'unit_auto'",
        "public.goods_receipt_effective_quantity(",
        "public.stock_unit_line_factor(",
        "public.stock_unit_pack_factor(",
        "public.stock_transfers",
        "'preview'",
        "'saved'",
        "'saved_only'",
        "'unit_factor_fix'",
        "'unit-fix:'",
        "public.material_alias_events",
        "'correct'",
        "public.stock_item_unit_factors",
        "on conflict do nothing",
    ):
        assert_true(needle in save, f"kho_set_item_conversion must contain {needle}")

    assert_true(
        "p_factor > 1000000" in save,
        "the factor must be capped at 1,000,000",
    )
    assert_true(
        "abs(v_delta) < 0.0005" in save,
        "the ledger correction must skip a delta below 0.0005",
    )
    preview_at = save.index("'preview'")
    alias_update_at = save.index("update public.stock_material_aliases")
    assert_true(
        preview_at < alias_update_at,
        "the dry run must return before any alias update",
    )
    dry_guard_at = save.index("if v_dry then")
    first_insert_at = save.index("insert into public.q7_inventory_movements")
    assert_true(
        dry_guard_at < first_insert_at,
        "the dry run must guard the ledger inserts",
    )

    print("PASS: kho unit-conversion contracts hold")


if __name__ == "__main__":
    main()
