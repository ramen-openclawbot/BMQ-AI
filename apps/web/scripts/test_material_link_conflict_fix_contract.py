#!/usr/bin/env python3
"""Static contract checks for the material-link conflict fix migration.

These checks never connect to a database or Supabase. They guard that migration
20261101210000_material_link_conflict_fix.sql keeps the public contracts while
fixing the live 409 conflicts:

  * q7_link_item_material_internal no longer RAISES material_name_conflict /
    material_alias_conflict, reports alias_skipped / alias_owner_material_code,
    and keeps its 6-arg signature + security definer + search_path;
  * link_exact_materials iterates jsonb_array_elements(v_review -> 'items');
  * material_link_review_items_internal carries the owner's stopword list and
    the 'huongduong' merge in its same-unit word rule;
  * material_link_counts_internal exists, is stable / security definer and is
    revoked from every role, and mission_evaluate's material_links_done branch
    uses it;
  * the internal revoke lines are kept;
  * the rollback-only smoke file exists.

Everything here is a text assertion; it does not prove runtime behaviour.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101210000_material_link_conflict_fix.sql"
SMOKE = SCRIPTS / "smoke_material_link_conflict_fix.sql"

Q7_MARKER = "create or replace function public.q7_link_item_material_internal("
REVIEW_MARKER = "create or replace function public.material_link_review_items_internal("
EXACT_MARKER = "create or replace function public.link_exact_materials("
COUNTS_MARKER = "create or replace function public.material_link_counts_internal("
MISSION_MARKER = "create or replace function public.mission_evaluate("

STOPWORDS = [
    "thung", "khoi", "goi", "hop", "chai", "binh", "bich", "tui", "bao", "can",
    "cay", "cuon", "lon", "hu", "kg", "gr", "gram", "ml", "lit", "l", "g",
    "cai", "chiec", "loai", "dac", "biet", "nhap", "khau", "nuoc", "x", "va",
    "voi", "cho", "lam", "banh", "mi", "lat", "trang", "den", "tuoi", "xop",
]

REVOKE_LINES = [
    "revoke execute on function public.resolve_canonical_material(text, text, text, uuid, text, date, text[]) from public, anon;",
    "revoke execute on function public.q7_link_item_material_internal(uuid, uuid, boolean, uuid, numeric, boolean) from public, anon, authenticated, service_role;",
    "revoke execute on function public.link_exact_materials(text, uuid) from public, anon;",
    "revoke execute on function public.material_link_review_items_internal(text) from public, anon, authenticated, service_role;",
    "revoke execute on function public.material_link_counts_internal(text) from public, anon, authenticated, service_role;",
    "revoke all on function public.mission_evaluate(uuid) from public, anon, authenticated;",
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
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    migration = read(MIGRATION)

    # --- 1. q7_link_item_material_internal: no conflict raises, alias skip ----
    assert_true(
        Q7_MARKER in migration,
        "migration must CREATE OR REPLACE public.q7_link_item_material_internal",
    )
    q7_def = extract_function(migration, Q7_MARKER)
    assert_true("p_defer_factor boolean default false" in canon(q7_def),
                "the linking core must keep its 6-arg signature")
    assert_true("language plpgsql" in q7_def, "the linking core must stay plpgsql")
    assert_true("security definer" in q7_def,
                "the linking core must stay security definer")
    assert_true("set search_path = public, pg_temp" in q7_def,
                "the linking core must keep its search_path")
    assert_true(
        re.search(r"raise\s+exception\s+'material_name_conflict'", q7_def, re.IGNORECASE) is None,
        "q7_link_item_material_internal must not raise material_name_conflict",
    )
    assert_true(
        re.search(r"raise\s+exception\s+'material_alias_conflict'", q7_def, re.IGNORECASE) is None,
        "q7_link_item_material_internal must not raise material_alias_conflict",
    )
    assert_true("alias_skipped" in q7_def,
                "the linking core result must report alias_skipped")
    assert_true("alias_owner_material_code" in q7_def,
                "the linking core result must report alias_owner_material_code")
    assert_true("force_material_id" in q7_def,
                "the linking core must force the picked material through the controller")

    # --- 2. link_exact_materials iterates the items array ---------------------
    assert_true(EXACT_MARKER in migration,
                "migration must keep public.link_exact_materials")
    exact_def = extract_function(migration, EXACT_MARKER)
    assert_true("-> 'items'" in exact_def,
                "link_exact_materials must iterate v_review -> 'items'")
    assert_true("jsonb_array_elements(v_review -> 'items')" in canon(exact_def),
                "link_exact_materials must feed the items array to jsonb_array_elements")

    # --- 3. review same-unit word rule ---------------------------------------
    assert_true(REVIEW_MARKER in migration,
                "migration must CREATE OR REPLACE public.material_link_review_items_internal")
    review_def = extract_function(migration, REVIEW_MARKER)
    assert_true("huongduong" in review_def,
                "the review word rule must merge 'huong duong' into 'huongduong'")
    for word in STOPWORDS:
        assert_true(
            f"'{word}'" in review_def,
            f"the review stopword list must contain {word!r}",
        )
    review_canon = canon(review_def)
    assert_true("shared_words >= 2" in review_canon,
                "the review must accept same-unit candidates with >= 2 shared words")
    assert_true("shared_words >= 1 and g.score >= 0.1" in review_canon,
                "the review must accept same-unit candidates with 1 shared word and score >= 0.1")
    assert_true("material_master_normalize" in review_def,
                "the review must include the material whose normalized_name matches the item")

    # --- 4. material_link_counts_internal + mission branch -------------------
    assert_true(COUNTS_MARKER in migration,
                "migration must define public.material_link_counts_internal")
    counts_def = extract_function(migration, COUNTS_MARKER)
    counts_header = counts_def[: counts_def.index("as $")]
    assert_true("p_location text" in counts_header,
                "material_link_counts_internal must take p_location text")
    assert_true("stable" in counts_header,
                "material_link_counts_internal must be stable")
    assert_true("security definer" in counts_header,
                "material_link_counts_internal must be security definer")
    assert_true("set search_path = public, extensions, pg_temp" in counts_header,
                "material_link_counts_internal must keep the extensions search_path")
    for key in ("total", "linked_total", "exact", "skipped"):
        assert_true(f"'{key}'" in counts_def,
                    f"material_link_counts_internal must return {key!r}")

    assert_true(MISSION_MARKER in migration,
                "migration must keep public.mission_evaluate")
    mission_def = extract_function(migration, MISSION_MARKER)
    assert_true("material_link_counts_internal" in mission_def,
                "mission_evaluate's material_links_done branch must use counts_internal")
    assert_true("material_links_done" in mission_def,
                "mission_evaluate must keep the material_links_done branch")

    # --- 5. revoke lines kept ------------------------------------------------
    for line in REVOKE_LINES:
        assert_true(canon(line) in canon(migration), f"missing revoke line: {line}")

    # --- 6. rollback-only smoke ----------------------------------------------
    smoke = read(SMOKE)
    for needle in ("SMOKE PASS", "rollback", "material_name_conflict",
                   "material_alias_conflict", "alias_skipped", "get_my_missions"):
        assert_true(needle in smoke, f"smoke must contain {needle!r}")
    assert_true("begin;" in smoke.lower(), "smoke must open one transaction")
    assert_true("commit;" not in smoke.lower(), "smoke must not commit")

    print("PASS: material link conflict-fix contracts hold")


if __name__ == "__main__":
    main()
