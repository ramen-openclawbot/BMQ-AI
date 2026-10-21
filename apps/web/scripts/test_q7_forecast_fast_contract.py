#!/usr/bin/env python3
"""Static contract for the fast Q7 purchase forecast migration.

These checks never connect to a database, never run the migration and never
touch a business table. They guard that the new
``*q7_purchase_forecast_fast*.sql``:
  * is the newest migration by timestamp;
  * recreates public.get_q7_purchase_forecast exactly once with the same
    signature, SECURITY DEFINER, pinned search_path and grants;
  * computes the open-PO quantity and latest-price maps once before the item
    loop, normalizing each PO/PR product name exactly once in a materialized
    CTE, and no longer scans aliases with a cross join lateral inside the loop;
  * never writes to a business table.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"

FAST_GLOB = "*q7_purchase_forecast_fast*.sql"
CREATE = "create or replace function public.get_q7_purchase_forecast("


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    matches = sorted(MIGRATIONS.glob(FAST_GLOB))
    assert_true(bool(matches), f"missing migration matching {FAST_GLOB}")
    migration_path = matches[-1]
    migration = migration_path.read_text(encoding="utf-8")
    lower_migration = migration.lower()

    # The new file must sort after every existing migration.
    stamps = sorted(
        path.name[:14]
        for path in MIGRATIONS.glob("*.sql")
        if path.name[:14].isdigit() and path != migration_path
    )
    assert_true(
        migration_path.name[:14].isdigit(),
        f"{migration_path.name} must start with a 14-digit timestamp",
    )
    assert_true(
        migration_path.name[:14] > max(stamps, default=""),
        f"{migration_path.name} must have a newer timestamp than every existing migration",
    )

    assert_true(
        lower_migration.count(CREATE) == 1,
        "exactly one CREATE OR REPLACE for the function",
    )
    start = lower_migration.index(CREATE)
    end = migration.index("$$;", start)
    function = migration[start:end]
    lower_function = function.lower()

    # Same function contract as the base definition.
    assert_true(
        "p_as_of date default null" in lower_function
        and "p_horizon_days integer default 14" in lower_function,
        "get_q7_purchase_forecast must keep its (date, integer) signature",
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
        "revoke all on function public.get_q7_purchase_forecast(date, integer) "
        "from public, anon;" in migration,
        "must keep the existing revoke",
    )
    assert_true(
        "grant execute on function public.get_q7_purchase_forecast(date, integer) "
        "to authenticated, service_role;" in migration,
        "must keep the existing grants",
    )

    # The item loop must only read the precomputed maps.
    loop_start = lower_function.index("for v_item in")
    # The item loop also contains a nested WHILE; its end is the last end loop.
    loop_end = lower_function.rindex("end loop;")
    loop_body = lower_function[loop_start:loop_end]
    assert_true(
        "cross join lateral" not in loop_body,
        "the item loop must not scan aliases with a cross join lateral",
    )
    assert_true(
        "normalize_stock_item_name(" not in loop_body,
        "the item loop must not normalize PO/PR product names per item",
    )
    assert_true(
        "purchase_order_items" not in loop_body
        and "payment_request_items" not in loop_body
        and "stock_material_aliases" not in loop_body,
        "the item loop must not query PO/PR lines or aliases per item",
    )
    assert_true(
        "v_open_po := coalesce((v_open_po_map" in loop_body,
        "open PO quantity must be read from the precomputed map",
    )
    assert_true(
        "v_price := (v_price_map" in loop_body,
        "last unit price must be read from the precomputed map",
    )

    # One normalization per PO/PR row, both before the loop, in materialized CTEs.
    prelude = lower_function[:loop_start]
    assert_true(
        lower_function.count("normalize_stock_item_name(") == 2,
        "product names must be normalized exactly twice (PO and PR)",
    )
    assert_true(
        prelude.count("normalize_stock_item_name(") == 2,
        "PO and PR product names must each be normalized once before the loop",
    )
    assert_true(
        "po_lines as materialized" in lower_function,
        "PO lines must be materialized before alias matching",
    )
    assert_true(
        "pr_lines as materialized" in lower_function,
        "PR lines must be materialized before alias matching",
    )
    assert_true(
        "cross join lateral" not in lower_function,
        "the function must not use a cross join lateral",
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
            forbidden not in lower_migration,
            f"migration must not contain {forbidden!r}",
        )

    print("PASS: fast Q7 purchase forecast contract holds")


if __name__ == "__main__":
    main()
