#!/usr/bin/env python3
"""Static contract for the Tân Tạo pass_through stock-ledger migration.

These checks never connect to a database, never run the migration and never
touch a business table. They guard that the new
``*_stock_ledger_overview_passthrough*.sql``:
  * has a timestamp newer than the 20261102400000 tip it follows;
  * recreates public.get_stock_ledger_overview with the same signature, STABLE,
    SECURITY DEFINER and pinned search_path, and restates the existing grants;
  * adds pass_through to the Tân Tạo ``materials`` element only, sourced from
    kitchen_inventory_items.pastry_q7 with false when null, and makes
    is_low_stock false whenever pass_through is true;
  * leaves the Q7 ``items`` low-stock expression untouched and never writes to a
    business table or movement ledger.

It also checks the TypeScript type/parser/filter and its regression test cover
the flag, so the robot and Sổ tồn keep agreeing with the ledger.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
TS = ROOT / "src" / "lib" / "stock-ledger.ts"
TS_TEST = ROOT / "src" / "lib" / "stock-ledger.test.ts"

PASSTHROUGH_GLOB = "*stock_ledger_overview_passthrough*.sql"
BASE_TIMESTAMP = "20261102400000"
LOW_STOCK = "(x.out_qty_7d > 0 and x.balance_qty < (x.out_qty_7d / 7.0) * 3)"
PASSTHROUGH_LOW_STOCK = (
    "(not x.pass_through and x.out_qty_7d > 0 "
    "and x.balance_qty < (x.out_qty_7d / 7.0) * 3)"
)


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    matches = sorted(MIGRATIONS.glob(PASSTHROUGH_GLOB))
    assert_true(bool(matches), f"missing migration matching {PASSTHROUGH_GLOB}")
    migration_path = matches[-1]
    migration = migration_path.read_text(encoding="utf-8")

    # The new file must sort after the migration it replaces.
    assert_true(
        migration_path.name[:14] > BASE_TIMESTAMP,
        f"{migration_path.name} must have a timestamp newer than {BASE_TIMESTAMP}",
    )

    start = migration.lower().index(
        "create or replace function public.get_stock_ledger_overview("
    )
    end = migration.index("$$;", start)
    function = migration[start:end]
    lower_function = function.lower()

    # Same function contract as the base definition.
    assert_true(
        "p_location text" in lower_function
        and "p_as_of date default current_date" in lower_function,
        "get_stock_ledger_overview must keep its (text, date) signature",
    )
    assert_true("returns jsonb" in lower_function, "must still return jsonb")
    assert_true("language plpgsql" in lower_function, "must stay plpgsql")
    assert_true("stable" in lower_function, "must stay STABLE")
    assert_true(
        "security definer" in lower_function, "must stay SECURITY DEFINER"
    )
    assert_true(
        "set search_path = public, pg_temp" in lower_function,
        "must pin search_path = public, pg_temp",
    )
    assert_true(
        migration.lower().count(
            "create or replace function public.get_stock_ledger_overview("
        )
        == 1,
        "exactly one CREATE OR REPLACE for the function",
    )
    assert_true(
        "revoke all on function public.get_stock_ledger_overview(text, date) "
        "from public, anon;" in migration,
        "must keep the existing revoke",
    )
    assert_true(
        "grant execute on function public.get_stock_ledger_overview(text, date) "
        "to authenticated, service_role;" in migration,
        "must keep the existing grants",
    )

    # The pass_through field exists only on Tân Tạo materials.
    assert_true(
        "'pass_through', x.pass_through" in function,
        "materials elements must expose pass_through",
    )
    assert_true(
        "coalesce(kii.pastry_q7, false) as pass_through" in function,
        "pass_through must come from kitchen_inventory_items.pastry_q7 (false when null)",
    )
    assert_true(
        function.count("pass_through") == 4,
        "pass_through must appear exactly in the materials build, source, "
        "and low-stock guard",
    )
    assert_true(
        PASSTHROUGH_LOW_STOCK in function,
        "materials is_low_stock must be false when pass_through is true",
    )

    # Q7 items and the Tân Tạo finished-goods items keep the old expression.
    q7_branch = function.split("v_location_name := 'Kho Tân Tạo';")[0]
    assert_true(
        "pass_through" not in q7_branch,
        "the Q7 branch must not gain pass_through",
    )
    assert_true(
        function.count(LOW_STOCK) == 2,
        "Q7 items and Tân Tạo finished-goods items must keep the old is_low_stock",
    )

    # Read-only migration: no data, movement or stock-count writes.
    for forbidden in (
        "insert into",
        "update public.",
        "delete from",
        "truncate",
        "drop table",
        "alter table",
    ):
        assert_true(
            forbidden not in migration.lower(),
            f"migration must not contain {forbidden!r}",
        )

    # TypeScript surface and the regression test.
    ts = TS.read_text(encoding="utf-8")
    assert_true(
        "pass_through?: boolean;" in ts,
        "StockLedgerMaterial must declare optional pass_through",
    )
    assert_true(
        "pass_through: material.pass_through === true" in ts,
        "the parser must read pass_through and default it to false",
    )
    assert_true(
        '!("pass_through" in row && row.pass_through === true)' in ts,
        "lowStockList must skip pass_through rows",
    )

    ts_test = TS_TEST.read_text(encoding="utf-8")
    assert_true(
        "pass_through: true" in ts_test,
        "the test must cover a material with pass_through true",
    )
    assert_true(
        "Bánh mì Q7" in ts_test,
        "the Tân Tạo low-stock test must include the pass-through material",
    )

    print("PASS: stock ledger overview passthrough contract holds")


if __name__ == "__main__":
    main()
