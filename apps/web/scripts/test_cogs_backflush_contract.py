#!/usr/bin/env python3
"""Static contract checks for 20261102590000_revenue_cogs_backflush.sql.

No database connection.  These checks guard the additive COGS backflush slice:
  * both stock-ledger source checks keep every old value and add revenue_cogs;
  * every function is SECURITY DEFINER with a pinned search_path and anon/public
    cannot execute it;
  * neither ledger is updated or deleted;
  * the two cron jobs exist with the required schedules and the loop variable is
    job_name (not job);
  * post_material_issue_usage is the previous body plus the Q7 early return;
  * kho_get_commitments keeps every previous top-level key and adds the cogs gap
    counts.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102590000_revenue_cogs_backflush.sql"
PREVIOUS_POST = ROOT / "supabase" / "migrations" / "20261102280000_q7_cancel_order_reverses_usage.sql"
PREVIOUS_KHO = ROOT / "supabase" / "migrations" / "20261102580000_kho_commitments.sql"

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
    "unit_factor_fix",
)
TT_SOURCES = (
    "goods_receipt",
    "manual_adjustment",
    "item_merge",
    "item_merge_revert",
    "stock_transfer",
    "production",
    "unit_factor_fix",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def normalize_sql(text: str) -> str:
    text = strip_comments(text)
    return re.sub(r"\s+", " ", text).strip().lower()


def extract_function(text: str, marker: str) -> str:
    lower = text.lower()
    start = lower.index(marker.lower())
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert match is not None, f"no AS dollar-quote after {marker}"
    tag = match.group(1)
    end = text.index(tag + ";", start + match.end())
    return text[start : end + len(tag) + 1]


def function_name(body: str) -> str:
    match = re.search(r"function\s+public\.([a-z0-9_]+)\s*\(", body, re.IGNORECASE)
    assert match is not None
    return match.group(1)


def main() -> None:
    assert MIGRATION.exists(), f"missing migration {MIGRATION.name}"
    migration = read(MIGRATION)
    sql = strip_comments(migration)
    lower = migration.lower()

    # --- 1. Ledger source checks -----------------------------------------
    q7_match = re.search(
        r"add\s+constraint\s+q7_inventory_movements_source_check\s+"
        r"check\s*\(\s*source\s+in\s*\((.*?)\)\s*\)\s*;",
        sql,
        re.IGNORECASE | re.S,
    )
    assert q7_match, "missing q7_inventory_movements_source_check"
    q7 = tuple(re.findall(r"'([^']+)'", q7_match.group(1)))
    for value in Q7_SOURCES + ("revenue_cogs",):
        assert value in q7, f"q7 source check lost {value}"

    tt_match = re.search(
        r"add\s+constraint\s+tan_tao_material_movements_source_check\s+"
        r"check\s*\(\s*source\s+in\s*\((.*?)\)\s*\)\s*;",
        sql,
        re.IGNORECASE | re.S,
    )
    assert tt_match, "missing tan_tao_material_movements_source_check"
    tt = tuple(re.findall(r"'([^']+)'", tt_match.group(1)))
    for value in TT_SOURCES + ("revenue_cogs",):
        assert value in tt, f"tan_tao source check lost {value}"

    # --- 2. New tables, RLS on, no client policies -----------------------
    for table in (
        "revenue_product_sku_map",
        "cogs_ingredient_stock_map",
        "cogs_mapping_events",
        "cogs_backflush_settings",
        "cogs_usage_factors",
        "cogs_backflush_runs",
        "cogs_backflush_trace",
    ):
        assert f"create table if not exists public.{table}" in lower, f"missing table {table}"
        assert f"alter table public.{table} enable row level security" in lower, (
            f"{table} must enable RLS"
        )
        assert f"revoke all on table public.{table} from public, anon, authenticated" in lower, (
            f"{table} must revoke anon/authenticated"
        )
    assert "create policy" not in lower, "new tables must have no policies"
    assert "cogs_usage_factors" in lower and "factor >= 0.5 and factor <= 2" in lower
    assert "insert into public.cogs_backflush_settings(location, enabled, start_date)" in lower

    # --- 3. Every function is locked down --------------------------------
    markers = re.findall(
        r"create\s+or\s+replace\s+function\s+public\.[a-z0-9_]+\s*\(",
        migration,
        re.IGNORECASE,
    )
    assert markers, "no functions found"
    starts = [m.start() for m in re.finditer(
        r"create\s+or\s+replace\s+function\s+public\.[a-z0-9_]+\s*\(",
        migration,
        re.IGNORECASE,
    )]
    for start in starts:
        body = extract_function(migration, migration[start : start + 120].split("\n")[0])
        name = function_name(body)
        body_lower = body.lower()
        assert "security definer" in body_lower, f"{name} must be SECURITY DEFINER"
        assert "set search_path = public, pg_temp" in body_lower, (
            f"{name} must pin search_path = public, pg_temp"
        )
        revoke = re.search(
            rf"revoke\s+all\s+on\s+function\s+public\.{re.escape(name)}\s*"
            r"\([^;]*?\)\s+from[^;]*?\banon\b[^;]*?;",
            lower,
            re.S,
        )
        assert revoke, f"{name} must be revoked from anon"

    # --- 4. No ledger update/delete --------------------------------------
    for table in ("q7_inventory_movements", "tan_tao_material_movements"):
        assert not re.search(
            rf"\b(?:update|delete\s+from)\s+(?:public\.)?{table}\b",
            sql,
            re.IGNORECASE,
        ), f"migration must not update or delete {table}"

    # --- 5. Cron names, schedules, job_name loop -------------------------
    assert "cogs-backflush-hourly" in lower
    assert "cogs-backflush-nightly" in lower
    assert "'15 * * * *'" in sql
    assert "'45 22 * * *'" in sql
    assert "cron.unschedule(job_name)" in lower, "must unschedule by job_name"
    assert re.search(r"\bjob\s+text\b", lower) is None, "loop variable must be job_name"
    assert "select public.run_cogs_backflush_scheduled();" in lower
    assert "select public.run_cogs_backflush_nightly();" in lower

    # --- 6. post_material_issue_usage = previous body + early return -----
    previous_post = extract_function(
        read(PREVIOUS_POST), "create or replace function public.post_material_issue_usage"
    )
    current_post = extract_function(
        migration, "create or replace function public.post_material_issue_usage"
    )
    early = "select 1\n    from public.cogs_backflush_settings s"
    early_pos = current_post.lower().find(early.lower())
    assert early_pos >= 0, "post_material_issue_usage early return missing"
    if_pos = current_post.lower().rfind("if exists (", 0, early_pos)
    assert if_pos >= 0, "post_material_issue_usage early return has no IF"
    end_pos = current_post.lower().find("end if;", early_pos)
    assert end_pos >= 0
    without_early = current_post[:if_pos] + current_post[end_pos + len("end if;") :]
    assert normalize_sql(without_early) == normalize_sql(previous_post), (
        "post_material_issue_usage changed beyond the Q7 early return"
    )
    assert "'cogs_backflush_enabled'" in current_post.lower()
    assert "'movement_count', 0" in current_post.lower()
    assert "'skipped_count', 0" in current_post.lower()

    # --- 7. kho_get_commitments keeps old keys, adds cogs ----------------
    current_kho = extract_function(
        migration, "create or replace function public.kho_get_commitments"
    )
    previous_kho = extract_function(
        read(PREVIOUS_KHO), "create or replace function public.kho_get_commitments"
    )
    for key in ("'as_of'", "'items'", "'skus'", "'gaps'"):
        assert key in previous_kho.lower()
        assert key in current_kho.lower(), f"kho_get_commitments lost {key}"
    for key in (
        "'pxk_lines_unposted'",
        "'pxk_unposted_issues'",
        "'cogs'",
        "'enabled_locations'",
        "'gap_products'",
        "'gap_ingredients'",
        "'Đơn '",
    ):
        assert key.lower() in current_kho.lower(), f"kho_get_commitments missing {key}"
    # Given-back PXK rows and corrected revenue_cogs rows are not holds.
    assert "'pmi-item-reverse:' || m.source_issue_item_id::text" in current_kho
    assert "m.source <> 'revenue_cogs'" in current_kho

    # --- 8. Core behavior markers ---------------------------------------
    refresh = extract_function(
        migration, "create or replace function public.cogs_refresh_mappings"
    ).lower()
    assert "'exact_code'" in refresh and "'payload_sku'" in refresh and "'production_name'" in refresh
    assert "status not in ('confirmed', 'rejected')" in refresh
    assert "'unit'" in refresh and "'never_stocked'" in refresh
    # Q7 ingredients follow the approved PXK mapping (a BOM remap rewrites it)
    # and only leaf recipe rows are used, like the material issue.
    assert "q7_material_issue_material_mappings" in refresh and "'q7_pxk_mapping'" in refresh
    assert "position(f.ingredient_name || ' > ' in child.ingredient_name) = 1" in refresh
    assert "'several_items'" in refresh and "'no_item'" in refresh

    explode = extract_function(
        migration, "create or replace function public.cogs_explode_revenue"
    ).lower()
    assert "'gap_product'" in explode and "'gap_recipe'" in explode
    assert "'gap_material'" in explode and "'gap_ingredient'" in explode
    assert "'gap_sub_recipe_unit'" in explode and "'skipped'" in explode
    assert "'ok'" in explode
    assert "depth" in explode and "array_append" in explode
    assert explode.count("position(f.ingredient_name || ' > ' in child.ingredient_name) = 1") == 4
    assert "like '%test%'" in explode
    assert "cogs_usage_factors" in explode

    runner = extract_function(
        migration, "create or replace function public.run_cogs_backflush"
    ).lower()
    assert "pg_advisory_xact_lock" in runner
    assert "production_usage" in runner and "'adjustment'" in runner
    assert "'revenue_cogs'" in runner
    assert "'cogs:'" in runner
    assert runner.count("greatest(v_setting.start_date, v_cutover + 1)") == 4
    assert "delete from public.cogs_backflush_trace" in runner
    assert "insert into public.q7_inventory_movements" in runner
    assert "insert into public.tan_tao_material_movements" in runner

    set_backflush = extract_function(
        migration, "create or replace function public.cogs_set_backflush"
    ).lower()
    # Reversals are dated on the usage's own day (a future-dated usage is not
    # in today's book), never through the today-dated helper.
    assert "public.reverse_material_issue_usage" not in set_backflush
    assert "'pmi-item-reverse:'" in set_backflush
    assert "select m.kitchen_inventory_item_id,\n             m.movement_date," in set_backflush
    assert "production_material_issue_reversal" in set_backflush
    assert "warning" in set_backflush and "không tự đăng lại" in set_backflush

    print("PASS: cogs backflush contracts hold")


if __name__ == "__main__":
    main()
