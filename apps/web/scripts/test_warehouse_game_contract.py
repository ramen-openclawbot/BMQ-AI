#!/usr/bin/env python3
"""Static contract checks for the Kho 2D warehouse-game migration.

These checks never connect to a database or Supabase. They guard that migration
20261023100000_warehouse_game.sql:
  * defines public.get_warehouse_game_snapshot(text) as a STABLE SECURITY DEFINER
    RPC with a pinned search_path, the same reader gate as
    public.get_stock_ledger_overview, the backlog review call and the
    unclassified item-class counts;
  * defines public.rename_stock_item(uuid, text, uuid) and
    public.change_stock_item_unit(uuid, text, numeric, uuid) as SECURITY DEFINER
    RPCs with a pinned search_path and every documented error code;
  * creates public.warehouse_game_requests with RLS and explicit grants, and uses
    it for idempotency;
  * writes the rename audit row and moves the unit with
    public.apply_stock_item_merge + public.stock_unit_conversions without ever
    rewriting the append-only ledgers or any purchase / payment / receipt table.
It also checks the rollback-only smoke test inlines the migration.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261023100000_warehouse_game.sql"
SMOKE = SCRIPTS / "smoke_warehouse_game.sql"

SNAPSHOT = "function public.get_warehouse_game_snapshot("
RENAME = "function public.rename_stock_item("
CHANGE = "function public.change_stock_item_unit("
GUARD = "function public.kitchen_inventory_items_unit_guard("


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def body_after(text: str, marker: str) -> str:
    """Return the SQL from marker to the end of that function ($;$)."""
    start = text.index(marker)
    end = text.index("$$;", start)
    return text[start:end]


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261023100000_warehouse_game.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    def assert_security_definer(marker: str, signature: str) -> str:
        body = body_after(lower, marker)
        assert_true("security definer" in body, f"{signature} must be SECURITY DEFINER")
        assert_true(
            "set search_path = public, pg_temp" in body,
            f"{signature} must pin search_path = public, pg_temp",
        )
        assert_true(
            f"revoke all on function public.{signature} from public, anon" in lower,
            f"{signature} must revoke default execute from public/anon",
        )
        assert_true(
            f"grant execute on function public.{signature} to authenticated, service_role" in lower,
            f"{signature} must grant execute to authenticated, service_role",
        )
        return body

    # --- 1. snapshot RPC -----------------------------------------------------
    assert_true(SNAPSHOT in lower, "migration must define get_warehouse_game_snapshot")
    snapshot = assert_security_definer(SNAPSHOT, "get_warehouse_game_snapshot(text)")
    assert_true("stable" in snapshot, "get_warehouse_game_snapshot must be STABLE")
    assert_true(
        "p_location not in ('q7', 'tan_tao')" in snapshot
        and "'unsupported_location'" in snapshot,
        "the snapshot must only accept q7 / tan_tao",
    )
    assert_true(
        "public.q7_material_inventory_can_view(v_actor)" in snapshot
        and "public.can_view_tan_tao_warehouse()" in snapshot,
        "the snapshot must use the same reader gate as get_stock_ledger_overview",
    )
    assert_true(
        "public.stock_ledger_cutover_date(p_location)" in snapshot,
        "the snapshot must return the location cutover date",
    )
    assert_true(
        "public.get_material_alias_backlog_review(p_location, 200)" in snapshot,
        "the snapshot must call get_material_alias_backlog_review(p_location, 200)",
    )
    assert_true(
        "merged_into_id is null" in snapshot,
        "the snapshot items must be the live unmerged catalog",
    )
    assert_true(
        "q7_inventory_movements" in snapshot and "tan_tao_material_movements" in snapshot,
        "the snapshot on_hand must read the location ledger",
    )
    assert_true(
        "tan_tao_warehouse_movements" in snapshot and "finished_good" in snapshot,
        "the Tân Tạo skus must read product_skus + tan_tao_warehouse_movements",
    )
    assert_true(
        "'unclassified'" in snapshot,
        "a null item_class must be returned as unclassified",
    )
    assert_true(
        "jsonb_object_agg" in snapshot,
        "the snapshot must return the item-class counts",
    )
    assert_true(
        "public.q7_material_inventory_can_edit(v_actor)" in snapshot,
        "the snapshot must return can_edit",
    )

    # --- 2. rename RPC -------------------------------------------------------
    assert_true(RENAME in lower, "migration must define rename_stock_item")
    rename = assert_security_definer(RENAME, "rename_stock_item(uuid, text, uuid)")
    for code in ("rename_forbidden", "invalid_name", "item_not_found", "item_name_duplicate"):
        assert_true(code in rename, f"rename_stock_item must use {code}")
    assert_true(
        "btrim(coalesce(p_new_name, ''))" in rename
        and "length(v_name) < 2" in rename
        and "length(v_name) > 120" in rename,
        "rename_stock_item must accept a btrimmed 2..120 char name",
    )
    assert_true(
        "public.normalize_stock_item_name(k.name) = v_norm" in rename,
        "rename_stock_item must refuse a normalized duplicate name",
    )
    assert_true(
        "exception when unique_violation" in rename,
        "rename_stock_item must surface the trigger duplicate error",
    )
    assert_true(
        "insert into public.kitchen_inventory_item_audit_logs" in rename
        and "'warehouse_game_rename'" in rename
        and "v_old_name" in rename
        and "changed_by" in rename,
        "rename_stock_item must write the audit row with old/new name and actor",
    )
    assert_true(
        "public.warehouse_game_requests" in rename,
        "rename_stock_item must use the idempotency table",
    )

    # --- 3. change-unit RPC --------------------------------------------------
    assert_true(CHANGE in lower, "migration must define change_stock_item_unit")
    change = assert_security_definer(
        CHANGE, "change_stock_item_unit(uuid, text, numeric, uuid)"
    )
    assert_true("unit_forbidden" in change, "change_stock_item_unit must use unit_forbidden")
    assert_true(
        "public.normalize_stock_unit(p_new_unit)" in change
        and "'unit_not_allowed'" in change,
        "change_stock_item_unit must normalize / validate the new unit",
    )
    assert_true("'unit_unchanged'" in change, "change_stock_item_unit must report unit_unchanged")
    assert_true(
        "v_old_kind in ('weight', 'volume')" in change
        and "v_old_to_base / v_new_to_base" in change,
        "change_stock_item_unit must compute a weight / volume factor from stock_units",
    )
    assert_true(
        "public.stock_unit_item_has_history(p_item_id)" in change,
        "change_stock_item_unit must branch on the item ledger history",
    )
    assert_true(
        "public.apply_stock_item_merge(p_item_id, v_new_item_id, v_factor, null)" in change,
        "the history branch must merge the old item into the new unit item",
    )
    assert_true(
        "public.stock_unit_conversions" in change,
        "change_stock_item_unit must write stock_unit_conversions",
    )
    assert_true(
        "conversion_factor = conversion_factor * v_factor" in change
        and "standard_unit_cost = round(standard_unit_cost / v_factor, 8)" in change,
        "the in-place branch must move aliases with the factor and inverse the cost",
    )
    assert_true(
        "public.warehouse_game_requests" in change,
        "change_stock_item_unit must use the idempotency table",
    )

    # --- 4. idempotency table ------------------------------------------------
    assert_true(
        "create table if not exists public.warehouse_game_requests" in lower,
        "migration must create public.warehouse_game_requests",
    )
    assert_true(
        "alter table public.warehouse_game_requests enable row level security" in lower,
        "warehouse_game_requests must enable RLS",
    )
    assert_true(
        "revoke all on table public.warehouse_game_requests from public, anon, authenticated"
        in lower,
        "warehouse_game_requests writes must be revoked from clients",
    )
    assert_true(
        "grant select on table public.warehouse_game_requests to authenticated, service_role"
        in lower,
        "warehouse_game_requests must be explicitly selectable",
    )
    assert_true(
        "request_id uuid primary key" in lower,
        "warehouse_game_requests must key on request_id",
    )

    # --- 5. never rewrite a document or an append-only ledger ----------------
    forbidden = (
        "insert into public.purchase_orders",
        "update public.purchase_orders",
        "delete from public.purchase_orders",
        "insert into public.purchase_order_items",
        "update public.purchase_order_items",
        "delete from public.purchase_order_items",
        "insert into public.payment_requests",
        "update public.payment_requests",
        "delete from public.payment_requests",
        "insert into public.goods_receipts",
        "update public.goods_receipts",
        "delete from public.goods_receipts",
        "insert into public.goods_receipt_items",
        "update public.goods_receipt_items",
        "delete from public.goods_receipt_items",
        "insert into public.q7_inventory_movements",
        "update public.q7_inventory_movements",
        "delete from public.q7_inventory_movements",
        "insert into public.tan_tao_material_movements",
        "update public.tan_tao_material_movements",
        "delete from public.tan_tao_material_movements",
        "insert into public.tan_tao_warehouse_movements",
        "update public.tan_tao_warehouse_movements",
        "delete from public.tan_tao_warehouse_movements",
    )
    for statement in forbidden:
        assert_true(statement not in lower, f"migration must not write {statement}")

    # --- 6. owner rule: base units only, the unit guard is not redefined ----
    assert_true(GUARD not in lower, "the migration must leave kitchen_inventory_items_unit_guard as is")
    assert_true(
        "v_new_unit := public.normalize_stock_unit(p_new_unit)" in change,
        "change_stock_item_unit must store the base unit (kg -> g, l -> ml)",
    )

    # --- 7. smoke test -------------------------------------------------------
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    smoke = read(SMOKE)
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true("rollback;" not in smoke.lower(), "smoke must roll back via the final RAISE")
    assert_true("commit;" not in smoke.lower(), "smoke must not commit")
    assert_true(
        migration.strip() in smoke,
        "smoke must inline the migration byte-for-byte (regenerate it when the migration changes)",
    )
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    for step in (
        "counts_match",
        "on_hand_match",
        "pending_match",
        "skus_location",
        "rename_duplicate",
        "rename_audit",
        "rename_idempotent",
        "unit_no_history",
        "unit_with_history",
        "unit_revert",
        "unit_base_only",
        "forbidden_rename",
        "forbidden_unit",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")
    assert_true(
        "from public.user_roles" in smoke and "role::text = 'owner'" in smoke,
        "smoke must take the owner from public.user_roles",
    )
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate the real owner / employee through auth claims",
    )

    print("PASS: Kho 2D warehouse-game contracts hold")


if __name__ == "__main__":
    main()
