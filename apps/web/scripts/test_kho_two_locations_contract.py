#!/usr/bin/env python3
"""Static contract checks for 20261102620000_kho_item_two_locations.sql.

No database connection.  The migration is the only schema change; these checks
guard the two-place flags, the new RPC envelope, the Tân Tạo membership reads,
and the promise that the migration never rewrites a stock ledger in place.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase" / "migrations" / "20261102620000_kho_item_two_locations.sql"
SMOKE = ROOT / "scripts" / "smoke_kho_two_locations.sql"

LEDGER_TABLES = (
    "q7_inventory_movements",
    "tan_tao_material_movements",
    "tan_tao_warehouse_movements",
    "q7_finished_goods_movements",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def canon(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def extract_function(text: str, marker: str) -> str:
    start = text.lower().index(marker.lower())
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    end = text.index("\n" + tag + ";", start + match.end())
    return text[start : end + len(tag) + 2]


def function_body(text: str, name: str) -> str:
    return extract_function(
        text, f"create or replace function public.{name}("
    )


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(SMOKE.exists(), f"missing smoke {SMOKE.name}")

    migration = read(MIGRATION)
    lower = migration.lower()
    smoke = read(SMOKE)

    # --- 1. column, backfills, trigger, constraint -------------------------
    assert_true(
        "add column if not exists in_tan_tao boolean" in canon(lower),
        "in_tan_tao must be added nullable first",
    )
    assert_true(
        "set in_tan_tao = not coalesce(pastry_q7, false)" in canon(lower),
        "first backfill must be in_tan_tao = not pastry_q7",
    )
    for needle in (
        "q7_material_issue_material_mappings",
        "q7_inventory_openings",
        "q7_inventory_movements",
        "tan_tao_material_movements",
    ):
        assert_true(needle in lower, f"two-kho balance must use {needle}")
    assert_true(
        canon("set in_tan_tao = true, pastry_q7 = true") in canon(migration),
        "both-kho backfill must set both flags",
    )
    assert_true(
        "pastry_q7_source = 'rule'" in lower and "two_kho_backfill" not in lower.split("-- ===", 2)[-1],
        "both-kho rows must be tagged 'rule' (the column only allows rule|owner)",
    )
    assert_true(
        "before insert on public.kitchen_inventory_items" in canon(lower),
        "the fill trigger must be BEFORE INSERT",
    )
    assert_true(
        "new.in_tan_tao := not coalesce(new.pastry_q7, false)" in canon(lower),
        "trigger must fill a null in_tan_tao from pastry_q7",
    )
    assert_true(
        "alter column in_tan_tao set default true" in canon(lower)
        and "alter column in_tan_tao set not null" in canon(lower),
        "in_tan_tao must end NOT NULL DEFAULT true",
    )
    assert_true(
        "check (in_tan_tao or coalesce(pastry_q7, false))" in canon(lower),
        "check must require at least one place",
    )

    # --- 2. new owner / kho-admin RPC -------------------------------------
    new_rpc = function_body(migration, "set_item_kho_locations").lower()
    assert "security definer" in new_rpc
    assert canon("set search_path = public, pg_temp") in canon(new_rpc)
    for needle in (
        "public.material_alias_can_admin(v_actor)",
        "'kho_location_required' using errcode = '22023'",
        "'item_not_found' using errcode = 'p0002'",
        "from public.warehouse_game_requests",
        "insert into public.warehouse_game_requests",
        "'in_tan_tao', p_tan_tao",
        "'in_q7', p_q7",
        "set pastry_q7 = p_q7",
        "in_tan_tao = p_tan_tao",
        "pastry_q7_source = 'owner'",
        "pastry_q7_set_at = now()",
        "pastry_q7_set_by = v_actor",
    ):
        assert_true(needle in new_rpc, f"new RPC missing {needle}")
    assert_true(
        "revoke all on function public.set_item_kho_locations(uuid, boolean, boolean, uuid) from public, anon"
        in canon(lower),
        "new RPC must revoke public/anon",
    )
    assert_true(
        "grant execute on function public.set_item_kho_locations(uuid, boolean, boolean, uuid) to authenticated"
        in canon(lower),
        "new RPC must grant authenticated",
    )
    assert_true(
        "set_item_kho_locations" in lower
        and "warehouse_game_requests_action_check" in lower,
        "request action constraint must allow set_item_kho_locations",
    )

    # --- 3. set_item_pastry_q7 stays single-kho ---------------------------
    old_rpc = function_body(migration, "set_item_pastry_q7").lower()
    assert_true(
        "in_tan_tao = not p_value" in canon(old_rpc),
        "set_item_pastry_q7 must set in_tan_tao to the opposite place",
    )
    assert_true(
        "set pastry_q7 = p_value" in canon(old_rpc),
        "set_item_pastry_q7 must keep setting pastry_q7",
    )

    # --- 4. list / count / learning / ledger / receipt --------------------
    get_items = function_body(migration, "kho_get_items").lower()
    assert_true(
        "'in_q7', coalesce(kii.pastry_q7, false)" in canon(get_items)
        and "'in_tan_tao', coalesce(kii.in_tan_tao, not coalesce(kii.pastry_q7, false))"
        in canon(get_items),
        "kho_get_items must return both in_q7 and in_tan_tao",
    )

    count = function_body(migration, "kho_count_item").lower()
    assert_true(
        "p_location = 'q7' and coalesce(v_item.pastry_q7, false) = false"
        in canon(count),
        "Q7 count guard must stay on pastry_q7",
    )
    assert_true(
        "p_location = 'tan_tao'" in count
        and "coalesce(v_item.in_tan_tao" in count
        and "'item_not_in_location' using errcode = '22023'" in count,
        "Tân Tạo count guard must follow in_tan_tao",
    )

    learn = function_body(migration, "learn_tan_tao_purchase_parameters").lower()
    assert_true(
        "coalesce(kii.in_tan_tao, not coalesce(kii.pastry_q7, false))" in canon(learn),
        "Tân Tạo learning must select in_tan_tao",
    )

    ledger = function_body(migration, "get_stock_ledger_overview").lower()
    assert_true(
        "(coalesce(kii.pastry_q7, false) and not coalesce(kii.in_tan_tao, false)) as pass_through"
        in canon(ledger),
        "pass_through must be false for a two-kho item",
    )

    receipt = function_body(migration, "post_stock_goods_receipt_item").lower()
    assert_true(
        "(coalesce(k.pastry_q7, false) and not coalesce(k.in_tan_tao, false))"
        in canon(receipt),
        "goods receipt auto-transfer must require Q7-only",
    )

    # --- 5. COGS branches --------------------------------------------------
    cogs = function_body(migration, "cogs_refresh_mappings").lower()
    assert_true(
        "v_item_in_tan_tao" in cogs
        and "kii.in_tan_tao" in cogs
        and "case when v_item_in_tan_tao then 'tan_tao' else 'q7' end"
        in canon(cogs),
        "cogs_refresh_mappings must prefer the Tân Tạo place",
    )
    assert_true(
        "v_location := 'q7'" in cogs
        and "v_q7map.id is not null" in cogs,
        "Q7 PXK branch must stay unchanged",
    )

    decide = function_body(migration, "cogs_decide_ingredient").lower()
    assert_true(
        "p_location = 'q7'" in decide
        and "v_item.pastry_q7" in decide
        and "p_location = 'tan_tao'" in decide
        and "v_item.in_tan_tao" in decide
        and "'location_mismatch' using errcode = '22023'" in decide,
        "cogs_decide_ingredient must accept either place",
    )

    # --- 6. inspected membership reads ------------------------------------
    for name, needle in (
        (
            "stock_count_eligible_lines",
            "coalesce(kii.in_tan_tao, not coalesce(kii.pastry_q7, false)) as in_tan_tao",
        ),
        (
            "material_link_counts_internal",
            "loc.location = 'tan_tao' and coalesce( kii.in_tan_tao, not coalesce(kii.pastry_q7, false) )",
        ),
        (
            "get_material_link_pending_factors",
            "v_location = 'tan_tao' and coalesce( kii.in_tan_tao, not coalesce(kii.pastry_q7, false) )",
        ),
    ):
        body = function_body(migration, name).lower()
        assert_true(
            canon(needle) in canon(body),
            f"{name} Tân Tạo branch must follow in_tan_tao",
        )

    review = function_body(migration, "material_link_review_items_internal").lower()
    assert_true(
        canon(review).count(
            canon(
                "v_location = 'tan_tao' and coalesce( kii.in_tan_tao, not coalesce(kii.pastry_q7, false) )"
            )
        )
        == 4,
        "material_link_review_items_internal must use in_tan_tao in all 4 Tân Tạo reads",
    )

    # --- 7. no in-place ledger rewrites in the migration body -------------
    for table in LEDGER_TABLES:
        assert_true(
            re.search(
                rf"\b(?:update\s+(?:public\.)?{table}|delete\s+from\s+(?:public\.)?{table})\b",
                lower,
            )
            is None,
            f"migration must not UPDATE/DELETE {table}",
        )

    # --- 8. smoke envelope -------------------------------------------------
    smoke_lower = smoke.lower()
    assert_true(smoke_lower.lstrip().startswith("-- smoke test"), "smoke needs a header")
    assert_true("begin;" in smoke_lower and "rollback;" in smoke_lower, "smoke must be BEGIN ... ROLLBACK")
    for needle in (
        "from public.user_roles",
        "where ur.role::text = 'owner'",
        "request.jwt.claims",
        "set_item_kho_locations",
        "kho_count_item('tan_tao'",
        "item_not_in_location",
        "kho_location_required",
        "set_item_pastry_q7",
        "has_function_privilege",
        "'anon'",
    ):
        assert_true(needle in smoke_lower, f"smoke missing {needle}")
    assert_true(
        "q7_inventory_movements" in smoke_lower
        and "tan_tao_material_movements" in smoke_lower,
        "smoke must compare both ledger quantity sums",
    )

    print("PASS: kho two-location contracts hold")


if __name__ == "__main__":
    main()
