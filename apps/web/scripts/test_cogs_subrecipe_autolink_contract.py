#!/usr/bin/env python3
"""Static contract checks for 20261102650000_cogs_subrecipe_autolink.sql.

No database connection.  These checks guard the sub-recipe auto-link slice:
  * cogs_resolve_child_sku is SECURITY DEFINER with a pinned search_path and
    anon/public cannot execute it;
  * an explicit ingredient_sku_id always wins;
  * the fallback rules (a) material link, (b) product canonical link, (c)
    whitespace/case-insensitive SKU code are tried in order, reject
    raw_material, require exactly one match and an existing COGS version;
  * cogs_explode_revenue keeps the previous RETURNS TABLE, grants and
    SECURITY DEFINER/search_path, and changes only the two ingredient_sku_id
    selects over sku_cogs_version_formulations;
  * no UPDATE/DELETE on the stock ledgers.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102650000_cogs_subrecipe_autolink.sql"
PREVIOUS = ROOT / "supabase" / "migrations" / "20261102600000_cogs_overview_fixes.sql"

RESOLVE_MARKER = "create or replace function public.cogs_resolve_child_sku"
EXPLODE_MARKER = "create or replace function public.cogs_explode_revenue"
RESOLVE_CALL = (
    "public.cogs_resolve_child_sku("
    "f.ingredient_sku_id, f.canonical_material_id, f.material_code"
    ") as ingredient_sku_id"
)
PREVIOUS_EXPLODE_REVOKE = (
    "revoke all on function public.cogs_explode_revenue(date, date) "
    "from public, anon, authenticated;"
)
PREVIOUS_EXPLODE_GRANT = (
    "grant execute on function public.cogs_explode_revenue(date, date) to service_role;"
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


def returns_table(body: str) -> str:
    match = re.search(
        r"returns\s+table\s*\((.*?)\)\s*language",
        body,
        re.IGNORECASE | re.S,
    )
    assert match is not None, "missing RETURNS TABLE"
    return normalize_sql(match.group(1))


def main() -> None:
    assert MIGRATION.exists(), f"missing migration {MIGRATION.name}"
    migration = read(MIGRATION)
    sql = strip_comments(migration)
    lower = migration.lower()

    # --- 1. The resolver is locked down ----------------------------------
    resolve = extract_function(migration, RESOLVE_MARKER)
    resolve_lower = resolve.lower()
    assert function_name(resolve) == "cogs_resolve_child_sku"
    assert re.search(r"returns\s+uuid", resolve_lower), "resolver must return uuid"
    assert "p_ingredient_sku_id uuid" in resolve_lower
    assert "p_canonical_material_id uuid" in resolve_lower
    assert "p_material_code text" in resolve_lower
    assert "language sql" in resolve_lower, "resolver must be language sql"
    assert "stable" in resolve_lower, "resolver must be stable"
    assert "security definer" in resolve_lower, "resolver must be SECURITY DEFINER"
    assert "set search_path = public, pg_temp" in resolve_lower, (
        "resolver must pin search_path = public, pg_temp"
    )

    revoke = re.search(
        r"revoke\s+execute\s+on\s+function\s+public\.cogs_resolve_child_sku\s*"
        r"\(\s*uuid\s*,\s*uuid\s*,\s*text\s*\)\s+from\s+([^;]*);",
        migration,
        re.IGNORECASE | re.S,
    )
    assert revoke, "resolver must revoke execute from public and anon"
    revoked_from = normalize_sql(revoke.group(1))
    assert "public" in revoked_from and "anon" in revoked_from, (
        "resolver must revoke execute from public and anon"
    )
    grant = re.search(
        r"grant\s+execute\s+on\s+function\s+public\.cogs_resolve_child_sku\s*"
        r"\(\s*uuid\s*,\s*uuid\s*,\s*text\s*\)\s+to\s+([^;]*);",
        migration,
        re.IGNORECASE | re.S,
    )
    assert grant, "resolver must grant execute to authenticated and service_role"
    granted_to = normalize_sql(grant.group(1))
    assert "authenticated" in granted_to and "service_role" in granted_to, (
        "resolver must grant execute to authenticated and service_role"
    )

    # --- 2. Rules: explicit id wins; (a)/(b)/(c) order; safety -----------
    assert (
        "when p_ingredient_sku_id is not null then p_ingredient_sku_id"
        in resolve_lower
    ), "an explicit ingredient_sku_id must win"
    assert "1 as priority" in resolve_lower, "missing rule (a)"
    assert "select 2, ps.id" in resolve_lower, "missing rule (b)"
    assert "select 3, ps.id" in resolve_lower, "missing rule (c)"
    assert "m.ingredient_sku_id" in resolve_lower, "rule (a) must read the material link"
    assert "ps.canonical_material_id = p_canonical_material_id" in resolve_lower, (
        "rule (b) must match product_skus.canonical_material_id"
    )
    assert "regexp_replace(coalesce(ps.sku_code, ''), '\\s', '', 'g')" in resolve_lower, (
        "rule (c) must strip whitespace from sku_code"
    )
    assert "regexp_replace(p_material_code, '\\s', '', 'g')" in resolve_lower, (
        "rule (c) must strip whitespace from material_code"
    )
    assert "upper(regexp_replace(coalesce(ps.sku_code" in resolve_lower, (
        "rule (c) must upper-case sku_code"
    )
    assert "upper(regexp_replace(p_material_code" in resolve_lower, (
        "rule (c) must upper-case material_code"
    )

    assert resolve_lower.count("ps.sku_type is distinct from 'raw_material'") == 3, (
        "every rule must reject raw_material"
    )
    assert resolve_lower.count(
        "from public.sku_cogs_versions v where v.sku_id = ps.id"
    ) == 3, "every rule must require an existing sku_cogs_versions row"
    assert "count(*) over (partition by c.priority) as match_count" in resolve_lower, (
        "rules must count matches"
    )
    assert "r.match_count = 1" in resolve_lower, "only exactly one match may be used"
    assert "min(c.priority) over () as first_priority" in resolve_lower
    assert "r.priority = r.first_priority" in resolve_lower

    # --- 3. Explode keeps its contract -----------------------------------
    explode = extract_function(migration, EXPLODE_MARKER)
    previous_explode = extract_function(read(PREVIOUS), EXPLODE_MARKER)
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
    assert PREVIOUS_EXPLODE_REVOKE.lower() in lower, "explode revoke changed"
    assert PREVIOUS_EXPLODE_GRANT.lower() in lower, "explode grant changed"

    # Exactly the two sku_cogs_version_formulations ingredient selects changed.
    assert explode.count(RESOLVE_CALL) == 2, "expected exactly two resolver substitutions"
    reverted = explode.replace(RESOLVE_CALL, "f.ingredient_sku_id")
    assert normalize_sql(reverted) == normalize_sql(previous_explode), (
        "explode changed beyond the cogs_resolve_child_sku substitutions"
    )
    # sku_formulations selects are untouched.
    sku_formulations_selects = re.findall(
        r"select\s+f\.id,\s*f\.canonical_material_id,\s*f\.ingredient_sku_id,"
        r"\s*f\.ingredient_name,\s*f\.unit,\s*f\.dosage_qty,\s*f\.wastage_percent,"
        r"\s*f\.sort_order\s+from\s+public\.sku_formulations\s+f",
        explode,
        re.IGNORECASE | re.S,
    )
    assert len(sku_formulations_selects) == 2, "sku_formulations selects must stay unchanged"
    assert "public.cogs_resolve_child_sku" not in " ".join(sku_formulations_selects)

    # --- 4. No stock ledger update/delete ---------------------------------
    for table in ("q7_inventory_movements", "tan_tao_material_movements"):
        assert not re.search(
            rf"\b(?:update|delete\s+from)\s+(?:public\.)?{table}\b",
            sql,
            re.IGNORECASE,
        ), f"migration must not update or delete {table}"

    print("PASS: cogs sub-recipe autolink contracts hold")


if __name__ == "__main__":
    main()
