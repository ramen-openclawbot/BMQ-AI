#!/usr/bin/env python3
"""Static contract checks for the backlog raw-unit migration.

These checks never connect to a database or Supabase. They guard that migration
20261027100000_backlog_raw_unit.sql:

  * drops public.get_material_alias_backlog_review(text, integer) because the
    RETURNS TABLE shape changes, then creates it again with the exact columns of
    the 20261025100000 definition plus raw_unit text and raw_units jsonb as the
    LAST two output columns;
  * keeps the body byte-for-byte identical to the 20261025100000 definition once
    the marked raw_unit / raw_units aggregation and output lines are removed, so
    the 90-day line window, the 60-day activity rule, the alias exclusion, the
    candidate / Jev columns, the ordering and the limits are untouched;
  * re-issues the same REVOKE / GRANT statements and never writes
    (insert / update / delete) inside the function.
It also checks the rollback-only smoke test inlines the migration and covers the
before / after assertions for q7 and tan_tao.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261027100000_backlog_raw_unit.sql"
PREVIOUS = MIGRATIONS / "20261025100000_alias_backlog_active_60.sql"
SMOKE = SCRIPTS / "smoke_backlog_raw_unit.sql"

REVIEW = "function public.get_material_alias_backlog_review("

OPEN_MARKERS = ("-- [raw-unit-agg]", "-- [raw-unit-out]")
CLOSE_MARKERS = ("-- [/raw-unit-agg]", "-- [/raw-unit-out]")
ALL_MARKERS = OPEN_MARKERS + CLOSE_MARKERS


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def extract_function(text: str, marker: str) -> tuple[str, str]:
    """Return (header, body) for the function that starts at marker.

    The header is everything from marker to the AS dollar-quote, the body is the
    SQL between the opening and closing dollar-quotes.
    """
    start = text.index(marker)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    header = text[start:start + match.start()]
    body_start = start + match.end()
    close = text.index(tag + ";", body_start)
    body = text[body_start:close]
    return header, body


def normalize_header(header: str) -> str:
    return re.sub(r"\s+", "", header).lower()


def return_columns(header: str) -> str:
    normalized = normalize_header(header)
    match = re.search(r"returnstable\((.*?)\)", normalized)
    assert_true(match is not None, "header must declare RETURNS TABLE")
    return match.group(1)


def strip_marked(body: str) -> str:
    """Drop the raw_unit / raw_units lines delimited by the migration markers."""
    kept: list[str] = []
    skipping = False
    for line in body.splitlines():
        stripped = line.strip()
        if stripped in OPEN_MARKERS:
            skipping = True
            continue
        if stripped in CLOSE_MARKERS:
            skipping = False
            continue
        if not skipping:
            kept.append(line)
    return "\n".join(kept)


def normalize_body(body: str) -> str:
    return re.sub(r"\s+", "", body)


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261027100000_backlog_raw_unit.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()
    flat = re.sub(r"\s+", "", lower)

    # --- 1. DROP + CREATE with the two trailing columns ----------------------
    assert_true(
        "drop function if exists public.get_material_alias_backlog_review(text, integer);"
        in lower,
        "migration must DROP get_material_alias_backlog_review(text, integer)",
    )
    assert_true(
        "create function public.get_material_alias_backlog_review(" in lower,
        "migration must CREATE get_material_alias_backlog_review",
    )
    assert_true(
        "create or replace function public.get_material_alias_backlog_review(" not in lower,
        "the changed return type must not use CREATE OR REPLACE",
    )
    assert_true(
        "create function public.get_material_alias_backlog(" not in lower,
        "only the review function may change; get_material_alias_backlog is untouched",
    )

    new_review_header, new_review_body = extract_function(migration, REVIEW)
    old_review_header, old_review_body = extract_function(read(PREVIOUS), REVIEW)

    old_cols = return_columns(old_review_header)
    new_cols = return_columns(new_review_header)
    assert_true(
        new_cols == old_cols + ",raw_unittext,raw_unitsjsonb",
        f"review must append raw_unit text, raw_units jsonb as the last columns; got {new_cols}",
    )

    # --- 2. body equality vs the 20261025 definition -------------------------
    for marker in ALL_MARKERS:
        assert_true(marker in new_review_body, f"missing aggregation/output marker {marker}")
    assert_true(
        normalize_body(strip_marked(new_review_body)) == normalize_body(old_review_body),
        "get_material_alias_backlog_review changed beyond the raw-unit additions",
    )

    # --- 3. the 60-day activity rule and the 90-day window stay --------------
    for needle in (
        "having max(l.receipt_date) >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 60",
        "gr.receipt_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90",
        "order by line_count desc, normalized_name asc",
        "limit greatest(1, least(coalesce(p_limit, 100), 500))",
    ):
        assert_true(needle in new_review_body, f"review must keep: {needle}")

    # --- 4. the new aggregation itself ---------------------------------------
    assert_true(
        "nullif(btrim(l2.raw_unit), '') as unit" in new_review_body,
        "the unit must be trimmed to null",
    )
    assert_true(
        "jsonb_build_object('unit', u.unit, 'line_count', u.unit_count)" in new_review_body,
        "raw_units must build {unit, line_count} objects",
    )
    assert_true(
        "order by u.unit_count desc, u.unit asc nulls last" in new_review_body,
        "raw_units must be ordered by count desc then unit asc",
    )
    assert_true(
        "order by u.unit_count desc, u.latest desc, u.unit asc nulls last" in new_review_body,
        "raw_unit must break count ties by the latest receipt_date",
    )
    assert_true(
        "where u.unit is not null" in new_review_body,
        "raw_unit must ignore blank units (null only when all are blank)",
    )

    # --- 5. grants and read-only surface -------------------------------------
    for line in (
        "revoke all on function public.get_material_alias_backlog_review(text, integer) "
        "from public, anon;",
        "grant execute on function public.get_material_alias_backlog_review(text, integer) "
        "to authenticated, service_role;",
    ):
        assert_true(line in lower, f"migration must re-issue: {line}")

    assert_true(
        "supabase db push" not in lower,
        "the migration must not contain 'supabase db push'",
    )
    assert_true(
        re.search(r"\b(insert|update|delete)\b", new_review_body, re.IGNORECASE) is None,
        "get_material_alias_backlog_review must be read-only (no insert / update / delete)",
    )

    # --- 6. smoke test -------------------------------------------------------
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true("rollback;" not in smoke_lower, "smoke must roll back via the final RAISE")
    assert_true("commit;" not in smoke_lower, "smoke must not commit")
    assert_true(
        migration.strip() in smoke,
        "smoke must inline the migration byte-for-byte (regenerate it when the migration changes)",
    )
    assert_true(
        smoke.index("smoke_backlog_raw_before") < smoke.index(migration.strip()),
        "smoke must capture the previous review rows before applying the migration",
    )
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    for step in (
        "review_same_rows",
        "review_order",
        "raw_unit_mode",
        "raw_units_sum",
        "snapshot_keys",
        "PACK-style",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")
    assert_true(
        "from public.user_roles" in smoke and "role::text = 'owner'" in smoke,
        "smoke must take the owner from public.user_roles",
    )
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate the real owner through auth claims",
    )
    assert_true(
        "'tan_tao'" in smoke and "'q7'" in smoke,
        "smoke must check both locations",
    )
    assert_true(
        "jsonb_array_elements(public.get_warehouse_game_snapshot(v_loc) -> 'pending')" in smoke,
        "smoke must read the snapshot pending objects",
    )

    print("PASS: backlog raw-unit contracts hold")


if __name__ == "__main__":
    main()
