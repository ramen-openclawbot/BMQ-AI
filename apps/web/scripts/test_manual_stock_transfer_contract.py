#!/usr/bin/env python3
"""Static contract checks for the manual Tân Tạo -> Q7 stock-transfer migration.

These checks never connect to a database or Supabase. They guard that migration
20261031100000_manual_stock_transfer.sql:
  * adds the slip_id / slip_number / request_id columns, the two-source check and
    the slip_id index to public.stock_transfers without changing its
    append-only trigger or the unique goods_receipt_item_id;
  * creates the service-only public.stock_transfer_requests idempotency table;
  * defines public.create_manual_stock_transfer(jsonb, text, uuid, date) as a
    security-definer function with a pinned search_path, the permission gate, the
    1..30 line limit, both ledger cutovers, the per-item advisory locks, the
    Tân Tạo on-hand check and an atomic transfer_out / transfer_in pair;
  * redefines the Q7 pastry-only guard so only a manually referenced transfer_in
    is exempt (receipt / opening / auto transfer_in still need pastry_q7);
  * redefines public.get_warehouse_game_snapshot(text) and public.start_stock_count
    (text, text) so the Q7 item set is active, unmerged items with pastry_q7 = true
    OR at least one public.q7_inventory_movements row, re-granting both;
  * redefines public.get_stock_transfers to append source / slip_id / slip_number
    / note and re-grants it identically;
  * never runs UPDATE / DELETE against stock_transfers or the two ledgers;
  * ships a rollback-only smoke that inlines the migration byte-for-byte, checks
    the new Q7 item set on both functions, and ends with the PASS raise.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261031100000_manual_stock_transfer.sql"
SMOKE = SCRIPTS / "smoke_manual_stock_transfer.sql"

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
        MIGRATION.name == "20261031100000_manual_stock_transfer.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. stock_transfers columns / source check / index -------------------
    for column in ("slip_id uuid", "slip_number text", "request_id uuid"):
        assert_true(
            f"add column if not exists {column}" in lower,
            f"stock_transfers must add a nullable {column}",
        )
    assert_true(
        "check (source in ('auto_goods_receipt', 'manual'))" in lower,
        "stock_transfers.source must allow auto_goods_receipt and manual",
    )
    assert_true(
        "constraint stock_transfers_slip_number_check" in lower
        and "slip_number ~ '^ckp-[0-9]{8}-[a-z0-9]{6}$'" in lower,
        "slip_number must follow CKP-YYYYMMDD-XXXXXX",
    )
    assert_true(
        "create index if not exists idx_stock_transfers_slip_id" in lower
        and "on public.stock_transfers(slip_id)" in lower,
        "stock_transfers.slip_id must be indexed",
    )
    assert_true(
        "drop trigger if exists stock_transfers_append_only" not in lower
        and "disable trigger" not in lower,
        "stock_transfers must stay append-only (the existing trigger is untouched)",
    )

    # --- 2. idempotency table ------------------------------------------------
    assert_true(
        "create table if not exists public.stock_transfer_requests" in lower,
        "migration must create public.stock_transfer_requests",
    )
    req_table = lower[
        lower.index("create table if not exists public.stock_transfer_requests") :
    ]
    req_table = req_table[: req_table.index(");")]
    for fragment in (
        "request_id uuid primary key",
        "slip_id uuid not null",
        "slip_number text not null",
        "result jsonb not null",
    ):
        assert_true(fragment in req_table, f"stock_transfer_requests must have {fragment}")
    assert_true(
        "alter table public.stock_transfer_requests enable row level security" in lower,
        "stock_transfer_requests must enable RLS",
    )
    assert_true(
        "revoke all on table public.stock_transfer_requests from public, anon, authenticated"
        in lower,
        "stock_transfer_requests must be revoked from every client role",
    )
    assert_true(
        "grant all on table public.stock_transfer_requests to service_role" in lower,
        "stock_transfer_requests must be service_role only",
    )
    assert_true(
        "create policy" not in lower[
            lower.index("create table if not exists public.stock_transfer_requests") :
            lower.index("create or replace function public.create_manual_stock_transfer(")
        ],
        "stock_transfer_requests must not expose a client policy",
    )

    # --- 3. create_manual_stock_transfer signature / security ----------------
    marker = "create or replace function public.create_manual_stock_transfer("
    assert_true(marker in lower, "migration must define create_manual_stock_transfer")
    fn = body_after(lower, marker)
    for fragment in (
        "p_lines jsonb",
        "p_note text default null",
        "p_request_id uuid default null",
        "p_transfer_date date default null",
        "returns jsonb",
        "language plpgsql",
        "security definer",
        "set search_path = public, pg_temp",
    ):
        assert_true(fragment in fn, f"create_manual_stock_transfer must keep {fragment}")

    # --- 4. permission gate --------------------------------------------------
    assert_true(
        "public.can_manage_tan_tao_warehouse()" in fn,
        "permission must accept the Tân Tạo warehouse manager",
    )
    assert_true(
        "public.has_role(v_actor, 'owner')" in fn,
        "permission must accept the owner role",
    )
    assert_true(
        "public.material_alias_can_admin(v_actor)" in fn,
        "permission must accept the material alias admin",
    )
    assert_true(
        "raise exception 'transfer_forbidden' using errcode = '42501'" in fn,
        "a denied actor must raise transfer_forbidden 42501",
    )
    assert_true(
        "coalesce(auth.role(), '') = 'service_role'" in fn,
        "the service_role must bypass the actor requirement",
    )

    # --- 5. request idempotency ----------------------------------------------
    assert_true(
        "if v_request is null then" in fn and "request_id_required" in fn,
        "p_request_id must be required",
    )
    assert_true(
        "select r.result into v_existing" in fn
        and "from public.stock_transfer_requests r" in fn
        and "return v_existing" in fn,
        "an existing request must return its stored result unchanged",
    )
    assert_true(
        "insert into public.stock_transfer_requests(" in fn,
        "the call must persist its result for idempotency",
    )

    # --- 6. line validation --------------------------------------------------
    assert_true(
        "jsonb_array_length(p_lines)" in fn,
        "the function must measure the line count",
    )
    assert_true(
        "if v_line_count = 0 then" in fn and "'lines_required'" in fn,
        "an empty line array must raise lines_required",
    )
    assert_true(
        "if v_line_count > 30 then" in fn and "'too_many_lines'" in fn,
        "more than 30 lines must raise too_many_lines",
    )
    assert_true("'quantity_invalid'" in fn, "a bad quantity must raise quantity_invalid")
    assert_true("'duplicate_item'" in fn, "duplicate item ids must raise duplicate_item")
    assert_true("'item_invalid'" in fn, "unknown / inactive / merged items must raise item_invalid")
    assert_true("'date_invalid'" in fn, "a future transfer date must raise date_invalid")
    assert_true(
        "coalesce(p_transfer_date, v_today)" in fn,
        "the transfer date must default to the Vietnam date",
    )

    # --- 7. cutovers / stock / locks -----------------------------------------
    assert_true(
        "public.stock_ledger_cutover_date('tan_tao')" in fn
        and "public.stock_ledger_cutover_date('q7')" in fn
        and "'ledger_not_started'" in fn,
        "both ledger cutovers must be started before a manual transfer",
    )
    assert_true(
        "v_qty > v_on_hand" in fn and "'stock_insufficient" in fn,
        "a quantity above on-hand must raise stock_insufficient",
    )
    assert_true(
        "when 'transfer_out' then -m.quantity" in fn,
        "the Tân Tạo on-hand must subtract transfer_out",
    )
    assert_true(
        "v_item.name" in fn and "v_on_hand" in fn,
        "stock_insufficient must carry the item name and on-hand",
    )
    assert_true(
        "pg_advisory_xact_lock" in fn and "hashtextextended" in fn,
        "the function must take advisory locks",
    )
    assert_true(
        "from unnest(v_item_ids) as id order by id" in fn,
        "item locks must be taken in sorted item order",
    )

    # --- 8. atomic transfer pair ---------------------------------------------
    assert_true(
        "insert into public.stock_transfers(" in fn
        and "'manual'" in fn
        and "slip_id, slip_number, request_id" in fn,
        "each line must write a manual stock_transfers row with the slip fields",
    )
    assert_true(
        "v_transfer_number := 'ck-'" in fn,
        "each line must keep the existing CK- transfer_number format",
    )
    assert_true(
        "'transfer_out'" in fn and "'transfer_in'" in fn,
        "each line must write a Tân Tạo transfer_out and a Q7 transfer_in",
    )
    assert_true(
        "'transfer:' || v_transfer_id::text" in fn,
        "both ledger rows must reference the stock_transfers row",
    )
    assert_true(
        "'slip_id', v_slip_id" in fn
        and "'slip_number', v_slip_number" in fn
        and "'lines', v_lines" in fn,
        "the function must return the slip and its lines",
    )

    # --- 9. guard keeps pastry_q7 for receipt / opening / auto ----------------
    guard_marker = "create or replace function public.q7_inventory_movements_pastry_only_guard()"
    assert_true(guard_marker in lower, "migration must redefine the Q7 pastry-only guard")
    guard = body_after(lower, guard_marker)
    assert_true(
        "new.movement_type in ('receipt', 'transfer_in', 'opening')" in guard,
        "the guard must keep covering receipt / transfer_in / opening",
    )
    assert_true(
        "new.movement_type = 'transfer_in'" in guard
        and "new.source = 'stock_transfer'" in guard
        and "st.source = 'manual'" in guard
        and "transfer:' || st.id::text" in guard,
        "only a manually referenced transfer_in may be exempt",
    )
    assert_true(
        "if v_is_manual_transfer then" in guard and "return new;" in guard,
        "the manual transfer_in must be allowed through",
    )
    assert_true(
        "select k.pastry_q7 into v_pastry" in guard
        and "raise exception 'q7_pastry_only' using errcode = '23514'" in guard,
        "every other increase must still require pastry_q7",
    )
    assert_true(
        "create trigger q7_inventory_movements_pastry_only_guard" in lower
        and "before insert on public.q7_inventory_movements" in lower,
        "the guard must stay a BEFORE INSERT trigger",
    )

    # --- 10. get_stock_transfers output + re-grant ---------------------------
    get_marker = "create or replace function public.get_stock_transfers(p_limit integer default 30)"
    assert_true(get_marker in lower, "migration must redefine get_stock_transfers")
    getter = body_after(lower, get_marker)
    for column in (
        "'transfer_number'",
        "'transfer_date'",
        "'item_id'",
        "'item_name'",
        "'quantity'",
        "'unit'",
        "'receipt_number'",
        "'source'",
        "'slip_id'",
        "'slip_number'",
        "'note'",
    ):
        assert_true(column in getter, f"get_stock_transfers must return {column}")
    assert_true(
        getter.index("'receipt_number'") < getter.index("'source'"),
        "the new get_stock_transfers columns must be appended after the existing ones",
    )

    # --- 10b. Q7 item-set redefinitions --------------------------------------
    new_q7_filter = (
        "kii.pastry_q7 = true or exists "
        "(select 1 from public.q7_inventory_movements qm "
        "where qm.kitchen_inventory_item_id = kii.id)"
    )
    for marker in (
        "create or replace function public.get_warehouse_game_snapshot(p_location text)",
        "create or replace function public.start_stock_count(",
    ):
        assert_true(marker in lower, f"migration must redefine {marker}")
        fn = body_after(lower, marker)
        assert_true(
            new_q7_filter in fn,
            f"{marker} must use the pastry-or-movement Q7 item filter",
        )
        assert_true(
            "and kii.pastry_q7 = true" not in fn,
            f"{marker} must not keep the standalone pastry_q7 = true filter",
        )
        assert_true(
            fn.count("kii.pastry_q7 = true")
            == fn.count(
                "kii.pastry_q7 = true or exists "
                "(select 1 from public.q7_inventory_movements"
            ),
            f"{marker}: every pastry_q7 = true must be part of the new filter",
        )
    for grant in (
        "revoke all on function public.get_warehouse_game_snapshot(text) from public, anon",
        "grant execute on function public.get_warehouse_game_snapshot(text) to authenticated, service_role",
        "revoke all on function public.start_stock_count(text, text) from public, anon",
        "grant execute on function public.start_stock_count(text, text) to authenticated, service_role",
    ):
        assert_true(grant in lower, f"missing re-issued grant: {grant}")

    # --- 11. grants ----------------------------------------------------------
    for fragment in (
        "revoke all on function public.create_manual_stock_transfer(jsonb, text, uuid, date) from public, anon",
        "grant execute on function public.create_manual_stock_transfer(jsonb, text, uuid, date) to authenticated, service_role",
        "revoke all on function public.q7_inventory_movements_pastry_only_guard() from public, anon, authenticated",
        "revoke all on function public.get_stock_transfers(integer) from public, anon",
        "grant execute on function public.get_stock_transfers(integer) to authenticated, service_role",
    ):
        assert_true(fragment in lower, f"missing grant fragment: {fragment}")

    # --- 12. safety: no UPDATE / DELETE of append-only rows ------------------
    assert_true("drop table" not in lower, "migration must not DROP TABLE")
    assert_true("supabase db push" not in lower, "migration must never run supabase db push")
    assert_true(
        re.search(r"\bdelete\s+from\b", lower) is None,
        "migration must not DELETE any row",
    )
    for table in ("stock_transfers", "q7_inventory_movements", "tan_tao_material_movements"):
        assert_true(
            re.search(rf"\bupdate\s+public\.{table}\b", lower) is None,
            f"migration must not UPDATE public.{table}",
        )
    assert_true(
        UUID_RE.search(migration) is None,
        "migration must not contain a hard-coded UUID",
    )

    # --- 13. smoke -----------------------------------------------------------
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
    assert_true(
        "SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step"
    )
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate the real owner through auth claims",
    )
    assert_true(
        "from public.user_roles" in smoke and "role::text = 'owner'" in smoke,
        "smoke must take the owner from public.user_roles",
    )
    assert_true(
        "record_tan_tao_material_count(" in smoke,
        "smoke must seed on-hand through the existing count path",
    )
    for step in (
        "transfer_rows",
        "tt_transfer_out",
        "q7_transfer_in",
        "tt_balance",
        "q7_balance",
        "replay_slip",
        "replay_request",
        "stock_insufficient",
        "duplicate_item",
        "transfer_forbidden",
        "guard_accepted",
        "receipt_guard_accepted",
        "get_stock_transfers",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} check")

    # The new Q7 item-set checks on both redefined functions.
    for step in (
        "q7_snapshot_item_a",
        "q7_snapshot_unmoved_nonpastry",
        "q7_snapshot_pastry_missing",
        "q7_count_missing_item_a",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} check")
    assert_true(
        "public.get_warehouse_game_snapshot('q7')" in smoke,
        "smoke must exercise the Q7 snapshot",
    )
    assert_true(
        "public.start_stock_count('q7'" in smoke,
        "smoke must exercise the Q7 stock count",
    )

    # The last SMOKE_RESULT raise must be the PASS and nothing may raise after it.
    pass_message = "SMOKE_RESULT PASS: manual stock transfer"
    pass_index = smoke.rfind(pass_message)
    assert_true(pass_index != -1, "smoke must end with the PASS raise")
    tail = smoke[pass_index + len(pass_message) :]
    assert_true("raise exception" not in tail.lower(), "no raise may follow the PASS raise")
    assert_true(
        tail.rstrip().endswith("$smoke$;"),
        "the PASS raise must close the DO block",
    )

    print("PASS: manual stock transfer contracts hold")


if __name__ == "__main__":
    main()
