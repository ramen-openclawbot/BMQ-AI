#!/usr/bin/env python3
"""Static contract checks for 20261102660000_cogs_production_location.sql.

No database connection.  These checks guard the production-kho slice:
  * cogs_sku_production_location has the approved shape, RLS with no client
    policy, anon/authenticated cannot touch it, and only the six listed SKU
    codes are seeded at tan_tao;
  * cogs_explode_revenue keeps its previous RETURNS TABLE, grants,
    SECURITY DEFINER/search_path and body, adding exactly one leaf deduct
    override that switches to the top-level SKU production kho only when the
    mapped item has a place there;
  * set_item_kho_locations keeps its previous body except for splitting the old
    item_not_found check into item_not_found (missing/merged) and
    item_inactive_place (exists but inactive);
  * no UPDATE/DELETE on the stock ledgers.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102660000_cogs_production_location.sql"
PREVIOUS_EXPLODE = ROOT / "supabase" / "migrations" / "20261102650000_cogs_subrecipe_autolink.sql"
PREVIOUS_KHO = ROOT / "supabase" / "migrations" / "20261102620000_kho_item_two_locations.sql"

EXPLODE_MARKER = "create or replace function public.cogs_explode_revenue"
SET_KHO_MARKER = "create or replace function public.set_item_kho_locations"
OVERRIDE_START = "-- >>> production-kho override"
OVERRIDE_END = "-- <<< production-kho override"

SEED_CODES = (
    "BMQ-001",
    "BMQ-002",
    "BMQ-003",
    "TP-PATE",
    "TP-BO BML",
    "TP-DO CHUA",
)

PREVIOUS_EXPLODE_REVOKE = (
    "revoke all on function public.cogs_explode_revenue(date, date) "
    "from public, anon, authenticated;"
)
PREVIOUS_EXPLODE_GRANT = (
    "grant execute on function public.cogs_explode_revenue(date, date) to service_role;"
)
PREVIOUS_SET_REVOKE = (
    "revoke all on function public.set_item_kho_locations(uuid, boolean, boolean, uuid) "
    "from public, anon;"
)
PREVIOUS_SET_GRANT = (
    "grant execute on function public.set_item_kho_locations(uuid, boolean, boolean, uuid) "
    "to authenticated;"
)

OLD_EXISTS_CHECK = """
if not exists (
  select 1 from public.kitchen_inventory_items k
  where k.id = p_item_id and k.active = true and k.merged_into_id is null
) then
  raise exception 'item_not_found' using errcode = 'P0002';
end if;
"""

NEW_EXISTS_CHECK = """
if not exists (
  select 1 from public.kitchen_inventory_items k
  where k.id = p_item_id and k.merged_into_id is null
) then
  raise exception 'item_not_found' using errcode = 'P0002';
end if;
if exists (
  select 1 from public.kitchen_inventory_items k
  where k.id = p_item_id and k.active is not true and k.merged_into_id is null
) then
  raise exception 'item_inactive_place' using errcode = '22023';
end if;
"""


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


def returns_table(body: str) -> str:
    match = re.search(r"returns\s+table\s*\((.*?)\)\s*language", body, re.IGNORECASE | re.S)
    assert match is not None, "missing RETURNS TABLE"
    return normalize_sql(match.group(1))


def main() -> None:
    assert MIGRATION.exists(), f"missing migration {MIGRATION.name}"
    migration = read(MIGRATION)
    sql = strip_comments(migration)
    lower = migration.lower()
    sql_norm = normalize_sql(migration)

    # --- 1. Production-location table is locked down ----------------------
    assert (
        "create table if not exists public.cogs_sku_production_location ("
        in sql_norm
    ), "missing cogs_sku_production_location table"
    assert (
        "sku_id uuid primary key references public.product_skus(id)"
        in sql_norm
    ), "sku_id must be the primary key referencing product_skus"
    assert (
        "location text not null check (location in ('tan_tao', 'q7'))" in sql_norm
    ), "location must be text not null with the two-kho check"
    assert "updated_by uuid" in sql_norm, "missing updated_by"
    assert (
        "updated_at timestamptz default now()" in sql_norm
    ), "missing updated_at default"
    assert (
        "alter table public.cogs_sku_production_location enable row level security;"
        in sql_norm
    ), "production-location table must enable RLS"
    assert (
        "revoke all on table public.cogs_sku_production_location from anon, authenticated;"
        in sql_norm
    ), "anon/authenticated must lose all table access"
    assert (
        "grant all on table public.cogs_sku_production_location to service_role;"
        in sql_norm
    ), "service_role must keep all table access"
    assert not re.search(r"\bcreate\s+policy\b", sql, re.IGNORECASE), (
        "production-location table must keep RLS with no client policies"
    )

    seed = re.search(
        r"insert\s+into\s+public\.cogs_sku_production_location\s*"
        r"\(\s*sku_id\s*,\s*location\s*\)(.*?)"
        r"on\s+conflict\s*\(\s*sku_id\s*\)\s*do\s+nothing\s*;",
        migration,
        re.IGNORECASE | re.S,
    )
    assert seed, "missing seed insert"
    seed_sql = normalize_sql(seed.group(0))
    assert "select ps.id, 'tan_tao'" in seed_sql, "seed must write tan_tao"
    assert "from public.product_skus ps" in seed_sql, "seed must read product_skus"
    for code in SEED_CODES:
        assert f"'{code.lower()}'" in seed_sql, f"seed missing {code}"
    assert seed_sql.count("'") >= len(SEED_CODES) * 2 + 2, "unexpected seed literals"

    # --- 2. Explode changes only the leaf deduct location -----------------
    explode = extract_function(migration, EXPLODE_MARKER)
    previous_explode = extract_function(read(PREVIOUS_EXPLODE), EXPLODE_MARKER)
    explode_lower = explode.lower()

    assert function_name(explode) == "cogs_explode_revenue"
    assert "language plpgsql" in explode_lower
    assert "security definer" in explode_lower, "explode must stay SECURITY DEFINER"
    assert "set search_path = public, pg_temp" in explode_lower, (
        "explode must keep search_path = public, pg_temp"
    )
    assert returns_table(explode) == returns_table(previous_explode), (
        "explode RETURNS TABLE changed"
    )
    assert normalize_sql(PREVIOUS_EXPLODE_REVOKE) in sql_norm, "explode revoke changed"
    assert normalize_sql(PREVIOUS_EXPLODE_GRANT) in sql_norm, "explode grant changed"

    start = explode.index(OVERRIDE_START)
    end_marker = explode.index(OVERRIDE_END, start)
    end = explode.index("\n", end_marker) + 1
    override = explode[start:end]
    override_sql = normalize_sql(override)

    deduct_at = explode_lower.index("if v_map_action = 'deduct'")
    usage_at = explode_lower.index("v_usage_factor := null;", start)
    assert deduct_at < start < usage_at, "override must be inside the leaf deduct branch"
    assert override_sql.count("public.cogs_sku_production_location") >= 1
    assert "join public.kitchen_inventory_items k on k.id = v_map_item" in override_sql
    assert "p.sku_id = v_node.sku_id" in override_sql, (
        "override must key on the top-level revenue SKU (v_node.sku_id)"
    )
    assert "p.location is distinct from v_map_location" in override_sql, (
        "override must only switch to a different location"
    )
    assert "(p.location = 'tan_tao' and k.in_tan_tao is true)" in override_sql, (
        "tan_tao override must require in_tan_tao"
    )
    assert "(p.location = 'q7' and k.pastry_q7 is true)" in override_sql, (
        "q7 override must require pastry_q7"
    )
    assert "v_map_location := coalesce((" in override_sql, (
        "override must keep the map location when no production place matches"
    )
    assert "), v_map_location);" in override_sql
    assert "limit 1" in override_sql

    reverted = explode[:start] + explode[end:]
    assert normalize_sql(reverted) == normalize_sql(previous_explode), (
        "explode changed beyond the one production-kho override block"
    )

    # --- 3. set_item_kho_locations splits missing from inactive ----------
    set_kho = extract_function(migration, SET_KHO_MARKER)
    previous_set_kho = extract_function(read(PREVIOUS_KHO), SET_KHO_MARKER)
    set_kho_norm = normalize_sql(set_kho)
    previous_set_kho_norm = normalize_sql(previous_set_kho)
    old_check = normalize_sql(OLD_EXISTS_CHECK)
    new_check = normalize_sql(NEW_EXISTS_CHECK)

    assert function_name(set_kho) == "set_item_kho_locations"
    assert "security definer" in set_kho_norm
    assert "set search_path = public, pg_temp" in set_kho_norm
    assert old_check in previous_set_kho_norm, "previous item_not_found check changed"
    assert old_check not in set_kho_norm, "old combined existence check must be split"
    assert new_check in set_kho_norm, "missing split item_not_found/item_inactive_place checks"
    assert set_kho_norm.count(
        "if not exists ( select 1 from public.kitchen_inventory_items k"
    ) == 1, "expected one missing-item check"
    assert set_kho_norm.count(
        "if exists ( select 1 from public.kitchen_inventory_items k"
    ) == 1, "expected one inactive-item check (raise only when inactive)"
    assert "raise exception 'item_not_found' using errcode = 'p0002';" in set_kho_norm
    assert (
        "raise exception 'item_inactive_place' using errcode = '22023';" in set_kho_norm
    ), "inactive item must raise item_inactive_place with 22023"
    restored = set_kho_norm.replace(new_check, old_check, 1)
    assert restored == previous_set_kho_norm, (
        "set_item_kho_locations changed beyond the split existence check"
    )
    assert normalize_sql(PREVIOUS_SET_REVOKE) in sql_norm, (
        "set_item_kho_locations revoke changed"
    )
    assert normalize_sql(PREVIOUS_SET_GRANT) in sql_norm, (
        "set_item_kho_locations grant changed"
    )

    # --- 4. No stock ledger update/delete ---------------------------------
    for table in ("q7_inventory_movements", "tan_tao_material_movements"):
        assert not re.search(
            rf"\b(?:update|delete\s+from)\s+(?:public\.)?{table}\b",
            sql,
            re.IGNORECASE,
        ), f"migration must not update or delete {table}"

    print("PASS: cogs production-location contracts hold")


if __name__ == "__main__":
    main()
