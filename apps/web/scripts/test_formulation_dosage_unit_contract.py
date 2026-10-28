#!/usr/bin/env python3
"""Static contract checks for 20261103150000_formulation_dosage_unit.sql.

No database connection.  These checks guard the dosage-unit slice:
  * sku_formulations and sku_cogs_version_formulations gain a nullable
    dosage_unit with a normalize_document_unit check;
  * save_sku_cogs is the 20261028100000 body plus exactly the dosage_unit
    column/value additions, with the same signature/security/search_path;
  * cogs_explode_revenue is the 20261102660000 body plus exactly the
    coalesce(dosage_unit, unit) recipe-unit expression and the extra selected
    dosage_unit column in both loops;
  * the only top-level UPDATEs are the two TP-PATE dosage_unit backfills,
    guarded by the exact version id and dosage_unit is null;
  * the `unit` column is never assigned, no trigger is dropped or disabled, and
    grants are unchanged.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (
    ROOT
    / "supabase"
    / "migrations"
    / "20261103150000_formulation_dosage_unit.sql"
)
PREVIOUS_SAVE = (
    ROOT
    / "supabase"
    / "migrations"
    / "20261028100000_sku_cogs_seed_standard_cost.sql"
)
PREVIOUS_EXPLODE = (
    ROOT
    / "supabase"
    / "migrations"
    / "20261102660000_cogs_production_location.sql"
)

SAVE_MARKER = "create or replace function public.save_sku_cogs"
EXPLODE_MARKER = "create or replace function public.cogs_explode_revenue"

TP_PATE_VERSION_ID = "59b2950e-949f-4ab8-8b76-8d4c4eb642b2"

SAVE_REVOKE = (
    "revoke all on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) "
    "from public, anon, service_role;"
)
SAVE_GRANT = (
    "grant execute on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) "
    "to authenticated;"
)
EXPLODE_REVOKE = (
    "revoke all on function public.cogs_explode_revenue(date, date) "
    "from public, anon, authenticated;"
)
EXPLODE_GRANT = (
    "grant execute on function public.cogs_explode_revenue(date, date) to service_role;"
)

OLD_RECIPE_UNIT = "public.normalize_document_unit(f.unit) as recipe_unit"
NEW_RECIPE_UNIT = (
    "public.normalize_document_unit(coalesce(nullif(f.dosage_unit, ''), f.unit)) "
    "as recipe_unit"
)

FALLBACK_DECLARATION = "  v_unit_fallback record;\n"

EXACT_MAP_LOOKUP = """      if v_node.recipe_unit is not null then
        select m.action, m.location, m.kitchen_inventory_item_id, m.factor,
               m.status, m.evidence
          into v_map_action, v_map_location, v_map_item, v_map_factor,
               v_map_status, v_map_evidence
        from public.cogs_ingredient_stock_map m
        where m.canonical_material_id = v_node.canonical_material_id
          and m.recipe_unit = v_node.recipe_unit
        limit 1;
      end if;
"""

UNIT_FALLBACK_BLOCK = """      -- The map may be stored in another convertible unit (kg vs g).  Keep the
      -- exact lookup above first; only fall back for a missing, suggested or
      -- actionless row.
      if v_node.recipe_unit is not null
         and (v_map_status is null or v_map_status = 'suggested' or v_map_action is null) then
        select m.action, m.location, m.kitchen_inventory_item_id,
               public.stock_unit_line_factor(v_node.recipe_unit, m.recipe_unit) * m.factor as factor,
               m.status,
               coalesce(m.evidence, '{}'::jsonb)
                 || jsonb_build_object('unit_fallback_from', m.recipe_unit) as evidence
          into v_unit_fallback
        from public.cogs_ingredient_stock_map m
        where m.canonical_material_id = v_node.canonical_material_id
          and m.status in ('auto', 'confirmed')
          and m.action is not null
          and public.stock_unit_line_factor(v_node.recipe_unit, m.recipe_unit) is not null
        order by (m.status = 'confirmed') desc, m.recipe_unit, m.id
        limit 1;
        if found then
          v_map_action := v_unit_fallback.action;
          v_map_location := v_unit_fallback.location;
          v_map_item := v_unit_fallback.kitchen_inventory_item_id;
          v_map_factor := v_unit_fallback.factor;
          v_map_status := v_unit_fallback.status;
          v_map_evidence := v_unit_fallback.evidence;
        end if;
      end if;
"""

GAP_INGREDIENT_CHECK = """      if v_node.recipe_unit is null
         or v_map_status is null
         or v_map_status = 'suggested'
         or v_map_action is null then
"""


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
    for marker in (SAVE_MARKER, EXPLODE_MARKER):
        start, end = function_span(text, marker)
        text = text[:start] + text[end:]
    return text


def function_name(body: str) -> str:
    match = re.search(r"function\s+public\.([a-z0-9_]+)\s*\(", body, re.IGNORECASE)
    assert match is not None
    return match.group(1)


def main() -> None:
    assert MIGRATION.exists(), f"missing migration {MIGRATION.name}"
    migration = read(MIGRATION)
    previous_save = read(PREVIOUS_SAVE)
    previous_explode = read(PREVIOUS_EXPLODE)
    sql_norm = normalize_sql(migration)

    # --- 1. Columns and checks -------------------------------------------
    for table in ("sku_formulations", "sku_cogs_version_formulations"):
        assert (
            f"alter table public.{table} add column if not exists dosage_unit text;"
            in sql_norm
        ), f"{table} must gain a nullable dosage_unit text column"
    assert sql_norm.count(
        "check (dosage_unit is null or "
        "public.normalize_document_unit(dosage_unit) is not null)"
    ) == 2, "both tables need the dosage_unit normalize check"

    # --- 2. save_sku_cogs is the old body plus only dosage_unit -----------
    save = extract_function(migration, SAVE_MARKER)
    old_save = extract_function(previous_save, SAVE_MARKER)
    assert function_name(save) == "save_sku_cogs"
    assert save.count("dosage_unit") == 4, "unexpected save_sku_cogs dosage_unit edits"

    restored_save = save
    save_additions = (
        (
            "canonical_default_unit, standard_unit_price, standard_price_id, dosage_unit)",
            "canonical_default_unit, standard_unit_price, standard_price_id)",
        ),
        (
            "(v_apply->>'price_id')::uuid, nullif(btrim(item->>'dosage_unit'),''))",
            "(v_apply->>'price_id')::uuid)",
        ),
        (
            "sort_order, canonical_material_snapshot, dosage_unit)",
            "sort_order, canonical_material_snapshot)",
        ),
        (
            "'published_at', now()),\n    f.dosage_unit\n  from",
            "'published_at', now())\n  from",
        ),
    )
    for addition, original in save_additions:
        assert addition in restored_save, f"missing save addition: {addition}"
        restored_save = restored_save.replace(addition, original, 1)
    assert normalize_sql(restored_save) == normalize_sql(old_save), (
        "save_sku_cogs changed beyond the dosage_unit column/value additions"
    )

    # --- 3. cogs_explode_revenue is the old body plus the coalesce --------
    explode = extract_function(migration, EXPLODE_MARKER)
    old_explode = extract_function(previous_explode, EXPLODE_MARKER)
    assert function_name(explode) == "cogs_explode_revenue"
    assert explode.count(NEW_RECIPE_UNIT) == 2, (
        "both formulation loops must use coalesce(dosage_unit, unit)"
    )
    assert explode.count("f.unit, f.dosage_unit, f.dosage_qty") == 4, (
        "all four union branches must expose f.dosage_unit"
    )

    assert explode.count(FALLBACK_DECLARATION) == 1, (
        "fallback needs exactly one record declaration"
    )
    assert explode.lower().index("declare") < explode.index(
        FALLBACK_DECLARATION
    ) < explode.lower().index("\nbegin\n"), (
        "fallback record must be declared in the declare section"
    )

    assert explode.count(EXACT_MAP_LOOKUP) == 1, "exact map lookup changed"
    assert explode.count(UNIT_FALLBACK_BLOCK) == 1, (
        "convertible-unit fallback must appear exactly once"
    )
    exact_at = explode.index(EXACT_MAP_LOOKUP)
    fallback_at = explode.index(UNIT_FALLBACK_BLOCK)
    gap_at = explode.index(GAP_INGREDIENT_CHECK)
    assert exact_at < fallback_at < gap_at, (
        "fallback must sit after the exact lookup and before the gap check"
    )
    assert explode[exact_at + len(EXACT_MAP_LOOKUP):fallback_at].strip() == "", (
        "fallback must follow the exact lookup immediately"
    )
    assert explode[fallback_at + len(UNIT_FALLBACK_BLOCK):gap_at].strip() == "", (
        "fallback must precede the gap_ingredient check immediately"
    )

    fallback_lower = UNIT_FALLBACK_BLOCK.lower()
    fallback_select = fallback_lower[fallback_lower.index("select"):]
    assert "status in ('auto', 'confirmed')" in fallback_select, (
        "fallback must only use auto/confirmed maps"
    )
    assert "'suggested'" not in fallback_select, (
        "fallback must never select a suggested map"
    )
    assert "m.action is not null" in fallback_select, (
        "fallback must require a real action"
    )
    assert (
        "public.stock_unit_line_factor(v_node.recipe_unit, m.recipe_unit) * m.factor"
        in fallback_select
    ), "fallback factor must convert the recipe unit into the map unit"
    assert (
        "order by (m.status = 'confirmed') desc, m.recipe_unit, m.id"
        in fallback_select
    ), "fallback must be deterministic"
    assert "if found then" in fallback_select, (
        "a missing fallback must leave the exact-lookup values untouched"
    )
    assert (
        "jsonb_build_object('unit_fallback_from', m.recipe_unit)"
        in fallback_select
    ), "fallback evidence must record the source unit"

    restored_explode = explode.replace(UNIT_FALLBACK_BLOCK, "", 1)
    restored_explode = restored_explode.replace(FALLBACK_DECLARATION, "", 1)
    restored_explode = restored_explode.replace(NEW_RECIPE_UNIT, OLD_RECIPE_UNIT)
    restored_explode = restored_explode.replace(
        "f.unit, f.dosage_unit, f.dosage_qty", "f.unit, f.dosage_qty"
    )
    assert normalize_sql(restored_explode) == normalize_sql(old_explode), (
        "cogs_explode_revenue changed beyond the dosage_unit/fallback expressions"
    )

    # --- 4. Grants unchanged ---------------------------------------------
    for grant_line in (SAVE_REVOKE, SAVE_GRANT, EXPLODE_REVOKE, EXPLODE_GRANT):
        assert normalize_sql(grant_line) in sql_norm, f"grant changed: {grant_line}"
    assert sql_norm.count("revoke all on function") == 2, "unexpected function revokes"
    assert sql_norm.count("grant execute on function") == 2, "unexpected function grants"

    # --- 5. Only the two TP-PATE backfill UPDATEs -------------------------
    dml_norm = normalize_sql(strip_function_bodies(migration))
    updates = re.findall(r"\bupdate\s+public\.([a-z_]+)\b", dml_norm)
    assert updates == ["sku_cogs_version_formulations", "sku_formulations"], (
        f"unexpected top-level UPDATE targets: {updates}"
    )

    assert (
        f"v_version_id constant uuid := '{TP_PATE_VERSION_ID}'" in dml_norm
    ), "the TP-PATE version id must be the exact constant"
    assert dml_norm.count("version_id = v_version_id") == 2, (
        "both backfills must use the exact TP-PATE version id"
    )

    version_update = re.search(
        r"update public\.sku_cogs_version_formulations set (.*?) where (.*?);",
        dml_norm,
        re.S,
    )
    assert version_update, "missing sku_cogs_version_formulations backfill"
    assert version_update.group(1).strip() == "dosage_unit = 'kg'", (
        "version backfill may only set dosage_unit"
    )
    assert "dosage_unit is null" in version_update.group(2), (
        "version backfill must guard on dosage_unit is null"
    )
    assert "version_id = v_version_id" in version_update.group(2)

    formulation_update = re.search(
        r"update public\.sku_formulations set (.*?) where (.*?);",
        dml_norm,
        re.S,
    )
    assert formulation_update, "missing sku_formulations backfill"
    assert formulation_update.group(1).strip() == "dosage_unit = 'kg'", (
        "formulation backfill may only set dosage_unit"
    )
    assert "dosage_unit is null" in formulation_update.group(2), (
        "formulation backfill must guard on dosage_unit is null"
    )
    assert "version_id = v_version_id" in formulation_update.group(2)
    assert "source_formulation_id" in formulation_update.group(2)

    # The unit column is never assigned (dosage_unit does not match \bunit).
    assert not re.search(r"(?<![a-z0-9_])unit\s*=", dml_norm), (
        "migration must never update the unit column"
    )

    # --- 6. No trigger is dropped or disabled -----------------------------
    assert not re.search(r"\bdrop\s+trigger\b", sql_norm), (
        "migration must not drop a trigger"
    )
    assert not re.search(r"\bdisable\s+trigger\b", sql_norm), (
        "migration must not disable a trigger"
    )
    assert not re.search(r"session_replication_role", sql_norm), (
        "migration must not bypass triggers via session_replication_role"
    )
    assert "material_master.sku_cogs_save" in sql_norm, (
        "backfill must use the existing guard bypass setting"
    )

    print("PASS: formulation dosage-unit contracts hold")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print(f"FAIL: {exc}")
        raise SystemExit(1)
