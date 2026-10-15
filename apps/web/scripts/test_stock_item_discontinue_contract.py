#!/usr/bin/env python3
"""Static contract checks for the stock-item discontinue migration.

These checks never connect to a database or Supabase. They guard that migration
20261101230000_stock_item_discontinue.sql keeps the public contracts for the
owner "Ngưng dùng" action (owner 15/10):

  * public.stock_item_discontinuations exists with RLS, a select policy for
    authenticated, and the expected table grants;
  * public.discontinue_stock_item is gated, raises item_has_stock and
    item_in_open_count, sets active = false, upserts the discontinuation row and
    deletes the item from material_link_skips / material_link_pending_factors;
  * public.reactivate_stock_item raises item_merged and clears the row;
  * public.get_discontinued_stock_items exists and returns the owner shape;
  * material_link_review_items_internal carries 'bot' in the same-unit shared
    word stopwords while still merging 'huongduong';
  * the React hook imports no .tsx module.

Everything here is a text assertion; it does not prove runtime behaviour.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
LIB = ROOT / "src" / "lib"
HOOKS = ROOT / "src" / "hooks"

MIGRATION = MIGRATIONS / "20261101230000_stock_item_discontinue.sql"
HOOK = HOOKS / "useStockItemDiscontinue.ts"
LIBRARY = LIB / "stock-item-discontinue.ts"

DISCONTINUE_MARKER = "create or replace function public.discontinue_stock_item("
REACTIVATE_MARKER = "create or replace function public.reactivate_stock_item("
LIST_MARKER = "create or replace function public.get_discontinued_stock_items("
REVIEW_MARKER = "create or replace function public.material_link_review_items_internal("

GRANT_LINES = [
    "revoke all on function public.discontinue_stock_item(uuid, text, uuid) from public, anon;",
    "revoke all on function public.reactivate_stock_item(uuid) from public, anon;",
    "revoke all on function public.get_discontinued_stock_items() from public, anon;",
    "grant execute on function public.discontinue_stock_item(uuid, text, uuid) to authenticated, service_role;",
    "grant execute on function public.reactivate_stock_item(uuid) to authenticated, service_role;",
    "grant execute on function public.get_discontinued_stock_items() to authenticated, service_role;",
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
    assert_true(HOOK.exists(), f"missing hook {HOOK.name}")
    assert_true(LIBRARY.exists(), f"missing library {LIBRARY.name}")
    migration = read(MIGRATION)

    # --- 1. table + RLS + policy + grants ------------------------------------
    assert_true(
        "create table if not exists public.stock_item_discontinuations" in canon(migration),
        "migration must create public.stock_item_discontinuations",
    )
    table_section = canon(migration)
    assert_true(
        "item_id uuid primary key references public.kitchen_inventory_items(id)" in table_section,
        "discontinuations.item_id must be the item primary key",
    )
    assert_true(
        "discontinued_at timestamptz not null default now()" in table_section,
        "discontinuations.discontinued_at must default to now()",
    )
    assert_true(
        "alter table public.stock_item_discontinuations enable row level security" in table_section,
        "discontinuations must enable RLS",
    )
    assert_true(
        canon(
            "create policy stock_item_discontinuations_select on public.stock_item_discontinuations"
            " for select to authenticated using (true)"
        )
        in table_section,
        "discontinuations must grant a select policy to authenticated",
    )
    assert_true(
        "grant select on table public.stock_item_discontinuations to authenticated" in table_section,
        "discontinuations must grant select to authenticated",
    )
    assert_true(
        "grant all on table public.stock_item_discontinuations to service_role" in table_section,
        "discontinuations must grant all to service_role",
    )

    # --- 2. discontinue_stock_item -------------------------------------------
    assert_true(DISCONTINUE_MARKER in migration,
                "migration must define public.discontinue_stock_item")
    discontinue_def = extract_function(migration, DISCONTINUE_MARKER)
    header = discontinue_def[: discontinue_def.index("as $")]
    assert_true("p_item_id uuid" in header, "discontinue must take p_item_id uuid")
    assert_true("p_reason text default null" in canon(header),
                "discontinue must take p_reason text default null")
    assert_true("p_request_id uuid default null" in canon(header),
                "discontinue must take p_request_id uuid default null")
    assert_true("returns jsonb" in header, "discontinue must return jsonb")
    assert_true("language plpgsql" in header, "discontinue must be plpgsql")
    assert_true("security definer" in header, "discontinue must be security definer")
    assert_true("set search_path = public, extensions, pg_temp" in header,
                "discontinue must keep its search_path")
    assert_true("public.q7_material_inventory_can_edit(v_actor)" in discontinue_def,
                "discontinue must gate on q7_material_inventory_can_edit")
    assert_true("public.can_edit_material_master()" in discontinue_def,
                "discontinue must fall back to can_edit_material_master")
    assert_true("insufficient_privilege" in discontinue_def
                and "errcode = '42501'" in discontinue_def,
                "discontinue must raise insufficient_privilege 42501")
    assert_true("merged_into_id is not null" in discontinue_def
                and "item_merged" in discontinue_def,
                "discontinue must reject merged items")
    assert_true(re.search(r"v_item\.active = false", discontinue_def) is not None,
                "discontinue must short-circuit an inactive item")
    assert_true("'item_has_stock'" in discontinue_def,
                "discontinue must raise item_has_stock")
    assert_true("errcode = '22023'" in discontinue_def,
                "item errors must use SQLSTATE 22023")
    assert_true("'item_in_open_count'" in discontinue_def,
                "discontinue must raise item_in_open_count")
    assert_true("public.stock_count_lines" in discontinue_def
                and "public.stock_count_sessions" in discontinue_def,
                "discontinue must inspect the open stock-count lines")
    assert_true("status = 'open'" in discontinue_def,
                "discontinue must only count an open stock-count session")
    assert_true(re.search(r"set active = false", discontinue_def) is not None,
                "discontinue must set kitchen_inventory_items.active = false")
    assert_true("insert into public.stock_item_discontinuations" in discontinue_def,
                "discontinue must write the discontinuation row")
    assert_true("on conflict (item_id) do update" in discontinue_def,
                "discontinue must upsert the discontinuation row")
    assert_true("delete from public.material_link_skips where item_id = v_item.id" in discontinue_def,
                "discontinue must delete the item's material_link_skips row")
    assert_true(
        "delete from public.material_link_pending_factors where item_id = v_item.id"
        in discontinue_def,
        "discontinue must delete the item's material_link_pending_factors row",
    )
    for key in ("'item_id'", "'name'", "'active'"):
        assert_true(key in discontinue_def, f"discontinue result must include {key}")

    # --- 3. reactivate_stock_item --------------------------------------------
    assert_true(REACTIVATE_MARKER in migration,
                "migration must define public.reactivate_stock_item")
    reactivate_def = extract_function(migration, REACTIVATE_MARKER)
    reactivate_header = reactivate_def[: reactivate_def.index("as $")]
    assert_true("security definer" in reactivate_header,
                "reactivate must be security definer")
    assert_true("public.can_edit_material_master()" in reactivate_def,
                "reactivate must keep the same edit gate")
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
        assert_true(key in list_def, f"the discontinued list must return {key}")
    assert_true("raw_user_meta_data ->> 'full_name'" in list_def,
                "the discontinued list must resolve the actor name")

    for line in GRANT_LINES:
        assert_true(canon(line) in canon(migration), f"missing grant line: {line}")

    # --- 5. review stopword 'bot' --------------------------------------------
    assert_true(REVIEW_MARKER in migration,
                "migration must CREATE OR REPLACE material_link_review_items_internal")
    review_def = extract_function(migration, REVIEW_MARKER)
    assert_true("huongduong" in review_def,
                "the review word rule must still merge 'huong duong' into 'huongduong'")
    assert_true("'bot'" in review_def,
                "the review same-unit stopword list must contain 'bot'")
    assert_true(review_def.count("'bot'") >= 1,
                "the review stopword list must contain 'bot'")
    assert_true(
        "revoke execute on function public.material_link_review_items_internal(text)"
        " from public, anon, authenticated, service_role;" in canon(migration),
        "the internal review revoke line must be kept",
    )

    # --- 6. hook imports no .tsx ---------------------------------------------
    hook = read(HOOK)
    assert_true(".tsx" not in hook, "the hook must not import a .tsx module")
    assert_true(re.search(r"from\s+[\"'][^\"']+\.tsx[\"']", hook) is None,
                "the hook must not import a .tsx module")
    assert_true("DISCONTINUED_ITEMS_QUERY_KEY" in hook,
                "the hook must export DISCONTINUED_ITEMS_QUERY_KEY")
    for export in ("useDiscontinuedStockItems", "useDiscontinueStockItem",
                   "useReactivateStockItem"):
        assert_true(f"export function {export}" in hook,
                    f"the hook must export {export}")

    # --- 7. library error texts ----------------------------------------------
    library = read(LIBRARY)
    assert_true("parseDiscontinuedStockItems" in library,
                "the library must export parseDiscontinuedStockItems")
    assert_true("discontinueErrorCode" in library and "discontinueErrorText" in library,
                "the library must export discontinueErrorCode / discontinueErrorText")
    for text in ("Món còn tồn", "phiếu kiểm kê chưa chốt", "Món đã được gộp vào món khác",
                 "Bạn không có quyền ngưng món này", "Chưa ngưng được món này"):
        assert_true(text in library, f"the library must map the text {text!r}")

    print("PASS: stock-item discontinue contracts hold")


if __name__ == "__main__":
    main()
