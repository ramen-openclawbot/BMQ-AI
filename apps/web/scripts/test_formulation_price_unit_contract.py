#!/usr/bin/env python3
"""Static contract checks for 20261103320000_formulation_price_unit.sql.

No database connection.  These checks guard the price-unit slice:
  * sku_formulations and sku_cogs_version_formulations gain a nullable
    price_unit with a normalize_document_unit check;
  * save_sku_cogs is the 20261103150000 body plus exactly the price_unit
    column/value additions, with the same signature/security/search_path;
  * there is no top-level UPDATE or backfill, no trigger change, and the
    function grants are unchanged;
  * cogs_explode_revenue and run_cogs_backflush are untouched.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (
    ROOT
    / "supabase"
    / "migrations"
    / "20261103320000_formulation_price_unit.sql"
)
PREVIOUS_SAVE = (
    ROOT
    / "supabase"
    / "migrations"
    / "20261103150000_formulation_dosage_unit.sql"
)

SAVE_MARKER = "create or replace function public.save_sku_cogs"

SAVE_REVOKE = (
    "revoke all on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) "
    "from public, anon, service_role;"
)
SAVE_GRANT = (
    "grant execute on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) "
    "to authenticated;"
)

COLUMN_CHECK = (
    "check (price_unit is null or "
    "public.normalize_document_unit(price_unit) is not null)"
)

SAVE_ADDITIONS = (
    (
        "canonical_default_unit, standard_unit_price, standard_price_id, dosage_unit, price_unit)",
        "canonical_default_unit, standard_unit_price, standard_price_id, dosage_unit)",
    ),
    (
        "(v_apply->>'price_id')::uuid, nullif(btrim(item->>'dosage_unit'),''), "
        "nullif(btrim(item->>'price_unit'),''))",
        "(v_apply->>'price_id')::uuid, nullif(btrim(item->>'dosage_unit'),''))",
    ),
    (
        "sort_order, canonical_material_snapshot, dosage_unit, price_unit)",
        "sort_order, canonical_material_snapshot, dosage_unit)",
    ),
    (
        "'published_at', now()),\n    f.dosage_unit, f.price_unit\n  from",
        "'published_at', now()),\n    f.dosage_unit\n  from",
    ),
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"--[^\n]*", "", text)


def normalize_sql(text: str) -> str:
    text = strip_comments(text)
    return re.sub(r"\s+", " ", text).strip().lower()


def function_span(text: str, marker: str) -> tuple[int, int]:
    lower = text.lower()
    start = lower.index(marker.lower())
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert match is not None, f"no AS dollar-quote after {marker}"
    tag = match.group(1)
    end = text.index(tag + ";", start + match.end())
    return start, end + len(tag) + 1


def extract_function(text: str, marker: str) -> str:
    start, end = function_span(text, marker)
    return text[start:end]


def strip_function_bodies(text: str) -> str:
    start, end = function_span(text, SAVE_MARKER)
    return text[:start] + text[end:]


def function_name(body: str) -> str:
    match = re.search(r"function\s+public\.([a-z0-9_]+)\s*\(", body, re.IGNORECASE)
    assert match is not None
    return match.group(1)


def main() -> None:
    assert MIGRATION.exists(), f"missing migration {MIGRATION.name}"
    migration = read(MIGRATION)
    previous_save = read(PREVIOUS_SAVE)
    sql_norm = normalize_sql(migration)

    # --- 1. Columns and checks -------------------------------------------
    for table in ("sku_formulations", "sku_cogs_version_formulations"):
        assert (
            f"alter table public.{table} add column if not exists price_unit text;"
            in sql_norm
        ), f"{table} must gain a nullable price_unit text column"
    assert sql_norm.count(COLUMN_CHECK) == 2, (
        "both tables need the price_unit normalize check"
    )
    for constraint in (
        "sku_formulations_price_unit_check",
        "sku_cogs_version_formulations_price_unit_check",
    ):
        assert f"conname = '{constraint}'" in sql_norm, (
            f"missing constraint guard for {constraint}"
        )

    # --- 2. save_sku_cogs is the old body plus only price_unit ------------
    save = extract_function(migration, SAVE_MARKER)
    old_save = extract_function(previous_save, SAVE_MARKER)
    assert function_name(save) == "save_sku_cogs"
    assert save.count("price_unit") == 4, (
        "unexpected save_sku_cogs price_unit edits"
    )

    restored_save = save
    for addition, original in SAVE_ADDITIONS:
        assert addition in restored_save, f"missing save addition: {addition}"
        restored_save = restored_save.replace(addition, original, 1)
    assert normalize_sql(restored_save) == normalize_sql(old_save), (
        "save_sku_cogs changed beyond the price_unit column/value additions"
    )

    # The function signature, security and search_path are part of that body.
    for clause in (
        "returns table(saved_sku_id uuid, version_id uuid, version_no integer)",
        "language plpgsql",
        "security definer",
        "set search_path = public, pg_temp",
    ):
        assert normalize_sql(clause) in sql_norm, f"save_sku_cogs clause changed: {clause}"

    # --- 3. Only the narrow price_unit backfill (g/ml dosage on a kg/l line) --
    dml_norm = normalize_sql(strip_function_bodies(migration))
    updates = re.findall(r"update public\.([a-z_]+) set (.*?) where (.*?);", dml_norm)
    assert [u[0] for u in updates] == ["sku_cogs_version_formulations", "sku_formulations"], updates
    for _, assignment, condition in updates:
        assert assignment.strip() == "price_unit = unit", assignment
        assert "price_unit is null" in condition
        assert "normalize_document_unit(dosage_unit) in ('g', 'ml')" in condition
        assert "normalize_document_unit(unit) in ('kg', 'l')" in condition
    assert "insert into" not in dml_norm, (
        "migration must not run a top-level INSERT/backfill"
    )

    # --- 4. Stock deduction functions are untouched -----------------------
    assert "cogs_explode_revenue" not in sql_norm, (
        "migration must not touch cogs_explode_revenue"
    )
    assert "run_cogs_backflush" not in sql_norm, (
        "migration must not touch run_cogs_backflush"
    )

    # --- 5. Grants unchanged ---------------------------------------------
    for grant_line in (SAVE_REVOKE, SAVE_GRANT):
        assert normalize_sql(grant_line) in sql_norm, f"grant changed: {grant_line}"
    assert sql_norm.count("revoke all on function") == 1, "unexpected function revokes"
    assert sql_norm.count("grant execute on function") == 1, "unexpected function grants"

    # --- 6. No trigger is created, altered, dropped or disabled ----------
    assert not re.search(
        r"\b(create|alter|drop|disable|enable)\s+trigger\b", sql_norm
    ), "migration must not change a trigger"
    assert not re.search(r"session_replication_role", sql_norm), (
        "migration must not bypass triggers via session_replication_role"
    )

    # --- 7. Protected columns are never assigned --------------------------
    for column in ("unit_price", "dosage_qty", "unit"):
        assert not re.search(
            rf"(?<![a-z0-9_]){column}\s*=", dml_norm
        ), f"migration must never update {column}"

    print("PASS: formulation price-unit contracts hold")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"FAIL: {exc}")
        raise SystemExit(1)
