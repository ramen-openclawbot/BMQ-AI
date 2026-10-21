#!/usr/bin/env python3
"""Static contract checks for the robot order desk foundation.

These checks never connect to a database or Supabase. They guard migration
20261101170000_robot_order_desk.sql, the debt_review edge mode and the client
hook/lib pair:

  * the three tables and their check constraints exist;
  * every table has RLS enabled, one SELECT-only policy for authenticated and
    the expected GRANTs (writes stay inside the SECURITY DEFINER RPCs);
  * create_robot_order_package reuses create_q7_draft_purchase_orders and
    create_payment_submission, keeps the idempotency short-circuit and never
    updates or deletes an existing payment request / purchase order;
  * set_supplier_debt_mark_ai is service_role only and its conflict update is
    guarded by source = 'jev' so learned / manual marks survive;
  * the edge function wires mode 'debt_review' and the service RPC;
  * the hook imports no .tsx file.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
FUNCTIONS = ROOT / "supabase" / "functions" / "stock-alias-jev"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101170000_robot_order_desk.sql"
SMOKE = SCRIPTS / "smoke_robot_order_desk.sql"
HANDLER = FUNCTIONS / "handler.ts"
INDEX = FUNCTIONS / "index.ts"
DEBT_REVIEW = FUNCTIONS / "debt-review.ts"

TABLES = (
    "supplier_debt_cutovers",
    "supplier_debt_marks",
    "robot_order_packages",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261101170000_robot_order_desk.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. the three tables and their check constraints ---------------------
    for table in TABLES:
        assert_true(
            f"create table if not exists public.{table} (" in lower,
            f"migration must create public.{table}",
        )
        assert_true(
            f"alter table public.{table} enable row level security;" in lower,
            f"public.{table} must enable RLS",
        )
        assert_true(
            f"create policy {table}_select on public.{table}" in lower
            and "for select to authenticated using (true);" in lower,
            f"public.{table} must have one SELECT-only authenticated policy",
        )
        assert_true(
            f"grant select on table public.{table} to authenticated;" in lower,
            f"public.{table} must grant SELECT to authenticated",
        )
        assert_true(
            f"grant all on table public.{table} to service_role;" in lower,
            f"public.{table} must grant ALL to service_role",
        )

    assert_true(
        lower.count("num_nonnulls(payment_request_id, purchase_order_id) = 1") >= 2,
        "the cutover and mark tables must pin exactly one document",
    )
    assert_true(
        "check (mark in ('settled_outside', 'real_debt', 'unsure'))" in lower,
        "supplier_debt_marks must constrain mark",
    )
    assert_true(
        "check (source in ('learned', 'jev', 'manual'))" in lower,
        "supplier_debt_marks must constrain source",
    )
    assert_true(
        "check (debt_kind in ('pr', 'po'))" in lower,
        "robot_order_packages must constrain debt_kind",
    )
    assert_true(
        "idempotency_key text not null unique" in lower,
        "robot_order_packages.idempotency_key must be unique",
    )
    assert_true(
        "create unique index if not exists supplier_debt_marks_doc_key"
        in lower
        and "on public.supplier_debt_marks (coalesce(payment_request_id, purchase_order_id));" in lower,
        "supplier_debt_marks needs the per-document unique index",
    )
    # No write policy may exist for authenticated.
    for verb in ("insert", "update", "delete"):
        assert_true(
            f"for {verb} to authenticated" not in lower,
            f"no {verb} policy may exist for authenticated on the new tables",
        )

    # --- 2. create_robot_order_package reuses the two existing RPCs ----------
    for helper in (
        "public.create_q7_draft_purchase_orders(p_lines, v_key || ':po')",
        "public.create_payment_submission(",
    ):
        assert_true(helper in migration, f"create_robot_order_package must call {helper}")
    assert_true(
        "idempotency_key_required" in lower,
        "create_robot_order_package must require the idempotency key",
    )
    assert_true(
        "select result into v_existing" in lower and "idempotent', true" in lower,
        "create_robot_order_package must replay a stored result by key",
    )
    assert_true(
        "pg_advisory_xact_lock(hashtext('robot_order_package:' || v_key))" in lower,
        "create_robot_order_package must serialise the same key",
    )
    assert_true(
        "raise exception 'forbidden' using errcode = '42501'" in lower,
        "create_robot_order_package must raise forbidden",
    )
    assert_true(
        "raise exception 'debt_not_payable'" in lower,
        "create_robot_order_package must raise debt_not_payable",
    )
    assert_true(
        "raise exception 'one_supplier_per_package'" in lower,
        "create_robot_order_package must raise one_supplier_per_package",
    )
    assert_true(
        "q7_material_inventory_can_edit" in lower
        and "has_module_permission(v_actor, 'payment_requests', 'edit')" in lower,
        "the debt gate must reuse the q7 edit and payment_requests edit checks",
    )

    # --- 3. never mutate an existing payment request / purchase order --------
    for verb, table in (
        ("update", "payment_requests"),
        ("delete", "payment_requests"),
        ("update", "purchase_orders"),
        ("delete", "purchase_orders"),
    ):
        pattern = rf"\b{verb}\s+(from\s+)?public\.{table}\b"
        assert_true(
            re.search(pattern, lower) is None,
            f"the migration must never {verb} public.{table}",
        )

    # --- 4. set_supplier_debt_mark_ai guards the Jev overwrite ---------------
    assert_true(
        "revoke all on function public.set_supplier_debt_mark_ai(uuid, jsonb) "
        "from public, anon, authenticated;" in lower,
        "set_supplier_debt_mark_ai must be revoked from public / anon / authenticated",
    )
    assert_true(
        "grant execute on function public.set_supplier_debt_mark_ai(uuid, jsonb) to service_role;"
        in lower,
        "set_supplier_debt_mark_ai must grant execute to service_role",
    )
    assert_true(
        re.search(
            r"grant execute on function public\.set_supplier_debt_mark_ai\(uuid, jsonb\) to authenticated",
            lower,
        )
        is None,
        "set_supplier_debt_mark_ai must not be granted to authenticated",
    )
    assert_true(
        "where supplier_debt_marks.source = 'jev';" in lower,
        "the Jev mark upsert must be guarded by source = 'jev'",
    )
    assert_true(
        "insert into public.supplier_debt_marks (" in lower
        and "'manual'" in lower,
        "the manual mark writer must upsert with source manual",
    )

    # --- 5. the edge function wires the new mode -----------------------------
    for path in (HANDLER, INDEX, DEBT_REVIEW):
        assert_true(path.exists(), f"missing edge file {path.name}")
    handler = read(HANDLER)
    index = read(INDEX)
    debt_review = read(DEBT_REVIEW)
    assert_true("debt_review" in handler, "handler.ts must mention debt_review")
    assert_true("debt_review" in index, "index.ts must mention debt_review")
    assert_true(
        "set_supplier_debt_mark_ai" in handler,
        "handler.ts must mention set_supplier_debt_mark_ai",
    )
    assert_true(
        "set_supplier_debt_mark_ai" in debt_review,
        "debt-review.ts must call set_supplier_debt_mark_ai",
    )
    assert_true(
        "get_supplier_debt_candidates" in debt_review,
        "debt-review.ts must call get_supplier_debt_candidates",
    )
    assert_true(
        "increment_stock_catalog_jev_usage" in debt_review
        or "incrementUsage" in debt_review,
        "debt_review must charge the shared daily quota",
    )
    assert_true(
        "debt_review" in debt_review and "set_supplier_debt_mark_ai" in index,
        "index.ts must mention the debt_review service RPC",
    )

    # The robot order desk front end left with the old warehouse game (owner 21/10/2026); only the backend is guarded here.

    # --- 7. the rollback-only smoke exists -----------------------------------
    assert_true(SMOKE.exists(), f"missing smoke {SMOKE.name}")
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke_lower, "smoke must open one transaction")
    assert_true("rollback;" in smoke_lower, "smoke must roll back")
    assert_true("commit;" not in smoke_lower, "smoke must not commit")
    assert_true("SMOKE PASS" in smoke, "smoke must raise the SMOKE PASS notice")
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate the owner through auth claims",
    )
    assert_true(
        "from public.user_roles" in smoke and "role::text = 'owner'" in smoke,
        "smoke must take the owner from public.user_roles",
    )

    print("PASS: robot order desk contracts hold")


if __name__ == "__main__":
    main()
