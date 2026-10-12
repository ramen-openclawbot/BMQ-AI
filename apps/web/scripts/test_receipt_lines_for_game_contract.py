#!/usr/bin/env python3
"""Static contract checks for the Kho 2D receipt-lines migration.

These checks never connect to a database or Supabase. They guard that migration
20261028110000_receipt_lines_for_game.sql:

  * adds public.get_crate_receipt_lines(text, uuid, text, integer) and
    public.get_item_receipt_lines(uuid, integer) as SECURITY DEFINER, STABLE,
    search_path-pinned, read-only jsonb RPCs;
  * both gate on public.material_alias_can_admin(auth.uid()) / service_role and
    raise 42501 otherwise, and both clamp p_limit;
  * the crate RPC keeps exactly the backlog line rules (90-day window) while
    the item RPC joins stock_material_aliases with no day limit;
  * the two backlog functions of 20261025100000 / 20261027100000 (60-day rule,
    raw_unit) are NOT redefined;
  * neither RPC writes (insert / update / delete) and no 'supabase db push'
    appears.
It also checks the rollback-only smoke test inlines the migration and covers
the crate / image / alias / non-admin assertions.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261028110000_receipt_lines_for_game.sql"
SMOKE = SCRIPTS / "smoke_receipt_lines_for_game.sql"

HELPER = "create or replace function public.receipt_lines_for_game_base("
CRATE = "create or replace function public.get_crate_receipt_lines("
ITEM = "create or replace function public.get_item_receipt_lines("

BACKLOG_FUNCTIONS = (
    "get_material_alias_backlog_review",
    "get_material_alias_backlog",
)


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


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261028110000_receipt_lines_for_game.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()
    flat = re.sub(r"\s+", "", lower)

    # --- 1. the two RPCs exist with the documented signatures ----------------
    assert_true(CRATE in migration, "migration must CREATE get_crate_receipt_lines")
    assert_true(ITEM in migration, "migration must CREATE get_item_receipt_lines")
    assert_true(HELPER in migration, "migration must CREATE the shared line helper")

    crate_header, crate_body = extract_function(migration, CRATE)
    item_header, item_body = extract_function(migration, ITEM)

    for name, header, args in (
        (
            "get_crate_receipt_lines",
            crate_header,
            ["p_location text", "p_supplier_id uuid", "p_normalized_name text",
             "p_limit integer default 20"],
        ),
        (
            "get_item_receipt_lines",
            item_header,
            ["p_item_id uuid", "p_limit integer default 12"],
        ),
    ):
        flat_header = re.sub(r"\s+", " ", normalize(header))
        for arg in args:
            assert_true(
                normalize(arg) in flat_header,
                f"{name} must keep argument {arg}",
            )
        assert_true(
            "returns jsonb" in flat_header,
            f"{name} must return jsonb",
        )
        assert_true(
            "language plpgsql" in flat_header,
            f"{name} must be plpgsql",
        )
        assert_true(
            "security definer" in flat_header,
            f"{name} must be SECURITY DEFINER",
        )
        assert_true(
            "set search_path = public, pg_temp" in flat_header
            or "set search_path to 'public', 'pg_temp'" in flat_header,
            f"{name} must pin search_path",
        )

    # --- 2. authorization on both RPCs ---------------------------------------
    for name, body in (
        ("get_crate_receipt_lines", crate_body),
        ("get_item_receipt_lines", item_body),
    ):
        normalized_body = normalize(body)
        assert_true(
            "material_alias_can_admin" in normalized_body,
            f"{name} must call material_alias_can_admin",
        )
        assert_true(
            "auth.uid()" in normalized_body,
            f"{name} must read auth.uid()",
        )
        assert_true(
            "service_role" in normalized_body,
            f"{name} must allow service_role",
        )
        assert_true(
            "errcode = '42501'" in normalized_body,
            f"{name} must raise 42501 for a non-admin",
        )
        assert_true(
            "jsonb_agg" in normalized_body,
            f"{name} must aggregate its rows to jsonb",
        )
        assert_true(
            "order by t.receipt_date desc, t.receipt_number desc" in normalized_body,
            f"{name} must order by receipt_date desc, receipt_number desc",
        )
        assert_true(
            re.search(r"\b(insert|update|delete)\b", body, re.IGNORECASE) is None,
            f"{name} must be read-only (no insert / update / delete)",
        )

    # --- 3. limits ------------------------------------------------------------
    assert_true(
        "greatest(1, least(coalesce(p_limit, 20), 50))" in normalize(crate_body),
        "the crate RPC must clamp p_limit to 1..50",
    )
    assert_true(
        "greatest(1, least(coalesce(p_limit, 12), 30))" in normalize(item_body),
        "the item RPC must clamp p_limit to 1..30",
    )

    # --- 4. the crate RPC keeps the backlog line rules -----------------------
    crate_flat = normalize(crate_body)
    assert_true(
        "receipt_lines_for_game_base(90)" in crate_flat,
        "the crate RPC must use the shared 90-day line helper",
    )
    for needle in (
        "b.supplier_id is not distinct from p_supplier_id",
        "b.normalized_name = p_normalized_name",
        "b.location = p_location",
    ):
        assert_true(needle in crate_flat, f"the crate RPC must keep: {needle}")

    item_flat = normalize(item_body)
    assert_true(
        "receipt_lines_for_game_base(null)" in item_flat,
        "the item RPC must use the shared helper with no day limit",
    )
    for needle in (
        "join public.stock_material_aliases a",
        "a.location = b.location",
        "a.normalized_name = b.normalized_name",
        "a.supplier_id is not distinct from b.supplier_id",
        "a.kitchen_inventory_item_id = p_item_id",
    ):
        assert_true(needle in item_flat, f"the item RPC must keep: {needle}")

    # --- 5. the shared helper copies the backlog line rules exactly ----------
    _, helper_body = extract_function(migration, HELPER)
    helper_flat = normalize(helper_body)
    for needle in (
        "public.normalize_stock_item_name(",
        "coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)",
        "gr.status in ('confirmed', 'received')",
        "coalesce(s.stock_exempt, false) = false",
        "coalesce(gr.receiving_location, s.default_receiving_location, 'q7')",
        "public.stock_line_auto_non_stock(",
        "is null",
        "(now() at time zone 'asia/ho_chi_minh')::date - p_window_days",
        "nullif(btrim(gr.image_url), '') as image_path",
        "coalesce(gr.product_photos, '{}'::text[]) as photo_paths",
        "coalesce(gri.actual_quantity, gri.quantity)",
    ):
        assert_true(needle in helper_flat, f"the shared helper must keep: {needle}")

    # --- 6. the 60-day / 90-day backlog functions are NOT redefined ----------
    for function_name in BACKLOG_FUNCTIONS:
        assert_true(
            re.search(
                rf"create(\s+or\s+replace)?\s+function\s+public\.{function_name}\b",
                lower,
            ) is None,
            f"migration must not redefine public.{function_name}",
        )

    # --- 7. grants, revokes and the read-only surface ------------------------
    for line in (
        "revoke all on function public.get_crate_receipt_lines(text, uuid, text, integer) "
        "from public, anon;",
        "grant execute on function public.get_crate_receipt_lines(text, uuid, text, integer) "
        "to authenticated, service_role;",
        "revoke all on function public.get_item_receipt_lines(uuid, integer) from public, anon;",
        "grant execute on function public.get_item_receipt_lines(uuid, integer) "
        "to authenticated, service_role;",
    ):
        assert_true(line in lower, f"migration must re-issue: {line}")

    assert_true(
        "supabase db push" not in lower,
        "the migration must not contain 'supabase db push'",
    )

    # --- 8. smoke test --------------------------------------------------------
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
    assert_true(
        "SMOKE_RESULT PASS: receipt lines for game" in smoke,
        "smoke must end with the exact PASS message",
    )
    for step in (
        "crate_count",
        "crate_membership",
        "image_path_missing",
        "item_alias_map",
        "non_admin_allowed",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate the real owner through auth claims",
    )
    assert_true("'tan_tao'" in smoke, "smoke must use the Tân Tạo crates")
    assert_true(
        "get_material_alias_backlog_review('tan_tao', 200)" in smoke,
        "smoke must take the first crates from the backlog review",
    )
    assert_true(
        "get_crate_receipt_lines" in smoke and "get_item_receipt_lines" in smoke,
        "smoke must exercise both receipt-line RPCs",
    )
    assert_true(
        "insufficient_privilege" in smoke,
        "smoke must catch the 42501 non-admin failure",
    )

    print("PASS: receipt lines for game contracts hold")


if __name__ == "__main__":
    main()
