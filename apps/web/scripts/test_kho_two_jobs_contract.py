#!/usr/bin/env python3
"""Static contract checks for 20261102500000_kho_two_jobs.sql.

These checks never connect to a database.  They guard the data layer of the
two-job warehouse game: the shared gate, rename/change bodies that only differ
in that gate, a list RPC with exactly two ledger calls, save validation before
writes, and count RPCs that reuse the submit_stock_count per-line functions.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
MIGRATION = MIGRATIONS / "20261102500000_kho_two_jobs.sql"
SOURCE = MIGRATIONS / "20261023100000_warehouse_game.sql"

FUNCTIONS = (
    "kho_item_can_edit(uuid)",
    "rename_stock_item(uuid, text, uuid)",
    "change_stock_item_unit(uuid, text, numeric, uuid)",
    "kho_get_items()",
    "kho_save_item(uuid, text, text, boolean, numeric, boolean, uuid)",
    "kho_count_item(text, uuid, numeric, uuid)",
)
LINE_TABLES = (
    "purchase_order_items",
    "payment_request_items",
    "goods_receipt_items",
    "invoice_items",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def canon(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def extract_function(text: str, marker: str) -> str:
    start = text.index(marker)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    end = text.index(tag + ";", start + match.end())
    return text[start : end + len(tag) + 1]


def first_write(body: str) -> int:
    matches = [
        match.start()
        for match in re.finditer(
            r"\b(?:insert\s+into|update|delete\s+from|perform)\b", body, re.IGNORECASE
        )
    ]
    return min(matches) if matches else len(body)


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. every function exists with the same security envelope ---------
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
    assert_true(
        "stable" in extract_function(
            migration, "create or replace function public.kho_item_can_edit("
        ).lower(),
        "kho_item_can_edit must be STABLE",
    )

    # --- 2. rename/change bodies only differ in the gate ------------------
    source = read(SOURCE)
    for marker in (
        "create or replace function public.rename_stock_item(",
        "create or replace function public.change_stock_item_unit(",
    ):
        original = canon(extract_function(source, marker))
        expected = original.replace(
            "public.q7_material_inventory_can_edit(v_actor)",
            "public.kho_item_can_edit(v_actor)",
        )
        current = canon(extract_function(migration, marker))
        assert_true(
            current == expected,
            f"{marker} must differ from the live body only in kho_item_can_edit",
        )
        assert_true(
            "public.kho_item_can_edit(v_actor)" in current,
            "the redefined gate must call kho_item_can_edit",
        )

    # --- 3. kho_get_items: two ledger calls, no per-item loop -------------
    get_items = extract_function(
        migration, "create or replace function public.kho_get_items("
    ).lower()
    assert_true(
        get_items.count("public.get_stock_ledger_overview(") == 2,
        "kho_get_items must call get_stock_ledger_overview exactly twice",
    )
    assert_true(
        "'tan_tao', current_date" in get_items and "'q7', current_date" in get_items,
        "the two ledger calls must be tan_tao and q7 for current_date",
    )
    assert_true(
        re.search(r"\bfor\b[\s\S]*?\bloop\b", get_items) is None,
        "kho_get_items must not loop per item",
    )
    assert_true(
        "stock_count_lines" in get_items and "stock_count_sessions" in get_items,
        "pending counts must come from the open count lines",
    )
    assert_true(
        "doc_lines" in get_items and "stock_material_aliases" in get_items,
        "doc_lines must use the receipt-line alias join once",
    )

    # --- 4. kho_save_item: validation before every write ------------------
    save = extract_function(
        migration, "create or replace function public.kho_save_item("
    )
    save_lower = save.lower()
    write_at = first_write(save)
    for needle in ("'name_taken'", "'unit_factor_needed'"):
        for match in re.finditer(re.escape(needle), save_lower):
            assert_true(
                match.start() < write_at,
                f"{needle} must be returned before any perform/insert/update",
            )
    assert_true(
        save_lower.index("'name_taken'") < save_lower.index("public.apply_stock_item_merge("),
        "name_taken must be returned before the merge write",
    )
    assert_true(
        save_lower.index("'unit_factor_needed'") < save_lower.index("public.rename_stock_item("),
        "unit_factor_needed must be returned before the first edit write",
    )
    for call in (
        "public.rename_stock_item(",
        "public.change_stock_item_unit(",
        "public.apply_stock_item_merge(",
        "public.discontinue_stock_item(",
        "public.reactivate_stock_item(",
    ):
        assert_true(call in save_lower, f"kho_save_item must call {call}")
    assert_true(
        "'kho_save_item'" in save_lower
        and "from public.warehouse_game_requests" in save_lower
        and "insert into public.warehouse_game_requests" in save_lower,
        "kho_save_item must store and replay its result",
    )
    assert_true(
        "md5(p_request_id::text || ':unit')::uuid" in save_lower,
        "change_stock_item_unit must get a derived request id",
    )
    assert_true(
        "'tắt trong game kho'" in save_lower,
        "discontinue_stock_item must get the game reason",
    )
    assert_true(
        "alter table public.warehouse_game_requests" in lower
        and "'kho_save_item'" in lower,
        "warehouse_game_requests constraint must allow kho_save_item",
    )

    # --- 5. kho_count_item: per-line RPCs, no session work ----------------
    count = extract_function(
        migration, "create or replace function public.kho_count_item("
    ).lower()
    assert_true(
        "public.record_q7_stock_count(" in count
        and "public.record_tan_tao_material_count(" in count,
        "kho_count_item must call both existing per-line count RPCs",
    )
    assert_true(
        "'kho-count:' || p_request_id" in count,
        "the idempotency key must be kho-count plus the request id",
    )
    assert_true(
        "stock_count_sessions" not in count
        and "submit_stock_count" not in count
        and "insert into" not in count,
        "kho_count_item must not open/submit a session or insert anything",
    )
    assert_true(
        "v_item.pastry_q7" in count and "'item_not_in_location'" in count,
        "Q7 must reject an item that is not in Q7",
    )
    assert_true(
        "'item_inactive'" in count and "'invalid_quantity'" in count,
        "kho_count_item must validate active and quantity",
    )

    # --- 6. no DELETE and no direct document-line write ------------------
    assert_true(re.search(r"\bdelete\s+from\b", lower) is None, "migration must not DELETE")
    for table in LINE_TABLES:
        assert_true(
            re.search(rf"\b(?:insert\s+into|update)\s+public\.{table}\b", lower) is None,
            f"migration must not write public.{table} directly",
        )

    print("PASS: kho two-jobs contracts hold")


if __name__ == "__main__":
    main()
