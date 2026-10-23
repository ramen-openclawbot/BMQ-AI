#!/usr/bin/env python3
"""Static contract checks for 20261102820000_kho_merge_chain.sql (no DB).

Guards the Kho merge-chain slice:
  * only apply_stock_item_merge and revert_stock_item_merge are redefined;
  * the merge keeps its signature, SECURITY DEFINER, search_path and grants,
    and still forwards aliases, both ledgers, recipe maps and settings;
  * merge_source_was_target is no longer raised;
  * after the source -> target merge, children that were merged into the source
    are re-pointed at the new target with factor * this merge factor in both
    kitchen_inventory_items and stock_item_merges;
  * revert_stock_item_merge accepts the two history rows written for a chain.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102820000_kho_merge_chain.sql"
LATEST = ROOT / "supabase" / "migrations" / "20261026100000_central_warehouse_flow.sql"

APPLY = "create or replace function public.apply_stock_item_merge("
REVERT = "create or replace function public.revert_stock_item_merge("
APPLY_SIG = "apply_stock_item_merge(uuid, uuid, numeric, uuid)"
REVERT_SIG = "revert_stock_item_merge(uuid)"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def extract_function(text: str, marker: str) -> str:
    start = text.lower().index(marker.lower())
    close = text.index("\n$$;", start)
    return text[start : close + len("\n$$;")]


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    migration = read(MIGRATION)
    sql = strip_comments(migration)
    lower = sql.lower()
    flat_sql = flat(sql)

    # --- 1. only the merge function and its undo are redefined ------------
    defined = re.findall(
        r"create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)\s*\(", lower
    )
    assert_true(
        defined == ["apply_stock_item_merge", "revert_stock_item_merge"],
        f"expected only apply_stock_item_merge + revert_stock_item_merge, got {defined}",
    )
    assert_true("create table" not in lower, "the migration must not create tables")
    assert_true("create trigger" not in lower, "the migration must not create triggers")

    # --- 2. same signature, security envelope and grants ------------------
    apply_fn = extract_function(migration, APPLY)
    revert_fn = extract_function(migration, REVERT)
    apply_flat = flat(apply_fn)
    revert_flat = flat(revert_fn)

    assert_true(apply_fn.startswith(APPLY), "apply function marker changed")
    assert_true("p_source uuid" in apply_flat, "apply keeps p_source uuid")
    assert_true("p_target uuid" in apply_flat, "apply keeps p_target uuid")
    assert_true("p_factor numeric" in apply_flat, "apply keeps p_factor numeric")
    assert_true(
        "p_suggestion uuid default null" in apply_flat,
        "apply keeps the p_suggestion default",
    )
    assert_true("returns jsonb" in apply_flat, "apply must still return jsonb")
    assert_true("language plpgsql" in apply_flat, "apply must stay plpgsql")
    assert_true("security definer" in apply_flat, "apply must stay SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in apply_flat,
        "apply must pin search_path = public, pg_temp",
    )
    assert_true(revert_fn.startswith(REVERT), "revert function marker changed")
    assert_true("p_merge_id uuid" in revert_flat, "revert keeps p_merge_id uuid")
    assert_true("returns jsonb" in revert_flat, "revert must still return jsonb")
    assert_true("security definer" in revert_flat, "revert must stay SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in revert_flat,
        "revert must pin search_path = public, pg_temp",
    )
    for signature in (APPLY_SIG, REVERT_SIG):
        assert_true(
            f"revoke all on function public.{signature} from public, anon" in flat_sql,
            f"{signature} must revoke public/anon",
        )
        assert_true(
            f"grant execute on function public.{signature} to authenticated, service_role"
            in flat_sql,
            f"{signature} must grant authenticated/service_role",
        )

    # --- 3. the old guard is gone ----------------------------------------
    assert_true(
        "merge_source_was_target" not in lower,
        "apply_stock_item_merge must no longer mention or raise merge_source_was_target",
    )

    # --- 4. a chain is re-pointed after the source -> target merge --------
    source_update = flat_sql.index(
        "update public.kitchen_inventory_items set active = false, "
        "merged_into_id = p_target, merged_factor = p_factor, merged_at = now() "
        "where id = p_source"
    )
    chain_start = flat_sql.index(
        "for c in select sm.* from public.stock_item_merges sm "
        "where sm.target_id = p_source and sm.status = 'applied'"
    )
    assert_true(
        chain_start > source_update,
        "children must be re-pointed after the source row is merged into the target",
    )

    assert_true(
        re.search(r"v_child_factor\s*:=\s*round\(\s*c\.factor\s*\*\s*p_factor\s*,\s*8\s*\)", apply_fn),
        "child factor must be composed as round(child factor * merge factor, 8)",
    )
    assert_true(
        re.search(
            r"update public\.kitchen_inventory_items as t\s+"
            r"set merged_into_id = p_target,\s+merged_factor = v_child_factor\s+"
            r"where t\.id = c\.source_id",
            apply_fn,
        ),
        "child kitchen item must be re-pointed at the new target with the composed factor",
    )
    assert_true(
        re.search(
            r"update public\.stock_item_merges as t\s+"
            r"set target_id = p_target,\s+factor = v_child_factor\s+"
            r"where t\.id = c\.id",
            apply_fn,
        ),
        "child stock_item_merges row must get the new target and composed factor",
    )
    assert_true(
        "values (v_merge_id, 'kitchen_inventory_items', c.source_id, v_old, v_new)" in apply_fn,
        "the old child item must be logged for undo",
    )
    assert_true(
        "values (v_merge_id, 'stock_item_merges', c.id, v_old, v_new)" in apply_fn,
        "the old child merge row must be logged for undo",
    )

    # --- 5. the rest of the merge body is still there ---------------------
    for needle in (
        "insert into public.stock_item_merges(source_id, target_id, factor, status, "
        "applied_by, applied_at, suggestion_id)",
        "insert into public.q7_inventory_movements",
        "insert into public.tan_tao_material_movements",
        "update public.production_material_issue_items",
        "update public.q7_material_issue_material_mappings",
        "update public.stock_material_aliases",
        "update public.q7_purchase_item_settings",
        "update public.stock_catalog_suggestions",
    ):
        assert_true(needle in apply_fn, f"merge body lost: {needle}")

    # --- 6. undo can restore the re-pointed chain -------------------------
    assert_true(
        "'kitchen_inventory_items'," in revert_fn
        and "'stock_item_merges'" in revert_fn,
        "revert_stock_item_merge must accept the chain history rows",
    )
    assert_true(
        "insert into public.stock_item_merge_rows" in apply_fn
        and "where merge_id = p_merge_id" in revert_fn,
        "chain history must be stored under this merge id and read on revert",
    )

    # The redefinition really is based on the latest body shipped before it.
    assert_true(LATEST.exists(), f"missing previous body {LATEST.name}")
    previous = read(LATEST)
    previous_apply = extract_function(previous, APPLY)
    for shared in (
        "for r in select * from public.production_material_issue_items",
        "for r in select * from public.q7_material_issue_material_mappings",
        "for r in select * from public.stock_material_aliases",
        "for r in select * from public.q7_purchase_item_settings",
    ):
        assert_true(shared in previous_apply, f"latest body lost {shared}")
        assert_true(shared in apply_fn, f"new body lost {shared}")

    print("PASS: kho merge-chain contracts hold")


if __name__ == "__main__":
    main()
