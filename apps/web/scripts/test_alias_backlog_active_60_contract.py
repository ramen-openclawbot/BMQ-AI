#!/usr/bin/env python3
"""Static contract checks for the alias-backlog active-60 migration.

These checks never connect to a database or Supabase. They guard that migration
20261025100000_alias_backlog_active_60.sql:

  * replaces public.get_material_alias_backlog(text, integer) and
    public.get_material_alias_backlog_review(text, integer) with
    CREATE OR REPLACE (never DROP) and the exact same signature / return type;
  * keeps the existing 90-day line window and adds the 60-day activity rule
    before ORDER BY / LIMIT, using the Asia/Ho_Chi_Minh date;
  * leaves everything else byte-for-byte identical once the new 60-day rule
    lines and whitespace are removed;
  * re-issues the same REVOKE / GRANT statements and never writes
    (insert / update / delete) inside either function.
It also checks the rollback-only smoke test inlines the migration and covers the
before / after assertions for q7 and tan_tao.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261025100000_alias_backlog_active_60.sql"
BACKLOG_PREVIOUS = MIGRATIONS / "20261019100000_purchase_must_stock.sql"
REVIEW_PREVIOUS = MIGRATIONS / "20261022100000_shared_catalog_units.sql"
SMOKE = SCRIPTS / "smoke_alias_backlog_active_60.sql"

BACKLOG = "function public.get_material_alias_backlog("
REVIEW = "function public.get_material_alias_backlog_review("

RULE_MARKERS = ("- 60", "receipt_date as receipt_date")


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


def normalize_body(body: str) -> str:
    """Drop the lines that carry the new 60-day rule, then all whitespace."""
    lines = [
        line
        for line in body.splitlines()
        if all(marker not in line for marker in RULE_MARKERS)
    ]
    return re.sub(r"\s+", "", "\n".join(lines))


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261025100000_alias_backlog_active_60.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. the two functions are replaced, never dropped --------------------
    assert_true(
        "create or replace function public.get_material_alias_backlog(" in lower,
        "migration must CREATE OR REPLACE get_material_alias_backlog",
    )
    assert_true(
        "create or replace function public.get_material_alias_backlog_review(" in lower,
        "migration must CREATE OR REPLACE get_material_alias_backlog_review",
    )
    assert_true(
        "drop function" not in lower,
        "migration must not DROP either function",
    )

    # --- 2. body equality vs the previous definitions ------------------------
    new_backlog_header, new_backlog_body = extract_function(migration, BACKLOG)
    old_backlog_header, old_backlog_body = extract_function(
        read(BACKLOG_PREVIOUS), BACKLOG
    )
    assert_true(
        normalize_header(new_backlog_header) == normalize_header(old_backlog_header),
        "get_material_alias_backlog signature / return type changed",
    )
    assert_true(
        normalize_body(new_backlog_body) == normalize_body(old_backlog_body),
        "get_material_alias_backlog changed beyond the 60-day rule",
    )

    new_review_header, new_review_body = extract_function(migration, REVIEW)
    old_review_header, old_review_body = extract_function(read(REVIEW_PREVIOUS), REVIEW)
    assert_true(
        normalize_header(new_review_header) == normalize_header(old_review_header),
        "get_material_alias_backlog_review signature / return type changed",
    )
    assert_true(
        normalize_body(new_review_body) == normalize_body(old_review_body),
        "get_material_alias_backlog_review changed beyond the 60-day rule",
    )

    # --- 3. the 60-day rule itself -------------------------------------------
    for name, body, after in (
        ("get_material_alias_backlog", new_backlog_body, "order by count(*) desc"),
        ("get_material_alias_backlog_review", new_review_body, "ordered as ("),
    ):
        assert_true("- 60" in body, f"{name} must contain the literal '- 60'")
        assert_true("- 90" in body, f"{name} must keep the 90-day line window")
        assert_true(
            "now() at time zone 'Asia/Ho_Chi_Minh'" in body,
            f"{name} must use the Asia/Ho_Chi_Minh date",
        )
        rule_at = body.index("- 60")
        after_at = body.lower().index(after)
        assert_true(
            rule_at < after_at,
            f"{name} must apply the 60-day rule before the order / limit",
        )

    # --- 4. grants and read-only surface -------------------------------------
    for line in (
        "revoke all on function public.get_material_alias_backlog(text, integer) "
        "from public, anon, authenticated;",
        "grant execute on function public.get_material_alias_backlog(text, integer) "
        "to service_role;",
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
    for name, body in (
        ("get_material_alias_backlog", new_backlog_body),
        ("get_material_alias_backlog_review", new_review_body),
    ):
        assert_true(
            re.search(r"\b(insert|update|delete)\b", body, re.IGNORECASE) is None,
            f"{name} must be read-only (no insert / update / delete)",
        )

    # --- 5. smoke test -------------------------------------------------------
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
        smoke.index("smoke_alias_before") < smoke.index(migration.strip()),
        "smoke must capture the previous review rows before applying the migration",
    )
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    for step in (
        "review_active_60",
        "review_count",
        "review_no_new_names",
        "backlog_active_60",
        "pending_match",
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

    print("PASS: alias backlog active-60 contracts hold")


if __name__ == "__main__":
    main()
