#!/usr/bin/env python3
"""Static contract checks for the material link review speed-up migration.

These checks never connect to a database or Supabase. They guard that migration
20261101200000_material_link_review_speed.sql keeps the public contract of
public.material_link_review_items_internal(p_location text) while moving the
expensive per-material work out of the item loop:

  * the migration CREATE OR REPLACEs the function with the same signature and
    keeps language plpgsql / stable / security definer;
  * q7_material_name_similarity is evaluated exactly once inside the function;
  * material_link_material_skus and q7_unit_status are NOT called inside the item
    FOR loop (they are precomputed before it);
  * the revoke execute line is present;
  * the rollback-only smoke file exists with the old/new diff and timing checks.

Everything here is a text assertion; it does not prove runtime behaviour.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101200000_material_link_review_speed.sql"
SMOKE = SCRIPTS / "smoke_material_link_review_speed.sql"

FUNCTION_MARKER = "create or replace function public.material_link_review_items_internal("
LOOP_START = "for v_i in 1 .. v_item_count loop"
LOOP_END = "end loop;"

REVOKE_LINE = (
    "revoke execute on function public.material_link_review_items_internal(text) "
    "from public, anon, authenticated, service_role;"
)


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
    assert_true(
        FUNCTION_MARKER in migration,
        "migration must CREATE OR REPLACE public.material_link_review_items_internal",
    )

    function_def = extract_function(migration, FUNCTION_MARKER)
    header = function_def[: function_def.index("as $")]
    assert_true(
        "p_location text" in header,
        "the review function must keep the p_location text signature",
    )
    assert_true("language plpgsql" in header, "the review function must stay plpgsql")
    assert_true("stable" in header, "the review function must stay stable")
    assert_true(
        "security definer" in header,
        "the review function must stay security definer",
    )
    assert_true(
        "set search_path = public, extensions, pg_temp" in header,
        "the review function must keep its search_path",
    )

    occurrences = function_def.count("q7_material_name_similarity")
    assert_true(
        occurrences == 1,
        "q7_material_name_similarity must be evaluated exactly once, "
        f"found {occurrences}",
    )

    assert_true(LOOP_START in function_def, "the item FOR loop marker is missing")
    loop_start = function_def.index(LOOP_START)
    loop_end = function_def.index(LOOP_END, loop_start) + len(LOOP_END)
    loop_body = function_def[loop_start:loop_end]
    assert_true(
        "material_link_material_skus" not in loop_body,
        "material_link_material_skus must be called before the item loop, not inside it",
    )
    assert_true(
        "q7_unit_status" not in loop_body,
        "q7_unit_status must be called before the item loop, not inside it",
    )
    # The precomputed material set must actually use those helpers before the loop.
    pre_loop = function_def[:loop_start]
    assert_true(
        "material_link_material_skus" in pre_loop,
        "the pre-loop material set must still compute fed SKUs",
    )
    assert_true(
        "q7_unit_status" in pre_loop,
        "the pre-loop unit-status map must still call q7_unit_status",
    )

    assert_true(
        canon(REVOKE_LINE) in canon(migration),
        "the function must keep its revoke execute line",
    )

    # --- smoke file -----------------------------------------------------------
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    smoke = read(SMOKE)
    for needle in (
        "pg_temp.old_review",
        "SMOKE FAIL diff",
        "SMOKE FAIL slow",
        "rollback",
    ):
        assert_true(needle in smoke, f"smoke must contain {needle!r}")
    assert_true(
        "begin;" in smoke.lower(),
        "smoke must open one transaction",
    )
    assert_true(
        "commit;" not in smoke.lower(),
        "smoke must not commit",
    )

    print("PASS: material link review speed contracts hold")


if __name__ == "__main__":
    main()
