#!/usr/bin/env python3
"""Static contract checks for the Jev whole-catalog options migration.

These checks never connect to a database or Supabase. They guard that:

  * the new migration 20261029100000_jev_catalog_options.sql defines
    public.material_alias_catalog_options(text) with CREATE OR REPLACE (never
    DROP), the exact candidate columns, SECURITY DEFINER and a pinned
    search_path;
  * the function is read-only (no insert / update / delete) and grants execute
    to service_role only (revoked from public, anon, authenticated);
  * the edge handler offers the catalog after the token candidates, caps the
    list at MATERIAL_ALIAS_MAX_CANDIDATES = 150 and bumps the prompt version;
  * the rollback-only smoke test inlines the migration and checks q7 / tan_tao
    plus the service_role / authenticated grant surface.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
FUNCTIONS = ROOT / "supabase" / "functions" / "stock-alias-jev"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261029130000_jev_catalog_options.sql"
HANDLER = FUNCTIONS / "handler.ts"
JEV = FUNCTIONS / "jev.ts"
SMOKE = SCRIPTS / "smoke_jev_catalog_options.sql"

FUNCTION_MARKER = "function public.material_alias_catalog_options("


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def extract_function(text: str, marker: str) -> tuple[str, str]:
    """Return (header, body) for the function that starts at marker."""
    start = text.index(marker)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    header = text[start:start + match.start()]
    body_start = start + match.end()
    close = text.index(tag + ";", body_start)
    body = text[body_start:close]
    return header, body


def main() -> None:
    # --- 1. migration shape ---------------------------------------------------
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261029130000_jev_catalog_options.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    assert_true(
        "create or replace function public.material_alias_catalog_options(" in lower,
        "migration must CREATE OR REPLACE material_alias_catalog_options",
    )
    assert_true("drop function" not in lower, "migration must not DROP the function")
    assert_true("security definer" in lower, "the function must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in lower
        or "set search_path to 'public', 'pg_temp'" in lower,
        "the function must pin search_path to public, pg_temp",
    )
    assert_true("stable" in lower, "the function must be STABLE (read-only)")

    header, body = extract_function(migration, FUNCTION_MARKER)
    normalized_header = re.sub(r"\s+", " ", header).lower()
    for column in (
        "item_id uuid",
        "sku_id uuid",
        "name text",
        "unit text",
        "score numeric",
        "reason text",
    ):
        assert_true(column in normalized_header, f"return column missing: {column}")

    # --- 2. catalog rules ----------------------------------------------------
    assert_true("kii.pastry_q7 = true" in body, "q7 options must require pastry_q7")
    assert_true(
        "coalesce(kii.item_class, '') <> 'non_stock'" in body,
        "options must exclude item_class = 'non_stock'",
    )
    assert_true(
        "kii.merged_into_id is null" in body,
        "options must be unmerged items",
    )
    assert_true("kii.active = true" in body, "options must be active items")
    assert_true(
        "upper(ps.sku_code) in ('bmq-001', 'bmq-002', 'pate-500g', 'pate-200g')"
        in body.lower(),
        "tan_tao must reuse the finished-goods SKU filter",
    )
    assert_true("'catalog'" in body or '"catalog"' in body, "reason must be 'catalog'")
    assert_true("order by" in body.lower(), "the options must be ordered by name")

    # --- 3. grants and read-only surface -------------------------------------
    for line in (
        "revoke all on function public.material_alias_catalog_options(text) "
        "from public, anon, authenticated;",
        "grant execute on function public.material_alias_catalog_options(text) "
        "to service_role;",
    ):
        assert_true(line in lower, f"migration must re-issue: {line}")

    assert_true(
        "supabase db push" not in lower,
        "the migration must not contain 'supabase db push'",
    )
    assert_true(
        re.search(r"\b(insert|update|delete)\b", body, re.IGNORECASE) is None,
        "the function must be read-only (no insert / update / delete)",
    )

    # --- 4. edge function changes -------------------------------------------
    handler = read(HANDLER)
    assert_true(
        "MATERIAL_ALIAS_MAX_CANDIDATES = 150" in handler,
        "handler must raise MATERIAL_ALIAS_MAX_CANDIDATES to 150",
    )
    assert_true(
        "catalogOptions" in handler,
        "handler deps must expose catalogOptions",
    )
    assert_true(
        "mergeCandidateOptions" in handler,
        "handler must append the catalog after the token candidates",
    )
    assert_true(
        "catalog_size" in handler,
        "the backlog audit must report catalog_size",
    )
    store = read(FUNCTIONS / "store.ts")
    assert_true(
        'admin.rpc("material_alias_catalog_options"' in store,
        "store must call the material_alias_catalog_options RPC",
    )

    jev = read(JEV)
    assert_true(
        'JEV_PROMPT_VERSION = "jev-material-alias-2026-10-29.1"' in jev,
        "JEV_PROMPT_VERSION must be bumped to jev-material-alias-2026-10-29.1",
    )
    assert_true(
        "ý nghĩa" in jev and "OCR" in jev and "viết tắt" in jev,
        "the match prompt must ask Jev to choose by meaning (translation / abbreviation / OCR)",
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
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    assert_true("'q7'" in smoke, "smoke must check q7 options")
    assert_true("'tan_tao'" in smoke, "smoke must check tan_tao options")
    assert_true(
        "pastry_q7" in smoke,
        "smoke must assert every q7 option has pastry_q7 = true",
    )
    assert_true(
        "has_function_privilege" in smoke,
        "smoke must check the service_role / authenticated execute privilege",
    )
    assert_true(
        "authenticated" in smoke and "service_role" in smoke,
        "smoke must cover both service_role and authenticated",
    )
    assert_true(
        "SMOKE_RESULT PASS: jev catalog options" in smoke,
        "smoke must finish with the jev catalog options PASS marker",
    )

    print("PASS: jev catalog options contracts hold")


if __name__ == "__main__":
    main()
