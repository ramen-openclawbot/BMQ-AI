#!/usr/bin/env python3
"""Static contract checks for the central-warehouse (Tân Tạo -> Q7) migration.

These checks never connect to a database or Supabase. They guard that migration
20261026100000_central_warehouse_flow.sql:
  * adds kitchen_inventory_items.pastry_q7 with the rule / owner source and a
    rule seed that never flags a meat_filling material;
  * creates public.stock_transfers and public.stock_location_moves with RLS,
    explicit grants and an append-only trigger on stock_transfers;
  * extends both ledgers with transfer_in / transfer_out and the stock_transfer
    source, and redefines every ledger reader that sums / classifies
    movement_type so the two new types are counted;
  * guards q7_inventory_movements with the q7_pastry_only raise (errcode 23514);
  * keeps public.post_stock_goods_receipt_item(uuid, public.stock_material_aliases)
    and writes the transfer pair for a flagged item;
  * coerces goods_receipts.receiving_location 'q7' to 'tan_tao' on insert/update
    and in set_goods_receipt_receiving_location / apply_supplier_routing;
  * never drops a table, never runs 'supabase db push' and has no literal UUID;
  * ships a rollback-only smoke that inlines the migration byte-for-byte.

It also checks the client fixture / parser contract is present in the scripts
directory (the .ts files are covered by the node test).
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261026100000_central_warehouse_flow.sql"
SMOKE = SCRIPTS / "smoke_central_warehouse_flow.sql"

# Functions that read the ledgers and sum / classify movement_type. Each one is
# redefined by the migration and must know the new transfer types.
LEDGER_READERS = {
    "get_q7_inventory_snapshot(": ("transfer_in",),
    "get_stock_ledger_overview(": ("transfer_in", "transfer_out"),
    "get_warehouse_game_snapshot(": ("transfer_in", "transfer_out"),
    "record_tan_tao_material_count(": ("transfer_out",),
    "apply_stock_item_merge(": ("transfer_out",),
    "revert_stock_item_merge(": ("transfer_in", "transfer_out"),
    "stock_item_merge_forward(": ("transfer_in",),
    "tan_tao_material_merge_forward(": ("transfer_out",),
    "mission_evaluate(": ("transfer_in",),
}

UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def body_after(text: str, marker: str) -> str:
    start = text.index(marker)
    end = text.index("\n$$;", start)
    return text[start:end]


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261026100000_central_warehouse_flow.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. pastry column + rule seed ---------------------------------------
    assert_true(
        "add column if not exists pastry_q7 boolean not null default false" in lower,
        "kitchen_inventory_items.pastry_q7 must be a not-null boolean defaulting false",
    )
    for column in ("pastry_q7_source", "pastry_q7_set_at", "pastry_q7_set_by"):
        assert_true(column in lower, f"missing pastry column {column}")
    assert_true(
        "pastry_q7_source in ('rule', 'owner')" in lower,
        "pastry_q7_source must accept rule / owner only",
    )
    assert_true(
        "pastry_q7_source = 'rule'" in lower and "raise notice" in lower,
        "the seed must set source rule and RAISE NOTICE the count",
    )
    assert_true(
        "scm.category in ('meat_filling', 'service')" in lower,
        "the seed must exclude meat_filling / service materials",
    )
    assert_true(
        "scm.category in ('flour', 'dairy_fat', 'eggs', 'sugar_additives', 'cheese')" in lower,
        "the seed must include the pastry raw-material categories",
    )

    # --- 2. new tables, RLS, grants, append-only ----------------------------
    for table in ("stock_transfers", "stock_location_moves"):
        assert_true(
            f"create table if not exists public.{table}" in lower,
            f"migration must create public.{table}",
        )
        assert_true(
            f"alter table public.{table} enable row level security" in lower,
            f"{table} must enable RLS",
        )
        assert_true(
            f"revoke all on table public.{table} from public, anon, authenticated" in lower,
            f"{table} must revoke default table access",
        )
        assert_true(
            f"grant select on table public.{table} to authenticated, service_role" in lower,
            f"{table} must be explicitly selectable",
        )
    assert_true(
        "goods_receipt_item_id uuid unique" in lower,
        "stock_transfers.goods_receipt_item_id must be unique (idempotent replay)",
    )
    assert_true(
        "quantity numeric(15, 3) not null" in lower and "quantity > 0" in lower,
        "stock_transfers.quantity must be positive numeric(15,3)",
    )
    assert_true(
        "transfer_number ~ '^CK-[0-9]{8}-[A-Z0-9]{6}$'" in migration,
        "stock_transfers.transfer_number must follow CK-YYYYMMDD-XXXXXX",
    )
    assert_true(
        "from_location = 'tan_tao'" in lower and "to_location = 'q7'" in lower,
        "stock_transfers must be Tân Tạo -> Q7",
    )
    assert_true(
        "create trigger stock_transfers_append_only" in lower
        and "before update or delete on public.stock_transfers" in lower,
        "stock_transfers must have an append-only trigger",
    )
    assert_true(
        "create trigger stock_location_moves_append_only" in lower
        and "before update or delete on public.stock_location_moves" in lower,
        "stock_location_moves must be append-only",
    )

    # --- 3. movement types and sources --------------------------------------
    for token in (
        "check (movement_type in ('receipt', 'production_usage', 'adjustment', 'transfer_in'))",
        "check (movement_type in ('receipt', 'production_usage', 'adjustment', 'opening', 'transfer_out'))",
        "'item_merge', 'item_merge_revert', 'stock_transfer'",
        "'goods_receipt', 'manual_adjustment', 'item_merge', 'item_merge_revert', 'stock_transfer'",
    ):
        assert_true(token in lower, f"missing constraint fragment: {token}")

    # --- 4. every ledger reader is redefined with the new types -------------
    for marker, needed in LEDGER_READERS.items():
        assert_true(
            f"create or replace function public.{marker}" in lower,
            f"migration must redefine public.{marker}",
        )
        body = body_after(lower, f"create or replace function public.{marker}")
        for token in needed:
            assert_true(token in body, f"public.{marker} must handle {token}")

    # --- 5. guard trigger ----------------------------------------------------
    assert_true(
        "function public.q7_inventory_movements_pastry_only_guard()" in lower,
        "migration must define the Q7 pastry-only guard",
    )
    guard = body_after(lower, "function public.q7_inventory_movements_pastry_only_guard()")
    assert_true(
        "new.movement_type in ('receipt', 'transfer_in', 'opening')" in guard.lower(),
        "the guard must cover receipt / transfer_in / opening",
    )
    assert_true(
        "raise exception 'q7_pastry_only' using errcode = '23514'" in guard,
        "the guard must raise q7_pastry_only with errcode 23514",
    )
    assert_true(
        "create trigger q7_inventory_movements_pastry_only_guard" in lower
        and "before insert on public.q7_inventory_movements" in lower,
        "the guard must be a BEFORE INSERT trigger on q7_inventory_movements",
    )

    # --- 6. receiving coercion ----------------------------------------------
    assert_true(
        "create trigger goods_receipts_central_receiving_guard" in lower
        and "before insert or update of receiving_location on public.goods_receipts" in lower,
        "goods_receipts must coerce receiving_location before insert / update",
    )
    central = body_after(lower, "function public.goods_receipts_central_receiving_guard()")
    assert_true(
        "if new.receiving_location = 'q7' then" in central.lower()
        and "new.receiving_location := 'tan_tao'" in central.lower(),
        "the receiving guard must map q7 to tan_tao",
    )
    for signature in (
        "set_goods_receipt_receiving_location(uuid, text, boolean)",
        "apply_supplier_routing(uuid, text, text, uuid)",
    ):
        assert_true(signature in lower, f"migration must redefine {signature}")
        name = signature.split("(")[0]
        body = body_after(lower, f"create or replace function public.{name}(")
        assert_true(
            "if p_location = 'q7' then" in body and "p_location := 'tan_tao'" in body,
            f"{signature} must map q7 to tan_tao",
        )

    # --- 7. posting signature and transfer pair -----------------------------
    post_marker = "create or replace function public.post_stock_goods_receipt_item("
    assert_true(post_marker in lower, "migration must redefine post_stock_goods_receipt_item")
    post = body_after(lower, post_marker)
    assert_true(
        "p_item_id uuid" in post and "p_alias public.stock_material_aliases" in post,
        "post_stock_goods_receipt_item must keep its (uuid, public.stock_material_aliases) signature",
    )
    assert_true(
        "'transfer_out'" in post and "'transfer_in'" in post,
        "post_stock_goods_receipt_item must write the Tân Tạo / Q7 transfer pair",
    )
    assert_true(
        "'transfer:' || v_transfer_id::text" in post,
        "the transfer pair must share the transfer:<id> source_ref_key",
    )
    assert_true(
        "'stock_transfer'" in post and "'auto_goods_receipt'" in post,
        "the transfer pair must use the stock_transfer source",
    )
    assert_true(
        "goods_receipt_item_id" in post and "on conflict (goods_receipt_item_id) do nothing" in lower,
        "the stock transfer insert must be idempotent per receipt line",
    )

    # --- 8. new RPCs and revokes --------------------------------------------
    assert_true(
        "create or replace function public.set_item_pastry_q7(" in lower
        and "p_item_id uuid" in lower
        and "p_value boolean" in lower
        and "p_request_id uuid" in lower,
        "migration must define set_item_pastry_q7(p_item_id, p_value, p_request_id)",
    )
    assert_true(
        "pastry_forbidden" in lower and "errcode = '42501'" in lower,
        "set_item_pastry_q7 must refuse non-admins with 42501",
    )
    assert_true(
        "create or replace function public.get_stock_transfers(p_limit integer default 30)" in lower,
        "migration must define get_stock_transfers(p_limit int default 30)",
    )
    for signature in (
        "set_item_pastry_q7(uuid, boolean, uuid)",
        "get_stock_transfers(integer)",
        "stock_transfers_append_only()",
        "stock_location_moves_append_only()",
        "q7_inventory_movements_pastry_only_guard()",
        "goods_receipts_central_receiving_guard()",
    ):
        assert_true(
            f"revoke all on function public.{signature} from public, anon" in lower,
            f"{signature} must revoke default execute from public/anon",
        )
    assert_true(
        "grant execute on function public.set_item_pastry_q7(uuid, boolean, uuid) to authenticated, service_role"
        in lower,
        "set_item_pastry_q7 must be granted to authenticated",
    )
    assert_true(
        "grant execute on function public.get_stock_transfers(integer) to authenticated, service_role"
        in lower,
        "get_stock_transfers must be granted to authenticated",
    )
    assert_true(
        "'transfers', v_transfers" in lower and "'pastry_q7'" in lower,
        "get_warehouse_game_snapshot must return pastry_q7 and the transfers array",
    )
    assert_true(
        "and kii.pastry_q7 = true" in lower,
        "the Q7 warehouse snapshot must list only pastry items",
    )

    # --- 9. safety ----------------------------------------------------------
    assert_true("supabase db push" not in lower, "migration must never run supabase db push")
    assert_true("drop table" not in lower, "migration must not DROP TABLE")
    assert_true(
        UUID_RE.search(migration) is None,
        "migration must not contain a hard-coded UUID",
    )

    # --- 10. smoke ----------------------------------------------------------
    assert_true(SMOKE.exists(), f"missing smoke {SMOKE.name}")
    smoke = read(SMOKE)
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true("rollback;" not in smoke.lower(), "smoke must roll back via the final RAISE")
    assert_true("commit;" not in smoke.lower(), "smoke must not commit")
    assert_true(
        migration.strip() in smoke,
        "smoke must inline the migration byte-for-byte (regenerate it when the migration changes)",
    )
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    for step in (
        "seed_count",
        "seeded_meat_filling",
        "q7_receipts_left",
        "alias_twin_missing",
        "receiving_coercion",
        "cutover_not_set",
        "transfer_count",
        "plain_transfer",
        "transfer_out_count",
        "transfer_in_count",
        "tt_balance",
        "q7_snapshot",
        "replay_transfer",
        "overview_q7",
        "overview_tan_tao",
        "snapshot_q7_pastry",
        "snapshot_q7_nonpastry",
        "snapshot_transfers",
        "get_stock_transfers",
        "tt_count",
        "merge_source_out",
        "merge_target_in",
        "guard_accepted",
        "pastry_forbidden",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} check")
    assert_true(
        "from public.user_roles" in smoke and "role::text = 'owner'" in smoke,
        "smoke must take the owner from public.user_roles",
    )
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate the real owner / employee through auth claims",
    )

    # --- 11. client fixture contract ----------------------------------------
    fixture = read(SCRIPTS / "qa_warehouse_game.fixture.json")
    assert_true('"pastry_q7"' in fixture, "QA fixture must carry pastry_q7 on items")
    assert_true('"transfers"' in fixture, "QA fixture must carry a transfers array")

    print("PASS: central warehouse flow contracts hold")


if __name__ == "__main__":
    main()
