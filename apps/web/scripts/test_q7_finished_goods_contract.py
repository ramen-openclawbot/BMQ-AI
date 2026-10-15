#!/usr/bin/env python3
"""Static contract checks for the Q7 finished-goods ledger migration.

These checks never connect to a database or Supabase. They guard that migration
20261101340000_q7_finished_goods_ledger.sql:
  * creates public.q7_finished_goods_movements with the type / sign / non-zero /
    slip-number checks, the two indexes, RLS, the Q7-viewer select policy, the
    append-only trigger and the client/service grants;
  * creates the service-only public.q7_finished_goods_requests idempotency table;
  * defines create_q7_finished_goods_receipt(jsonb, text, uuid, date),
    create_q7_finished_goods_issue(jsonb, text, text, uuid, date) and
    get_q7_finished_goods_planned(date) as security-definer functions with a
    pinned search_path, the permission gate, the 1..30 line limit, request_id
    idempotency, the per-SKU advisory locks and the over-issue rejection;
  * redefines public.get_warehouse_game_snapshot(text) keeping the Tân Tạo branch
    and adding the Q7 finished-goods SKU branch, re-granting it identically;
  * never runs UPDATE / DELETE against production_order_items,
    q7_inventory_movements, tan_tao_warehouse_movements or
    q7_finished_goods_movements;
  * ships a rollback-only smoke that inlines the migration byte-for-byte and ends
    with the PASS raise.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101340000_q7_finished_goods_ledger.sql"
SMOKE = SCRIPTS / "smoke_q7_finished_goods.sql"

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
        MIGRATION.name == "20261101340000_q7_finished_goods_ledger.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. ledger table columns / checks / indexes --------------------------
    marker = "create table if not exists public.q7_finished_goods_movements"
    assert_true(marker in lower, "migration must create public.q7_finished_goods_movements")
    table = lower[lower.index(marker):]
    table = table[: table.index(");")]
    for fragment in (
        "id uuid primary key",
        "sku_id uuid not null references public.product_skus(id) on delete restrict",
        "sku_code_snapshot text not null",
        "movement_type text not null",
        "quantity numeric not null",
        "movement_date date not null",
        "slip_id uuid not null",
        "slip_number text not null",
        "production_order_item_id uuid references public.production_order_items(id) on delete restrict",
        "request_id uuid not null",
        "note text",
        "created_by uuid references auth.users(id) on delete set null",
        "created_at timestamptz not null default now()",
    ):
        assert_true(fragment in table, f"q7_finished_goods_movements must have {fragment}")

    assert_true(
        "check (movement_type in ('production_receipt', 'dispatch', 'write_off', 'adjustment'))"
        in table,
        "movement_type must allow the four movement types",
    )
    assert_true("check (quantity <> 0)" in table, "quantity must be non-zero")
    assert_true(
        "(movement_type = 'production_receipt' and quantity > 0)" in table,
        "a production_receipt must be positive",
    )
    assert_true(
        "(movement_type in ('dispatch', 'write_off') and quantity < 0)" in table,
        "a dispatch / write_off must be negative",
    )
    assert_true(
        "slip_number ~ '^ntp-[0-9]{8}-[a-z0-9]{6}$'" in table,
        "a receipt slip_number must follow NTP-YYYYMMDD-XXXXXX",
    )
    assert_true(
        "slip_number ~ '^xtp-[0-9]{8}-[a-z0-9]{6}$'" in table,
        "a dispatch / write_off slip_number must follow XTP-YYYYMMDD-XXXXXX",
    )

    assert_true(
        "create index if not exists idx_q7_finished_goods_movements_sku_date" in lower
        and "on public.q7_finished_goods_movements(sku_id, movement_date)" in lower,
        "the ledger must index (sku_id, movement_date)",
    )
    assert_true(
        "create index if not exists idx_q7_finished_goods_movements_slip_id" in lower
        and "on public.q7_finished_goods_movements(slip_id)" in lower,
        "the ledger must index slip_id",
    )

    # --- 2. append-only trigger ----------------------------------------------
    assert_true(
        "function public.q7_finished_goods_movements_append_only()" in lower,
        "migration must define the append-only trigger function",
    )
    assert_true(
        "raise exception 'q7_finished_goods_movements are append-only'" in lower,
        "the append-only trigger must raise the exact message",
    )
    assert_true(
        "create trigger q7_finished_goods_movements_append_only" in lower
        and "before update or delete on public.q7_finished_goods_movements" in lower,
        "the append-only trigger must cover UPDATE / DELETE",
    )

    # --- 3. RLS + grants on the ledger ---------------------------------------
    assert_true(
        "alter table public.q7_finished_goods_movements enable row level security" in lower,
        "the ledger must enable RLS",
    )
    assert_true(
        "create policy q7_finished_goods_movements_select" in lower
        and "on public.q7_finished_goods_movements for select to authenticated" in lower
        and "using (public.q7_material_inventory_can_view((select auth.uid())))" in lower,
        "the ledger select policy must reuse the Q7 snapshot read gate",
    )
    assert_true(
        "revoke all on table public.q7_finished_goods_movements from public, anon, authenticated"
        in lower,
        "the ledger must be revoked from every client role",
    )
    assert_true(
        "grant select on table public.q7_finished_goods_movements to authenticated" in lower,
        "authenticated must only get SELECT on the ledger",
    )
    assert_true(
        "grant all on table public.q7_finished_goods_movements to service_role" in lower,
        "service_role must own the ledger",
    )

    # --- 4. idempotency table ------------------------------------------------
    req_marker = "create table if not exists public.q7_finished_goods_requests"
    assert_true(req_marker in lower, "migration must create public.q7_finished_goods_requests")
    req_table = lower[lower.index(req_marker):]
    req_table = req_table[: req_table.index(");")]
    for fragment in (
        "request_id uuid primary key",
        "kind text",
        "slip_id uuid",
        "slip_number text",
        "result jsonb",
        "created_by uuid references auth.users(id) on delete set null",
        "created_at timestamptz not null default now()",
    ):
        assert_true(fragment in req_table, f"q7_finished_goods_requests must have {fragment}")
    assert_true(
        "alter table public.q7_finished_goods_requests enable row level security" in lower,
        "q7_finished_goods_requests must enable RLS",
    )
    assert_true(
        "revoke all on table public.q7_finished_goods_requests from public, anon, authenticated"
        in lower,
        "q7_finished_goods_requests must be revoked from every client role",
    )
    assert_true(
        "grant all on table public.q7_finished_goods_requests to service_role" in lower,
        "q7_finished_goods_requests must be service_role only",
    )
    assert_true(
        "create policy" not in lower[
            lower.index(req_marker):
            lower.index("create or replace function public.create_q7_finished_goods_receipt(")
        ],
        "q7_finished_goods_requests must not expose a client policy",
    )

    # --- 5. receipt function signature / security ----------------------------
    receipt_marker = "create or replace function public.create_q7_finished_goods_receipt("
    assert_true(receipt_marker in lower, "migration must define create_q7_finished_goods_receipt")
    receipt = body_after(lower, receipt_marker)
    for fragment in (
        "p_lines jsonb",
        "p_note text",
        "p_request_id uuid",
        "p_date date default (now() at time zone 'asia/ho_chi_minh')::date",
        "returns jsonb",
        "language plpgsql",
        "security definer",
        "set search_path = public, pg_temp",
    ):
        assert_true(fragment in receipt, f"create_q7_finished_goods_receipt must keep {fragment}")

    # --- 6. issue function signature / security ------------------------------
    issue_marker = "create or replace function public.create_q7_finished_goods_issue("
    assert_true(issue_marker in lower, "migration must define create_q7_finished_goods_issue")
    issue = body_after(lower, issue_marker)
    for fragment in (
        "p_lines jsonb",
        "p_reason text",
        "p_note text",
        "p_request_id uuid",
        "p_date date default (now() at time zone 'asia/ho_chi_minh')::date",
        "returns jsonb",
        "security definer",
        "set search_path = public, pg_temp",
    ):
        assert_true(fragment in issue, f"create_q7_finished_goods_issue must keep {fragment}")
    assert_true(
        "v_reason not in ('dispatch', 'write_off')" in issue and "'reason_invalid" in issue,
        "the issue reason must be dispatch or write_off",
    )
    assert_true(
        "v_reason, -v_qty" in issue,
        "an issue line must store the quantity negative",
    )

    # --- 7. planned function signature / security ----------------------------
    planned_marker = "create or replace function public.get_q7_finished_goods_planned(p_date date)"
    assert_true(planned_marker in lower, "migration must define get_q7_finished_goods_planned")
    planned = body_after(lower, planned_marker)
    for fragment in (
        "returns jsonb",
        "security definer",
        "set search_path = public, pg_temp",
        "public.q7_material_inventory_can_view(v_actor)",
    ):
        assert_true(fragment in planned, f"get_q7_finished_goods_planned must keep {fragment}")
    for column in (
        "'production_order_item_id'",
        "'sku_id'",
        "'sku_code'",
        "'product_name'",
        "'unit'",
        "'planned_qty'",
        "'already_received'",
    ):
        assert_true(column in planned, f"get_q7_finished_goods_planned must return {column}")
    assert_true(
        "po.location_code = 'q7'" in planned
        and "po.planned_start_date = p_date" in planned
        and "po.status::text <> 'cancelled'" in planned
        and "poi.sku_id is not null" in planned,
        "the planned reader must filter Q7, the date, non-cancelled and non-null SKUs",
    )
    assert_true(
        "m.movement_type = 'production_receipt'" in planned
        and "where m.production_order_item_id = poi.id" in planned,
        "already_received must sum the receipt rows of the order item",
    )

    # --- 8. permission gate --------------------------------------------------
    for gate in (
        "public.can_manage_tan_tao_warehouse()",
        "public.has_role(v_actor, 'owner')",
        "public.material_alias_can_admin(v_actor)",
    ):
        assert_true(gate in receipt and gate in issue, f"permission must accept {gate}")
    assert_true(
        "'finished_goods_forbidden" in receipt and "'finished_goods_forbidden" in issue,
        "a denied actor must raise finished_goods_forbidden",
    )
    assert_true(
        "coalesce(auth.role(), '') = 'service_role'" in receipt
        and "coalesce(auth.role(), '') = 'service_role'" in issue,
        "the service_role must bypass the actor requirement",
    )

    # --- 9. request idempotency + 1..30 lines --------------------------------
    for fn, label in ((receipt, "receipt"), (issue, "issue")):
        assert_true(
            "if v_request is null then" in fn and "'request_id_required" in fn,
            f"the {label} p_request_id must be required",
        )
        assert_true(
            "select r.result into v_existing" in fn
            and "from public.q7_finished_goods_requests r" in fn
            and "return v_existing" in fn,
            f"a repeated {label} request must return its stored result",
        )
        assert_true(
            "insert into public.q7_finished_goods_requests(" in fn,
            f"the {label} call must persist its result for idempotency",
        )
        assert_true(
            "jsonb_array_length(p_lines)" in fn and "if v_line_count = 0 then" in fn
            and "'lines_required" in fn,
            f"the {label} function must require at least one line",
        )
        assert_true(
            "if v_line_count > 30 then" in fn and "'too_many_lines" in fn,
            f"the {label} function must cap the lines at 30",
        )

    # --- 10. locks + over-issue rejection ------------------------------------
    assert_true(
        "pg_advisory_xact_lock" in receipt and "pg_advisory_xact_lock" in issue,
        "both writers must take advisory locks",
    )
    for fn, label in ((receipt, "receipt"), (issue, "issue")):
        assert_true(
            "hashtext('q7_fg:' || v_lock_sku::text)" in fn,
            f"the {label} per-SKU lock must use hashtext('q7_fg:' || sku)",
        )
        assert_true(
            "from unnest(v_sku_ids) as id order by id" in fn,
            f"the {label} SKU locks must be taken in sorted order",
        )
    assert_true(
        "v_requested > v_on_hand" in issue and "'finished_goods_insufficient" in issue,
        "an over-issue must raise finished_goods_insufficient",
    )
    assert_true(
        "v_sku.sku_code" in issue and "v_on_hand" in issue,
        "the over-issue error must name the SKU and on_hand",
    )
    assert_true(
        "insert into public.q7_finished_goods_movements(" in receipt
        and "'production_receipt'" in receipt,
        "the receipt must write a production_receipt row per line",
    )
    assert_true(
        "insert into public.q7_finished_goods_movements(" in issue,
        "the issue must write a ledger row per line",
    )
    for value in ("'on_hand_after'", "'slip_id', v_slip_id", "'slip_number', v_slip_number"):
        assert_true(value in receipt and value in issue, f"both writers must return {value}")
    assert_true(
        "'ntp-'" in receipt and "'xtp-'" in issue,
        "the receipt / issue slip numbers must use NTP / XTP",
    )

    # --- 11. snapshot redefinition -------------------------------------------
    snap_marker = "create or replace function public.get_warehouse_game_snapshot(p_location text)"
    assert_true(snap_marker in lower, "migration must redefine get_warehouse_game_snapshot")
    snap = body_after(lower, snap_marker)
    # Tân Tạo branch stays.
    assert_true(
        "public.tan_tao_warehouse_movements m" in snap
        and "m.location_code = 'warehouse_tan_tao'" in snap
        and "ps.sku_type::text = 'finished_good'" in snap,
        "the snapshot must keep the Tân Tạo finished-goods branch",
    )
    # Q7 branch added.
    assert_true(
        "public.q7_finished_goods_movements m" in snap,
        "the Q7 snapshot branch must read the finished-goods ledger",
    )
    assert_true(
        "public.production_order_items poi" in snap
        and "po.location_code = 'q7'" in snap
        and "coalesce(po.planned_start_date, po.planned_end_date)" in snap
        and "between v_as_of - 30 and v_as_of" in snap,
        "the Q7 snapshot branch must add the last-30-day production plan source",
    )
    assert_true(
        "grant execute on function public.get_warehouse_game_snapshot(text) to authenticated, service_role"
        in lower,
        "the snapshot must keep its grant",
    )

    # --- 12. grants ----------------------------------------------------------
    for fragment in (
        "revoke all on function public.create_q7_finished_goods_receipt(jsonb, text, uuid, date) from public, anon",
        "grant execute on function public.create_q7_finished_goods_receipt(jsonb, text, uuid, date) to authenticated, service_role",
        "revoke all on function public.create_q7_finished_goods_issue(jsonb, text, text, uuid, date) from public, anon",
        "grant execute on function public.create_q7_finished_goods_issue(jsonb, text, text, uuid, date) to authenticated, service_role",
        "revoke all on function public.get_q7_finished_goods_planned(date) from public, anon",
        "grant execute on function public.get_q7_finished_goods_planned(date) to authenticated, service_role",
        "revoke all on function public.get_warehouse_game_snapshot(text) from public, anon",
        "grant execute on function public.get_warehouse_game_snapshot(text) to authenticated, service_role",
        "revoke all on function public.q7_finished_goods_movements_append_only() from public, anon, authenticated",
    ):
        assert_true(fragment in lower, f"missing grant fragment: {fragment}")

    # --- 13. safety: no UPDATE / DELETE of append-only rows ------------------
    assert_true("drop table" not in lower, "migration must not DROP TABLE")
    assert_true("supabase db push" not in lower, "migration must never run supabase db push")
    assert_true(
        re.search(r"\bdelete\s+from\b", lower) is None,
        "migration must not DELETE any row",
    )
    for table in (
        "production_order_items",
        "q7_inventory_movements",
        "tan_tao_warehouse_movements",
        "q7_finished_goods_movements",
    ):
        assert_true(
            re.search(rf"\bupdate\s+public\.{table}\b", lower) is None,
            f"migration must not UPDATE public.{table}",
        )
        assert_true(
            re.search(rf"\bdelete\s+from\s+public\.{table}\b", lower) is None,
            f"migration must not DELETE from public.{table}",
        )
    assert_true(
        UUID_RE.search(migration) is None,
        "migration must not contain a hard-coded UUID",
    )

    # --- 14. smoke -----------------------------------------------------------
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
        "public.product_skus" in smoke and "public.production_orders" in smoke,
        "smoke must seed a SKU and a Q7 production order",
    )
    for step in (
        "receipt_result",
        "receipt_rows",
        "receipt_replay",
        "replay_rows",
        "receipt_request",
        "planned_already_received",
        "issue_result",
        "issue_rows",
        "issue_balance",
        "over_issue",
        "snapshot_on_hand",
        "receipt_forbidden",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} check")
    assert_true(
        "public.get_warehouse_game_snapshot('q7')" in smoke,
        "smoke must exercise the Q7 snapshot",
    )
    assert_true(
        "public.get_q7_finished_goods_planned(" in smoke,
        "smoke must exercise the planned reader",
    )
    assert_true(
        "public.create_q7_finished_goods_receipt(" in smoke
        and "public.create_q7_finished_goods_issue(" in smoke,
        "smoke must exercise both writers",
    )

    # The last SMOKE_RESULT raise must be the PASS and nothing may raise after it.
    pass_message = "SMOKE_RESULT PASS: q7 finished goods"
    pass_index = smoke.rfind(pass_message)
    assert_true(pass_index != -1, "smoke must end with the PASS raise")
    tail = smoke[pass_index + len(pass_message):]
    assert_true("raise exception" not in tail.lower(), "no raise may follow the PASS raise")
    assert_true(
        tail.rstrip().endswith("$smoke$;"),
        "the PASS raise must close the DO block",
    )

    print("PASS: q7 finished goods contracts hold")


if __name__ == "__main__":
    main()
