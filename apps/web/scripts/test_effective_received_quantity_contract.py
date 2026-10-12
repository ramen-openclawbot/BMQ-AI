#!/usr/bin/env python3
"""Static contract checks for the effective received quantity migration.

These checks never connect to a database or Supabase. They guard that migration
20261029150000_effective_received_quantity.sql:

  * adds public.goods_receipt_effective_quantity(numeric, numeric, numeric, text)
    as an IMMUTABLE SQL helper with the exact coalesce order
    coalesce(actual, nullif(quantity, 0), ordered) for a confirmed / received
    parent and coalesce(actual, quantity) otherwise;
  * redefines public.get_crate_receipt_lines, public.get_item_receipt_lines and
    public.post_stock_goods_receipt_item with identical signatures / return
    types, and all three call the helper;
  * post_stock_goods_receipt_item keeps the (uuid, public.stock_material_aliases)
    signature, the tan_tao cutover check, the stock_transfers write and every
    idempotency key used by the Tân Tạo -> Q7 transfer;
  * the migration never updates goods_receipt_items rows and never contains
    'supabase db push';
  * the header lists the other SQL readers with a decision.
It also checks the rollback-only smoke test inlines the migration and covers the
helper, crate, posting and q7-count assertions.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261029150000_effective_received_quantity.sql"
SMOKE = SCRIPTS / "smoke_effective_received_quantity.sql"

HELPER = "create or replace function public.goods_receipt_effective_quantity("
CRATE = "create or replace function public.get_crate_receipt_lines("
ITEM = "create or replace function public.get_item_receipt_lines("
POST = "create or replace function public.post_stock_goods_receipt_item("

ALIGNED = (CRATE, ITEM, POST)


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
        MIGRATION.name == "20261029150000_effective_received_quantity.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()
    flat = re.sub(r"\s+", "", lower)

    # --- 1. the helper and its exact definition ------------------------------
    assert_true(HELPER in migration, "migration must CREATE the effective-quantity helper")
    helper_header, helper_body = extract_function(migration, HELPER)
    helper_flat = normalize(helper_header)
    assert_true("returns numeric" in helper_flat, "helper must return numeric")
    assert_true("language sql" in helper_flat, "helper must be language sql")
    assert_true("immutable" in helper_flat, "helper must be IMMUTABLE")

    helper_norm = normalize(helper_body)
    assert_true(
        "p_status in ('confirmed', 'received')" in helper_norm,
        "helper must branch on status confirmed / received",
    )
    assert_true(
        "coalesce(p_actual, nullif(p_quantity, 0), p_ordered)" in helper_norm,
        "helper must use coalesce(actual, nullif(quantity, 0), ordered)",
    )
    assert_true(
        "coalesce(p_actual, p_quantity)" in helper_norm,
        "helper must fall back to coalesce(actual, quantity)",
    )

    # --- 2. the three redefined functions use the helper ---------------------
    crate_header, crate_body = extract_function(migration, CRATE)
    item_header, item_body = extract_function(migration, ITEM)
    post_header, post_body = extract_function(migration, POST)

    for name, body in (
        ("get_crate_receipt_lines", crate_body),
        ("get_item_receipt_lines", item_body),
        ("post_stock_goods_receipt_item", post_body),
    ):
        assert_true(
            "public.goods_receipt_effective_quantity(" in normalize(body),
            f"{name} must call goods_receipt_effective_quantity",
        )

    # --- 3. signatures / return types / security stay identical --------------
    for name, header, args, returns in (
        (
            "get_crate_receipt_lines",
            crate_header,
            ["p_location text", "p_supplier_id uuid", "p_normalized_name text",
             "p_limit integer default 20"],
            "returns jsonb",
        ),
        (
            "get_item_receipt_lines",
            item_header,
            ["p_item_id uuid", "p_limit integer default 12"],
            "returns jsonb",
        ),
        (
            "post_stock_goods_receipt_item",
            post_header,
            ["p_item_id uuid", "p_alias public.stock_material_aliases"],
            "returns boolean",
        ),
    ):
        flat_header = re.sub(r"\s+", " ", normalize(header))
        for arg in args:
            assert_true(
                normalize(arg) in flat_header,
                f"{name} must keep argument {arg}",
            )
        assert_true(returns in flat_header, f"{name} must keep {returns}")
        assert_true("security definer" in flat_header, f"{name} must be SECURITY DEFINER")
        assert_true(
            "set search_path = public, pg_temp" in flat_header
            or "set search_path to 'public', 'pg_temp'" in flat_header,
            f"{name} must pin search_path",
        )

    # --- 4. post keeps the Tân Tạo cutover, transfer and idempotency ---------
    post_norm = normalize(post_body)
    for needle in (
        "public.stock_ledger_cutover_date('tan_tao')",
        "v_receipt.receipt_date < v_cutover",
        "public.stock_goods_receipt_item_is_posted(p_item_id)",
        "insert into public.stock_transfers(",
        "on conflict (goods_receipt_item_id) do nothing",
        "from_location, to_location",
        "'gr-item:' || p_item_id::text",
        "'transfer:' || v_transfer_id::text",
        "on conflict (source, source_ref_key) where source_ref_key is not null do nothing",
        "on conflict (idempotency_key) do nothing",
        "select k.pastry_q7 into v_pastry",
    ):
        assert_true(needle in post_norm, f"post must keep: {needle}")

    # --- 5. read-only surface: no goods_receipt_items write ------------------
    for pattern in (
        r"\bupdate\s+public\.goods_receipt_items\b",
        r"\binsert\s+into\s+public\.goods_receipt_items\b",
        r"\bdelete\s+from\s+public\.goods_receipt_items\b",
    ):
        assert_true(
            re.search(pattern, lower) is None,
            f"the migration must never write goods_receipt_items ({pattern})",
        )

    assert_true(
        "supabase db push" not in lower,
        "the migration must not contain 'supabase db push'",
    )

    # --- 6. grants and revokes ----------------------------------------------
    for line in (
        "revoke all on function public.goods_receipt_effective_quantity(numeric, numeric, numeric, text) "
        "from public, anon;",
        "grant execute on function public.goods_receipt_effective_quantity(numeric, numeric, numeric, text) "
        "to authenticated, service_role;",
        "revoke all on function public.get_crate_receipt_lines(text, uuid, text, integer) "
        "from public, anon;",
        "grant execute on function public.get_crate_receipt_lines(text, uuid, text, integer) "
        "to authenticated, service_role;",
        "revoke all on function public.get_item_receipt_lines(uuid, integer) from public, anon;",
        "grant execute on function public.get_item_receipt_lines(uuid, integer) "
        "to authenticated, service_role;",
        "revoke all on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases) "
        "from public, anon, authenticated;",
        "grant execute on function public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases) "
        "to service_role;",
    ):
        assert_true(line in lower, f"migration must re-issue: {line}")

    # --- 7. the header lists the other readers with a decision ---------------
    for reader in (
        "receipt_lines_for_game_base",
        "get_stock_ledger_overview",
        "post_goods_receipt_to_stock",
        "stock_goods_receipt_item_is_posted",
        "auto_receive_goods_receipt",
        "backfill_auto_receive_paid",
        "create-warehouse-receipt",
        "match-delivery-note",
        "production-material-issue-check",
    ):
        assert_true(reader in lower, f"the header must list the other reader {reader}")
    assert_true(
        "aligned" in lower and "left alone" in lower,
        "the header must mark readers aligned or left alone",
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
        "SMOKE_RESULT PASS: effective received quantity" in smoke,
        "smoke must end with the exact PASS message",
    )
    for step in (
        "helper_actual",
        "helper_quantity",
        "helper_ordered",
        "helper_draft",
        "crate_not_found",
        "crate_quantity",
        "crate_zero_quantity",
        "tt_receipt",
        "transfer_count",
        "transfer_out",
        "transfer_in",
        "replay_transfer",
        "cutover_not_set",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")
    assert_true(
        "'bánh mì que ngày 1'" in smoke,
        "smoke must assert the named Tân Tạo crate",
    )
    assert_true("2131" in smoke, "smoke must assert the 2131 effective quantity")
    assert_true(
        "post_goods_receipt_to_stock" in smoke,
        "smoke must post through the real posting path",
    )
    assert_true(
        "raise notice" in smoke_lower,
        "smoke must raise the newly-postable count as a notice",
    )
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate the real owner through auth claims",
    )

    print("PASS: effective received quantity contracts hold")


if __name__ == "__main__":
    main()
