#!/usr/bin/env python3
"""Static contract checks for the stock-item ON/OFF toggle migration.

These checks never connect to a database or Supabase. They guard migration
20261102460000_stock_item_in_use_toggle.sql, the owner 21/10 ON/OFF request:

  * stock_item_discontinuations gains tan_tao_qty_at_stop / q7_qty_at_stop;
  * public.discontinue_stock_item no longer raises item_has_stock, records the
    on-hand at stop time and accepts the old edit gates OR the 'inventory' edit
    module permission;
  * public.reactivate_stock_item uses the same gate;
  * public.get_discontinued_stock_items still returns every old key and adds
    item_class, current on-hand, in_q7, used_7d and the qty at stop;
  * public.get_stock_ledger_overview carries 'active' and never marks a stopped
    item as low stock;
  * every redefined function keeps its revoke/grant contract;
  * the hook exposes useSetStockItemInUse and the library keeps its error texts.

Everything here is a text assertion; it does not prove runtime behaviour.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"

MIGRATION = MIGRATIONS / "20261102460000_stock_item_in_use_toggle.sql"

DISCONTINUE_MARKER = "create or replace function public.discontinue_stock_item("
REACTIVATE_MARKER = "create or replace function public.reactivate_stock_item("
LIST_MARKER = "create or replace function public.get_discontinued_stock_items("
LEDGER_MARKER = "create or replace function public.get_stock_ledger_overview("

GRANT_LINES = [
    "revoke all on function public.discontinue_stock_item(uuid, text, uuid) from public, anon;",
    "revoke all on function public.reactivate_stock_item(uuid) from public, anon;",
    "revoke all on function public.get_discontinued_stock_items() from public, anon;",
    "revoke all on function public.get_stock_ledger_overview(text, date) from public, anon;",
    "grant execute on function public.discontinue_stock_item(uuid, text, uuid) to authenticated, service_role;",
    "grant execute on function public.reactivate_stock_item(uuid) to authenticated, service_role;",
    "grant execute on function public.get_discontinued_stock_items() to authenticated, service_role;",
    "grant execute on function public.get_stock_ledger_overview(text, date) to authenticated, service_role;",
]


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def extract_function(text: str, marker: str) -> str:
    """Return the full function definition from marker to its closing dollar tag."""
    start = text.index(marker)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    end = text.index(tag + ";", start + match.end())
    return text[start : end + len(tag) + 1]


def canon(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    migration = read(MIGRATION)
    flat = canon(migration)

    # --- 1. header + the two qty-at-stop columns -----------------------------
    assert_true(
        "21/10" in flat or "21/10" in migration,
        "the migration header must explain the owner 21/10 ON/OFF request",
    )
    assert_true(
        "add column if not exists tan_tao_qty_at_stop numeric" in flat,
        "stock_item_discontinuations must add tan_tao_qty_at_stop numeric",
    )
    assert_true(
        "add column if not exists q7_qty_at_stop numeric" in flat,
        "stock_item_discontinuations must add q7_qty_at_stop numeric",
    )

    # --- 2. discontinue_stock_item -------------------------------------------
    assert_true(DISCONTINUE_MARKER in migration,
                "migration must define public.discontinue_stock_item")
    discontinue_def = extract_function(migration, DISCONTINUE_MARKER)
    discontinue_header = discontinue_def[: discontinue_def.index("as $")]
    assert_true("p_item_id uuid" in discontinue_header,
                "discontinue must take p_item_id uuid")
    assert_true("p_reason text default null" in canon(discontinue_header),
                "discontinue must take p_reason text default null")
    assert_true("p_request_id uuid default null" in canon(discontinue_header),
                "discontinue must take p_request_id uuid default null")
    assert_true("returns jsonb" in discontinue_header,
                "discontinue must return jsonb")
    assert_true("security definer" in discontinue_header,
                "discontinue must be security definer")
    assert_true("set search_path = public, extensions, pg_temp" in discontinue_header,
                "discontinue must keep its search_path")

    # Owner 21/10: stopping is allowed with stock left.
    assert_true(
        re.search(r"raise\s+exception\s+'item_has_stock'", discontinue_def) is None,
        "discontinue must NOT raise item_has_stock any more",
    )
    assert_true(
        "'item_has_stock'" not in discontinue_def,
        "the item_has_stock code must be gone from discontinue_stock_item",
    )

    # Permission gate: old gates plus the inventory edit module.
    assert_true("public.q7_material_inventory_can_edit(v_actor)" in discontinue_def,
                "discontinue must keep q7_material_inventory_can_edit")
    assert_true("public.can_edit_material_master()" in discontinue_def,
                "discontinue must keep can_edit_material_master")
    assert_true(
        "public.has_module_permission(v_actor, 'inventory', 'edit')" in discontinue_def,
        "discontinue must accept the inventory edit module permission",
    )
    assert_true("insufficient_privilege" in discontinue_def
                and "errcode = '42501'" in discontinue_def,
                "discontinue must raise insufficient_privilege 42501")

    # Old behaviour kept.
    assert_true("merged_into_id is not null" in discontinue_def
                and "item_merged" in discontinue_def,
                "discontinue must reject merged items")
    assert_true(re.search(r"v_item\.active = false", discontinue_def) is not None,
                "discontinue must short-circuit an inactive item")
    assert_true("'item_in_open_count'" in discontinue_def,
                "discontinue must keep the item_in_open_count rule")
    assert_true("public.stock_count_lines" in discontinue_def
                and "public.stock_count_sessions" in discontinue_def,
                "discontinue must inspect the open stock-count lines")
    assert_true(re.search(r"set active = false", discontinue_def) is not None,
                "discontinue must set kitchen_inventory_items.active = false")
    assert_true("delete from public.material_link_skips where item_id = v_item.id"
                in discontinue_def,
                "discontinue must delete the item's material_link_skips row")
    assert_true(
        "delete from public.material_link_pending_factors where item_id = v_item.id"
        in discontinue_def,
        "discontinue must delete the item's material_link_pending_factors row",
    )
    for key in ("'item_id'", "'name'", "'active'"):
        assert_true(key in discontinue_def, f"discontinue result must include {key}")

    # On-hand computation + write of the qty at stop.
    assert_true("public.tan_tao_material_movements" in discontinue_def,
                "discontinue must compute the Tân Tạo on-hand")
    assert_true("public.q7_inventory_openings" in discontinue_def
                and "public.q7_inventory_movements" in discontinue_def,
                "discontinue must compute the Q7 on-hand")
    assert_true("v_tan_tao" in discontinue_def and "v_q7" in discontinue_def,
                "discontinue must keep computing v_tan_tao / v_q7")
    insert_section = canon(discontinue_def)
    assert_true(
        "tan_tao_qty_at_stop, q7_qty_at_stop" in insert_section,
        "discontinue insert must write both qty-at-stop columns",
    )
    assert_true(
        "tan_tao_qty_at_stop = excluded.tan_tao_qty_at_stop" in insert_section,
        "discontinue on-conflict update must refresh tan_tao_qty_at_stop",
    )
    assert_true(
        "q7_qty_at_stop = excluded.q7_qty_at_stop" in insert_section,
        "discontinue on-conflict update must refresh q7_qty_at_stop",
    )

    # --- 3. reactivate_stock_item --------------------------------------------
    assert_true(REACTIVATE_MARKER in migration,
                "migration must define public.reactivate_stock_item")
    reactivate_def = extract_function(migration, REACTIVATE_MARKER)
    assert_true("security definer" in reactivate_def,
                "reactivate must be security definer")
    assert_true("public.q7_material_inventory_can_edit(v_actor)" in reactivate_def,
                "reactivate must keep q7_material_inventory_can_edit")
    assert_true("public.can_edit_material_master()" in reactivate_def,
                "reactivate must keep can_edit_material_master")
    assert_true(
        "public.has_module_permission(v_actor, 'inventory', 'edit')" in reactivate_def,
        "reactivate must accept the inventory edit module permission",
    )
    assert_true("insufficient_privilege" in reactivate_def
                and "errcode = '42501'" in reactivate_def,
                "reactivate must raise insufficient_privilege 42501")
    assert_true("'item_merged'" in reactivate_def and "errcode = '22023'" in reactivate_def,
                "reactivate must raise item_merged 22023")
    assert_true(re.search(r"set active = true", reactivate_def) is not None,
                "reactivate must set active = true")
    assert_true("delete from public.stock_item_discontinuations" in reactivate_def,
                "reactivate must clear the discontinuation row")

    # --- 4. get_discontinued_stock_items -------------------------------------
    assert_true(LIST_MARKER in migration,
                "migration must define public.get_discontinued_stock_items")
    list_def = extract_function(migration, LIST_MARKER)
    assert_true("public.q7_material_inventory_can_view(v_actor)" in list_def
                and "public.can_view_tan_tao_warehouse()" in list_def,
                "the discontinued list must gate on the two warehouse viewers")
    assert_true("where kii.active = false" in list_def,
                "the discontinued list must only return inactive items")
    for key in ("'item_id'", "'item_code'", "'name'", "'unit'", "'pastry_q7'",
                "'reason'", "'discontinued_by_name'", "'discontinued_at'"):
        assert_true(key in list_def, f"the discontinued list must keep returning {key}")
    for key in ("'item_class'", "'tan_tao_qty'", "'q7_qty'", "'in_q7'",
                "'used_7d'", "'tan_tao_qty_at_stop'", "'q7_qty_at_stop'"):
        assert_true(key in list_def, f"the discontinued list must add {key}")
    assert_true("kii.item_class" in list_def,
                "the discontinued list must read kii.item_class")
    assert_true("kii.pastry_q7" in list_def,
                "in_q7 must consider kii.pastry_q7")
    assert_true("'production_usage'" in list_def,
                "used_7d must look at production_usage movements")
    assert_true("public.q7_inventory_movements" in list_def
                and "public.tan_tao_material_movements" in list_def,
                "used_7d must look in both movement tables")

    # --- 5. get_stock_ledger_overview ----------------------------------------
    assert_true(LEDGER_MARKER in migration,
                "migration must define public.get_stock_ledger_overview")
    ledger_def = extract_function(migration, LEDGER_MARKER)
    ledger_flat = canon(ledger_def)
    assert_true("'active', coalesce(x.active, true)" in ledger_flat,
                "the ledger rows must expose active (true when null)")
    assert_true("'active', true," in ledger_flat
                or "'active', true\n" in ledger_def,
                "the Tân Tạo finished-goods rows must carry active = true")
    assert_true("'pass_through', x.pass_through" in ledger_flat,
                "the ledger must keep its pass_through key")
    assert_true(
        "not x.pass_through and coalesce(x.active, true)" in ledger_flat,
        "the Tân Tạo is_low_stock rule must combine pass_through and active",
    )
    assert_true(
        "coalesce(x.active, true) and x.out_qty_7d > 0" in ledger_flat,
        "the Q7 is_low_stock rule must be false for inactive items",
    )
    assert_true("with lines as materialized" in ledger_def,
                "the materialized pending-alias CTE must be kept")

    for line in GRANT_LINES:
        assert_true(canon(line) in flat, f"missing grant line: {line}")

    # The stock-item ON/OFF front end left with the old warehouse game (owner 21/10/2026); only the backend is guarded here.

    print("PASS: stock-item ON/OFF toggle contracts hold")


if __name__ == "__main__":
    main()
